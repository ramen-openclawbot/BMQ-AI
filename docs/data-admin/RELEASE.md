# VNAgent data assets admin — local release preparation

Status: **LOCAL ONLY — not applied, not deployed.** Nothing below has been run
against production in this task.

## 1. Migration

File: `apps/web/supabase/migrations/20260920120000_vnagent_data_assets.sql`

Apply order: single forward migration. It creates four tables, six reviewed
functions (evidence helper, transition, contribution, trusted capture, metrics,
daily timeseries) and owner-only RLS with **no** direct authenticated writes. On a
linked project use a reviewed, transaction-wrapped apply, not a blind `db push`
(this repo has prior migration-history drift):

```bash
# review only — do not run as part of the local implementation task
supabase db diff --linked
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f apps/web/supabase/migrations/20260920120000_vnagent_data_assets.sql
```

Pre-flight checks after apply:

```sql
select tablename, rowsecurity from pg_tables
 where schemaname = 'public' and tablename like 'vnagent_%';
select policyname, cmd, roles from pg_policies where tablename like 'vnagent_%';
-- every vnagent table must show only a SELECT grant for authenticated
select table_name, privilege_type from information_schema.role_table_grants
 where grantee = 'authenticated' and table_name like 'vnagent_%';
select public.vnagent_data_admin_metrics(current_date);  -- must run only as owner
select public.vnagent_data_admin_timeseries(30);         -- must run only as owner
```

Local regression (already run against an isolated PostgreSQL 17/18-compatible
engine): `apps/web/scripts/qa_vnagent_data_admin_sql.sh` asserts the privilege
model and then attempts the raw authenticated INSERT/UPDATE/write probes, failing if
any of them succeeds.

### Rollback

Forward-only migrations are the house style; the migration header carries the
rollback block. On a reviewed, backed-up database:

```sql
drop function if exists public.vnagent_data_admin_timeseries(integer);
drop function if exists public.vnagent_data_admin_metrics(date);
drop function if exists public.vnagent_capture_chat(jsonb, jsonb);
drop function if exists public.vnagent_create_data_asset(text, text, text, jsonb, jsonb, jsonb, timestamptz, text);
drop function if exists public.vnagent_transition_data_asset(uuid, integer, text, text, jsonb);
drop function if exists public.vnagent_evidence_is_meaningful(jsonb);
drop table if exists public.vnagent_jev_events;
drop table if exists public.vnagent_data_asset_events;
drop table if exists public.vnagent_data_assets;
drop table if exists public.vnagent_interactions;
```

Rollback loses captured interactions and the dataset — export first if needed.

## 2. Edge function

File tree: `apps/web/supabase/functions/vnagent-data-admin/**`

```bash
supabase functions deploy vnagent-data-admin
```

- Keep the existing edge JWT convention for this project: the caller's ES256 user
  token reaches the function and is re-verified in code, so `verify_jwt = false`
  may be needed in `supabase/config.toml` (same reason documented for
  `scan-invoice`, `material-learning-suggest`, `bmq-analytics`). That config edit
  is **not** included here.
- Required env: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (provided by the platform),
  `VNAGENT_DATA_ADMIN_ENABLED=true` to enable the admin, and
  `VNAGENT_CAPTURE_ENABLED=true` (shared project secret) to switch on analytics
  capture. Both flags are default OFF; the overview reports the capture flag so an
  empty dataset is never confused with a running pipeline.
- The BMQ analytics capture calls the atomic `vnagent_capture_chat` RPC and needs
  `SUPABASE_SERVICE_ROLE_KEY`. Capture runs under a separate bounded deadline and
  never changes the business reply; a failure is audited
  (`bmq_interaction_capture_failed`).

## 3. Future `admin.vnagent.ai` domain prerequisites

The SPA already handles the hostname (`App.tsx` title, `AppRoutes.tsx` owner-only
route tree). To go live:

1. DNS: `admin.vnagent.ai` → the same Vercel project as `ai.banhmique.vn`.
2. Vercel: add the custom domain to the `bmq-ai` project.
3. Supabase Auth → URL configuration: add `https://admin.vnagent.ai/**` to the
   redirect allow-list, otherwise the `/auth` login callback on the new host
   fails. `AuthContext`/`OwnerRoute` are reused unchanged.
4. Verify the CORS allow-list in `vnagent-data-admin/index.ts` covers the origin
   (it already includes `https://admin.vnagent.ai`).
5. Confirm the owner's `user_roles` row is `owner`; non-owners are denied by both
   `OwnerRoute` and the server-side check.

## 4. Post-deploy verification (owner session)

- `/data-admin` on an existing BMQ host shows the sidebar and real counts.
- A non-owner account is denied (redirect) and the edge function returns 403.
- A real analytics chat question appears once in the interaction dataset, with the
  same `requestId` **and** an initial `raw` dataset asset with the same question,
  original answer and executed filters; repeating the request does not duplicate.
