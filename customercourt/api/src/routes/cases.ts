import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { triageQueue } from "../queues.js";

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
}
