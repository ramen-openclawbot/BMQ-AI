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

## U1 business answer presentation (local, release pending)

The authenticated handler now formats structured warehouse/customer/live-query facts through `presentation.ts`. Main answers contain the business label, period/customer and formatted values. Original definitions, raw amounts, sources, snapshot time and model interpretation remain in expandable `provenance.details`; selection hints and permissions are unchanged. The explicit owner connectivity diagnostic remains a diagnostic.

Vietnamese uses VND with dot grouping and no fractional dong (`51.225.132 ₫`). English converts VND amounts to an indicative USD value using the current public ExchangeRate-API USD feed; this is display-only, not a historical/accounting rate. Original VND values remain available in details. Other source currencies are not relabelled. Counts and percentages never trigger FX. Knowledge answers do not undergo numeric text replacement.

`money.ts` requests only `https://open.er-api.com/v6/latest/USD`, with no auth, BMQ data, user text or dynamic URL. The feed updates daily; isolate-local cache refreshes hourly, caps source age at 48h and uses a 2.5s timeout/64KB response limit. Invalid/stale/unavailable rates fall back explicitly to VND, never a guessed USD value. Provider attribution, timestamp and exact rate are exposed in details. No extra secret or scheduler required. Reference: https://www.exchangerate-api.com/docs/free (attribution required, caching allowed).

Local verification: `node --experimental-strip-types --test apps/web/supabase/functions/bmq-analytics/*.test.ts` from repo root. Release still requires the owner's next-turn confirmation, backend before UI, plus live owner verification. No build/commit/push/deploy was performed for U1.

## Cost classification lane (local, release pending)

Owner-scoped expense/cost-classification questions are routed to a bounded read-only
cost lane instead of the generic metric DSL, which cannot express a review-status or
line-detail filter. Supported questions: month totals by category and review status,
pending review count/amount, largest pending lines with supplier/document, two-month
category comparison, unmapped/low-confidence lines, why one line was classified that
way (with the stored rule/alias link metadata, never an invented reason or a claim that
the current rule state caused the historical result), and last sync freshness. The lane
mirrors all four arms of the canonical `cost_classification_line_details` view
(classified plus OCR-only payment request/invoice lines, never double counted); a cost
answer is not restricted to classified rows and the answer disclaimer says so.

