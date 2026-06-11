import { Worker } from "bullmq";
import { PrismaClient } from "@prisma/client";
import {
  connection,
  escalationQueue,
  MAX_FOLLOWUPS,
  outreachQueue,
  QUEUES,
  slaQueue,
} from "../queues.js";

const prisma = new PrismaClient();

const SWEEP_EVERY_MS = Number(process.env.SLA_SWEEP_MS ?? 5 * 60_000);

// Repeatable sweep: any case the company has left past its SLA deadline
// either gets a follow-up or, after MAX_FOLLOWUPS, is handed to the
// escalation worker (next contact-ladder tier, or a consumer handoff
// package when the ladder is exhausted).
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
        // Follow-ups exhausted: hand off to the escalation worker, which
        // either climbs the contact ladder or produces a consumer handoff
        // package. Clear the deadline so the sweep doesn't double-fire while
        // the escalation job is in flight; the worker owns the case's next
        // status and deadline.
        await prisma.$transaction([
          prisma.case.update({
            where: { id: kase.id },
            data: { slaDeadline: null },
          }),
          prisma.caseEvent.create({
            data: {
              caseId: kase.id,
              type: "case.sla_exhausted",
              payload: {
                reason: "max_followups_reached",
                followups: kase.followupCount,
              },
            },
          }),
        ]);
        await escalationQueue.add("escalate", { caseId: kase.id });
      }
    }

    return { overdue: overdue.length };
  },
  { connection },
);

slaWorker.on("failed", (_job, err) => {
  console.error("sla sweep failed:", err.message);
});
