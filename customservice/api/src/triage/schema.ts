// Triage output contract. This JSON schema is sent to the API via
// output_config.format, so the model's response is guaranteed to parse
// against it — no defensive parsing needed downstream.
// Structured-output rules: every object needs additionalProperties: false,
// and no numeric/string min-max constraints.

export const CATEGORIES = [
  "billing",
  "refund",
  "delivery",
  "service_quality",
  "product_defect",
  "warranty",
  "cancellation",
  "account_access",
  "safety",
  "other",
] as const;

export const SEVERITIES = ["low", "medium", "high", "urgent"] as const;

export interface TriageResult {
  category: (typeof CATEGORIES)[number];
  severity: (typeof SEVERITIES)[number];
  summary: string;
  company_name: string | null;
  desired_outcome: string;
  estimated_value_cents: number | null;
  safety_flag: boolean;
  recommended_first_action: string;
}

export const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...CATEGORIES] },
    severity: { type: "string", enum: [...SEVERITIES] },
    summary: {
      type: "string",
      description: "One-sentence neutral summary of the complaint",
    },
    company_name: {
      type: ["string", "null"],
      description: "The company the complaint is against, or null if unclear",
    },
    desired_outcome: {
      type: "string",
      description:
        "What the consumer wants, in concrete terms (e.g. 'full refund of $54.99')",
    },
    estimated_value_cents: {
      type: ["integer", "null"],
      description: "Dollar value at stake in cents, or null if non-monetary",
    },
    safety_flag: {
      type: "boolean",
      description:
        "True if the complaint involves threats, medical harm, or fraud in progress — routes to a human",
    },
    recommended_first_action: {
      type: "string",
      description: "The single next step the platform should take",
    },
  },
  required: [
    "category",
    "severity",
    "summary",
    "company_name",
    "desired_outcome",
    "estimated_value_cents",
    "safety_flag",
    "recommended_first_action",
  ],
  additionalProperties: false,
} as const;