Routing keeps the exact qualifiers: an explicit month (`MM/YYYY`), an exact category
code (for example `OPEX_GENERAL`) or its canonical Vietnamese label (for example "bánh
mì" -> `COGS_BMQ_BREAD`), an explicit review status for month totals/comparison
(`approved`, `suggested`, `rejected`, or pending), and an exact classification/source
line id are passed through unchanged. A missing month, missing line reference or
unrecognised cost question clarifies, and qualifiers this lane cannot express (staff,
department, bank, route, project, an arbitrary day, foreign currency, supplier filters,
future months, mixed statuses) abstain with zero warehouse numeric calls. An "all
statuses" question is not narrowed to the pending branch just because it mentions cần
review. Cost answers are never taken from documents, no arbitrary SQL or tenant
selection is possible, and the cost catalog must be present or the lane abstains rather
than answering an unrelated total. The lane requires the warehouse `/v1/cost` contract;
`warehouseClient` allowlists that path. Frontend summary pending money uses the same
exact per-`review_status` amounts, not a row-count ratio, and a status with a count but
no recorded amount is flagged unknown rather than shown as an exact zero.

Local verification for this lane: `node --experimental-strip-types --test
apps/web/supabase/functions/bmq-analytics/cost.test.ts` (17 tests) plus the Python
`tests/test_bmq_cost.py` (41 tests) and the coordinator's independent
`generated/cost-classification/coordinator/test_parity.py` (2 probes). Deno type check
was not run in this environment (no Deno binary); behavior is covered by the
type-stripped Node tests.

## Conversation context and example→evidence (local, release pending)

Approved phases 1+2 add a bounded, non-authoritative conversation state for the cost
lane and a deterministic "example line → real line ref → stored evidence" workflow.
Everything is default-off and rollbackable:

- backend `BMQ_CHAT_CONTEXT_ENABLED` (default false) — off ignores any state hint and
  keeps the previous routing.
- backend `BMQ_CHAT_CONTEXT_SECRET` — dedicated server-side signing secret, provisioned
  by the coordinator (never committed/generated/logged). When it is absent or shorter
  than 32 characters the context stays disabled (fail closed) even if the flag is true.
  The key is never the caller bearer token or any client-known value.
- frontend `VITE_BMQ_CHAT_CONTEXT_ENABLED` (default false) — off never stores or
  echoes `provenance.costContext`.
- Activate backend first, then the frontend flag; both off restores the old flow with
  no migration and no Gateway restart.

The state (`context.ts`) carries only the previous scope (month/category/review status),
one selected line ref and the observed snapshot id. It is HMAC-signed with the server
secret, bound to the authenticated `user` id and to the current `conversationId` carried
in the request body, TTL-limited to 15 minutes, validates `exp > iat` and real `01..12`
months, and is only read from the immediately preceding assistant message; a history
mixing two conversation ids is rejected, and a token refresh keeps the same user id so a
conversation is not lost. Every follow-up is re-resolved through the closed cost grammar
and re-read from the current snapshot, so the state can never widen scope or serve an
arbitrary row as truth. Scope priority is explicit new intent > validated conversation >
page route, and a changed month/category/status drops the selected line.

Route filters are read only from the explicit allow-list for the real finance cost route
(`/finance-control/classification`). The page keeps month/category/status in component
state rather than the URL, so no cost-route URL filter is source-verified: the allow-list
is intentionally empty and every page filter fails closed instead of being dropped.

Explicit "tất cả nhóm"/"tất cả trạng thái" clears the inherited category/status (stored
as null, never sent as an unsupported field). `pending_summary`/`top_pending_lines`
always mean `needs_review` and never carry a review status the question rejects.

The deterministic example workflow uses the Python `example_line` question (fixed SQL,
ordered by exact `line_amount` desc, then source date, then classification id; the rule is
disclosed in the answer), then reads evidence for the exact chosen `classification_id`.
The evidence read must observe the same snapshot id as the pick; a mismatch re-reads once
and otherwise publishes the picked row without mixed evidence. `provenance.queries`
includes both the pick and the explanation call. An explicitly named new line ref
overrides the stored selection, and a planner-proposed ref must appear in the current
question or match the validated selection, so old prose cannot resurrect a stale id.
Missing rule/alias metadata is reported as unavailable, never invented. The lane issues
no model call and no write, and totals stay exact.

Local verification: `context.test.ts` (23 orchestration/state-safety tests),
`handler.test.ts` (5 end-to-end `createHandler` fixture-auth + real warehouse-call
contract probes), `cost.test.ts`, Python `tests/test_bmq_cost.py` (46), the golden eval
(renamed to a deterministic fixture expectation match rate — not real LLM accuracy,
tokens/cost unmeasured), and the WebKit fixture-auth widget QA (320/390/1440
populated/empty/error/reset/long + 44px reset target + EN label, flags on and off).
`tsc -p generated/tsc-edge/tsconfig.json` (strict) type-checks the changed Edge
functions with 0 errors; no Deno binary is available, so no Deno check was run; no
production activation, deploy or owner login was performed.

## Selective Jev semantic planner (local trial, default off)

Owner approved a **LOCAL-ONLY** trial of Jev as a selective semantic planner on
2026-09-20 (coordinator review notes folded in on the same date). No build, commit,
push, deploy, paid provider request or BMQ data transfer was performed. Contract
reference (verified 2026-09-20, AI Gateway shape):
https://vercel.com/docs/ai-gateway/modalities/evaluation

`BMQ_JEV_ENABLED` (default false) enables one fixed, direct HTTPS call to
`https://ai-gateway.vercel.sh/v1/evaluate` with model `typesafe-ai/jev`, no SDK,
`redirect: "error"`, `providerOptions.gateway.zeroDataRetention: true` and
`only: ["typesafe-ai"]`. The server-only `AI_GATEWAY_API_KEY` is the only credential;
the caller bearer token is never read or forwarded. When the flag is on but the key is
absent, Jev is skipped (fail closed) and the planner is unchanged.
`BMQ_JEV_KILL_SWITCH=true` is an independent immediate kill switch that forces Jev off
even while the rollout flag is on.

### Exact rules first, then one bounded semantic request

The fast lane, cost lane, customer lane, validated conversation continuation, example
workflow and UNC/image lane all run first. The Jev branch is reached only for a first
turn with no page filters and an empty `history`. The signed-context **capability**
being enabled (`contextEnabled`: production always supplies the server secret, the user
id and a conversation id) is not an active inbound context, so it does not disable Jev;
`core.Input` stores any signed/structured context only inside `history`, and a non-empty
history skips Jev. Inside the branch an anchored deterministic bounded rule is applied
before any provider call. The old trial computed a metric+period with a regex and asked
Jev to confirm a known answer; that oracle is gone.

1. **Deterministic exact bounded rules.** `matchExactBounded` recognises the anchored
   3-metric x 6-period utterances (for example `số đơn đại lý tuần trước`,
   `dealer ordered value last month`, `kiosk report count this month`) and answers them
   with no Jev call. It is active only when the trial flag is on, so the flag-off
   pipeline keeps its previous planner behavior. The same function is benchmark lane B.
2. **Conservative eligibility screen** (`screenBoundedQuestion`) is a rejection gate
   only — it never returns a metric or a period. It refuses comparison/trend/causal
   wording, filters and dimensions (branch/store/customer/status/channel/category/
   district/`riêng`/`only`/`unique`), a unit/quantity or product reading
   (`số lượng`, `quantity`, `units`, `bánh`, `product`, `mặt hàng`, … — the operational
   measures count submitted orders/reports, not product quantities), negation or
   exception, a different date basis (delivered/received/created/invoice), a rolling or
   accumulated range (`tính đến`, `so far`, `since`, `kỳ trước`, `ngày mai`), more than
   one relative period, an absolute date/month/quarter/year, a currency conversion,
   revenue/sales/profit/debt/cost/payment vocabulary, the documentation/customer/image
   lanes, prompt injection, an over-long utterance and any utterance with no
   bounded-domain cue.
3. **One batched request** with three independent `choice` questions over the same
   bounded utterance — never history, catalog rows, financial values, SQL, generated
   dates or the caller JWT. Each question is self-contained (an independent question
   cannot see the others):
   - `metric`: `dealer_order_count`, `dealer_order_value`, `kiosk_report_count`,
     `none`, `unsupported`;
   - `period`: `today`, `yesterday`, `this_week`, `previous_week`, `this_month`,
     `previous_month`, `not_stated`;
   - `support`: `supported_unqualified`, `unsupported`, `not_stated` — the model must
     reject any extra condition rather than let code silently discard it.
4. **Code composes** the three answers. A plan is used only when support is
   `supported_unqualified`, the metric is one of the three bounded metrics present in
   the live catalog, the period is one of the six, and every used answer is the unique
   top of a finite, normalised distribution above the provisional floor
   (`JEV_PROBABILITY_THRESHOLD = 0.6`, explicitly uncalibrated). `none`, `not_stated`,
   `unsupported`, an unknown value, an absent catalog metric, a low probability, a
   malformed body, an HTTP error, a 429, a timeout, an expired deadline and an open
   circuit all return null, and the caller runs the unchanged Luna planner with the
   exact original input. Parent cancellation is propagated and never becomes a fallback.

Business definitions are stated in the registry and prompts: dealer count/value are
**non-test submitted** dealer orders counted by submitted date in Vietnam time, not
delivered orders, not units, not revenue or collections; kiosk report count is counted
by **report date**, not a created/submitted timestamp. A different date basis or a
currency-converted amount is unsupported.

### Bounds, reliability and telemetry

The provider deadline is bound to the remaining server budget (`deadlineAt`, derived
from the existing 20s request abort) and hard-capped independently; one call, one
deadline, no retries and no extra serialized provider calls. A short per-isolate
circuit breaker opens after three consecutive provider failures and skips Jev for a 30s
cooldown, then probes once. The 2500 ms body deadline covers a stalled stream and
cleanup never awaits a provider `cancel()` promise. The response is validated
exhaustively (exact `model`, exactly the three answer keys, `choice` type, exact
probability key sets, finite 0..1 values, a uniquely top choice per question, a
normalised distribution, numeric usage). `JEV_PROMPT_VERSION` and
`JEV_REGISTRY_VERSION` are reported in `provenance.jev` and the audit event, together
with the chosen metric/period/support, per-answer top probabilities, threshold, screen
reason, circuit state, Gateway-reported cost, separate Jev tokens and per-stage
wall-clock timings. The audit never logs the question, provider body, key or business
rows, and the `jev` field remains absent when the flag is off.

### Benchmark harness (opt-in, hard-capped, sanitized)

`jev-dataset.ts` is a synthetic, versioned `tune`/`holdout` labelled set (37 cases; no
real BMQ data). `jev-benchmark.ts` compares three lanes case-by-case, interleaved so a
budget stop cannot favour a lane:

- **A** the existing warehouse pipeline (deterministic routes then the Luna planner)
  with Jev disabled;
- **B** the actual enabled deterministic matcher `matchExactBounded`, not a second
  comparator that could drift;
- **C** the Jev-gated path, scored separately by path (`jev` vs `planner` vs
  `exact_rule`) so an LLM fallback is never credited as a Jev plan.

The synthetic warehouse stub uses the real BMQ operational descriptors and units
(`sme-data-platform/src/sme_platform/bmq_semantic.py`): dealer order count and kiosk
report count are `count`, dealer ordered value is `VND` (non-test submitted orders by
submitted date / submitted reports by report_date), plus the `controlled_revenue` ledger
in `VND`; it is not an all-count catalog. This remains a synthetic-warehouse/subset
figure, not browser or production end-to-end performance.

`BMQ_JEV_BENCH_ENABLED=true` is required before lanes A and C make any real provider
call. The request budget is a shared object reserved **before every provider dispatch**
inside the gated fetch used by both the Jev client and the planner model; a failing,
timed-out or erroring attempt still consumes its reservation, so the cap defaults to
and is hard-limited at 60 and cannot be disabled by a NaN. Every attempt, including a
failed or timed-out provider call, contributes its real wall-clock latency (never 0),
so failures remain visible in p50/p95. The report includes the explicit paired subset
where every requested lane produced a non-skipped, non-error result. Cost is split:
`cost.jev` is the summed Gateway-reported Jev cost (null when unknown or unused) and
`cost.planner` is null because the planner does not report per-request cost, so
`cost.total` is null (unknown) when only the Jev part is known — a partial Jev figure is
never labelled the total pipeline cost. Run it with `jev-benchmark-cli.ts`; the free
dry-run artifact at `generated/jev-semantic/benchmark-dry-run.json` shows lane B =
29/37 = 0.784 on the synthetic set.

Local verification: 196 analytics tests pass (`node --experimental-strip-types --test
apps/web/supabase/functions/bmq-analytics/*.test.ts`): `jev.test.ts` 30,
`jev-benchmark.test.ts` 14, `handler.test.ts` 11, plus the untouched existing suite. All
provider calls are mocked through an injected fetcher. The coordinator independently
verified **217/217** tests (196 analytics + 21 reviewer tests) after the repair.
Final `deno check --cached-only` with the existing Deno 2.9.6 binary passes for the
Edge entrypoint and Jev/benchmark modules (including transitive dependencies).
The worker's Deno 1.30.3 limitation report does not describe the coordinator runtime;
see `generated/jev-semantic/coordinator/final-deno.log`. A free
screen-only probe of the coordinator's `holdout.json`
(`generated/jev-semantic/screen-holdout-probe.json`) deterministically rejects **all 26**
negative cases via the screen (including `reviewer-20`,
`Số lượng bánh mà đại lý đặt tháng trước`, now refused as `units_or_quantity`); the 6
positive paraphrases all pass the screen and none is exact-matched, so they genuinely
require the semantic model. A permanent regression (`jev.test.ts`, plus the
production-shaped handler test) proves that a real first turn with the context capability
enabled — secret, user and conversation id present, `history: []` — still uses
model-selected Jev and the exact rules, while a genuine follow-up history still skips
Jev. No live provider request, measured Jev accuracy, latency gain or cost figure is
claimed. Evidence: `generated/jev-semantic/`.

## Honest limitation (read before any paid trial)

The screen, the anchored exact rules and the bounded registry keep Jev inside a closed
3x6 answer space, and the validator/composition reject detected unsupported conditions. This does not
guarantee that the model detects every qualifier. It is still unmeasured: the
probability floor is provisional and not calibrated on BMQ data, the labelled set is
synthetic, and no real comparison of lanes A/B/C exists yet. The flag stays off until
the coordinator runs the opt-in benchmark on an approved dataset, compares accuracy,
p50/p95, token cost and failure modes, and confirms no qualifier or permission is lost.
