// Bank-account integration port: verifies that promised money (refund,
// credit) actually landed in the consumer's account, so resolutions are
// confirmed against transactions instead of taking anyone's word for it.
//
// Provider: Stripe Financial Connections. Consumers link their bank through
// the Stripe-hosted flow (see src/routes/bank.ts); verification then searches
// posted transactions on the linked account for a credit matching the
// promised amount.

import type Stripe from "stripe";
import { maybeStripe } from "./stripe.js";

export interface DepositQuery {
  // Provider-specific linked-account reference (Stripe: fca_...). Null when
  // the consumer hasn't linked a bank account.
  accountRef: string | null;
  amountCents: number;
  since: Date;
}

export interface DepositResult {
  found: boolean;
  transactionRef: string | null;
}

export interface BankProvider {
  readonly name: string;
  findDeposit(query: DepositQuery): Promise<DepositResult>;
}

// Default when Stripe isn't configured: reports "not found" so resolutions
// stay unverified rather than falsely verified.
export class StubBankProvider implements BankProvider {
  readonly name = "stub";

  async findDeposit(_query: DepositQuery): Promise<DepositResult> {
    return { found: false, transactionRef: null };
  }
}

// How many transactions to scan before giving up. Refunds land within weeks
// of a case opening; a deposit older than the scan window is out of scope.
const MAX_SCANNED_TRANSACTIONS = 500;

export class StripeBankProvider implements BankProvider {
  readonly name = "stripe";

  constructor(private readonly stripe: Stripe) {}

  async findDeposit(query: DepositQuery): Promise<DepositResult> {
    if (!query.accountRef) return { found: false, transactionRef: null };

    const sinceEpoch = Math.floor(query.since.getTime() / 1000);
    let scanned = 0;

    // Financial Connections transactions: amount is in minor units, credits
    // to the account are positive. We want a posted credit for the promised
    // amount, transacted after the case opened.
    for await (const tx of this.stripe.financialConnections.transactions.list({
      account: query.accountRef,
      limit: 100,
    })) {
      if (++scanned > MAX_SCANNED_TRANSACTIONS) break;
      if (
        tx.status === "posted" &&
        tx.amount === query.amountCents &&
        tx.transacted_at >= sinceEpoch
      ) {
        return { found: true, transactionRef: tx.id };
      }
    }
    return { found: false, transactionRef: null };
  }
}

export function bankProvider(): BankProvider {
  const stripe = maybeStripe();
  return stripe ? new StripeBankProvider(stripe) : new StubBankProvider();
}
