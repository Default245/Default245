import { Queue } from "bullmq";

export const connection = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
};

export const QUEUES = {
  triage: "triage",
  outreach: "outreach",
  replies: "replies",
  sla: "sla",
} as const;

// Case-loop policy knobs. Env-overridable so ops can tune without a deploy.
export const SLA_HOURS = Number(process.env.SLA_HOURS ?? 72);
export const MAX_FOLLOWUPS = Number(process.env.MAX_FOLLOWUPS ?? 2);

export interface TriageJob {
  caseId: string;
}

export interface OutreachJob {
  caseId: string;
  kind: "first_contact" | "followup";
}

export interface ReplyJob {
  caseId: string;
  messageId: string;
}

export const triageQueue = new Queue<TriageJob>(QUEUES.triage, { connection });
export const outreachQueue = new Queue<OutreachJob>(QUEUES.outreach, {
  connection,
});
export const replyQueue = new Queue<ReplyJob>(QUEUES.replies, { connection });
export const slaQueue = new Queue(QUEUES.sla, { connection });
