-- VNAgent data assets admin (future admin.vnagent.ai).
--
-- Scope for this migration:
--   * vnagent_interactions      raw analytics-chat interaction capture (SEPARATE
--                               from any business/finance ledger; never a source
--                               of financial truth)
--   * vnagent_data_assets       the evaluation dataset inventory (raw/curated/gold
--                               are stages of the SAME asset, not independent assets)
--   * vnagent_data_asset_events audited, versioned stage transitions
--   * vnagent_jev_events        bounded Jev telemetry using the REAL JevTelemetry
--                               fields from jev.ts (metric/period/support with
--                               probabilities, prompt/registry version, cost,
--                               usage, timings, counts). No question/prompt/keys.
--
-- Security model (hardened):
--   * Row level security is enabled on every table and authenticated callers get
--     SELECT only. There is NO authenticated INSERT/UPDATE/DELETE grant on any
--     table, so a direct REST/SQL write cannot fabricate a stage, version,
--     reviewer, evidence, audit event or operational_chat asset.
--   * Every mutation goes through a reviewed SECURITY DEFINER routine with a
--     fixed search_path and a server-side owner check:
--       - vnagent_create_data_asset()   manual/synthetic contribution (raw only,
--                                       created_by = auth.uid(), reviewer null)
--       - vnagent_transition_data_asset() audited single-step promotion/demotion
--                                       with optimistic version and real reviewer
--       - vnagent_capture_chat()        service-role-only atomic capture of an
--                                       interaction + its initial raw asset + Jev row
--   * The transition audit table is append-only through its routine; no caller
--     (including service_role) holds INSERT/UPDATE/DELETE on it.
--   * BMQ is a single-business deployment: tenant is pinned to 'bmq'. This
--     migration deliberately does not invent a cross-tenant selector.
--
-- Rollback (forward-only migrations; run only on a reviewed, backed-up database):
--   drop function if exists public.vnagent_data_admin_timeseries(integer);
--   drop function if exists public.vnagent_data_admin_metrics(date);
--   drop function if exists public.vnagent_capture_chat(jsonb, jsonb);
--   drop function if exists public.vnagent_create_data_asset(text, text, text, jsonb, jsonb, jsonb, timestamptz, text);
--   drop function if exists public.vnagent_transition_data_asset(uuid, integer, text, text, jsonb);
--   drop function if exists public.vnagent_evidence_is_meaningful(jsonb);
--   drop table if exists public.vnagent_jev_events;
--   drop table if exists public.vnagent_data_asset_events;
--   drop table if exists public.vnagent_data_assets;
--   drop table if exists public.vnagent_interactions;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. vnagent_interactions — raw analytics-chat capture
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.vnagent_interactions (
  id uuid primary key default gen_random_uuid(),
  tenant text not null default 'bmq',
  -- Durable idempotency key: a retried capture of the SAME event can never create
  -- a second row, while every distinct real event keeps its own identity.
  request_id text not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_label text,
  conversation_id text,
  source_route text,
  source_label text,
  -- Question text after secret/context minimization; never an authorization
  -- header, token or credential value.
  question_text text not null,
  -- Bounded, redacted ORIGINAL answer/source observation. Kept separately from
  -- any Gold verified semantics so the reviewer can compare the two.
  answer_text text,
  redaction_applied boolean not null default true,
  -- Actor/tenant-bound context, minimized to bounded keys. Never raw rows,
  -- full conversation history or provider bodies.
  context_summary jsonb not null default '{}'::jsonb,
  understood_intent jsonb not null default '{}'::jsonb,
  -- Page input filters are what the screen SENT (context only). Executed filters
  -- are what the analytics lane actually ran (metric/date/dimensions), captured
  -- from the reviewed provenance rather than inferred from the page.
  page_filters jsonb not null default '{}'::jsonb,
  executed_filters jsonb not null default '{}'::jsonb,
  tool text,
  provenance jsonb not null default '{}'::jsonb,
  response_status text not null,
  response_code text,
  -- Known and unknown usage are stored separately on purpose: an abstained or
  -- failed answer is not mixed into "answered" usage, and unknown numbers stay
  -- null (never fabricated as 0).
  known_usage jsonb not null default '{}'::jsonb,
  unknown_usage jsonb not null default '{}'::jsonb,
  model_route text,
  capture_status text not null default 'captured',
  created_at timestamptz not null default now(),
  retention_expires_at timestamptz not null default (now() + interval '180 days'),
  constraint vnagent_interactions_tenant_check check (tenant = 'bmq'),
  constraint vnagent_interactions_request_unique unique (tenant, request_id),
  constraint vnagent_interactions_response_status_check
    check (response_status in ('success', 'abstained', 'error', 'unknown')),
  constraint vnagent_interactions_capture_status_check
    check (capture_status in ('captured', 'redacted', 'partial')),
  constraint vnagent_interactions_retention_check
    check (retention_expires_at > created_at),
  constraint vnagent_interactions_context_object_check
    check (jsonb_typeof(context_summary) = 'object'),
  constraint vnagent_interactions_provenance_object_check
    check (jsonb_typeof(provenance) = 'object'),
  constraint vnagent_interactions_known_object_check
    check (jsonb_typeof(known_usage) = 'object'),
  constraint vnagent_interactions_unknown_object_check
    check (jsonb_typeof(unknown_usage) = 'object'),
  constraint vnagent_interactions_page_filters_check
    check (jsonb_typeof(page_filters) = 'object'),
  constraint vnagent_interactions_executed_filters_check
    check (jsonb_typeof(executed_filters) = 'object')
);

