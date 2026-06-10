# Architecture

## System overview

```
                ┌──────────────┐
 consumer ────▶ │  Next.js app │
                └──────┬───────┘
                       │ HTTPS
                ┌──────▼───────┐      ┌──────────────┐
                │ Fastify API  │─────▶│   Postgres   │  cases, companies,
                └──────┬───────┘      │   (Prisma)   │  messages, events
                       │ enqueue      └──────────────┘
                ┌──────▼───────┐
                │ Redis/BullMQ │  queues: triage, outreach, followup, escalation
                └──────┬───────┘
        ┌──────────────┼────────────────────┐
 ┌──────▼─────┐ ┌──────▼───────┐ ┌──────────▼────────┐
 │ Triage     │ │ Outreach     │ │ SLA / Escalation  │
 │ worker     │ │ worker       │ │ scheduler         │
 │ (Claude)   │ │ (email out)  │ │ (repeatable jobs) │
 └────────────┘ └──────────────┘ └───────────────────┘
```

One Postgres database is the source of truth. Everything asynchronous goes through BullMQ so AI calls, outbound email, and SLA timers never block the API. Every state change is appended to the `CaseEvent` timeline — the timeline *is* the case history, and it's what consumers see.

## Case lifecycle

```
INTAKE → TRIAGED → SENT → AWAITING_COMPANY ⇄ NEGOTIATING → RESOLVED → CLOSED
                                  │
                                  └→ ESCALATED (next contact tier / regulator path)
```

State transitions are only performed by workers and recorded as events. The SLA scheduler watches `AWAITING_COMPANY` cases: no company response within the SLA window → automatic follow-up; repeated silence → escalate one tier up the company's contact ladder.

## AI pipeline

All model calls go through one module with prompt caching (stable system prompt cached with `cache_control: {type: "ephemeral"}`, volatile case content after the cache breakpoint).

| Stage | What it does | Model | Output |
|---|---|---|---|
| **Triage** | Classify category + severity, extract company, desired outcome, dollar value; flag safety/legal issues | `claude-opus-4-8` | Structured JSON (`output_config.format` with a strict schema — guaranteed parseable) |
| **First-contact drafting** | Draft the initial demand/complaint email in the consumer's voice, citing relevant consumer-protection framing | `claude-opus-4-8` | Draft + consumer approval gate |
| **Reply analysis** | Parse company responses: offer? refusal? stall? request for info? | `claude-opus-4-8` | Structured JSON → drives state machine |
| **Negotiation** | Counter-offers and follow-ups against the consumer's stated acceptable outcome | `claude-opus-4-8` | Draft + approval gate above a value threshold |
| **Outcome scoring** | Label closed cases (outcome type, value recovered, days-to-resolution) for the learning loop | Batch API (50% cost) | Training labels |

Cost notes for later tiering (current pricing, per 1M tokens): Opus 4.8 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5. We start everything on Opus 4.8 for quality; once evals exist (workstream 5), high-volume low-risk stages (triage classification, reply parsing) are candidates to move down-tier — that's an eval-gated decision, not a default.

Key API details baked into the scaffold:
- **Structured outputs** via `output_config: {format: {type: "json_schema", schema}}` — no regex parsing of model text, ever.
- **Adaptive thinking** (`thinking: {type: "adaptive"}`) on triage and negotiation.
- **Prompt caching** on the system prompt (it's large: taxonomy + policy + examples).
- **Batch API** for nightly outcome labeling and eval runs.

## Company graph

`Company` rows accumulate **contact points** (support email, escalation alias, executive relations, regulator) each with an observed resolution rate and median response time per category. Routing picks the contact point that maximizes expected resolution for this case. Cold-start companies (the lollipop-soda shop) get a discovery pass: domain lookup → published support address → fall back to asking the consumer.

## Trust, safety, consent

- The platform sends on the consumer's behalf only with explicit per-case authorization (recorded as a `CaseEvent`).
- PII is redacted before any text enters model-training or eval datasets.
- Safety-flagged categories (threats, medical harm, ongoing fraud) bypass automation and route to a human queue.
- Drafts above a configurable dollar threshold, and anything legal-adjacent, require consumer approval before sending.

## What's deliberately not here yet

Company-side dashboard (companies will want to resolve in-platform once volume exists), voice intake, payments/refund rails, and the consumer mobile app. The walking skeleton proves the loop: file → triage → contact → resolve.
