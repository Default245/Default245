// Single entrypoint for all queue consumers. The API process stays free of
// workers; this process does everything asynchronous.
import { triageWorker } from "./triage/worker.js";
import { outreachWorker } from "./outreach/worker.js";
import { replyWorker } from "./replies/worker.js";
import { slaWorker, startSlaScheduler } from "./sla/scheduler.js";

await startSlaScheduler();

console.log("workers up: triage, outreach, replies, sla");

async function shutdown() {
  await Promise.all([
    triageWorker.close(),
    outreachWorker.close(),
    replyWorker.close(),
    slaWorker.close(),
  ]);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
