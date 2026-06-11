import { Worker } from "bullmq";
import { PrismaClient } from "@prisma/client";
import {
  connection,
  QUEUES,
  SLA_HOURS,
  type EscalationJob,
} from "../queues.js";
import { structuredCall } from "../lib/claude.js";
import { sendEmail } from "../lib/mailer.js";
import { nextContactPoint } from "../outreach/routing.js";

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Tier escalation: draft an email to the next rung of the contact ladder.
// ---------------------------------------------------------------------------

const ESCALATION_SYSTEM = `You draft escalation correspondence to companies on
behalf of consumers, as their authorized third-party representative on the
CustomerCourt platform. You are writing to a HIGHER tier of contact — an
escalation desk or executive relations team — because the front-line contact
has failed to resolve the case.

Rules:
- Summarize the case history compactly and concretely, with dates: when the
  company was first contacted, how many follow-ups were sent, and the total
  duration of silence (or note that responses received were inadequate).
- State plainly that the front-line contact failed to resolve the matter, so
  the case is being escalated.
- Firm but professional. No threats, no legal advice, no bluffing about
  actions the consumer hasn't authorized.
- Use only facts present in the case record. Never invent order numbers,
  dates, amounts, or prior interactions.
- Make an explicit ask: state the desired outcome and request a substantive
  response within 5 business days.
- Write in plain language a consumer would be comfortable signing.`;

const ESCALATION_DRAFT_SCHEMA = {
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

interface EscalationDraft {
  subject: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Ladder exhausted: generate a consumer handoff package.
// ---------------------------------------------------------------------------

const HANDOFF_SYSTEM = `The company in this case has proven unresponsive or
unwilling to resolve the consumer's complaint through every contact tier
CustomerCourt could reach. Your job is to produce an honest, practical guide
for the consumer's remaining options.

Rules:
- Be candid about what happened: how long we tried, what we tried, and that
  the company did not engage.
- Recommend only paths that genuinely fit this case (payment method, amount
  at stake, category, jurisdiction signals in the record). Don't pad the list.
- For each recommended path, explain WHY it fits this case and give concrete,
  step-by-step instructions the consumer can follow today.
- "drop" is a legitimate recommendation when the cost of pursuing exceeds the
  value at stake — say so honestly if that's the situation.
- If a regulator complaint is recommended, name the most relevant regulator;
  otherwise set regulator_name to null.
- At most one sentence noting this is general guidance, not legal advice — no
  further disclaimer boilerplate.`;

const HANDOFF_SCHEMA = {
  type: "object",
  properties: {
    summary_of_efforts: {
      type: "string",
      description:
        "Honest recap of what CustomerCourt attempted and how the company responded (or didn't), with dates",
    },
    recommended_paths: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: {
            type: "string",
            enum: [
              "chargeback",
              "regulator_complaint",
              "small_claims",
              "public_review",
              "drop",
            ],
          },
          rationale: {
            type: "string",
            description: "Why this path fits this specific case",
          },
          how_to: {
            type: "string",
            description: "Concrete steps the consumer can take today",
          },
        },
        required: ["path", "rationale", "how_to"],
        additionalProperties: false,
      },
    },
    regulator_name: {
      type: ["string", "null"],
      description:
        "Most relevant regulator if a regulator complaint is recommended, else null",
    },
  },
  required: ["summary_of_efforts", "recommended_paths", "regulator_name"],
  additionalProperties: false,
} as const;

