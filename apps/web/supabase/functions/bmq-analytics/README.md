# BMQ hybrid analytics — owner pilot

Implementation approval: owner approved hybrid plan on 2026-09-09. Baseline
`491b2685`, branch `feat/bmq-hybrid-analytics-20260909`. Owner approved build, commit/push and owner-pilot deployment on 2026-09-09.
Release checks: production build, 28 tests, 9 legacy contracts, Deno check and
390/1440 browser fixtures passed. A signed, expiring synthetic probe executed
from the Supabase protected environment returned HTTP 200, completed, exact
`gpt-5.6-luna`, 37 input / 12 output tokens. Probe was deleted immediately.
No Gateway/adapter restart or business-data mutation is needed.

## Flow

`BMQ widget → Supabase user JWT → owner check → canonical match / Luna plan → strict DSL → fixed read tools under caller RLS → formatter / Luna explanation`

This endpoint does not call OpenClaw or the universal adapter. No shared agent
configuration changes. All model calls are `gpt-5.6-luna`, `reasoning.effort=none`,
`store=false`, strict Responses JSON schema, max 1,200 output tokens/call.
No fallback to another model. Model documentation verified at
https://developers.openai.com/api/docs/models/gpt-5.6-luna (2026-09-09 ICT).

## Pilot business contract

| Metric | Meaning | Dimensions |
| --- | --- | --- |
| controlled_revenue | Approved gross ledger amounts from controlled/trusted documents; not net/audited revenue | channel, date |
| purchase_order_count | Purchase orders by order_date, all statuses; not sales orders | status, date |
| low_stock_count | Current inventory_items below/equal minimum; excludes specialist warehouse ledgers | category |
| supplier_debt | Current unpaid/partial requests less allocations, clamped per request; not NPP receivables | payment_method |

References: RevenueManagementDashboard.fetchAllRevenueLines, useReportStats,
useInventory. Metadata schema and owner SELECT policies were read-only verified
against the linked BMQ Supabase project; no actual customer/finance rows were
retrieved during this implementation. Real owner JWT-based queries and canonical-screen reconciliation remain
to be verified in an authenticated owner session; no owner login is impersonated.

DSL: one metric, compatible dimension/null, exact start/end dates, limit 1–20,
sort asc/desc. No SQL/table/tenant/user/filter fields accepted. At most 366 days;
snapshot metrics only today in Vietnam. Entity filters, net margin, sales counts,
computed conditions and historical snapshots are unsupported: planner must
abstain rather than invent definitions. Any selected URL page filters cause a
deterministic clarification, never a global replacement total. In-page state not
represented by URLs is not a source of truth for this pilot.

## Lanes / limits

- Fast: exact full-utterance registry, no model. Disabled for follow-ups with history
  to avoid dropping prior scope. Four example prompts are shown in the widget.
- Semantic: one Luna planning call → one validated query → deterministic text.
- Agentic pilot: one bounded plan (up to 4 validated queries) → one optional Luna
  explanation. This is not an iterative autonomous agent. All initial queries
  validate before any data read; explanations are labelled advisory/observational.
- 20-second server abort signal covers auth, body, model and database fetches.
- Reads use exact-count 500-row pagination with a 10,000-row/query aggregate
  budget; fail on caps, count drift, duplicate rows or invalid numeric data.
- No primary DB writes; no schema migration; no pre-aggregations yet. Multi-page
  reads are not a transaction snapshot; concurrent value-only edits can still
  yield mixed read times. This is not audited or month-end reporting.
- At most 20 returned groups/query; bounded labels/results before model/cache.
- 15-second, 128-entry isolate-local result cache keyed by deployment (business),
  verified user/owner policy, canonical query including sort, semantic version
  and TTL bucket. This is bounded staleness, NOT data-version invalidation.
  Auth/owner is rechecked before every lookup; no stale-on-error response.
- Request logs contain request ID, user ID, canonical DSL, lane, model, elapsed
  time, cache hits and actual token counts; no raw question, answer, credential or
  financial values. Existing Edge logs are the pilot telemetry store, not a new
  persistent evaluation/feedback warehouse. No cost figures/SLA claimed.
- Per-isolate 20/minute + one-in-flight/user guard. Distributed rate limiting is
  required before expanding beyond owner pilot.

## Frontend / compatibility

`VITE_BMQ_ANALYTICS_ENABLED=true` selects the pilot. Otherwise existing adapter,
session picker, chat history and current UI contracts are unchanged.
The analytics timeline is explicitly temporary (refresh/logout clears it), kept
while closing/reopening, isolated on account change. Last 6 messages, 2,000 chars
each are sent as untrusted context. New request lock prevents double send; errors
restore drafts; stale replies after logout are discarded. Auto-grow retained.
No arbitrary rendering of model HTML.

## Local verification

