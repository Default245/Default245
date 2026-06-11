import { Worker } from "bullmq";
import { PrismaClient, type CaseStatus } from "@prisma/client";
import {
  connection,
  negotiationQueue,
  QUEUES,
  type ReplyJob,
} from "../queues.js";
import { structuredCall } from "../lib/claude.js";
import {
  REPLY_SCHEMA,
  REPLY_SYSTEM,
  type ReplyAnalysis,
} from "./analysis.js";

const prisma = new PrismaClient();

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

    // An offer that falls short or an outright refusal warrants a counter —
    // hand the analysis to the negotiation worker to draft one.
    if (
      (analysis.reply_type === "offer" || analysis.reply_type === "refusal") &&
      !analysis.meets_desired_outcome
    ) {
      await negotiationQueue.add("counter", {
        caseId,
        replyMessageId: messageId,
        analysis,
      });
    }

    return analysis;
  },
  { connection },
);

replyWorker.on("failed", (job, err) => {
  console.error(`reply analysis failed for case ${job?.data.caseId}:`, err.message);
});
