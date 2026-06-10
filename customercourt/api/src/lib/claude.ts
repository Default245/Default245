import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// One call shape for every pipeline stage: stable cached system prompt,
// volatile case content in the user turn, response constrained to a strict
// JSON schema so it's guaranteed to parse.
export async function structuredCall<T>(opts: {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}): Promise<T> {
  const response = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: opts.maxTokens ?? 2048,
    thinking: { type: "adaptive" },
    system: [
      { type: "text", text: opts.system, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: opts.user }],
    output_config: {
      format: { type: "json_schema", schema: opts.schema },
    },
  });

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("structuredCall: no text block in response");
  }
  return JSON.parse(text.text) as T;
}