create index if not exists vnagent_interactions_created_idx
  on public.vnagent_interactions (tenant, created_at desc);
create index if not exists vnagent_interactions_status_idx
  on public.vnagent_interactions (tenant, response_status, created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- 1b. Evidence helper — meaningful Gold evidence only (defined before the table
--     that references it in a CHECK constraint)
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.vnagent_evidence_is_meaningful(p_evidence jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when p_evidence is null or jsonb_typeof(p_evidence) <> 'array' then false
    else not exists (
      select 1
      from jsonb_array_elements(p_evidence) as item
      where item = 'null'::jsonb
        or (jsonb_typeof(item) = 'string' and length(btrim(item #>> '{}')) = 0)
        or (jsonb_typeof(item) = 'object' and item = '{}'::jsonb)
        or (jsonb_typeof(item) = 'array' and item = '[]'::jsonb)
    )
  end
$$;

revoke all on function public.vnagent_evidence_is_meaningful(jsonb) from public, anon;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. vnagent_data_assets — evaluation dataset inventory
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.vnagent_data_assets (
  id uuid primary key default gen_random_uuid(),
  tenant text not null default 'bmq',
  dataset_stage text not null default 'raw',
  source_kind text not null,
  source_designation text,
  interaction_id uuid references public.vnagent_interactions(id) on delete set null,
  -- Final question semantics as accepted into the dataset (not a raw log copy).
  question text not null,
  -- Bounded original answer/observation for reviewer reference only; never the
  -- Gold verified truth.
  source_answer text,
  expected_intent jsonb not null default '{}'::jsonb,
  expected_filters jsonb not null default '{}'::jsonb,
  -- Provenance / snapshot / capture time of the source this asset was derived from.
  provenance jsonb not null default '{}'::jsonb,
  snapshot_at timestamptz,
  -- Stable export date key: the source snapshot time, else the creation time.
  effective_at timestamptz generated always as (coalesce(snapshot_at, created_at)) stored,
  evaluation_status text not null default 'not_evaluated',
  -- Gold-only verified semantics; a real reviewer is required (reviewer_id).
  verified_intent text,
  verified_conditions jsonb,
  evidence jsonb not null default '[]'::jsonb,
  reviewer_id uuid references auth.users(id) on delete set null,
  version integer not null default 1,
  dedupe_key text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vnagent_data_assets_tenant_check check (tenant = 'bmq'),
  constraint vnagent_data_assets_stage_check
    check (dataset_stage in ('raw', 'curated', 'gold')),
  constraint vnagent_data_assets_source_kind_check
    check (source_kind in ('operational_chat', 'contributor', 'synthetic')),
  constraint vnagent_data_assets_designation_check
    check (source_designation is null or source_designation in ('manual', 'llm_generated')),
  constraint vnagent_data_assets_evaluation_check
    check (evaluation_status in ('not_evaluated', 'pending_review', 'verified', 'rejected')),
  constraint vnagent_data_assets_version_check check (version >= 1),
  constraint vnagent_data_assets_source_designation_check
    check (source_kind <> 'contributor' or source_designation is not null),
  -- A Gold asset must carry explicit verified intent, explicit conditions and at
  -- least one MEANINGFUL piece of evidence ([null], [""] and [{}] do not count),
  -- plus a real reviewer identity. Database-level backstop for the server rules.
  constraint vnagent_data_assets_gold_check check (
    dataset_stage <> 'gold' or (
      evaluation_status = 'verified'
      and reviewer_id is not null
      and verified_intent is not null and length(btrim(verified_intent)) > 0
      and verified_conditions is not null and verified_conditions <> 'null'::jsonb
      and jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) > 0
      and public.vnagent_evidence_is_meaningful(evidence)
    )
  ),
  constraint vnagent_data_assets_intent_object_check
    check (jsonb_typeof(expected_intent) = 'object'),
  constraint vnagent_data_assets_filters_object_check
    check (jsonb_typeof(expected_filters) = 'object'),
  constraint vnagent_data_assets_provenance_object_check
    check (jsonb_typeof(provenance) = 'object'),
  constraint vnagent_data_assets_dedupe_unique unique (tenant, dedupe_key)
);

create index if not exists vnagent_data_assets_stage_idx
  on public.vnagent_data_assets (tenant, dataset_stage, updated_at desc);
create index if not exists vnagent_data_assets_review_idx
  on public.vnagent_data_assets (tenant, evaluation_status, updated_at desc);
create index if not exists vnagent_data_assets_kind_idx
  on public.vnagent_data_assets (tenant, source_kind, updated_at desc);
create index if not exists vnagent_data_assets_interaction_idx
  on public.vnagent_data_assets (interaction_id);
create index if not exists vnagent_data_assets_effective_idx
  on public.vnagent_data_assets (tenant, effective_at desc, id);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. vnagent_data_asset_events — audited versioned transitions (append-only)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.vnagent_data_asset_events (
  id uuid primary key default gen_random_uuid(),
  tenant text not null default 'bmq',
  asset_id uuid not null references public.vnagent_data_assets(id) on delete cascade,
  from_stage text not null,
  to_stage text not null,
  from_version integer not null,
  to_version integer not null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_kind text not null default 'owner',
  reason text,
  evidence jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint vnagent_data_asset_events_tenant_check check (tenant = 'bmq'),
  constraint vnagent_data_asset_events_actor_kind_check
    check (actor_kind in ('owner', 'system')),
  constraint vnagent_data_asset_events_stage_check
    check (from_stage in ('raw', 'curated', 'gold') and to_stage in ('raw', 'curated', 'gold')),
  constraint vnagent_data_asset_events_version_check
    check (to_version = from_version + 1),
  constraint vnagent_data_asset_events_evidence_check
    check (jsonb_typeof(evidence) = 'array')
);

create index if not exists vnagent_data_asset_events_asset_idx
  on public.vnagent_data_asset_events (asset_id, created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. vnagent_jev_events — REAL Jev telemetry (JevTelemetry in jev.ts)
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.vnagent_jev_events (
  id uuid primary key default gen_random_uuid(),
  tenant text not null default 'bmq',
  request_id text not null,
  model text,
  prompt_version text,
  registry_version text,
  attempted boolean not null default false,
  decided boolean not null default false,
  screen text,
  circuit text,
  metric text,
  metric_probability numeric,
  period text,
  period_probability numeric,
  support text,
  support_probability numeric,
  threshold numeric,
  fallback text,
  -- Gateway-reported cost in USD when supplied, else null (never fabricated 0).
  cost numeric,
  -- Real JevUsage {input, output}; no invented input/output/cached triple.
  token_counts jsonb not null default '{}'::jsonb,
  -- Real JevTimings {screenMs, evaluateMs, catalogMs, warehouseMs, plannerMs,
  -- narrationMs, totalMs}.
  stage_timings jsonb not null default '{}'::jsonb,
  -- Real JevCounts {warehouseReads, plannerCalls, narrationCalls}.
  counts jsonb not null default '{}'::jsonb,
  decision text,
  created_at timestamptz not null default now(),
  constraint vnagent_jev_events_tenant_check check (tenant = 'bmq'),
  constraint vnagent_jev_events_request_unique unique (tenant, request_id),
  constraint vnagent_jev_events_token_counts_check check (jsonb_typeof(token_counts) = 'object'),
  constraint vnagent_jev_events_timings_check check (jsonb_typeof(stage_timings) = 'object'),
  constraint vnagent_jev_events_counts_check check (jsonb_typeof(counts) = 'object')
);

create index if not exists vnagent_jev_events_created_idx
  on public.vnagent_jev_events (tenant, created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Atomic, audited, optimistic-versioned transition RPC (SECURITY DEFINER)
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.vnagent_transition_data_asset(
  p_asset_id uuid,
  p_expected_version integer,
  p_to_stage text,
  p_reason text default null,
  p_verified jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_asset public.vnagent_data_assets%rowtype;
  v_updated public.vnagent_data_assets%rowtype;
  v_rank integer;
  v_next_rank integer;
  v_next_version integer;
  v_intent text;
  v_conditions jsonb;
  v_evidence jsonb;
  v_eval text;
  v_reviewer uuid;
begin
  -- Server-side owner authorization; never trust a client-supplied role.
  if v_actor is null or not public.has_role(v_actor, 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_to_stage not in ('raw', 'curated', 'gold') then
    raise exception 'invalid_stage' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'invalid_expected_version' using errcode = '22023';
  end if;

  select * into v_asset
  from public.vnagent_data_assets
  where id = p_asset_id and tenant = 'bmq'
  for update;
  if not found then
    raise exception 'asset_not_found' using errcode = 'P0002';
  end if;
  if v_asset.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = '40001';
  end if;

  v_rank := case v_asset.dataset_stage when 'raw' then 0 when 'curated' then 1 else 2 end;
  v_next_rank := case p_to_stage when 'raw' then 0 when 'curated' then 1 else 2 end;

  if v_next_rank = v_rank + 1 then
    null;
  elsif v_next_rank = v_rank - 1 then
    if p_reason is null or length(btrim(p_reason)) = 0 then
      raise exception 'demotion_reason_required' using errcode = '22023';
    end if;
  else
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  if p_to_stage = 'gold' then
    if p_verified is null or jsonb_typeof(p_verified) <> 'object' then
      raise exception 'gold_verification_required' using errcode = '22023';
    end if;
    v_intent := btrim(coalesce(p_verified ->> 'intent', ''));
    if v_intent = '' or length(v_intent) > 2000 then
      raise exception 'gold_intent_required' using errcode = '22023';
    end if;
    v_conditions := p_verified -> 'conditions';
    if v_conditions is null or v_conditions = 'null'::jsonb then
      raise exception 'gold_conditions_required' using errcode = '22023';
    end if;
    v_evidence := p_verified -> 'evidence';
    if v_evidence is null
       or jsonb_typeof(v_evidence) <> 'array'
       or jsonb_array_length(v_evidence) = 0
       or not public.vnagent_evidence_is_meaningful(v_evidence) then
      raise exception 'gold_evidence_required' using errcode = '22023';
    end if;
    v_eval := 'verified';
    -- The reviewer is the authenticated owner performing this transition. It can
    -- never be null, a service account or a client-supplied id.
    v_reviewer := v_actor;
  elsif p_to_stage = 'curated' then
    v_intent := null;
    v_conditions := null;
    v_evidence := '[]'::jsonb;
    v_eval := 'pending_review';
    v_reviewer := null;
  else
    v_intent := null;
    v_conditions := null;
    v_evidence := '[]'::jsonb;
    v_eval := 'not_evaluated';
    v_reviewer := null;
  end if;

  v_next_version := v_asset.version + 1;

  update public.vnagent_data_assets set
    dataset_stage = p_to_stage,
    version = v_next_version,
    evaluation_status = v_eval,
    verified_intent = v_intent,
    verified_conditions = v_conditions,
    evidence = coalesce(v_evidence, '[]'::jsonb),
    reviewer_id = v_reviewer,
    updated_at = now()
  where id = p_asset_id
  returning * into v_updated;

  insert into public.vnagent_data_asset_events (
    asset_id, from_stage, to_stage, from_version, to_version,
    actor_id, actor_kind, reason, evidence
  ) values (
    p_asset_id, v_asset.dataset_stage, p_to_stage, v_asset.version, v_next_version,
    v_actor, 'owner', nullif(btrim(coalesce(p_reason, '')), ''), coalesce(v_evidence, '[]'::jsonb)
  );

  return jsonb_build_object('status', 'ok', 'asset', to_jsonb(v_updated));
end;
$$;

revoke all on function public.vnagent_transition_data_asset(uuid, integer, text, text, jsonb) from public, anon;
grant execute on function public.vnagent_transition_data_asset(uuid, integer, text, text, jsonb) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Manual/synthetic contribution RPC (raw only, server-derived identity)
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.vnagent_create_data_asset(
  p_question text,
  p_source_kind text,
  p_source_designation text,
  p_expected_intent jsonb default '{}'::jsonb,
  p_expected_filters jsonb default '{}'::jsonb,
  p_provenance jsonb default '{}'::jsonb,
  p_snapshot_at timestamptz default null,
  p_dedupe_key text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_question text := btrim(coalesce(p_question, ''));
  v_key text := nullif(btrim(coalesce(p_dedupe_key, '')), '');
  v_created public.vnagent_data_assets%rowtype;
  v_existing public.vnagent_data_assets%rowtype;
begin
  if v_actor is null or not public.has_role(v_actor, 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_question = '' or length(v_question) > 4000 then
    raise exception 'question_required' using errcode = '22023';
  end if;
  -- operational_chat is only ever created by trusted server capture, never by
  -- the manual contribution form.
  if p_source_kind not in ('contributor', 'synthetic') then
    raise exception 'invalid_source_kind' using errcode = '22023';
  end if;
  if p_source_designation not in ('manual', 'llm_generated') then
    raise exception 'invalid_source_designation' using errcode = '22023';
  end if;
  if p_expected_intent is null or jsonb_typeof(p_expected_intent) <> 'object' then
    raise exception 'invalid_expected_intent' using errcode = '22023';
  end if;
  if p_expected_filters is null or jsonb_typeof(p_expected_filters) <> 'object' then
    raise exception 'invalid_expected_filters' using errcode = '22023';
  end if;
  if p_provenance is null or jsonb_typeof(p_provenance) <> 'object' then
    raise exception 'invalid_request' using errcode = '22023';
  end if;

  -- Dedupe by source kind + normalized question + expected scope, so the same
  -- question with a genuinely different expected scope is NOT collapsed.
  if v_key is null then
    v_key := p_source_kind || ':' || md5(
      'bmq|' || p_source_kind || '|' || v_question || '|' ||
      p_expected_intent::text || '|' || p_expected_filters::text
    );
  end if;

  insert into public.vnagent_data_assets (
    tenant, dataset_stage, source_kind, source_designation, question,
    expected_intent, expected_filters, provenance, snapshot_at,
    evaluation_status, version, dedupe_key, created_by
  ) values (
    'bmq', 'raw', p_source_kind, p_source_designation, v_question,
    p_expected_intent, p_expected_filters, p_provenance, p_snapshot_at,
    'not_evaluated', 1, v_key, v_actor
  )
  on conflict (tenant, dedupe_key) do nothing
  returning * into v_created;

  if v_created.id is null then
    select * into v_existing
    from public.vnagent_data_assets
    where tenant = 'bmq' and dedupe_key = v_key;
    if not found then
      raise exception 'create_failed' using errcode = 'P0001';
    end if;
    return jsonb_build_object('status', 'duplicate', 'asset', to_jsonb(v_existing));
  end if;

  return jsonb_build_object('status', 'created', 'asset', to_jsonb(v_created));
end;
$$;

revoke all on function public.vnagent_create_data_asset(text, text, text, jsonb, jsonb, jsonb, timestamptz, text) from public, anon;
grant execute on function public.vnagent_create_data_asset(text, text, text, jsonb, jsonb, jsonb, timestamptz, text) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 8. Trusted server capture RPC — atomic interaction + initial raw asset + Jev
-- ────────────────────────────────────────────────────────────────────────────
-- Called ONLY by the bmq-analytics edge function with the service role. It is a
-- single transaction, so a partial capture is impossible; retries are idempotent
-- on both the interaction request id and the derived asset dedupe key, which
-- means a retry after a previous partial failure still recovers the raw asset.
create or replace function public.vnagent_capture_chat(
  p_interaction jsonb,
  p_jev jsonb default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request text := btrim(coalesce(p_interaction ->> 'request_id', ''));
  v_interaction public.vnagent_interactions%rowtype;
  v_asset_id uuid;
  v_key text;
  v_question text;
  v_intent jsonb;
  v_filters jsonb;
begin
  if p_interaction is null or jsonb_typeof(p_interaction) <> 'object' then
    raise exception 'invalid_interaction' using errcode = '22023';
  end if;
  if v_request = '' then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  insert into public.vnagent_interactions (
    tenant, request_id, actor_id, actor_label, conversation_id,
    source_route, source_label, question_text, answer_text, redaction_applied,
    context_summary, understood_intent, page_filters, executed_filters, tool,
    provenance, response_status, response_code, known_usage, unknown_usage,
    model_route, capture_status, created_at, retention_expires_at
  ) values (
    'bmq', v_request, nullif(p_interaction ->> 'actor_id', '')::uuid,
    p_interaction ->> 'actor_label', p_interaction ->> 'conversation_id',
    p_interaction ->> 'source_route', p_interaction ->> 'source_label',
    coalesce(nullif(btrim(p_interaction ->> 'question_text'), ''), '(empty question)'),
    p_interaction ->> 'answer_text',
    coalesce((p_interaction ->> 'redaction_applied')::boolean, true),
    coalesce(p_interaction -> 'context_summary', '{}'::jsonb),
    coalesce(p_interaction -> 'understood_intent', '{}'::jsonb),
    coalesce(p_interaction -> 'page_filters', '{}'::jsonb),
    coalesce(p_interaction -> 'executed_filters', '{}'::jsonb),
    p_interaction ->> 'tool',
    coalesce(p_interaction -> 'provenance', '{}'::jsonb),
    coalesce(nullif(p_interaction ->> 'response_status', ''), 'unknown'),
    p_interaction ->> 'response_code',
    coalesce(p_interaction -> 'known_usage', '{}'::jsonb),
    coalesce(p_interaction -> 'unknown_usage', '{}'::jsonb),
    p_interaction ->> 'model_route',
    coalesce(nullif(p_interaction ->> 'capture_status', ''), 'captured'),
    coalesce((p_interaction ->> 'created_at')::timestamptz, now()),
    coalesce((p_interaction ->> 'retention_expires_at')::timestamptz, now() + interval '180 days')
  )
  on conflict (tenant, request_id) do nothing;

  select * into v_interaction
  from public.vnagent_interactions
  where tenant = 'bmq' and request_id = v_request;
  if not found then
    raise exception 'capture_failed' using errcode = 'P0001';
  end if;

  v_question := coalesce(nullif(btrim(v_interaction.question_text), ''), '(empty question)');
  v_intent := case when jsonb_typeof(v_interaction.understood_intent) = 'object'
    then v_interaction.understood_intent else '{}'::jsonb end;
  v_filters := case when jsonb_typeof(v_interaction.executed_filters) = 'object'
    then v_interaction.executed_filters else '{}'::jsonb end;
  -- Deterministic key so a retry recovers the raw asset instead of skipping it.
  v_key := 'operational_chat:' || md5('bmq|' || v_interaction.request_id);

  insert into public.vnagent_data_assets (
    tenant, dataset_stage, source_kind, source_designation, interaction_id,
    question, source_answer, expected_intent, expected_filters, provenance,
    snapshot_at, evaluation_status, version, dedupe_key, created_by,
    created_at, updated_at
  ) values (
    'bmq', 'raw', 'operational_chat', null, v_interaction.id,
    v_question, v_interaction.answer_text, v_intent, v_filters,
    jsonb_build_object(
      'capture', 'operational_chat',
      'requestId', v_interaction.request_id,
      'sourceRoute', v_interaction.source_route,
      'executedFilters', v_filters,
      'capturedAt', v_interaction.created_at
    ),
    v_interaction.created_at, 'not_evaluated', 1, v_key, v_interaction.actor_id,
    v_interaction.created_at, v_interaction.created_at
  )
  on conflict (tenant, dedupe_key) do nothing
  returning id into v_asset_id;

  if v_asset_id is null then
    select id into v_asset_id
    from public.vnagent_data_assets
    where tenant = 'bmq' and dedupe_key = v_key;
  end if;

  if p_jev is not null and jsonb_typeof(p_jev) = 'object' then
    insert into public.vnagent_jev_events (
      tenant, request_id, model, prompt_version, registry_version,
      attempted, decided, screen, circuit, metric, metric_probability,
      period, period_probability, support, support_probability, threshold,
      fallback, cost, token_counts, stage_timings, counts, decision
    ) values (
      'bmq', v_request,
      p_jev ->> 'model', p_jev ->> 'prompt_version', p_jev ->> 'registry_version',
      coalesce((p_jev ->> 'attempted')::boolean, false),
      coalesce((p_jev ->> 'decided')::boolean, false),
      p_jev ->> 'screen', p_jev ->> 'circuit', p_jev ->> 'metric',
      (p_jev ->> 'metric_probability')::numeric,
      p_jev ->> 'period', (p_jev ->> 'period_probability')::numeric,
      p_jev ->> 'support', (p_jev ->> 'support_probability')::numeric,
      (p_jev ->> 'threshold')::numeric, p_jev ->> 'fallback',
      (p_jev ->> 'cost')::numeric,
      coalesce(p_jev -> 'token_counts', '{}'::jsonb),
      coalesce(p_jev -> 'stage_timings', '{}'::jsonb),
      coalesce(p_jev -> 'counts', '{}'::jsonb),
      p_jev ->> 'decision'
    )
    on conflict (tenant, request_id) do nothing;
  end if;

  return jsonb_build_object(
    'status', 'captured',
    'interactionId', v_interaction.id,
    'assetId', v_asset_id
  );
end;
$$;

-- Capture is trusted-server only: no authenticated/public execute.
revoke all on function public.vnagent_capture_chat(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.vnagent_capture_chat(jsonb, jsonb) to service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 9. Real dataset metrics for the dashboard (no double counting)
-- ────────────────────────────────────────────────────────────────────────────
-- Current assets are counted once per stage. `raw + curated + gold` are stages of
-- the same inventory (an item moves between them), so they must not be presented
-- as three independent assets. `createdToday` counts assets CREATED today (they
-- all start raw); promoted/collected stay separate so an item is never counted
-- three times. Source contributions count the current inventory by source kind.
create or replace function public.vnagent_data_admin_metrics(p_today date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_day_start timestamptz;
  v_week_start timestamptz;
  v_result jsonb;
begin
  if v_actor is null or not public.has_role(v_actor, 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_day_start := (p_today::timestamp at time zone 'Asia/Ho_Chi_Minh');
  v_week_start := v_day_start - interval '6 days';

  select jsonb_build_object(
    'asOf', p_today,
    'timezone', 'Asia/Ho_Chi_Minh',
    'assets', jsonb_build_object(
      'raw', (select count(*) from public.vnagent_data_assets where tenant = 'bmq' and dataset_stage = 'raw'),
      'curated', (select count(*) from public.vnagent_data_assets where tenant = 'bmq' and dataset_stage = 'curated'),
      'gold', (select count(*) from public.vnagent_data_assets where tenant = 'bmq' and dataset_stage = 'gold'),
      'total', (select count(*) from public.vnagent_data_assets where tenant = 'bmq')
    ),
    'createdToday', (select count(*) from public.vnagent_data_assets where tenant = 'bmq' and created_at >= v_day_start),
    'promotionsToday', jsonb_build_object(
      'rawToCurated', (select count(*) from public.vnagent_data_asset_events where tenant = 'bmq' and from_stage = 'raw' and to_stage = 'curated' and created_at >= v_day_start),
      'curatedToGold', (select count(*) from public.vnagent_data_asset_events where tenant = 'bmq' and from_stage = 'curated' and to_stage = 'gold' and created_at >= v_day_start),
      'demotions', (select count(*) from public.vnagent_data_asset_events where tenant = 'bmq' and created_at >= v_day_start and (from_stage = 'gold' or (from_stage = 'curated' and to_stage = 'raw')))
    ),
    'promotions7d', jsonb_build_object(
      'rawToCurated', (select count(*) from public.vnagent_data_asset_events where tenant = 'bmq' and from_stage = 'raw' and to_stage = 'curated' and created_at >= v_week_start),
      'curatedToGold', (select count(*) from public.vnagent_data_asset_events where tenant = 'bmq' and from_stage = 'curated' and to_stage = 'gold' and created_at >= v_week_start)
    ),
    'collected', jsonb_build_object(
      'today', (select count(*) from public.vnagent_interactions where tenant = 'bmq' and created_at >= v_day_start),
      'last7d', (select count(*) from public.vnagent_interactions where tenant = 'bmq' and created_at >= v_week_start),
      'total', (select count(*) from public.vnagent_interactions where tenant = 'bmq')
    ),
    'reviewed', jsonb_build_object(
      'verified', (select count(*) from public.vnagent_data_assets where tenant = 'bmq' and evaluation_status = 'verified'),
      'pending', (select count(*) from public.vnagent_data_assets where tenant = 'bmq' and evaluation_status = 'pending_review'),
      'rejected', (select count(*) from public.vnagent_data_assets where tenant = 'bmq' and evaluation_status = 'rejected'),
      'notEvaluated', (select count(*) from public.vnagent_data_assets where tenant = 'bmq' and evaluation_status = 'not_evaluated'),
      'denominator', (select count(*) from public.vnagent_data_assets where tenant = 'bmq')
    ),
    'unknown', jsonb_build_object(
      'abstainedToday', (select count(*) from public.vnagent_interactions where tenant = 'bmq' and response_status = 'abstained' and created_at >= v_day_start),
      'abstainedTotal', (select count(*) from public.vnagent_interactions where tenant = 'bmq' and response_status = 'abstained'),
      'errorsToday', (select count(*) from public.vnagent_interactions where tenant = 'bmq' and response_status = 'error' and created_at >= v_day_start),
      'errorsTotal', (select count(*) from public.vnagent_interactions where tenant = 'bmq' and response_status = 'error')
    ),
    'sourceContributions', jsonb_build_object(
      'operational_chat', (select count(*) from public.vnagent_data_assets where tenant = 'bmq' and source_kind = 'operational_chat'),
      'contributor', (select count(*) from public.vnagent_data_assets where tenant = 'bmq' and source_kind = 'contributor'),
      'synthetic', (select count(*) from public.vnagent_data_assets where tenant = 'bmq' and source_kind = 'synthetic'),
      'total', (select count(*) from public.vnagent_data_assets where tenant = 'bmq')
    ),
    'scopeNote', 'raw/curated/gold are stages of the same asset inventory, not independent assets'
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.vnagent_data_admin_metrics(date) from public, anon;
grant execute on function public.vnagent_data_admin_metrics(date) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 10. Daily event-derived timeseries (historic stock reconstructed, not grouped)
-- ────────────────────────────────────────────────────────────────────────────
-- For each day in the window the stock per stage is reconstructed from the asset
-- creation time plus the audited transition events up to that day's end; the
-- inflow series counts new raw assets and real promotions. `new` never invents a
-- value for a day with no events (it stays 0 only when the ledger says 0).
create or replace function public.vnagent_data_admin_timeseries(p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date;
  v_from date;
  v_days jsonb;
  v_contributions jsonb;
begin
  if v_actor is null or not public.has_role(v_actor, 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_days is null or p_days not in (7, 30, 90) then
    raise exception 'invalid_days' using errcode = '22023';
  end if;
  v_today := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_from := v_today - (p_days - 1);

  with bounds as (
    select d::date as day,
           (d::timestamp at time zone 'Asia/Ho_Chi_Minh') as day_start,
           ((d + interval '1 day')::timestamp at time zone 'Asia/Ho_Chi_Minh') as day_end
    from generate_series(v_from::timestamp, v_today::timestamp, interval '1 day') as d
  ),
  stock as (
    select b.day,
           count(a.id) as total,
           count(a.id) filter (where coalesce(e.to_stage, 'raw') = 'raw') as raw,
           count(a.id) filter (where e.to_stage = 'curated') as curated,
           count(a.id) filter (where e.to_stage = 'gold') as gold
    from bounds b
    left join public.vnagent_data_assets a
      on a.tenant = 'bmq' and a.created_at < b.day_end
    left join lateral (
      select ev.to_stage
      from public.vnagent_data_asset_events ev
      where ev.asset_id = a.id and ev.created_at < b.day_end
      order by ev.created_at desc, ev.id desc
      limit 1
    ) e on true
    group by b.day
  ),
  inflow as (
    select b.day,
           (select count(*) from public.vnagent_data_assets a
             where a.tenant = 'bmq' and a.created_at >= b.day_start and a.created_at < b.day_end) as raw,
           (select count(*) from public.vnagent_data_asset_events ev
             where ev.tenant = 'bmq' and ev.from_stage = 'raw' and ev.to_stage = 'curated'
               and ev.created_at >= b.day_start and ev.created_at < b.day_end) as curated,
           (select count(*) from public.vnagent_data_asset_events ev
             where ev.tenant = 'bmq' and ev.from_stage = 'curated' and ev.to_stage = 'gold'
               and ev.created_at >= b.day_start and ev.created_at < b.day_end) as gold
    from bounds b
  )
  select coalesce(jsonb_agg(
      jsonb_build_object(
        'date', to_char(s.day, 'YYYY-MM-DD'),
        'stock', jsonb_build_object('raw', s.raw, 'curated', s.curated, 'gold', s.gold, 'total', s.total),
        'inflow', jsonb_build_object('raw', i.raw, 'curated', i.curated, 'gold', i.gold)
      ) order by s.day
    ), '[]'::jsonb)
  into v_days
  from stock s
  join inflow i on i.day = s.day;

  select jsonb_build_object(
    'operational_chat', count(*) filter (where source_kind = 'operational_chat'),
    'contributor', count(*) filter (where source_kind = 'contributor'),
    'synthetic', count(*) filter (where source_kind = 'synthetic'),
    'total', count(*)
  )
  into v_contributions
  from public.vnagent_data_assets
  where tenant = 'bmq';

  return jsonb_build_object(
    'from', to_char(v_from, 'YYYY-MM-DD'),
    'to', to_char(v_today, 'YYYY-MM-DD'),
    'timezone', 'Asia/Ho_Chi_Minh',
    'days', v_days,
    'sourceContributions', coalesce(v_contributions, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.vnagent_data_admin_timeseries(integer) from public, anon;
grant execute on function public.vnagent_data_admin_timeseries(integer) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 11. Row level security — authenticated callers get SELECT only
-- ────────────────────────────────────────────────────────────────────────────
alter table public.vnagent_interactions enable row level security;
alter table public.vnagent_data_assets enable row level security;
alter table public.vnagent_data_asset_events enable row level security;
alter table public.vnagent_jev_events enable row level security;

-- Owner read policies only. No insert/update/delete policy exists, so even if a
-- future grant were added the row level security would still deny the write.
drop policy if exists vnagent_interactions_owner_select on public.vnagent_interactions;
create policy vnagent_interactions_owner_select
  on public.vnagent_interactions for select to authenticated
  using (public.has_role((select auth.uid()), 'owner'));

drop policy if exists vnagent_jev_events_owner_select on public.vnagent_jev_events;
create policy vnagent_jev_events_owner_select
  on public.vnagent_jev_events for select to authenticated
  using (public.has_role((select auth.uid()), 'owner'));

drop policy if exists vnagent_data_assets_owner_select on public.vnagent_data_assets;
create policy vnagent_data_assets_owner_select
  on public.vnagent_data_assets for select to authenticated
  using (public.has_role((select auth.uid()), 'owner'));

drop policy if exists vnagent_data_asset_events_owner_select on public.vnagent_data_asset_events;
create policy vnagent_data_asset_events_owner_select
  on public.vnagent_data_asset_events for select to authenticated
  using (public.has_role((select auth.uid()), 'owner'));

-- Remove any first-draft write policies/grants if this migration is re-run.
drop policy if exists vnagent_data_assets_owner_insert on public.vnagent_data_assets;
drop policy if exists vnagent_data_assets_owner_update on public.vnagent_data_assets;
drop policy if exists vnagent_data_asset_events_owner_insert on public.vnagent_data_asset_events;

-- ────────────────────────────────────────────────────────────────────────────
-- 12. Privileges — SELECT only for authenticated; no direct table writes at all
-- ────────────────────────────────────────────────────────────────────────────
revoke all on public.vnagent_interactions from anon, authenticated;
grant select on public.vnagent_interactions to authenticated;
grant select on public.vnagent_interactions to service_role;

revoke all on public.vnagent_jev_events from anon, authenticated;
grant select on public.vnagent_jev_events to authenticated;
grant select on public.vnagent_jev_events to service_role;

-- Assets/events are only written by the SECURITY DEFINER routines above. Even
-- service_role has no direct INSERT/UPDATE/DELETE, so the audit trail cannot be
-- bypassed with a raw REST call.
revoke all on public.vnagent_data_assets from anon, authenticated;
grant select on public.vnagent_data_assets to authenticated;
grant select on public.vnagent_data_assets to service_role;

revoke all on public.vnagent_data_asset_events from anon, authenticated;
grant select on public.vnagent_data_asset_events to authenticated;
grant select on public.vnagent_data_asset_events to service_role;

comment on table public.vnagent_interactions is
  'Raw BMQ analytics-chat interaction capture. Separate from business ledgers; owner-only read; written only by vnagent_capture_chat().';
comment on table public.vnagent_data_assets is
  'VNAgent evaluation dataset inventory. raw/curated/gold are stages of the same asset; Gold requires verified intent, conditions, meaningful evidence and a real reviewer. Direct writes are revoked; use the reviewed RPCs.';
comment on table public.vnagent_data_asset_events is
  'Audited, versioned stage transitions for VNAgent dataset assets. Append-only through vnagent_transition_data_asset().';
comment on table public.vnagent_jev_events is
  'Bounded real Jev telemetry (metric/period/support probabilities, versions, cost, usage, timings, counts) without question text, prompts or credentials.';
