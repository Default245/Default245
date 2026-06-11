import { Worker } from "bullmq";
import { PrismaClient } from "@prisma/client";
import { connection, QUEUES, type VerificationJob } from "../queues.js";
import { bankProvider } from "../lib/bank.js";

const prisma = new PrismaClient();

// Monetary outcomes worth checking against the consumer's account.
const MONETARY_OUTCOMES = new Set(["REFUND", "CREDIT", "PARTIAL"]);

// Verifies that a resolved case's money actually arrived. With the stub
// provider this records "unverified" honestly; once Lossless is configured
// (LOSSLESS_ENABLED=true + LOSSLESS_API_KEY) it checks real transactions.
export const verificationWorker = new Worker<VerificationJob>(
  QUEUES.verification,
  async (job) => {
    const { caseId } = job.data;
    const kase = await prisma.case.findUniqueOrThrow({
      where: { id: caseId },
      include: { resolution: true, consumer: true },
    });

    const resolution = kase.resolution;
    if (
      !resolution ||
      !MONETARY_OUTCOMES.has(resolution.outcome) ||
      !resolution.valueCents
    ) {
      return { verified: false, reason: "nothing_to_verify" };
    }

    if (!kase.consumer.fcAccountId) {
      await prisma.caseEvent.create({
        data: {
          caseId,
          type: "resolution.unverified",
          payload: { reason: "bank_not_linked" },
        },
      });
      return { verified: false, reason: "bank_not_linked" };
    }

    const provider = bankProvider();
    const result = await provider.findDeposit({
      accountRef: kase.consumer.fcAccountId,
      amountCents: resolution.valueCents,
      since: kase.createdAt,
    });

    if (result.found) {
      await prisma.$transaction([
        prisma.resolution.update({
          where: { id: resolution.id },
          data: {
            verifiedAt: new Date(),
            verificationRef: result.transactionRef,
          },
        }),
        prisma.caseEvent.create({
          data: {
            caseId,
            type: "resolution.verified",
            payload: {
              provider: provider.name,
              transactionRef: result.transactionRef,
              amountCents: resolution.valueCents,
            },
          },
        }),
      ]);
      return { verified: true };
    }

    await prisma.caseEvent.create({
      data: {
        caseId,
        type: "resolution.unverified",
        payload: {
          reason: "deposit_not_found",
          provider: provider.name,
          amountCents: resolution.valueCents,
        },
      },
    });
    return { verified: false, reason: "deposit_not_found" };
  },
  { connection },
);

verificationWorker.on("failed", (job, err) => {
  console.error(
    `verification failed for case ${job?.data.caseId}:`,
    err.message,
  );
});
