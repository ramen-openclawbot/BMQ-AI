# vnagent-data-admin

Owner-only HTTP endpoint behind the VNAgent data-assets admin page
(`/data-admin` on BMQ hosts; `admin.banhmique.vn` primary, `admin.vnagent.ai`
alias).

- Feature flag: `VNAGENT_DATA_ADMIN_ENABLED === "true"` (default off, fails closed).
- Auth: caller bearer token is verified, then `user_roles` is read under the
  caller's own RLS; the `owner` role is required. The handler re-checks the role.
- No service-role client: dataset reads/writes use the caller-scoped Supabase
  client, so RLS (owner-only) is the final authority.
- CORS allow-list (exact match, no suffix/prefix): `admin.banhmique.vn`,
  `admin.vnagent.ai`, `ai.banhmique.vn`, local dev origins.
- Language: **English by default**. With no `language` body field and no
  Vietnamese `Accept-Language`, error messages are English. A caller can still
  opt into Vietnamese with `language: "vi"` or `Accept-Language: vi`. The
  generated Markdown export is always English. Captured question/answer/evidence
  content is returned verbatim and is never translated.

## Actions (POST JSON `{ action, language?, ... }`)

| Action | Body | Result |
| --- | --- | --- |
| `overview` | — | `{ status, overview }` real dataset metrics (stages, growth, reviewed denominator, unknown) |
| `assets` | `stage?, source_kind?, evaluation_status?, search?, limit 1..100, offset` | `{ status, assets, total, filters }` |
| `asset` | `asset_id` | `{ status, asset }` or 404 |
| `contribute` | `question, source_kind (contributor\|synthetic), source_designation (manual\|llm_generated), expected_intent?, expected_filters?, provenance?, snapshot_at?` | `{ status: created\|duplicate, asset, duplicate }`; dedupe by normalized question + source kind |
| `transition` | `asset_id, expected_version, to_stage, reason?, verified?` | `{ status, asset }`; Gold requires `verified { intent, conditions, evidence[] }`; `409 version_conflict` on stale version |
| `jev` | `limit 1..200` | `{ status, events }` bounded route telemetry |
| `export` | `stage?, source_kind?, from?, to?, limit 1..200` | `{ status, markdown, count, truncated, filters }` escaped, permission-checked |
| `generate` | `topic (supported id\|mixed), count 20..50, target_language (vi\|en), budget_usd, style_mix?, seed_ids?, idempotency_key?` | `{ status: ok\|in_progress\|abandoned, resumed, job, results, assets? }` one bounded paid batch |
| `generate_status` | `job_id?` | `{ status, job }` or `{ status, jobs }` owner's durable runs |

Note: the transport `language` field selects admin UI copy; the generated question
language is the independent `target_language` field, so changing the admin copy can
never change a batch.

Errors: `{ error, code }` with stable codes
(`forbidden`, `version_conflict`, `gold_intent_required`, `gold_conditions_required`,
`gold_evidence_required`, `invalid_transition`, `store_unavailable`, `rate_limited`,
`generation_disabled`, `generation_cost_unbounded`, `generation_budget_exceeded`,
`generation_busy`, `generation_invalid_output`, `generation_duplicate_output`, …).

## Generate Data (owner-only, default off)

`generate` runs ONE bounded batch of 20–50 synthetic evaluation questions from the
supported BMQ business definitions in `generation.ts` and the curated **built-in
example** questions shipped in reviewed source. Those examples are explicitly
labelled as NOT owner-approved: real owner approval exists only on Curated/Gold
dataset assets. It never invents a business definition.

- Flag: `VNAGENT_GENERATE_ENABLED === "true"` **and** `DEEPSEEK_API_KEY` present;
  otherwise the action is `generation_disabled` (fail closed). The caller bearer
  token is never the model credential, and the Jev/Vercel Gateway key
  (`AI_GATEWAY_API_KEY`) is **not** a fallback: a missing DeepSeek key must not
  silently spend through another provider.
