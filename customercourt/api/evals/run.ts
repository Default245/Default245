/**
 * Eval harness for CustomerCourt's two Claude pipeline stages: intake triage
 * and company-reply analysis. This is the regression gate for any change to
 * the prompts (src/triage/prompt.ts, src/replies/analysis.ts), the output
 * schemas, or the model in src/lib/claude.ts — run it before and after such
 * changes and compare.
 *
 * How to run:
 *   ANTHROPIC_API_KEY=sk-ant-... npm run eval
 *
 * Cost: ~32 calls to claude-opus-4-8 (18 triage + 14 reply examples), short
 * prompts — roughly a dollar or two per run at current Opus pricing.
 *
 * Pass/fail: exits 1 if triage category accuracy < 0.85, reply_type accuracy
 * < 0.85, or there is ANY safety_flag miss (safety misses are never
 * acceptable — they decide whether a case routes to a human).
 *
 * Imports the production prompts/schemas directly (not copies), so the eval
 * always exercises exactly what ships. Do NOT import any worker.ts here —
 * those start BullMQ consumers on import.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { structuredCall } from "../src/lib/claude.js";
import { TRIAGE_SYSTEM } from "../src/triage/prompt.js";
import { TRIAGE_SCHEMA, type TriageResult } from "../src/triage/schema.js";
import {
  REPLY_SCHEMA,
  REPLY_SYSTEM,
  type ReplyAnalysis,
} from "../src/replies/analysis.js";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "golden");
const CONCURRENCY = 4;
const CATEGORY_THRESHOLD = 0.85;
const REPLY_TYPE_THRESHOLD = 0.85;

// ---------------------------------------------------------------------------
// Golden-file row shapes
// ---------------------------------------------------------------------------

interface TriageGolden {
  id: string;
  complaint: string;
  expected: {
    category: string;
    severity: string;
    safety_flag: boolean;
    company_known: boolean;
    has_value: boolean;
  };
}

interface ReplyGolden {
  id: string;
  case_summary: string;
  desired_outcome: string;
  reply_body: string;
  expected: {
    reply_type: string;
    meets_desired_outcome: boolean;
    has_offer_value: boolean;
  };
}

function loadJsonl<T>(filename: string): T[] {
  const raw = readFileSync(join(GOLDEN_DIR, filename), "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

// ---------------------------------------------------------------------------
// Scoring plumbing
// ---------------------------------------------------------------------------

interface Miss {
  id: string;
  field: string;
  expected: unknown;
  got: unknown;
}

interface ItemError {
  id: string;
  error: string;
}

class Scorecard {
  readonly stats = new Map<string, { correct: number; total: number }>();
  readonly misses: Miss[] = [];
  readonly errors: ItemError[] = [];

  check(id: string, field: string, expected: unknown, got: unknown): void {
    const stat = this.stats.get(field) ?? { correct: 0, total: 0 };
    stat.total += 1;
    if (expected === got) {
      stat.correct += 1;
    } else {
      this.misses.push({ id, field, expected, got });
    }
    this.stats.set(field, stat);
  }

  // An API failure counts against every field of that item so a flaky run
  // can't silently pass; it is reported separately from real mismatches.
  fail(id: string, fields: string[], error: unknown): void {
    this.errors.push({ id, error: error instanceof Error ? error.message : String(error) });
    for (const field of fields) {
      const stat = this.stats.get(field) ?? { correct: 0, total: 0 };
      stat.total += 1;
      this.stats.set(field, stat);
    }
  }

  accuracy(field: string): number {
    const stat = this.stats.get(field);
    if (!stat || stat.total === 0) return 0;
    return stat.correct / stat.total;
  }
}

// Simple promise pool: at most `limit` tasks in flight. `fn` must not throw
// (per-item errors are handled inside), so one 529 never kills the run.
async function pool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i]!);
      }
    },
  );
  await Promise.all(lanes);
}

// ---------------------------------------------------------------------------
// Triage eval
// ---------------------------------------------------------------------------

const TRIAGE_FIELDS = [
  "triage.category",
  "triage.severity",
  "triage.safety_flag",
  "triage.company_known",
  "triage.has_value",
];

async function runTriage(card: Scorecard): Promise<void> {
  const examples = loadJsonl<TriageGolden>("triage.jsonl");
  console.log(`Running ${examples.length} triage examples...`);

  await pool(examples, CONCURRENCY, async (ex) => {
    let result: TriageResult;
    try {
      result = await structuredCall<TriageResult>({
        system: TRIAGE_SYSTEM,
        user: ex.complaint,
        schema: TRIAGE_SCHEMA,
      });
    } catch (err) {
      card.fail(ex.id, TRIAGE_FIELDS, err);
      return;
    }
    card.check(ex.id, "triage.category", ex.expected.category, result.category);
    card.check(ex.id, "triage.severity", ex.expected.severity, result.severity);
    card.check(ex.id, "triage.safety_flag", ex.expected.safety_flag, result.safety_flag);
    card.check(ex.id, "triage.company_known", ex.expected.company_known, result.company_name !== null);
    card.check(ex.id, "triage.has_value", ex.expected.has_value, result.estimated_value_cents !== null);
  });
}

// ---------------------------------------------------------------------------
// Reply-analysis eval
// ---------------------------------------------------------------------------

const REPLY_FIELDS = [
  "reply.reply_type",
  "reply.meets_desired_outcome",
  "reply.has_offer_value",
];

async function runReplies(card: Scorecard): Promise<void> {
  const examples = loadJsonl<ReplyGolden>("replies.jsonl");
  console.log(`Running ${examples.length} reply-analysis examples...`);

  await pool(examples, CONCURRENCY, async (ex) => {
    let result: ReplyAnalysis;
    try {
      result = await structuredCall<ReplyAnalysis>({
        system: REPLY_SYSTEM,
        schema: REPLY_SCHEMA,
        // Mirror src/replies/worker.ts exactly (subject-less variant).
        user: [
          `Case summary: ${ex.case_summary}`,
          `Consumer's desired outcome: ${ex.desired_outcome}`,
          `Company reply:\n${ex.reply_body}`,
        ].join("\n\n"),
      });
    } catch (err) {
      card.fail(ex.id, REPLY_FIELDS, err);
      return;
    }
    card.check(ex.id, "reply.reply_type", ex.expected.reply_type, result.reply_type);
    card.check(ex.id, "reply.meets_desired_outcome", ex.expected.meets_desired_outcome, result.meets_desired_outcome);
    card.check(ex.id, "reply.has_offer_value", ex.expected.has_offer_value, result.offer_value_cents !== null);
  });
}

// ---------------------------------------------------------------------------
// Reporting + gate
// ---------------------------------------------------------------------------

function report(card: Scorecard): number {
  console.log("\n=== Per-field accuracy ===");
  const rows = [...TRIAGE_FIELDS, ...REPLY_FIELDS].map((field) => {
    const stat = card.stats.get(field) ?? { correct: 0, total: 0 };
    return {
      field,
      correct: stat.correct,
      total: stat.total,
      accuracy: stat.total === 0 ? "n/a" : (stat.correct / stat.total).toFixed(3),
    };
  });
  console.table(rows);

  if (card.errors.length > 0) {
    console.log("=== API errors (item marked failed, run continued) ===");
    for (const e of card.errors) {
      console.log(`  ${e.id}: ${e.error}`);
    }
    console.log("");
  }

  if (card.misses.length > 0) {
    console.log("=== Misses ===");
    for (const m of card.misses) {
      console.log(
        `  ${m.id} [${m.field}] expected=${JSON.stringify(m.expected)} got=${JSON.stringify(m.got)}`,
      );
    }
    console.log("");
  }

  const categoryAcc = card.accuracy("triage.category");
  const replyTypeAcc = card.accuracy("reply.reply_type");
  const safetyMisses = card.misses.filter((m) => m.field === "triage.safety_flag");

  const failures: string[] = [];
  if (categoryAcc < CATEGORY_THRESHOLD) {
    failures.push(
      `triage category accuracy ${categoryAcc.toFixed(3)} < ${CATEGORY_THRESHOLD}`,
    );
  }
  if (replyTypeAcc < REPLY_TYPE_THRESHOLD) {
    failures.push(
      `reply_type accuracy ${replyTypeAcc.toFixed(3)} < ${REPLY_TYPE_THRESHOLD}`,
    );
  }
  if (safetyMisses.length > 0) {
    failures.push(
      `${safetyMisses.length} safety_flag miss(es) [${safetyMisses.map((m) => m.id).join(", ")}] — safety misses are never acceptable`,
    );
  }

  if (failures.length > 0) {
    console.log(`FAIL: ${failures.join("; ")}`);
    return 1;
  }
  console.log(
    `PASS: category=${categoryAcc.toFixed(3)}, reply_type=${replyTypeAcc.toFixed(3)}, safety_flag misses=0`,
  );
  return 0;
}

async function main(): Promise<void> {
  const card = new Scorecard();
  await runTriage(card);
  await runReplies(card);
  process.exitCode = report(card);
}

main().catch((err) => {
  console.error("eval run crashed:", err);
  process.exitCode = 1;
});
