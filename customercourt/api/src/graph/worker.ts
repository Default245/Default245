import { Worker } from "bullmq";
import { Prisma, PrismaClient } from "@prisma/client";
import { connection, QUEUES, type OutcomeJob } from "../queues.js";

const prisma = new PrismaClient();

// Event types whose payloads carry the contact address we actually wrote to.
const OUTREACH_EVENT_TYPES = new Set([
  "outreach.approved_and_sent",
  "outreach.followup_sent",
  "case.escalated_tier",
]);

// Outcomes where the company itself never made it right — nothing for the
// contact graph to credit.
const NON_SUCCESS_OUTCOMES = new Set<string>(["UNRESOLVED", "HANDED_OFF"]);

// Safely pull a string `to` field out of a Prisma Json payload without `any`.
function extractTo(payload: Prisma.JsonValue): string | null {
  if (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    "to" in payload
  ) {
    const to = payload.to;
    return typeof to === "string" ? to : null;
  }
  return null;
}

// Learning loop: when a case closes, fold its outcome back into the stats of
// every contact point we actually used, so routing can rank contacts by what
// has historically worked. Pure bookkeeping — no AI calls here.
export const graphWorker = new Worker<OutcomeJob>(
  QUEUES.outcomes,
  async (job) => {
    const { caseId } = job.data;

    const kase = await prisma.case.findUniqueOrThrow({
      where: { id: caseId },
      include: {
        resolution: true,
        events: { orderBy: { createdAt: "asc" } },
        messages: { orderBy: { createdAt: "asc" } },
        company: { include: { contactPoints: true } },
      },
    });

    if (!kase.resolution || !kase.companyId || !kase.company) {
      console.log(
        `graph: case ${caseId} has no resolution or company — nothing to learn`,
      );
      return { updated: 0 };
    }

    // Which addresses did we actually contact on this case?
    const usedAddresses = new Set<string>();
    for (const event of kase.events) {
      if (!OUTREACH_EVENT_TYPES.has(event.type)) continue;
      const to = extractTo(event.payload);
      if (to) usedAddresses.add(to);
    }

    const success = !NON_SUCCESS_OUTCOMES.has(kase.resolution.outcome);

    // Reply-latency signal: hours from our first approved send to the first
    // company message that came after it.
    let replyHours: number | null = null;
    const firstSend = kase.events.find(
      (e) => e.type === "outreach.approved_and_sent",
    );
    if (firstSend) {
      const firstCompanyReply = kase.messages.find(
        (m) =>
          m.direction === "COMPANY" && m.createdAt > firstSend.createdAt,
      );
      if (firstCompanyReply) {
        replyHours =
          (firstCompanyReply.createdAt.getTime() -
            firstSend.createdAt.getTime()) /
          (1000 * 60 * 60);
      }
    }

    const touched = kase.company.contactPoints.filter((cp) =>
      usedAddresses.has(cp.address),
    );

    const updates = touched.map((cp) => {
      const casesTotal = cp.casesTotal + 1;
      const casesResolved = cp.casesResolved + (success ? 1 : 0);

      // Honesty note: this is a *running mean*, not a median. The column is
      // named medianReplyHrs because workstream 3 will replace this with a
      // proper streaming quantile estimate; we keep the column name stable so
      // routing doesn't have to migrate twice.
      let medianReplyHrs = cp.medianReplyHrs;
      if (replyHours !== null) {
        medianReplyHrs =
          medianReplyHrs === null
            ? replyHours
            : (medianReplyHrs * (casesTotal - 1) + replyHours) / casesTotal;
      }

      return prisma.contactPoint.update({
        where: { id: cp.id },
        data: {
          casesTotal,
          casesResolved,
          resolutionRate: casesResolved / casesTotal,
          medianReplyHrs,
        },
      });
    });

    await prisma.$transaction([
      ...updates,
      prisma.caseEvent.create({
        data: {
          caseId,
          type: "graph.stats_updated",
          payload: {
            addresses: touched.map((cp) => cp.address),
            success,
            replyHours,
          },
        },
      }),
    ]);

    return { updated: touched.length, success, replyHours };
  },
  { connection },
);

graphWorker.on("failed", (job, err) => {
  console.error(
    `graph stats update failed for case ${job?.data.caseId}:`,
    err.message,
  );
});