- Two different real error events produce two distinct interaction rows.
- A direct authenticated `insert`/`update` against `vnagent_data_assets`,
  `vnagent_data_asset_events` or `vnagent_jev_events` is rejected (permission
  denied), and the audit trail stays empty for a rejected write.
- A Gold transition without intent/conditions/**meaningful** evidence is rejected;
  `[null]` and `[""]` are rejected; with a real reviewer it succeeds and bumps the
  version once.
- A stale `expected_version` returns `version_conflict`.
- The daily chart shows a real 7/30/90 series with the stock/new toggle and source
  contribution counts; an empty range shows zeros, not a placeholder curve.
- Export with a `|`/`<script>` in a question produces escaped Markdown, applies the
  date filters before the limit and reports the correct total/truncation; a single
  selected case exports its original answer, executed filters, Gold semantics and
  evidence.
- Jev panel shows real metric/period/support probabilities, versions, cost, usage
  and timings without any question text; unknown cost/tokens render as "—", not 0.

## 5. Generate Data (owner-only synthetic batches)

Migration: `apps/web/supabase/migrations/20260921100000_vnagent_generation_jobs.sql`
(one table, three SECURITY DEFINER routines, owner-only SELECT, no direct writes).
Apply it with the same reviewed, transaction-wrapped method as the base migration:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f apps/web/supabase/migrations/20260921100000_vnagent_generation_jobs.sql
```

Edge env (all default OFF / fail closed):

- `VNAGENT_GENERATE_ENABLED=true` — switch the action on.
- `DEEPSEEK_API_KEY` — server-only DeepSeek key (never a client value). The
  Jev/Vercel `AI_GATEWAY_API_KEY` is NOT a fallback for generation.
- `VNAGENT_GENERATE_MODEL` — optional; defaults to `deepseek-flash`
  (DeepSeek-V4.1-Flash). `deepseek-v4-pro` is also priced.
- Pricing is the reviewed **official DeepSeek price list** in `generation-pricing.ts`
  (`deepseek-flash`, conservative peak cache-miss input + peak output); no env is
  required for a ready feature.
  `VNAGENT_GENERATE_INPUT_USD_PER_1K` / `VNAGENT_GENERATE_OUTPUT_USD_PER_1K` are an
  OPTIONAL explicit override, recorded as `env_override`; if the model is unknown
  and no override is set the action returns `generation_cost_unbounded` and makes
  no paid call.

Reviewer checklist after apply/deploy:

- A non-owner is denied (403) and never reaches `generate`.
- A direct authenticated `insert`/`update` on `vnagent_generation_jobs` is denied;
  the job row appears only through the RPCs with `created_by = auth.uid()`.
- Pricing comes from the reviewed official DeepSeek price entry for the model; only
  an unknown model with no explicit override fails closed. With a budget below the
  worst case it returns `generation_budget_exceeded` before any call.
- The request goes to `https://api.deepseek.com/chat/completions` with the server
  `DEEPSEEK_API_KEY`, `response_format: { type: "json_object" }`,
  `thinking: { type: "disabled" }` and a bounded `max_tokens`; no
  `providerOptions.gateway.zeroDataRetention` payload is sent and no DeepSeek
  retention guarantee is claimed.
- A 20-question batch creates exactly its accepted rows as `raw` `synthetic` /
  `llm_generated` with `provenance.model`, `promptVersion`, `runId`, `seedIds`,
  `topic`, `style`, `pricing`; the same key does not create a second batch or a
  second paid call, and the same key with a different payload returns
  `generation_idempotency_conflict` (409).
- Two concurrent owner batches: the second returns `generation_busy` (409); the
  partial unique index guarantees at most one live `running` job per owner.
- The Generate panel shows the job status/created counts and Recent runs; an
  uncertain outcome is reconciled with a read of the exact key; an expired lease is
  reported as abandoned on the server clock so the owner can start a new batch. A
  reload restores the exact pending request before any retry.

## 6. Remaining blockers / not verified locally

- The new generation migration was **not applied to production** and no Supabase CLI
  was used. It was reviewed and exercised in an isolated PostgreSQL 18 container
  (fresh apply and re-apply over the interim state); a real PostgreSQL apply remains
  the deployment gate.
- No production deploy, DB apply, commit, push or restart was performed.
- No real paid DeepSeek call was made; `generate` is verified with a mocked DeepSeek
  client only. The earlier Vercel AI Gateway generation attempt was abandoned (its
  live 403 paid-credits probe is preserved as history); this lane does not use the
  Gateway.
- Capture is **not** a blocker: production is proven working (3 interactions /
  3 Raw assets, 2 screenshot-verbatim questions, RPC and service-role grants
  present, capture flag SHA256 matches true). No capture change was made. Earlier
  drafts wrongly claimed a missing capture flag, missing key or unapplied base
  migration; those claims were removed.
