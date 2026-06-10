# ML Engineering Workstreams (team of five)

Each workstream is owned by one engineer end-to-end (models, prompts, evals, serving). Workstream 5 is the shared platform everyone else builds on — staff it first.

## 1. Intake & Triage

Turn free-text complaints into structured cases.

- Category + severity classification (taxonomy in `api/src/triage/schema.ts` is v0)
- Entity extraction: company, product, order IDs, dollar amounts, dates
- Company matching/disambiguation ("Comcast" vs "Xfinity" vs a typo'd local shop)
- Safety/legal flagging (threats, medical harm, fraud-in-progress → human queue)
- **Metric:** triage accuracy vs. human labels; % of cases needing manual re-triage

## 2. Resolution Drafting & Negotiation

The agent that actually talks to companies.

- First-contact drafting in the consumer's voice with the right firmness level
- Reply understanding: classify company responses (offer / refusal / stall / info request)
- Counter-offer strategy against the consumer's stated acceptable-outcome floor
- Tool use: case timeline lookup, company policy retrieval, consumer-approval gate
- **Metric:** resolution rate and recovered value per case vs. consumer-handled baseline

## 3. Company Graph & Routing

Know who to contact at every company on earth, and which contact actually resolves things.

- Contact-point discovery (domains, published support channels, regulator registries)
- Dedup/merge of company entities; subsidiary and brand mapping
- Learned routing: per-company, per-category resolution rate and response time
- Cold-start strategy for long-tail businesses
- **Metric:** first-contact deliverability; routing lift over naive "support@" baseline

## 4. Outcome Prediction & Escalation

Decide what each case is worth pursuing and when to change tactics.

- Resolution-likelihood and expected-value prediction at intake (sets effort budget)
- SLA tuning: per-company response-time models drive follow-up timing
- Escalation policy: when to climb the contact ladder, when to hand the consumer the chargeback/regulator/small-claims package
- **Metric:** median time-to-resolution; % of stalled cases revived by escalation

## 5. Evals, Safety & Data Platform

The substrate. Without this, workstreams 1–4 are vibes.

- Eval harness: golden sets per pipeline stage, regression gates on prompt/model changes
- Labeling pipeline: Batch API for nightly outcome labeling of closed cases
- Prompt/version management and structured-output schema registry
- PII redaction before anything enters datasets; consent and audit logging
- Model-tiering experiments (Opus 4.8 → Sonnet/Haiku where evals say quality holds)
- **Metric:** eval coverage per stage; time from prompt change to validated deploy

## Sequencing

**Weeks 1–4:** 5 builds the eval skeleton; 1 ships triage v1 (the scaffold's worker) and starts the golden set; 3 seeds the company graph from public directories. **Weeks 5–8:** 2 ships first-contact drafting behind a consumer-approval gate; 4 ships static SLA timers. **After first 1,000 cases:** 3 and 4 switch from heuristics to learned models on real outcome data.
