import { Worker } from "bullmq";
import { PrismaClient } from "@prisma/client";
import {
  connection,
  QUEUES,
  SLA_HOURS,
  type OutreachJob,
} from "../queues.js";
import { structuredCall } from "../lib/claude.js";
import { sendEmail } from "../lib/mailer.js";
import { contactAddress } from "./routing.js";

const prisma = new PrismaClient();

const OUTREACH_SYSTEM = `You draft correspondence to companies on behalf of
consumers, as their authorized third-party representative on the CustomerCourt
platform.

Rules:
- Professional, firm, and concise. No threats, no legal advice, no bluffing
  about actions the consumer hasn't authorized.
- Use only facts present in the case record. Never invent order numbers,
  dates, amounts, or prior interactions.
- State the desired outcome explicitly and ask for a response within 5
  business days.
- For follow-ups, reference the prior contact and dates, note the silence,
  and escalate the firmness one notch — still professional.
- Write in plain language a consumer would be comfortable signing.`;

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: {
      type: "string",
      description: "Plain-text email body, ready to send",
    },
  },
  required: ["subject", "body"],
  additionalProperties: false,
} as const;

interface Draft {
  subject: string;
  body: string;
}

export const outreachWorker = new Worker<OutreachJob>(
  QUEUES.outreach,
  async (job) => {
    const { caseId, kind } = job.data;
    const kase = await prisma.case.findUniqueOrThrow({
      where: { id: caseId },
      include: {
        consumer: true,
        company: { include: { contactPoints: true } },
        messages: { orderBy: { createdAt: "asc" } },
      },
    });

    const priorCorrespondence = kase.messages
      .filter((m) => m.direction !== "CONSUMER")
      .map(
        (m) =>
          `[${m.direction} ${m.createdAt.toISOString()}] ${m.subject ?? ""}\n${m.body}`,
      )
      .join("\n---\n");

    const draft = await structuredCall<Draft>({
      system: OUTREACH_SYSTEM,
      schema: DRAFT_SCHEMA,
      user: [
        `Task: draft a ${kind === "first_contact" ? "first contact" : `follow-up (attempt ${kase.followupCount + 1})`} email.`,
        `Company: ${kase.company?.name ?? "unknown"}`,
        `Consumer: ${kase.consumer.name ?? kase.consumer.email}`,
        `Category: ${kase.category} | Severity: ${kase.severity}`,
        `Case summary: ${kase.summary}`,
        `Desired outcome: ${kase.desiredOutcome}`,
        `Consumer's original complaint:\n${kase.rawComplaint}`,
        priorCorrespondence
          ? `Prior correspondence:\n${priorCorrespondence}`
          : "No prior correspondence.",
      ].join("\n\n"),
      maxTokens: 4096,
    });

    if (kind === "first_contact") {
      // First contact waits for explicit consumer approval before sending.
      const message = await prisma.message.create({
        data: {
          caseId,
          direction: "PLATFORM",
          status: "DRAFT",
          subject: draft.subject,
          body: draft.body,
        },
      });
      await prisma.caseEvent.create({
        data: {
          caseId,
          type: "outreach.drafted",
          payload: { messageId: message.id, kind },
        },
      });
      return { messageId: message.id, status: "awaiting_approval" };
    }

    // Follow-ups auto-send under the authorization granted at first approval.
    const to = contactAddress(kase.company);
    await sendEmail({ to, subject: draft.subject, body: draft.body });

    const slaDeadline = new Date(Date.now() + SLA_HOURS * 3600_000);
    await prisma.$transaction([
      prisma.message.create({
        data: {
          caseId,
          direction: "PLATFORM",
          status: "SENT",
          subject: draft.subject,
          body: draft.body,
        },
      }),
      prisma.case.update({
        where: { id: caseId },
        data: {
          status: "AWAITING_COMPANY",
          followupCount: { increment: 1 },
          slaDeadline,
        },
      }),
      prisma.caseEvent.create({
        data: {
          caseId,
          type: "outreach.followup_sent",
          payload: { to, attempt: kase.followupCount + 1 },
        },
      }),
    ]);
    return { status: "sent" };
  },
  { connection },
);

outreachWorker.on("failed", (job, err) => {
  console.error(`outreach failed for case ${job?.data.caseId}:`, err.message);
});
