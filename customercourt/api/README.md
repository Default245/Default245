# API scaffold

The walking skeleton: file a case over HTTP → BullMQ triage worker calls Claude with a strict output schema → structured triage lands on the case and its timeline.

## Run it

```bash
cp .env.example .env          # add your ANTHROPIC_API_KEY
docker compose up -d          # postgres + redis
npm install
npm run db:migrate            # creates schema, generates Prisma client
npm run dev                   # API on :3001
npm run worker                # triage worker (separate terminal)
```

## Try it

```bash
# File a complaint
curl -s -X POST localhost:3001/v1/cases \
  -H 'content-type: application/json' \
  -d '{
    "email": "jane@example.com",
    "complaint": "Comcast has charged me $30/mo for a modem I returned in March. Two support calls, both promised a refund, nothing happened. I want the $120 back."
  }'

# Watch triage land on the timeline (a few seconds later)
curl -s localhost:3001/v1/cases/<id> | jq '.status, .category, .severity, .desiredOutcome'
```

Expected: status `TRIAGED`, category `billing`, a concrete desired outcome ("refund of $120"), and a `triage.completed` event with the full structured result.
