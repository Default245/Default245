# API scaffold

The full case loop, end to end: file a case → AI triage → AI-drafted first contact (consumer approves) → SLA clock → AI reply analysis → follow-ups and escalation on silence → resolution recorded.

```
POST /v1/cases ──▶ triage worker ──▶ outreach worker (draft)
                                          │
              consumer approves: POST /v1/cases/:id/drafts/:messageId/approve
                                          │ email sent, SLA clock starts
                                          ▼
              company replies: POST /v1/cases/:id/replies ──▶ reply worker
                                          │                    (offer/refusal/stall/…)
              company silent:  SLA sweep ─┴─▶ follow-up ×2 ──▶ ESCALATED
                                          │
              consumer closes: POST /v1/cases/:id/resolve
```

## Run it

```bash
cp .env.example .env          # add your ANTHROPIC_API_KEY
docker compose up -d          # postgres + redis
npm install
npm run db:migrate            # creates schema, generates Prisma client
npm run dev                   # API on :3001
npm run worker                # all queue workers + SLA scheduler (separate terminal)
```

## Walk the loop

```bash
# 1. File a complaint
curl -s -X POST localhost:3001/v1/cases \
  -H 'content-type: application/json' \
  -d '{
    "email": "jane@example.com",
    "complaint": "Comcast has charged me $30/mo for a modem I returned in March. Two support calls, both promised a refund, nothing happened. I want the $120 back."
  }'
# → {"id":"<caseId>","status":"INTAKE"}

# 2. A few seconds later: triage done, first-contact draft waiting for approval
curl -s localhost:3001/v1/cases/<caseId> | jq '.status, .category, .desiredOutcome, (.messages[] | select(.status=="DRAFT") | {id, subject})'

# 3. Approve the draft — email "sends" (stub), SLA clock starts
curl -s -X POST localhost:3001/v1/cases/<caseId>/drafts/<messageId>/approve

# 4. Simulate the company replying
curl -s -X POST localhost:3001/v1/cases/<caseId>/replies \
  -H 'content-type: application/json' \
  -d '{"body": "We apologize for the inconvenience. We can offer a $60 account credit as a goodwill gesture."}'

# 5. Reply analysis lands on the timeline: type "offer", $60, does NOT meet
#    the desired outcome — case moves to NEGOTIATING
curl -s localhost:3001/v1/cases/<caseId> | jq '.status, (.events[] | select(.type=="reply.analyzed") | .payload)'

# 6. Record the final outcome
curl -s -X POST localhost:3001/v1/cases/<caseId>/resolve \
  -H 'content-type: application/json' \
  -d '{"outcome": "REFUND", "valueCents": 12000, "consumerSatisfied": true}'
```

If the company never replies: the SLA sweep (every 5 min; `SLA_SWEEP_MS` to change) sends up to `MAX_FOLLOWUPS` (default 2) increasingly firm follow-ups `SLA_HOURS` (default 72h) apart, then marks the case `ESCALATED`.

## Deploy (Fly.io)

The app deploys to the existing Fly apps (`customercourt`, `customercourt-db`, `customercourt-redis`, region ams). From this directory:

```bash
# One-time: secrets
fly postgres attach customercourt-db -a customercourt   # sets DATABASE_URL
fly secrets set -a customercourt \
  REDIS_URL='rediss://...' \          # from customercourt-redis (Upstash)
  ANTHROPIC_API_KEY='sk-ant-...' \
  STRIPE_SECRET_KEY='sk_live_or_test_...'

# Every deploy: builds the Dockerfile, runs prisma migrate deploy as the
# release command, then rolls api + worker processes
fly deploy
```

`fly.toml` defines two process groups: `api` (HTTP, health-checked on `/healthz`, can auto-stop) and `worker` (queues + SLA scheduler — pinned on, because a sleeping worker means follow-ups silently stop). Scale with `fly scale count api=2 worker=2`.

## Layout

| Path | What it does |
|---|---|
| `src/server.ts` + `src/routes/cases.ts` | HTTP API (no queue consumers in this process) |
| `src/worker.ts` | Entrypoint for all queue workers + SLA scheduler |
| `src/triage/` | Complaint → structured case (category, severity, company, ask) |
| `src/outreach/` | Drafts first contact (approval-gated) and follow-ups; ladder routing |
| `src/replies/` | Company reply → offer/refusal/stall/info_request → state machine |
| `src/negotiation/` | Counters lowball offers and refusals; drafts behind the approval gate |
| `src/escalation/` | Climbs the contact ladder; consumer handoff package when it's exhausted |
| `src/sla/` | Repeatable sweep: overdue cases get follow-ups, then escalate |
| `src/graph/` | Resolved cases → contact-point resolution rates and reply latency |
| `src/lib/claude.ts` | One structured-output call shape for every pipeline stage |
| `src/lib/mailer.ts` | Outbound email stub (swap for SES/Postmark/Resend) |
| `evals/` | Golden sets + regression gate: `npm run eval` (~32 calls; fails on category/reply_type accuracy < 0.85 or any safety_flag miss) |