- Provider: DeepSeek's official OpenAI-compatible API,
  `https://api.deepseek.com/chat/completions`, with `stream: false`,
  `response_format: { type: "json_object" }` (DeepSeek JSON Output guarantees valid
  JSON but **not** a schema; the exact contract is enforced in code),
  `thinking: { type: "disabled" }` (DeepSeek enables thinking by default and its
  reasoning tokens would eat the bounded `max_tokens`) and `max_tokens` set to the
  same output token bound used for the cost estimate. Default model:
  `deepseek-flash` (DeepSeek-V4.1-Flash); `deepseek-v4-pro` is also priced and can
  be selected with `VNAGENT_GENERATE_MODEL`.
- Hard budget: pricing comes from the reviewed **official DeepSeek price list**
  (`generation-pricing.ts`), using the conservative **peak** cache-miss input and
  peak output rates, with an honest `pricing` provenance recorded on every asset
  (URLs + captured snapshot). A complete explicit
  `VNAGENT_GENERATE_INPUT_USD_PER_1K` / `VNAGENT_GENERATE_OUTPUT_USD_PER_1K`
  override is honoured but labelled `env_override`; if neither exists the action is
  `generation_cost_unbounded` and no call is made. The worst case is measured from
  the ACTUAL serialized request body (UTF-8 bytes bound the input tokens) and the
  output bound; `budget_usd < worst_case` is refused. DeepSeek reports no dollar
  cost, so the actual cost is computed from the usage tokens it DOES report
  (cache-miss input + cache-hit input + output) at the same reviewed prices.
  Unknown usage stays `null`, never a fabricated 0.
- Retention: no DeepSeek retention guarantee is asserted. The reviewed official
  docs do not state one, so none is claimed and no ZDR parameter is sent (the
  Gateway-only `providerOptions.gateway.zeroDataRetention` payload was removed for
  this lane).
- Durable job: `vnagent_generation_jobs` (owner-only RLS, no direct writes) is
  created before the call and finished after it. Uniqueness on
  `(tenant, created_by, idempotency_key)` makes a retry read the existing job; a
  same-key retry with a different contract is `idempotency_conflict` (409), never a
  silent reuse. An owner-scoped advisory lock plus a partial unique index on the
  live `running` row makes a concurrent double dispatch impossible; an expired lease
  is reaped to `failed` and surfaced as `abandoned`. No scheduled/background worker.
- Output contract: the model schema has no stage/evaluation/truth field; every
  item is validated (style↔expected routing, no fabricated money, no duplicates,
  exact count) or the whole batch is refused. Accepted items are inserted as `raw`
  `synthetic` / `llm_generated` only, with provenance `model`, `promptVersion`,
  `runId`, `seedIds`, `topic`, `style`, `pricing` and `inputTokenBound`.
  Curated/Gold review is unchanged.
- Not used to train a model; no auto-Gold and no fine-tune path.

## Server-side invariants

- Stage moves are one step only (`raw → curated → gold`, or one step down with a
  reason) and are recorded in `vnagent_data_asset_events`.
- `Gold` requires verified intent, explicit conditions and at least one piece of
  evidence, with `reviewer_id` set to the authenticated owner (never null).
- Concurrency uses `expected_version` (`409 version_conflict` on mismatch).
- Duplicate contributions return the existing asset instead of creating another.
- Export rows are escaped (`|`, newlines, backticks, `<`/`>`), scoped and bounded.
- Generation is owner-gated, cost-bounded and idempotent; it writes only `raw`
  `synthetic` / `llm_generated` assets with run provenance.

## Local checks

```bash
node --test apps/web/supabase/functions/vnagent-data-admin/data-assets.test.ts
node --test apps/web/supabase/functions/vnagent-data-admin/handler.test.ts
node --test apps/web/supabase/functions/vnagent-data-admin/generation.test.ts
node --test apps/web/supabase/functions/vnagent-data-admin/generation-client.test.ts
node apps/web/scripts/qa_vnagent_data_admin_contract.mjs
PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node apps/web/scripts/qa_vnagent_data_admin_ui.mjs
```
