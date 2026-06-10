import { Worker } from "bullmq";
import { PrismaClient } from "@prisma/client";
import {
  connection,
  MAX_FOLLOWUPS,
  outreachQueue,
  QUEUES,
  slaQueue,
} from "../queues.js";

const prisma = new PrismaClient();

const SWEEP_EVERY_MS = Number(process.env.SLA_SWEEP_MS ?? 5 * 60_000);

// Repeatable sweep: any case the company has left past its SLA deadline
// either gets a follow-up or, after MAX_FOLLOWUPS, escalates (next contact
// tier / regulator package — workstream 4 owns what ESCALATED does next).
export async function startSlaScheduler() {
  await slaQueue.upsertJobScheduler("sla-sweep", { every: SWEEP_EVERY_MS });
}

export const slaWorker = new Worker(
  QUEUES.sla,
  async () => {
    const overdue = await prisma.case.findMany({
      where: { status: "AWAITING_COMPANY", slaDeadline: { lt: new Date() } },
      select: { id: true, followupCount: true },
    });

    for (const kase of overdue) {
      if (kase.followupCount < MAX_FOLLOWUPS) {
        // Clear the deadline so the next sweep doesn't double-enqueue while
        // the follow-up job is still in flight; outreach sets a fresh one.
        await prisma.case.update({
          where: { id: kase.id },
          data: { slaDeadline: null },
        });
        await outreachQueue.add("followup", {
          caseId: kase.id,
          kind: "followup",
        });
      } else {
        await prisma.$transaction([
          prisma.case.update({
            where: { id: kase.id },
            data: { status: "ESCALATED", slaDeadline: null },
          }),
          prisma.caseEvent.create({
            data: {
              caseId: kase.id,
              type: "case.escalated",
              payload: {
                reason: "sla_exhausted",
                followups: kase.followupCount,
              },
            },
          }),
        ]);
      }
    }

    return { overdue: overdue.length };
  },
  { connection },
);

slaWorker.on("failed", (_job, err) => {
  console.error("sla sweep failed:", err.message);
});