```sh
node --test apps/web/supabase/functions/bmq-analytics/core.test.ts apps/web/supabase/functions/bmq-analytics/data.test.ts apps/web/src/lib/bmqAnalytics.test.ts
npx deno check apps/web/supabase/functions/bmq-analytics/index.ts
```

28 focused tests pass. Existing widget contract script: 9/9 pass. Scoped frontend
ESLint passes. App-wide typecheck still has pre-existing unrelated errors; no
changed frontend file errors. Actual widget fixture at 390/1440 widths, flag on
and off: duplicate lock, autogrow, page/history, filter sanitization, error
guidance/draft recovery, close/reopen, logout/late response, account isolation and
no adapter request pass. Evidence is in workspace
`generated/bmq-hybrid-analytics-20260909/`. Physical Safari not tested.

## Approval-gated rollout

1. Owner approval for build/commit/push/deploy was received on 2026-09-09.
2. Recheck origin/main and production baseline; resolve only scoped changes.
3. Build and publish exact source to Git. Deploy `bmq-analytics` disabled first;
   `verify_jwt=false` is intentional for ES256, own `auth.getUser` + owner check
   are mandatory. Verify unauthenticated 401, nonowner 403 and owner-disabled 503.
4. Remote secret-name inventory already contains OPENAI_API_KEY (value never
   read); existing OPENAI_MODEL is deliberately ignored. No new key requested.
   Verify a synthetic Luna request using the deployed protected environment;
   failure must block activation, not select a different model.
5. Only then enable backend BMQ_ANALYTICS_ENABLED and frontend
   VITE_BMQ_ANALYTICS_ENABLED for owner pilot. Verify exact domain assets and
   authenticated queries against canonical screen totals, restricted-user denial,
   errors, token telemetry and Safari responsiveness.
6. Rollback frontend flag to false restores legacy chat; backend flag false stops
   analytics/model calls. No database rollback or adapter restart needed.

Remaining roadmap (not delivered/claimed): entity filter DSL, broader governed
metrics, persisted analytics conversations, shared invalidation/distributed quotas,
materialized marts, gold-set model eval, feedback/promotion registry and iterative
budgeted agent orchestration. Expand only after pilot evidence.

## Local-first warehouse bridge (default off)

`BMQ_WAREHOUSE_ENABLED=true` switches authenticated analytics requests to the warehouse/knowledge lane. Default remains the deployed four-metric Supabase pilot. `BMQ_WAREHOUSE_URL` is a **server-only HTTPS origin**, without path/query/credentials. It must reach the local Python API through an operator-configured TLS endpoint; the database is never exposed. Redirects are forbidden. No browser controls this URL. API independently verifies the forwarded owner JWT and derives the BMQ tenant from server configuration.

Deploy `bmq-data-sources` alongside analytics when approved. It uses the same owner verification and warehouse flag. POST actions: `status`, `sources`, `ingest`, `document`. UTF-8 file content is bounded to 1 MiB, request to 2 MiB. CSV/JSON uploads require source/entity/filename/content; MD/TXT documents require source/title/filename/content. Source write operations are explicit user uploads; chat query tools remain read-only. No PDF/Office parsing or arbitrary URL fetching.

Chat fetches the semantic catalog at runtime, so business definitions remain in Python semantic configuration. Exact today-revenue/order queries are deterministic; flexible queries use Luna structured planning, at most four warehouse reads and two total Luna calls. Unsupported page filters abstain. Knowledge results are limited to five source chunks; answers include validated citation IDs/title/source/date and never use documentation as authoritative current numerical facts. Empty retrieval and unavailable local storage do not silently fall back to fabricated answers or the old business totals.

No new cloud endpoint, secret, live data upload, deployment, or production flag has been activated by adding this code. A reachable TLS bridge and authenticated end-to-end owner verification are required before enabling it. Local CLI ingestion/query works independently of this optional online bridge.

## BMQ raw connection v2 (2026-09-09)
- Python catalog for BMQ exposes four named operational metrics only: non-test submitted dealer order count/value and submitted kiosk report count/channel amount. Atomic raw publication is queried read-only with bounded SQL, Vietnam dates, no personal columns, 30-minute freshness guard and snapshot provenance.
- Existing controlled revenue, PO count, low stock and supplier debt keep their original RLS queries. Generic uploaded `revenue` is not relabelled as BMQ revenue. No ledger/channel double counting.
- Owner activation check: while normal warehouse routing remains OFF, ask `Kiểm tra kết nối kho` / `Check warehouse connection` with page filters cleared. Same authenticated owner JWT passes Edge and warehouse auth, executes today's dealer count, returns watermark. No model or source write; successful checks log event `bmq_warehouse_owner_check` without question/data/token.
- Enable normal `BMQ_WAREHOUSE_ENABLED` only after the actual owner check succeeds. Prior deployment authorization persists. No backup/training/model change. Missing/stale snapshot is not zero and no stale fallback is used.
