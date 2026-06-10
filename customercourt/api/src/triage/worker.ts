import { Worker } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { connection, outreachQueue, QUEUES, type TriageJob } from "../queues.js";
import { structuredCall } from "../lib/claude.js";
import { TRIAGE_SCHEMA, type TriageResult } from "./schema.js";

const prisma = new PrismaClient();

// Stable system prompt — cached across requests by structuredCall. Keep it
// byte-identical between calls; volatile case content goes in the user turn.
const TRIAGE_SYSTEM = `You are the intake triage engine for a consumer-complaint
resolution platform. Consumers describe problems with companies in their own
words; your job is to turn each complaint into a structured case.

Rules:
- Be neutral and factual in the summary; do not editorialize.
- desired_outcome must be concrete and actionable, inferring a reasonable ask
  if the consumer didn't state one.
- Set safety_flag true for threats of violence, medical harm, or fraud in
  progress — these route to a human, not automation.
- If the company is ambiguous (e.g. a brand vs. its parent), use the name the
  consumer used.`;

export const triageWorker = new Worker<TriageJob>(
  QUEUES.triage,
  async (job) => {
    const { caseId } = job.data;
    const kase = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });

    const triage = await structuredCall<TriageResult>({
      system: TRIAGE_SYSTEM,
      user: kase.rawComplaint,
      schema: TRIAGE_SCHEMA,
    });

    // Resolve or create the company record so routing has something to work with.
    let companyId: string | null = null;
    if (triage.company_name) {
      const company = await prisma.company.upsert({
        where: { domain: triage.company_name.toLowerCase().replace(/\s+/g, "-") },
        update: {},
        create: {
          name: triage.company_name,
          domain: triage.company_name.toLowerCase().replace(/\s+/g, "-"),
        },
      });
      companyId = company.id;
    }

    await prisma.$transaction([
      prisma.case.update({
        where: { id: caseId },
        data: {
          status: triage.safety_flag ? "ESCALATED" : "TRIAGED",
          category: triage.category,
          severity: triage.severity,
          summary: triage.summary,
          desiredOutcome: triage.desired_outcome,
          valueCents: triage.estimated_value_cents,
          safetyFlag: triage.safety_flag,
          companyId,
        },
      }),
      prisma.caseEvent.create({
        data: { caseId, type: "triage.completed", payload: triage as object },
      }),
    ]);

    // Safety-flagged cases stop here (human queue). Everything else moves
    // straight to drafting the first contact, which waits on consumer approval.
    if (!triage.safety_flag) {
      await outreachQueue.add("first_contact", {
        caseId,
        kind: "first_contact",
      });
    }

    return triage;
  },
  { connection },
);

triageWorker.on("failed", (job, err) => {
  console.error(`triage failed for case ${job?.data.caseId}:`, err.message);
});
