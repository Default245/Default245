import { Worker } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { connection, QUEUES, type NegotiationJob } from "../queues.js";
import { structuredCall } from "../lib/claude.js";

const prisma = new PrismaClient();

const NEGOTIATION_SYSTEM = `You draft counter-offer and rebuttal emails to
companies on behalf of consumers, as their authorized third-party
representative on the CustomerCourt platform.

Rules:
- You are responding to a company's offer or refusal. Acknowledge it
  specifically — name the amounts, terms, or reasons the company gave —
  before countering. Never pretend the company's position wasn't heard.
- Never accept less than the consumer's desired outcome. Whether to take a
  lesser offer is the consumer's decision alone; your draft counters, it
  does not concede. Restate the desired outcome as the position.
- Use only facts present in the case record. Never invent order numbers,
  dates, amounts, prior promises, or interactions.
- Professional and firm. After a refusal, escalate the firmness one notch
  beyond what you would use after a lowball offer — still professional, no
  threats, no legal advice, no bluffing about actions the consumer hasn't
  authorized.
- Ask for a response within 5 business days, stated explicitly.
- Write in plain language a consumer would be comfortable signing.
- Also produce a short internal note (1-2 sentences) to the consumer
  explaining the negotiation strategy behind the draft.`;

const COUNTER_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: {
      type: "string",
      description: "Plain-text email body, ready to send",
    },
    negotiation_note: {
      type: "string",
      description:
        "1-2 sentence internal note to the consumer explaining the strategy",
    },
  },
  required: ["subject", "body", "negotiation_note"],
  additionalProperties: false,
} as const;

interface CounterDraft {
  subject: string;
  body: string;
  negotiation_note: string;
}

export const negotiationWorker = new Worker<NegotiationJob>(
  QUEUES.negotiation,
  async (job) => {
    const { caseId, replyMessageId, analysis } = job.data;
    const kase = await prisma.case.findUniqueOrThrow({
      where: { id: caseId },
      include: {
        consumer: true,
        company: { include: { contactPoints: true } },
        messages: { orderBy: { createdAt: "asc" } },
      },
    });

    const companyReply = kase.messages.find((m) => m.id === replyMessageId);

    const correspondence = kase.messages
      .map(
        (m) =>
          `[${m.direction} ${m.createdAt.toISOString()}] ${m.subject ?? ""}\n${m.body}`,
      )
      .join("\n---\n");

    const draft = await structuredCall<CounterDraft>({
      system: NEGOTIATION_SYSTEM,
      schema: COUNTER_SCHEMA,
      user: [
        `Task: draft a counter to the company's ${analysis.reply_type}.`,
        `Company: ${kase.company?.name ?? "unknown"}`,
        `Consumer: ${kase.consumer.name ?? kase.consumer.email}`,
        `Category: ${kase.category} | Severity: ${kase.severity}`,
        `Case summary: ${kase.summary}`,
        `Consumer's desired outcome: ${kase.desiredOutcome}`,
        [
          "Analysis of the company's reply:",
          `- Type: ${analysis.reply_type}`,
          `- Summary: ${analysis.summary}`,
          `- Offer value (cents): ${analysis.offer_value_cents ?? "none"}`,
          `- Meets desired outcome: ${analysis.meets_desired_outcome}`,
          `- Recommended next step: ${analysis.recommended_next_step}`,
        ].join("\n"),
        companyReply
          ? `Company's reply being countered${companyReply.subject ? ` (subject: ${companyReply.subject})` : ""}:\n${companyReply.body}`
          : "Company's reply text unavailable; rely on the analysis above.",
        `Full correspondence history:\n${correspondence}`,
      ].join("\n\n"),
      maxTokens: 4096,
    });

    // Stored as a DRAFT only — this worker never sends and never touches the
    // case status. The consumer reviews and approves through the existing
    // approve endpoint, which handles DRAFT PLATFORM messages, sends the
    // email, and restarts the SLA clock.
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
        type: "negotiation.drafted",
        payload: {
          messageId: message.id,
          negotiation_note: draft.negotiation_note,
          respondingTo: replyMessageId,
        },
      },
    });

    return { messageId: message.id, status: "awaiting_approval" };
  },
  { connection },
);

negotiationWorker.on("failed", (job, err) => {
  console.error(
    `negotiation draft failed for case ${job?.data.caseId}:`,
    err.message,
  );
});
