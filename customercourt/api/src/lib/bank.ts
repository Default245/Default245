// Bank-account integration port: verifies that promised money (refund,
// credit) actually landed in the consumer's account, so resolutions are
// confirmed against transactions instead of taking anyone's word for it.
//
// Lossless is the intended provider. Its API is not publicly documented, so
// LosslessBankProvider is a skeleton: auth and config are wired (key from
// LOSSLESS_API_KEY env — never in the repo), the request shape is TODO until
// we have the docs. The stub provider keeps the pipeline runnable meanwhile.

export interface DepositQuery {
  consumerEmail: string;
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

// Default until Lossless is configured: reports "not found" so resolutions
// stay unverified rather than falsely verified.
export class StubBankProvider implements BankProvider {
  readonly name = "stub";

  async findDeposit(_query: DepositQuery): Promise<DepositResult> {
    return { found: false, transactionRef: null };
  }
}

export class LosslessBankProvider implements BankProvider {
  readonly name = "lossless";

  constructor(private readonly apiKey: string) {}

  async findDeposit(_query: DepositQuery): Promise<DepositResult> {
    // TODO(lossless-docs): implement against the Lossless API once we have
    // its documentation (base URL, endpoint, auth header, response shape).
    // Until then this provider must not be selected silently.
    throw new Error(
      "LosslessBankProvider: API integration not implemented — awaiting API docs",
    );
  }
}

export function bankProvider(): BankProvider {
  const key = process.env.LOSSLESS_API_KEY;
  if (key && process.env.LOSSLESS_ENABLED === "true") {
    return new LosslessBankProvider(key);
  }
  return new StubBankProvider();
}
