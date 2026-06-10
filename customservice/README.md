# CustomService (CS)

**A universal contact point between consumers and companies — every complaint gets driven to a resolution.**

Whether the complaint is against Comcast or Sears or the corner lollipop-soda shop, the platform takes the case, finds the right contact point at the company, and works it until there's an outcome. Consumers get one place to file anything; companies get one structured, deduplicated channel instead of scattered angry emails; and the platform acts as the consumer's authorized third-party representative throughout.

## The core promise

1. **Any complaint, any company.** No company directory entry required to file — the platform discovers and maintains contact points (support email, escalation desk, executive relations, regulators) as cases flow through.
2. **A resolution, not a ticket.** Every case ends in an explicit outcome: refund, replacement, credit, apology, policy exception, or a documented dead end with the next escalation path (chargeback, regulator, small claims) handed to the consumer.
3. **Positive-outcome bias.** The system is measured on resolution rate, time-to-resolution, and consumer-reported satisfaction — not on case throughput.

## How a case flows

```
File → Triage (AI) → Route → Contact company → Negotiate / follow up → Escalate if stalled → Resolve → Score outcome
```

- **File** — consumer describes the problem in plain language (web form first; email and voice later).
- **Triage** — Claude classifies category and severity, extracts the company, desired outcome, and dollar value, and drafts the first contact.
- **Route** — the company graph picks the contact point with the best historical resolution rate for this company + category.
- **Drive** — automated follow-ups on an SLA clock; stalled cases escalate up the contact ladder.
- **Resolve** — outcome recorded, consumer confirms, and the result feeds back into routing and outcome-prediction models.

## Repo layout

| Path | What it is |
|---|---|
| `docs/architecture.md` | System design: services, data model, AI pipeline, SLA engine |
| `docs/ml-workstreams.md` | The five ML engineering workstreams and how they split the problem |
| `api/` | Runnable scaffold: Fastify API + BullMQ triage worker + Prisma schema |

## Stack

Fastify · BullMQ · Postgres · Prisma · Redis · Anthropic (Claude Opus 4.8 for triage and drafting) · Next.js (consumer app, not yet scaffolded)

## Status

Design stage. The scaffold in `api/` is the walking skeleton: file a case over HTTP, watch it get AI-triaged through the queue, and read the structured triage back off the case timeline.
