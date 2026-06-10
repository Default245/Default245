import { Worker } from "bullmq";
import { PrismaClient, type CaseStatus } from "@prisma/client";
import { connection, QUEUES, type ReplyJob } from "../queues.js";
import { structuredCall } from "../lib/claude.js";

const prisma = new PrismaClient();

const REPLY_SYSTEM = `You analyze company responses to consumer complaints for
the CustomerCourt platform. Classify what the company is actually saying —
companies often bury a refusal in polite language or stall with vague
process talk. Be literal about commitments: "we'll look into it" is a stall,
not an offer.`;

export const REPLY_TYPES = [
  "offer", // concrete remedy proposed
  "refusal", // explicit or thinly-veiled no
  "stall", // acknowledgment without commitment
  "info_request", // company needs something from the consumer
  "resolution_confirmation", // company confirms remedy is done/issued
  "other",
] as const;

interface ReplyAnalysis {
  reply_type: (typeof REPLY_TYPES)[number];
  summary: string;
  offer_value_cents: number | null;
  meets_desired_outcome: boolean;
  recommended_next_step: string;
}

const REPLY_SCHEMA = {
  type: "object",
  properties: {
    reply_type: { type: "string", enum: [...REPLY_TYPES] },
    summary: {
      type: "string",
      description: "One sentence: what the company is actually saying",
    },
    offer_value_cents: {
      type: ["integer", "null"],
      description: "Value of any concrete offer in cents, null if none",
    },
    meets_desired_outcome: {
      type: "boolean",
      description: "Whether the reply fully satisfies the consumer's desired outcome",
    },
    recommended_next_step: { type: "string" },
  },
  required: [
    "reply_type",
    "summary",
    "offer_value_cents",
    "meets_desired_outcome",
    "recommended_next_step",
  ],
  additionalProperties: false,
} as const;

// What each reply type does to the case state. Stalls keep the SLA clock
// running so the follow-up scheduler stays armed; everything needing a
// consumer or agent decision goes to NEGOTIATING.
const NEXT_STATUS: Record<ReplyAnalysis["reply_type"], CaseStatus> = {
  offer: "NEGOTIATING",
  refusal: "NEGOTIATING",
  info_request: "NEGOTIATING",
  resolution_confirmation: "NEGOTIATING", // consumer confirms via /resolve
  stall: "AWAITING_COMPANY",
  other: "NEGOTIATING",
};

export const replyWorker = new Worker<ReplyJob>(
  QUEUES.replies,
  async (job) => {
    const { caseId, messageId } = job.data;
    const [kase, message] = await Promise.all([
      prisma.case.findUniqueOrThrow({ where: { id: caseId } }),
      prisma.message.findUniqueOrThrow({ where: { id: messageId } }),
    ]);

    const analysis = await structuredCall<ReplyAnalysis>({
      system: REPLY_SYSTEM,
      schema: REPLY_SCHEMA,
      user: [
        `Case summary: ${kase.summary}`,
        `Consumer's desired outcome: ${kase.desiredOutcome}`,
        `Company reply${message.subject ? ` (subject: ${message.subject})` : ""}:\n${message.body}`,
      ].join("\n\n"),
    });

    await prisma.$transaction([
      prisma.case.update({
        where: { id: caseId },
        data: { status: NEXT_STATUS[analysis.reply_type] },
      }),
      prisma.caseEvent.create({
        data: { caseId, type: "reply.analyzed", payload: analysis as object },
      }),
    ]);

    return analysis;
  },
  { connection },
);

replyWorker.on("failed", (job, err) => {
  console.error(`reply analysis failed for case ${job?.data.caseId}:`, err.message);
});
