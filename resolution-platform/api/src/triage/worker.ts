import Anthropic from "@anthropic-ai/sdk";
import { Worker } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { connection, QUEUES, type TriageJob } from "../queues.js";
import { TRIAGE_SCHEMA, type TriageResult } from "./schema.js";

const prisma = new PrismaClient();
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// Stable system prompt — cached across requests via cache_control below.
// Keep this byte-identical between calls; volatile case content goes in the
// user turn after the cache breakpoint.
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

    const response = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text",
          text: TRIAGE_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: kase.rawComplaint }],
      output_config: {
        format: { type: "json_schema", schema: TRIAGE_SCHEMA },
      },
    });

    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      throw new Error(`triage: no text block in response for case ${caseId}`);
    }
    const triage: TriageResult = JSON.parse(text.text);

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

    return triage;
  },
  { connection },
);

triageWorker.on("failed", (job, err) => {
  console.error(`triage failed for case ${job?.data.caseId}:`, err.message);
});

console.log("triage worker listening");
