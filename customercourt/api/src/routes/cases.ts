import type { FastifyInstance } from "fastify";
import { PrismaClient, type Outcome } from "@prisma/client";
import {
  outcomesQueue,
  replyQueue,
  SLA_HOURS,
  triageQueue,
} from "../queues.js";
import { sendEmail } from "../lib/mailer.js";
import { contactAddress } from "../outreach/routing.js";

const prisma = new PrismaClient();

interface CreateCaseBody {
  email: string;
  name?: string;
  complaint: string;
}

interface AddMessageBody {
  body: string;
  subject?: string;
}

export async function caseRoutes(app: FastifyInstance) {
  // File a complaint. Creates the case and enqueues AI triage.
  app.post<{ Body: CreateCaseBody }>("/v1/cases", {
    schema: {
      body: {
        type: "object",
        required: ["email", "complaint"],
        properties: {
          email: { type: "string", format: "email" },
          name: { type: "string" },
          complaint: { type: "string", minLength: 10 },
        },
      },
    },
    handler: async (req, reply) => {
      const { email, name, complaint } = req.body;

      const consumer = await prisma.consumer.upsert({
        where: { email },
        update: {},
        create: { email, name },
      });

      const kase = await prisma.case.create({
        data: {
          consumerId: consumer.id,
          rawComplaint: complaint,
          events: {
            create: { type: "case.created", payload: { source: "api" } },
          },
        },
      });

      await triageQueue.add("triage", { caseId: kase.id });

      return reply.code(201).send({ id: kase.id, status: kase.status });
    },
  });

  // Case detail with full timeline.
  app.get<{ Params: { id: string } }>("/v1/cases/:id", async (req, reply) => {
    const kase = await prisma.case.findUnique({
      where: { id: req.params.id },
      include: {
        company: true,
        resolution: true,
        events: { orderBy: { createdAt: "asc" } },
        messages: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!kase) return reply.code(404).send({ error: "case not found" });
    return kase;
  });

  // Consumer adds context to an open case.
  app.post<{ Params: { id: string }; Body: AddMessageBody }>(
    "/v1/cases/:id/messages",
    {
      schema: {
        body: {
          type: "object",
          required: ["body"],
          properties: {
            body: { type: "string", minLength: 1 },
            subject: { type: "string" },
          },
        },
      },
      handler: async (req, reply) => {
        const kase = await prisma.case.findUnique({
          where: { id: req.params.id },
        });
        if (!kase) return reply.code(404).send({ error: "case not found" });

        const message = await prisma.message.create({
          data: {
            caseId: kase.id,
            direction: "CONSUMER",
            body: req.body.body,
            subject: req.body.subject,
          },
        });
        return reply.code(201).send(message);
      },
    },
  );

  // Consumer approves a drafted first contact. This is the authorization
  // moment: the email goes out, the SLA clock starts, and follow-ups are
  // covered by this approval.
  app.post<{ Params: { id: string; messageId: string } }>(
    "/v1/cases/:id/drafts/:messageId/approve",
    async (req, reply) => {
      const message = await prisma.message.findUnique({
        where: { id: req.params.messageId },
        include: {
          case: { include: { company: { include: { contactPoints: true } } } },
        },
      });
      if (!message || message.caseId !== req.params.id) {
        return reply.code(404).send({ error: "draft not found" });
      }
      if (message.direction !== "PLATFORM" || message.status !== "DRAFT") {
        return reply.code(409).send({ error: "message is not an approvable draft" });
      }

      const to = contactAddress(message.case.company);
      await sendEmail({
        to,
        subject: message.subject ?? "Complaint",
        body: message.body,
      });

      const slaDeadline = new Date(Date.now() + SLA_HOURS * 3600_000);
      await prisma.$transaction([
        prisma.message.update({
          where: { id: message.id },
          data: { status: "SENT" },
        }),
        prisma.case.update({
          where: { id: message.caseId },
          data: { status: "AWAITING_COMPANY", slaDeadline },
        }),
        prisma.caseEvent.create({
          data: {
            caseId: message.caseId,
            type: "outreach.approved_and_sent",
            payload: { messageId: message.id, to, slaDeadline },
          },
        }),
      ]);

      return { status: "AWAITING_COMPANY", to, slaDeadline };
    },
  );

  // Company reply lands here (manual paste for now; the inbound-email
  // webhook will hit the same endpoint). Enqueues AI reply analysis.
  app.post<{ Params: { id: string }; Body: AddMessageBody }>(
    "/v1/cases/:id/replies",
    {
      schema: {
        body: {
          type: "object",
          required: ["body"],
          properties: {
            body: { type: "string", minLength: 1 },
            subject: { type: "string" },
          },
        },
      },
      handler: async (req, reply) => {
        const kase = await prisma.case.findUnique({
          where: { id: req.params.id },
        });
        if (!kase) return reply.code(404).send({ error: "case not found" });

        const message = await prisma.message.create({
          data: {
            caseId: kase.id,
            direction: "COMPANY",
            body: req.body.body,
            subject: req.body.subject,
          },
        });
        await replyQueue.add("analyze", {
          caseId: kase.id,
          messageId: message.id,
        });
        return reply.code(201).send({ messageId: message.id, status: "queued" });
      },
    },
  );

  // Consumer records the outcome. Closing the loop here is what feeds the
  // learning systems: routing stats, outcome prediction, eval labels.
  app.post<{
    Params: { id: string };
    Body: { outcome: Outcome; valueCents?: number; consumerSatisfied?: boolean };
  }>(
    "/v1/cases/:id/resolve",
    {
      schema: {
        body: {
          type: "object",
          required: ["outcome"],
          properties: {
            outcome: {
              type: "string",
              enum: [
                "REFUND",
                "REPLACEMENT",
                "CREDIT",
                "APOLOGY",
                "POLICY_EXCEPTION",
                "PARTIAL",
                "HANDED_OFF",
                "UNRESOLVED",
              ],
            },
            valueCents: { type: "integer" },
            consumerSatisfied: { type: "boolean" },
          },
        },
      },
      handler: async (req, reply) => {
        const kase = await prisma.case.findUnique({
          where: { id: req.params.id },
          include: { resolution: true },
        });
        if (!kase) return reply.code(404).send({ error: "case not found" });
        if (kase.resolution) {
          return reply.code(409).send({ error: "case already resolved" });
        }

        const [resolution] = await prisma.$transaction([
          prisma.resolution.create({
            data: {
              caseId: kase.id,
              outcome: req.body.outcome,
              valueCents: req.body.valueCents,
              consumerSatisfied: req.body.consumerSatisfied,
            },
          }),
          prisma.case.update({
            where: { id: kase.id },
            data: { status: "RESOLVED", slaDeadline: null },
          }),
          prisma.caseEvent.create({
            data: {
              caseId: kase.id,
              type: "case.resolved",
              payload: { outcome: req.body.outcome, valueCents: req.body.valueCents ?? null },
            },
          }),
        ]);

        // Feed the learning loop: contact-point stats, outcome labels.
        await outcomesQueue.add("update", { caseId: kase.id });

        return reply.code(201).send(resolution);
      },
    },
  );
}
