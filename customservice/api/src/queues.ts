import { Queue } from "bullmq";

export const connection = {
  host: process.env.REDIS_HOST ?? "localhost",
  port: Number(process.env.REDIS_PORT ?? 6379),
};

export const QUEUES = {
  triage: "triage",
  outreach: "outreach",
  followup: "followup",
} as const;

export interface TriageJob {
  caseId: string;
}

export const triageQueue = new Queue<TriageJob>(QUEUES.triage, { connection });
