import { Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";

// Prefer REDIS_URL (managed Redis like Upstash on Fly hands out a single
// rediss:// URL); fall back to host/port for local docker-compose.
function redisConnection(): ConnectionOptions {
  const url = process.env.REDIS_URL;
  if (url) {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: Number(u.port || 6379),
      username: u.username || undefined,
      password: u.password || undefined,
      ...(u.protocol === "rediss:" ? { tls: {} } : {}),
    };
  }
  return {
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
  };
}

export const connection = redisConnection();

export const QUEUES = {
  triage: "triage",
  outreach: "outreach",
  replies: "replies",
  sla: "sla",
  negotiation: "negotiation",
  escalation: "escalation",
  outcomes: "outcomes",
  verification: "verification",
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

export interface NegotiationJob {
  caseId: string;
  replyMessageId: string;
  // Full analysis from the replies worker, so negotiation doesn't re-read
  // the event timeline to find it.
  analysis: {
    reply_type: string;
    summary: string;
    offer_value_cents: number | null;
    meets_desired_outcome: boolean;
    recommended_next_step: string;
  };
}

export interface EscalationJob {
  caseId: string;
}

export interface OutcomeJob {
  caseId: string;
}

export interface VerificationJob {
  caseId: string;
}

export const triageQueue = new Queue<TriageJob>(QUEUES.triage, { connection });
export const outreachQueue = new Queue<OutreachJob>(QUEUES.outreach, {
  connection,
});
export const replyQueue = new Queue<ReplyJob>(QUEUES.replies, { connection });
export const slaQueue = new Queue(QUEUES.sla, { connection });
export const negotiationQueue = new Queue<NegotiationJob>(QUEUES.negotiation, {
  connection,
});
export const escalationQueue = new Queue<EscalationJob>(QUEUES.escalation, {
  connection,
});
export const outcomesQueue = new Queue<OutcomeJob>(QUEUES.outcomes, {
  connection,
});
export const verificationQueue = new Queue<VerificationJob>(
  QUEUES.verification,
  { connection },
);
