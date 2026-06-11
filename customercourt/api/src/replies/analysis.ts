// Reply-analysis prompt, taxonomy, and schema. Side-effect-free module so
// the eval harness and other workers can import without starting a consumer.

export const REPLY_SYSTEM = `You analyze company responses to consumer complaints for
the CustomerCourt platform. Classify what the company is actually saying —
companies often bury a refusal in polite language or stall with vague
process talk. Be literal about commitments: "we'll look into it" is a stall,
not an offer.`;

export const REPLY_TYPES = [
  "offer", // concrete remedy proposed
  "refusal", // explicit or thinly-veiled no
  "stall", // acknowledgment without commitment
  "info_request", // company needs something from the consumer
  "resolution_confirmation", // company confirms remedy is done/issued
  "other",
] as const;

export interface ReplyAnalysis {
  reply_type: (typeof REPLY_TYPES)[number];
  summary: string;
  offer_value_cents: number | null;
  meets_desired_outcome: boolean;
  recommended_next_step: string;
}

export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    reply_type: { type: "string", enum: [...REPLY_TYPES] },
    summary: {
      type: "string",
      description: "One sentence: what the company is actually saying",
    },
    offer_value_cents: {
      type: ["integer", "null"],
      description: "Value of any concrete offer in cents, null if none",
    },
    meets_desired_outcome: {
      type: "boolean",
      description:
        "Whether the reply fully satisfies the consumer's desired outcome",
    },
    recommended_next_step: { type: "string" },
  },
  required: [
    "reply_type",
    "summary",
    "offer_value_cents",
    "meets_desired_outcome",
    "recommended_next_step",
  ],
  additionalProperties: false,
} as const;