// Type alias (not interface) so it stays assignable to Prisma's JSON input.
type HandoffPackage = {
  summary_of_efforts: string;
  recommended_paths: {
    path:
      | "chargeback"
      | "regulator_complaint"
      | "small_claims"
      | "public_review"
      | "drop";
    rationale: string;
    how_to: string;
  }[];
  regulator_name: string | null;
};

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export const escalationWorker = new Worker<EscalationJob>(
  QUEUES.escalation,
  async (job) => {
    const { caseId } = job.data;
    const kase = await prisma.case.findUniqueOrThrow({
      where: { id: caseId },
      include: {
        consumer: true,
        company: { include: { contactPoints: true } },
        messages: { orderBy: { createdAt: "asc" } },
      },
    });

    const platformMessages = kase.messages.filter(
      (m) => m.direction === "PLATFORM",
    );
    const companyReplies = kase.messages.filter(
      (m) => m.direction === "COMPANY",
    );
    const firstContactAt = platformMessages[0]?.createdAt ?? kase.createdAt;

    const correspondence = kase.messages
      .filter((m) => m.direction !== "CONSUMER")
      .map(
        (m) =>
          `[${m.direction} ${m.createdAt.toISOString()}] ${m.subject ?? ""}\n${m.body}`,
      )
      .join("\n---\n");

    const caseFacts = [
      `Company: ${kase.company?.name ?? "unknown"}`,
      `Consumer: ${kase.consumer.name ?? kase.consumer.email}`,
      `Category: ${kase.category} | Severity: ${kase.severity}`,
      `Case summary: ${kase.summary}`,
      `Desired outcome: ${kase.desiredOutcome}`,
      `Estimated value at stake (cents): ${kase.valueCents ?? "unknown"}`,
      `First contact sent: ${firstContactAt.toISOString()}`,
      `Follow-ups sent after first contact: ${kase.followupCount}`,
      companyReplies.length === 0
        ? `Company replies: none — total silence since first contact (today is ${new Date().toISOString()})`
        : `Company replies: ${companyReplies.length}, but none resolved the case`,
      `Consumer's original complaint:\n${kase.rawComplaint}`,
      correspondence
        ? `Full correspondence record:\n${correspondence}`
        : "No correspondence on record.",
    ].join("\n\n");

    const rung = nextContactPoint(kase.company, kase.escalationTier);

    if (rung) {
      // --- Next rung exists: climb the ladder ---
      const draft = await structuredCall<EscalationDraft>({
        system: ESCALATION_SYSTEM,
        schema: ESCALATION_DRAFT_SCHEMA,
        user: [
          `Task: draft an escalation email to the company's tier-${rung.tier} contact (escalation desk / executive relations). The front-line contact (tier ${kase.escalationTier}) did not resolve the case.`,
          caseFacts,
        ].join("\n\n"),
        maxTokens: 4096,
      });

      // Escalation sends are covered by the consumer's original outreach
      // authorization (granted at first-contact approval) — no new approval
      // gate before sending up the ladder.
      await sendEmail({ to: rung.address, subject: draft.subject, body: draft.body });

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
            escalationTier: rung.tier,
            // Reset the follow-up budget for the new rung; the SLA sweep
            // restarts the follow-up/escalation cycle against this contact.
            followupCount: 0,
            slaDeadline,
          },
        }),
        prisma.caseEvent.create({
          data: {
            caseId,
            type: "case.escalated_tier",
            payload: {
              to: rung.address,
              fromTier: kase.escalationTier,
              toTier: rung.tier,
            },
          },
        }),
      ]);
      return { status: "escalated", toTier: rung.tier };
    }

    // --- Ladder exhausted: hand the case back to the consumer ---
    const handoff = await structuredCall<HandoffPackage>({
      system: HANDOFF_SYSTEM,
      schema: HANDOFF_SCHEMA,
      user: [
        `Task: the contact ladder is exhausted (highest tier reached: ${kase.escalationTier}). Produce the consumer handoff package.`,
        caseFacts,
      ].join("\n\n"),
      maxTokens: 4096,
    });

    // The package is FOR the consumer, so it lives on the case timeline only
    // (no Message row — Messages model platform<->company correspondence).
    // The consumer app renders the handoff package from this CaseEvent.
    await prisma.$transaction([
      prisma.case.update({
        where: { id: caseId },
        data: { status: "ESCALATED", slaDeadline: null },
      }),
      prisma.caseEvent.create({
        data: {
          caseId,
          type: "case.handoff_package",
          payload: handoff,
        },
      }),
    ]);
    return { status: "handed_off", paths: handoff.recommended_paths.length };
  },
  { connection },
);

escalationWorker.on("failed", (job, err) => {
  console.error(`escalation failed for case ${job?.data.caseId}:`, err.message);
});
