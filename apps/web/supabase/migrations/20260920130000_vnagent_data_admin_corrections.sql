-- VNAgent data-assets admin — narrow corrections after the first review.
--
-- This migration is additive and replaces three routines only. It does not touch
-- tables, grants, RLS or any unrelated admin code.
--
--   1. vnagent_data_admin_timeseries: the latest-event tie-break must be the
--      monotonic version, not a random UUID. PostgreSQL now() is transaction
--      stable, so several transitions in one transaction share created_at; the
--      previous `order by created_at desc, id desc` could pick an older stage
--      (wrong historic stock). `to_version desc` is the authoritative ordering.
--   2. vnagent_evidence_is_meaningful: numeric/boolean "evidence" (0, false, ...)
--      proves nothing; only a non-blank string or a non-empty structured value
--      (object/array) counts.
--   3. vnagent_capture_chat: the initial raw asset provenance must carry the
--      original interaction provenance (citations/evidence/semanticVersion/
--      snapshot) nested and sanitized as `sourceProvenance`, instead of dropping
--      it for requestId/sourceRoute only.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Evidence helper — reject numeric/boolean placeholders
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
        -- A number or boolean (including 0/false) is not evidence.
        or jsonb_typeof(item) in ('number', 'boolean')
        or (jsonb_typeof(item) = 'string' and length(btrim(item #>> '{}')) = 0)
        or (jsonb_typeof(item) = 'object' and item = '{}'::jsonb)
        or (jsonb_typeof(item) = 'array' and item = '[]'::jsonb)
    )
  end
$$;

revoke all on function public.vnagent_evidence_is_meaningful(jsonb) from public, anon;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Bounded, credential-stripped source provenance
-- ────────────────────────────────────────────────────────────────────────────
-- Recursive sanitizer used to nest the interaction provenance onto its derived
-- asset. It clamps depth (3), object keys (24), array items (20) and strings
-- (2000), drops control/sensitive keys, and never invents a value.
create or replace function public.vnagent_sanitize_source_provenance(p_value jsonb, p_depth integer default 0)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_key text;
  v_child jsonb;
  v_out jsonb;
  v_ord integer := 0;
begin
  -- Match capture's container-depth bound: scalar source/snapshot identifiers
  -- at the leaf of evidence arrays must survive (object -> array -> object).
  if p_value is null or (p_depth >= 3 and jsonb_typeof(p_value) in ('object', 'array')) then
    return null;
  end if;
  case jsonb_typeof(p_value)
    when 'object' then
      v_out := '{}'::jsonb;
      for v_key, v_child in select key, value from jsonb_each(p_value) loop
        v_ord := v_ord + 1;
        exit when v_ord > 24;
        if length(v_key) > 80
           or v_key ~* '^(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|bearer|cookie|session)$' then
          continue;
        end if;
        v_out := v_out || jsonb_build_object(v_key, public.vnagent_sanitize_source_provenance(v_child, p_depth + 1));
      end loop;
      return v_out;
    when 'array' then
      v_out := '[]'::jsonb;
      for v_child in select value from jsonb_array_elements(p_value) loop
        v_ord := v_ord + 1;
        exit when v_ord > 20;
        v_out := v_out || jsonb_build_array(public.vnagent_sanitize_source_provenance(v_child, p_depth + 1));
      end loop;
      return v_out;
    when 'string' then
      return to_jsonb(left(p_value #>> '{}', 2000));
    when 'number' then
      return p_value;
    when 'boolean' then
      return p_value;
    else
      return null;
  end case;
end;
$$;

revoke all on function public.vnagent_sanitize_source_provenance(jsonb, integer) from public, anon;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Trusted capture keeps the original source provenance
-- ────────────────────────────────────────────────────────────────────────────
-- Body matches 20260920120000 except the asset provenance now nests the
-- sanitized interaction provenance as `sourceProvenance`. Everything about
-- atomicity, idempotency and identity is unchanged.
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
      'capturedAt', v_interaction.created_at,
      -- Original source provenance (citations/evidence/semanticVersion/snapshot)
      -- kept for verification; bounded and credential-stripped, never invented.
      'sourceProvenance', public.vnagent_sanitize_source_provenance(v_interaction.provenance)
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
-- 4. Daily timeseries — deterministic latest-event tie-break
-- ────────────────────────────────────────────────────────────────────────────
-- Body matches 20260920120000 except the lateral subquery now orders by
-- `created_at desc, to_version desc`. Version is monotonic per asset, so a
-- same-transaction transition chain is resolved to its real latest stage while
-- the per-day `created_at < day_end` boundary (historic day semantics) is kept.
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
      order by ev.created_at desc, ev.to_version desc
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
