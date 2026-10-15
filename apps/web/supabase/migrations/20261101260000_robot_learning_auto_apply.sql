-- Robot Bé Mì học từ sửa của con người + tự áp khi đủ tin cậy.
--
-- Additive only. This migration adds:
--   (a) public.robot_feedback — one feedback memory row per (kind, subject,
--       robot choice); every human rejection / override of a robot suggestion is
--       captured here and never re-suggested, even after a prompt_version bump;
--   (b) public.robot_auto_actions — the audit + undo trail of every automatic
--       action the robot applied;
--   (c) public.robot_settings — a single-row off switch, thresholds and cap;
--   (d) the service-role internal writers robot_auto_confirm_alias /
--       robot_auto_apply_class and the undo RPC, plus the read RPCs the app and
--       the edge functions use.
--
-- Design rules:
--   * merges and spend decisions are NEVER auto-applied;
--   * every automatic action has an undo path and a daily cap and lives behind
--     an off switch;
--   * functions are SECURITY DEFINER with search_path = public, pg_temp and keep
--     the same permission gates as the existing human decide RPCs;
--   * internal service-role helpers are revoked from public, anon, authenticated.
--
-- It never changes an existing RPC signature, table column or business row shape.

-- The finance duplicate check stores its per-pair JSON evidence (images_used,
-- p_same_text, p_same_image). The column is additive and nullable.
alter table public.finance_jev_duplicate_checks
  add column if not exists evidence jsonb;

-- ===========================================================================
-- 1. robot_feedback: the human-correction memory
-- ===========================================================================

create table if not exists public.robot_feedback (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in (
    'alias', 'catalog_merge', 'catalog_class', 'finance_duplicate', 'routing', 'debt_mark'
  )),
  -- alias: supplier|normalized name; catalog_merge: sorted item-id pair;
  -- catalog_class: item id; finance_duplicate: pair_key; routing: supplier id;
  -- debt_mark: coalesce(payment_request_id, purchase_order_id).
  subject_key text not null,
  robot_choice text,
  human_choice text,
  robot_probability numeric,
  note text,
  source_table text,
  source_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- One row per (kind, subject, robot choice); a null choice coalesces to ''.
create unique index if not exists robot_feedback_subject_uidx
  on public.robot_feedback (kind, subject_key, coalesce(robot_choice, ''));

create index if not exists idx_robot_feedback_kind_subject
  on public.robot_feedback (kind, subject_key, created_at desc);

alter table public.robot_feedback enable row level security;

drop policy if exists robot_feedback_select on public.robot_feedback;
create policy robot_feedback_select on public.robot_feedback
  for select to authenticated
  using (
    public.q7_material_inventory_can_view((select auth.uid()))
    or public.has_role((select auth.uid()), 'owner')
  );

revoke all on public.robot_feedback from public, anon, authenticated;
grant select on public.robot_feedback to authenticated;
grant all on public.robot_feedback to service_role;

-- ===========================================================================
-- 2. AFTER triggers: capture only real contradictions / rejections
-- ===========================================================================

-- 2.1 alias: a human corrected the robot's candidate on an alias subject.
create or replace function public.robot_feedback_from_alias_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_alias public.stock_material_aliases%rowtype;
  v_human uuid;
begin
  if new.action <> 'correct' or new.jev_item_id is null then
    return new;
  end if;
  v_human := coalesce(new.new_item_id, new.new_sku_id);
  if new.jev_item_id is not distinct from v_human then
    return new;
  end if;
  select * into v_alias from public.stock_material_aliases where id = new.alias_id;
  if not found then
    return new;
  end if;
  insert into public.robot_feedback (
    kind, subject_key, robot_choice, human_choice, robot_probability, note,
    source_table, source_id, created_by, created_at
  ) values (
    'alias',
    coalesce(v_alias.supplier_id::text, '') || '|' || v_alias.normalized_name,
    new.jev_item_id::text,
    v_human::text,
    new.jev_probability,
    new.raw_name,
    'material_alias_events',
    new.id,
    new.actor_id,
    coalesce(new.created_at, now())
  )
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists robot_feedback_alias_event on public.material_alias_events;
create trigger robot_feedback_alias_event
  after insert on public.material_alias_events
  for each row execute function public.robot_feedback_from_alias_event();

-- 2.2 catalog: a suggestion was rejected by a human.
create or replace function public.robot_feedback_from_catalog_suggestion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status <> 'rejected' or new.status is not distinct from old.status then
    return new;
  end if;
  insert into public.robot_feedback (
    kind, subject_key, robot_choice, human_choice, robot_probability, note,
    source_table, source_id, created_by, created_at
  ) values (
    case when new.kind = 'merge' then 'catalog_merge' else 'catalog_class' end,
    case
      when new.kind = 'merge' then
        least(new.item_id, new.other_item_id)::text || ':' || greatest(new.item_id, new.other_item_id)::text
      else new.item_id::text
    end,
    case when new.kind = 'merge' then new.proposed_target_id::text else new.proposed_class end,
    'rejected',
    new.probability,
    null,
    'stock_catalog_suggestions',
    new.id,
    new.decided_by,
    coalesce(new.decided_at, now())
  )
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists robot_feedback_catalog_suggestion on public.stock_catalog_suggestions;
create trigger robot_feedback_catalog_suggestion
  after update on public.stock_catalog_suggestions
  for each row execute function public.robot_feedback_from_catalog_suggestion();

-- 2.3 finance duplicate: the CEO decided on a pair the robot labelled.
create or replace function public.robot_feedback_from_finance_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.review_decision is null or new.review_decision is not distinct from old.review_decision then
    return new;
  end if;
  insert into public.robot_feedback (
    kind, subject_key, robot_choice, human_choice, robot_probability, note,
    source_table, source_id, created_by, created_at
  ) values (
    'finance_duplicate',
    new.pair_key,
    new.status,
    new.review_decision,
    new.p_same,
    new.review_note,
    'finance_jev_duplicate_checks',
    new.id,
    new.reviewed_by,
    coalesce(new.reviewed_at, now())
  )
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists robot_feedback_finance_check on public.finance_jev_duplicate_checks;
create trigger robot_feedback_finance_check
  after update on public.finance_jev_duplicate_checks
  for each row execute function public.robot_feedback_from_finance_check();

-- 2.4 routing: a supplier routing suggestion was rejected or reverted.
create or replace function public.robot_feedback_from_routing_suggestion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status not in ('rejected', 'reverted') or new.status is not distinct from old.status then
    return new;
  end if;
  insert into public.robot_feedback (
    kind, subject_key, robot_choice, human_choice, robot_probability, note,
    source_table, source_id, created_by, created_at
  ) values (
    'routing',
    new.supplier_id::text,
    new.proposed_location,
    new.status,
    new.probability,
    null,
    'supplier_routing_suggestions',
    new.id,
    new.applied_by,
    coalesce(new.applied_at, new.created_at, now())
  )
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists robot_feedback_routing_suggestion on public.supplier_routing_suggestions;
create trigger robot_feedback_routing_suggestion
  after update on public.supplier_routing_suggestions
  for each row execute function public.robot_feedback_from_routing_suggestion();

-- 2.5 debt mark: a manual mark replaced a Jev mark with a different value.
create or replace function public.robot_feedback_from_debt_mark()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.source <> 'manual' or old.source <> 'jev' then
    return new;
  end if;
  if new.mark is not distinct from old.mark then
    return new;
  end if;
  insert into public.robot_feedback (
    kind, subject_key, robot_choice, human_choice, robot_probability, note,
    source_table, source_id, created_by, created_at
  ) values (
    'debt_mark',
    coalesce(new.payment_request_id, new.purchase_order_id)::text,
    old.mark,
    new.mark,
    old.probability,
    new.note,
    'supplier_debt_marks',
    new.id,
    new.created_by,
    coalesce(new.created_at, now())
  )
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists robot_feedback_debt_mark on public.supplier_debt_marks;
create trigger robot_feedback_debt_mark
  after update on public.supplier_debt_marks
  for each row execute function public.robot_feedback_from_debt_mark();

-- ===========================================================================
-- 3. One-time backfill from existing rows
-- ===========================================================================

insert into public.robot_feedback (
  kind, subject_key, robot_choice, human_choice, robot_probability, note,
  source_table, source_id, created_by, created_at
)
select
  'alias',
  coalesce(a.supplier_id::text, '') || '|' || a.normalized_name,
  e.jev_item_id::text,
  coalesce(e.new_item_id, e.new_sku_id)::text,
  e.jev_probability,
  e.raw_name,
  'material_alias_events',
  e.id,
  e.actor_id,
  coalesce(e.created_at, now())
from public.material_alias_events e
join public.stock_material_aliases a on a.id = e.alias_id
where e.action = 'correct'
  and e.jev_item_id is not null
  and e.jev_item_id is distinct from coalesce(e.new_item_id, e.new_sku_id)
on conflict do nothing;

insert into public.robot_feedback (
  kind, subject_key, robot_choice, human_choice, robot_probability, note,
  source_table, source_id, created_by, created_at
)
select
  case when s.kind = 'merge' then 'catalog_merge' else 'catalog_class' end,
  case
    when s.kind = 'merge' then
      least(s.item_id, s.other_item_id)::text || ':' || greatest(s.item_id, s.other_item_id)::text
    else s.item_id::text
  end,
  case when s.kind = 'merge' then s.proposed_target_id::text else s.proposed_class end,
  'rejected',
  s.probability,
  null,
  'stock_catalog_suggestions',
  s.id,
  s.decided_by,
  coalesce(s.decided_at, now())
from public.stock_catalog_suggestions s
where s.status = 'rejected'
on conflict do nothing;

insert into public.robot_feedback (
  kind, subject_key, robot_choice, human_choice, robot_probability, note,
  source_table, source_id, created_by, created_at
)
select
  'finance_duplicate',
  c.pair_key,
  c.status,
  c.review_decision,
  c.p_same,
  c.review_note,
  'finance_jev_duplicate_checks',
  c.id,
  c.reviewed_by,
  coalesce(c.reviewed_at, now())
from public.finance_jev_duplicate_checks c
where c.review_decision is not null
on conflict do nothing;

insert into public.robot_feedback (
  kind, subject_key, robot_choice, human_choice, robot_probability, note,
  source_table, source_id, created_by, created_at
)
select
  'routing',
  r.supplier_id::text,
  r.proposed_location,
  r.status,
  r.probability,
  null,
  'supplier_routing_suggestions',
  r.id,
  r.applied_by,
  coalesce(r.applied_at, r.created_at, now())
from public.supplier_routing_suggestions r
where r.status in ('rejected', 'reverted')
on conflict do nothing;

-- ===========================================================================
-- 4. get_robot_feedback_for: the only feedback reader (service role only)
-- ===========================================================================

-- Safe uuid cast: a routing / debt / status choice is not a uuid and must never
-- make the alias label join raise.
create or replace function public.robot_try_uuid(p_value text)
returns uuid
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then p_value::uuid
    else null
  end;
$$;

revoke all on function public.robot_try_uuid(text) from public, anon, authenticated;
grant execute on function public.robot_try_uuid(text) to service_role;

create or replace function public.get_robot_feedback_for(
  p_kind text,
  p_keys text[],
  p_limit integer default 5
)
returns table (
  id uuid,
  kind text,
  subject_key text,
  robot_choice text,
  human_choice text,
  robot_probability numeric,
  note text,
  created_at timestamptz,
  robot_label text,
  human_label text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select
    f.id,
    f.kind,
    f.subject_key,
    f.robot_choice,
    f.human_choice,
    f.robot_probability,
    f.note,
    f.created_at,
    case
      when f.kind = 'alias' then coalesce(kii_r.name, ps_r.product_name)
      else f.robot_choice
    end as robot_label,
    case
      when f.kind = 'alias' then coalesce(kii_h.name, ps_h.product_name)
      else f.human_choice
    end as human_label
  from public.robot_feedback f
  left join public.kitchen_inventory_items kii_r
    on f.kind = 'alias' and kii_r.id = public.robot_try_uuid(f.robot_choice)
  left join public.product_skus ps_r
    on f.kind = 'alias' and kii_r.id is null and ps_r.id = public.robot_try_uuid(f.robot_choice)
  left join public.kitchen_inventory_items kii_h
    on f.kind = 'alias' and kii_h.id = public.robot_try_uuid(f.human_choice)
  left join public.product_skus ps_h
    on f.kind = 'alias' and kii_h.id is null and ps_h.id = public.robot_try_uuid(f.human_choice)
  where f.kind = p_kind
    and f.subject_key = any (coalesce(p_keys, array[]::text[]))
  order by f.created_at desc, f.id desc
  limit greatest(1, least(coalesce(p_limit, 5), 50));
end;
$$;

revoke all on function public.get_robot_feedback_for(text, text[], integer) from public, anon, authenticated;
grant execute on function public.get_robot_feedback_for(text, text[], integer) to service_role;

-- ===========================================================================
-- 5. robot_auto_actions + robot_settings
-- ===========================================================================

create table if not exists public.robot_auto_actions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('alias', 'catalog_class')),
  subject_key text not null,
  target jsonb not null default '{}'::jsonb,
  robot_probability numeric,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'applied' check (status in ('applied', 'undone')),
  applied_at timestamptz not null default now(),
  undone_by uuid references auth.users(id) on delete set null,
  undone_at timestamptz
);

create index if not exists idx_robot_auto_actions_status_applied
  on public.robot_auto_actions (status, applied_at desc);
create index if not exists idx_robot_auto_actions_subject
  on public.robot_auto_actions (kind, subject_key);

alter table public.robot_auto_actions enable row level security;

drop policy if exists robot_auto_actions_select on public.robot_auto_actions;
create policy robot_auto_actions_select on public.robot_auto_actions
  for select to authenticated
  using (
    public.q7_material_inventory_can_view((select auth.uid()))
    or public.has_role((select auth.uid()), 'owner')
  );

revoke all on public.robot_auto_actions from public, anon, authenticated;
grant select on public.robot_auto_actions to authenticated;
grant all on public.robot_auto_actions to service_role;

create table if not exists public.robot_settings (
  id boolean primary key default true check (id),
  auto_apply_enabled boolean not null default true,
  alias_threshold numeric not null default 0.95
    check (alias_threshold >= 0 and alias_threshold <= 1),
  class_threshold numeric not null default 0.90
    check (class_threshold >= 0 and class_threshold <= 1),
  daily_cap integer not null default 50 check (daily_cap >= 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.robot_settings (id) values (true) on conflict (id) do nothing;

alter table public.robot_settings enable row level security;

drop policy if exists robot_settings_select on public.robot_settings;
create policy robot_settings_select on public.robot_settings
  for select to authenticated using (true);

revoke all on public.robot_settings from public, anon, authenticated;
grant select on public.robot_settings to authenticated;
grant all on public.robot_settings to service_role;

-- ===========================================================================
-- 6. Internal service-role auto-apply writers
-- ===========================================================================

-- The shared refusal gate for both auto writers. Returns a reason string or null.
create or replace function public.robot_auto_refusal(
  p_kind text,
  p_subject_key text,
  p_probability numeric,
  p_threshold numeric
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.robot_settings%rowtype;
  v_today_count integer;
begin
  select * into v_settings from public.robot_settings where id = true;
  if not found then
    v_settings.auto_apply_enabled := true;
    v_settings.alias_threshold := 0.95;
    v_settings.class_threshold := 0.90;
    v_settings.daily_cap := 50;
  end if;
  if v_settings.auto_apply_enabled is not true then
    return 'disabled';
  end if;
  if exists (
    select 1 from public.robot_feedback f
    where f.kind = p_kind and f.subject_key = p_subject_key
  ) then
    return 'feedback';
  end if;
  if p_probability is null or p_probability < p_threshold then
    return 'below_threshold';
  end if;
  select count(*) into v_today_count
  from public.robot_auto_actions a
  where a.status = 'applied'
    and (a.applied_at at time zone 'Asia/Ho_Chi_Minh')::date
        = (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  if v_today_count >= v_settings.daily_cap then
    return 'daily_cap';
  end if;
  return null;
end;
$$;

revoke all on function public.robot_auto_refusal(text, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.robot_auto_refusal(text, text, numeric, numeric) to service_role;

-- Auto-confirm one alias. Reuses the exact core of confirm_material_alias; never
-- raises for a refusal (returns {applied:false, reason}).
create or replace function public.robot_auto_confirm_alias(
  p_supplier_id uuid,
  p_location text,
  p_raw_name text,
  p_raw_unit text,
  p_kitchen_inventory_item_id uuid,
  p_tan_tao_sku_id uuid,
  p_entered_unit_label text,
  p_conversion_factor numeric,
  p_jev_item_id uuid,
  p_jev_probability numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.robot_settings%rowtype;
  v_norm text;
  v_subject text;
  v_choice uuid;
  v_target_name text;
  v_target_unit text;
  v_unit_status text;
  v_reason text;
  v_event_id uuid;
  v_result jsonb;
  v_action_id uuid;
begin
  select * into v_settings from public.robot_settings where id = true;
  if not found then
    v_settings.auto_apply_enabled := true;
    v_settings.alias_threshold := 0.95;
    v_settings.class_threshold := 0.90;
    v_settings.daily_cap := 50;
  end if;

  v_norm := public.normalize_stock_item_name(p_raw_name);
  if v_norm is null then
    return jsonb_build_object('applied', false, 'reason', 'invalid_request');
  end if;
  v_subject := coalesce(p_supplier_id::text, '') || '|' || v_norm;
  v_choice := coalesce(p_kitchen_inventory_item_id, p_tan_tao_sku_id);
  if v_choice is null or p_jev_item_id is null or v_choice is distinct from p_jev_item_id then
    return jsonb_build_object('applied', false, 'reason', 'not_robot_choice');
  end if;

  if p_kitchen_inventory_item_id is not null then
    select kii.name, kii.unit into v_target_name, v_target_unit
    from public.kitchen_inventory_items kii
    where kii.id = p_kitchen_inventory_item_id;
  else
    select ps.product_name, ps.unit into v_target_name, v_target_unit
    from public.product_skus ps
    where ps.id = p_tan_tao_sku_id;
  end if;

  v_reason := public.robot_auto_refusal('alias', v_subject, p_jev_probability, v_settings.alias_threshold);
  if v_reason is not null then
    return jsonb_build_object('applied', false, 'reason', v_reason);
  end if;

  -- Unit must be the same or auto-convertible, unless the names are an exact match.
  if v_target_name is null
     or public.normalize_stock_item_name(v_target_name) is distinct from v_norm then
    v_unit_status := public.q7_unit_status(v_target_unit, p_raw_unit);
    if v_unit_status is null or v_unit_status not in ('same', 'auto') then
      return jsonb_build_object('applied', false, 'reason', 'unit_mismatch');
    end if;
  end if;

  v_result := public.confirm_material_alias(
    p_supplier_id,
    p_location,
    p_raw_name,
    p_raw_unit,
    p_kitchen_inventory_item_id,
    p_tan_tao_sku_id,
    p_entered_unit_label,
    p_conversion_factor,
    p_jev_item_id,
    p_jev_probability,
    'robot_auto',
    null::uuid,
    'stock'
  );

  -- The event confirm_material_alias just wrote is the last robot_auto event for
  -- this alias; keep its id so undo can revert through the existing path.
  select e.id into v_event_id
  from public.material_alias_events e
  where e.alias_id = nullif(v_result -> 'alias' ->> 'id', '')::uuid
    and e.source_table = 'robot_auto'
    and e.action in ('confirm', 'correct')
    and not exists (
      select 1 from public.material_alias_events u
      where u.action = 'undo' and u.undo_of_event_id = e.id
    )
  order by e.created_at desc, e.id desc
  limit 1;

  insert into public.robot_auto_actions (
    kind, subject_key, target, robot_probability, payload, status
  ) values (
    'alias',
    v_subject,
    jsonb_build_object(
      'item_id', v_choice,
      'supplier_id', p_supplier_id,
      'location', p_location,
      'normalized_name', v_norm,
      'alias_id', v_result -> 'alias' ->> 'id'
    ),
    p_jev_probability,
    jsonb_build_object(
      'raw_name', p_raw_name,
      'raw_unit', p_raw_unit,
      'entered_unit_label', p_entered_unit_label,
      'conversion_factor', p_conversion_factor,
      'robot_item_id', p_jev_item_id,
      'event_id', v_event_id
    ),
    'applied'
  )
  returning id into v_action_id;

  return jsonb_build_object(
    'applied', true,
    'action_id', v_action_id,
    'event_id', v_event_id,
    'alias', v_result -> 'alias',
    'applied_lines', v_result -> 'applied_lines'
  );
end;
$$;

revoke all on function public.robot_auto_confirm_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric)
  from public, anon, authenticated;
grant execute on function public.robot_auto_confirm_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric)
  to service_role;

-- Auto-apply one catalog CLASS suggestion (never a merge).
create or replace function public.robot_auto_apply_class(p_suggestion_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.robot_settings%rowtype;
  v_suggestion public.stock_catalog_suggestions%rowtype;
  v_item public.kitchen_inventory_items%rowtype;
  v_reason text;
  v_subject text;
  v_action_id uuid;
  v_result jsonb;
begin
  select * into v_settings from public.robot_settings where id = true;
  if not found then
    v_settings.auto_apply_enabled := true;
    v_settings.alias_threshold := 0.95;
    v_settings.class_threshold := 0.90;
    v_settings.daily_cap := 50;
  end if;

  select * into v_suggestion from public.stock_catalog_suggestions where id = p_suggestion_id for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'not_found');
  end if;
  if v_suggestion.kind <> 'classify' then
    return jsonb_build_object('applied', false, 'reason', 'not_classify');
  end if;
  if v_suggestion.status <> 'pending' then
    return jsonb_build_object('applied', false, 'reason', 'not_pending');
  end if;

  v_subject := v_suggestion.item_id::text;
  v_reason := public.robot_auto_refusal('catalog_class', v_subject, v_suggestion.probability, v_settings.class_threshold);
  if v_reason is not null then
    return jsonb_build_object('applied', false, 'reason', v_reason);
  end if;

  select * into v_item from public.kitchen_inventory_items where id = v_suggestion.item_id;

  v_result := public.decide_stock_catalog_suggestion(p_suggestion_id, 'approve', null, null);

  insert into public.robot_auto_actions (
    kind, subject_key, target, robot_probability, payload, status
  ) values (
    'catalog_class',
    v_subject,
    jsonb_build_object(
      'item_id', v_suggestion.item_id,
      'suggestion_id', p_suggestion_id,
      'item_class', v_suggestion.proposed_class
    ),
    v_suggestion.probability,
    jsonb_build_object(
      'proposed_class', v_suggestion.proposed_class,
      'previous_class', v_item.item_class,
      'previous_class_source', v_item.item_class_source
    ),
    'applied'
  )
  returning id into v_action_id;

  return jsonb_build_object(
    'applied', true,
    'action_id', v_action_id,
    'item_id', v_suggestion.item_id,
    'item_class', v_suggestion.proposed_class,
    'result', v_result
  );
end;
$$;

revoke all on function public.robot_auto_apply_class(uuid) from public, anon, authenticated;
grant execute on function public.robot_auto_apply_class(uuid) to service_role;

-- ===========================================================================
-- 7. undo_robot_auto_action: revert through the existing undo path
-- ===========================================================================

create or replace function public.undo_robot_auto_action(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_action public.robot_auto_actions%rowtype;
  v_event_id uuid;
  v_undone jsonb;
  v_class text;
  v_class_source text;
begin
  select * into v_action from public.robot_auto_actions where id = p_id for update;
  if not found then
    raise exception 'action_not_found' using errcode = 'P0002';
  end if;

  -- Same gates as the matching human decide RPC.
  if v_action.kind = 'alias' then
    if not v_is_service and not public.material_alias_can_admin(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  else
    if not v_is_service and not public.q7_material_inventory_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if v_action.status <> 'applied' then
    return jsonb_build_object('status', 'already_undone', 'action_id', p_id, 'kind', v_action.kind);
  end if;

  if v_action.kind = 'alias' then
    v_event_id := nullif(v_action.payload ->> 'event_id', '')::uuid;
    if v_event_id is null then
      select e.id into v_event_id
      from public.material_alias_events e
      where e.alias_id = nullif(v_action.target ->> 'alias_id', '')::uuid
        and e.source_table = 'robot_auto'
        and e.action in ('confirm', 'correct')
        and not exists (
          select 1 from public.material_alias_events u
          where u.action = 'undo' and u.undo_of_event_id = e.id
        )
      order by e.created_at desc, e.id desc
      limit 1;
    end if;
    if v_event_id is not null then
      v_undone := public.undo_material_alias_event(v_event_id);
    else
      v_undone := jsonb_build_object('status', 'no_robot_event');
    end if;
  else
    v_class := nullif(v_action.payload ->> 'previous_class', '');
    v_class_source := nullif(v_action.payload ->> 'previous_class_source', '');
    update public.kitchen_inventory_items
      set item_class = v_class,
          item_class_source = v_class_source,
          updated_at = now()
      where id = (v_action.target ->> 'item_id')::uuid;
    update public.stock_catalog_suggestions
      set status = 'pending',
          decided_by = null,
          decided_at = null
      where id = (v_action.target ->> 'suggestion_id')::uuid
        and status = 'applied';
    v_undone := jsonb_build_object('status', 'reverted', 'item_id', v_action.target ->> 'item_id');
  end if;

  update public.robot_auto_actions
    set status = 'undone', undone_by = v_actor, undone_at = now()
    where id = p_id;

  -- The human undid the robot: remember it so the robot never re-applies.
  insert into public.robot_feedback (
    kind, subject_key, robot_choice, human_choice, robot_probability, note,
    source_table, source_id, created_by, created_at
  ) values (
    v_action.kind,
    v_action.subject_key,
    coalesce(v_action.payload ->> 'robot_item_id', v_action.payload ->> 'proposed_class'),
    'undone',
    v_action.robot_probability,
    'undo_robot_auto_action',
    'robot_auto_actions',
    v_action.id,
    v_actor,
    now()
  )
  on conflict do nothing;

  return jsonb_build_object(
    'status', 'undone',
    'action_id', p_id,
    'kind', v_action.kind,
    'result', v_undone
  );
end;
$$;

revoke all on function public.undo_robot_auto_action(uuid) from public, anon;
grant execute on function public.undo_robot_auto_action(uuid) to authenticated, service_role;

-- ===========================================================================
-- 8. Read RPCs for the app / edge functions
-- ===========================================================================

create or replace function public.get_robot_auto_actions(p_days integer default 1)
returns table (
  id uuid,
  kind text,
  subject_key text,
  target jsonb,
  payload jsonb,
  robot_probability numeric,
  status text,
  applied_at timestamptz,
  undone_by uuid,
  undone_at timestamptz,
  item_name text,
  raw_name text,
  class_label text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null
       or (not public.q7_material_inventory_can_view(v_actor)
           and not public.has_role(v_actor, 'owner')) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  return query
  select
    a.id,
    a.kind,
    a.subject_key,
    a.target,
    a.payload,
    a.robot_probability,
    a.status,
    a.applied_at,
    a.undone_by,
    a.undone_at,
    coalesce(kii.name, ps.product_name) as item_name,
    a.payload ->> 'raw_name' as raw_name,
    case
      when a.kind = 'catalog_class' then
        coalesce(a.target ->> 'item_class', a.payload ->> 'proposed_class')
      else null
    end as class_label
  from public.robot_auto_actions a
  left join public.kitchen_inventory_items kii
    on kii.id = nullif(a.target ->> 'item_id', '')::uuid
  left join public.product_skus ps
    on kii.id is null and ps.id = nullif(a.target ->> 'item_id', '')::uuid
  where a.applied_at >= now() - make_interval(days => greatest(1, coalesce(p_days, 1)))
  order by a.applied_at desc, a.id desc
  limit 500;
end;
$$;

revoke all on function public.get_robot_auto_actions(integer) from public, anon;
grant execute on function public.get_robot_auto_actions(integer) to authenticated, service_role;

create or replace function public.get_robot_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_settings public.robot_settings%rowtype;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role'
     and not public.has_role(v_actor, 'owner') then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  select * into v_settings from public.robot_settings where id = true;
  return to_jsonb(v_settings);
end;
$$;

revoke all on function public.get_robot_settings() from public, anon;
grant execute on function public.get_robot_settings() to authenticated, service_role;

create or replace function public.set_robot_settings(
  p_auto_apply_enabled boolean default null,
  p_alias_threshold numeric default null,
  p_class_threshold numeric default null,
  p_daily_cap integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_settings public.robot_settings%rowtype;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role'
     and not public.has_role(v_actor, 'owner') then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  if p_alias_threshold is not null and (p_alias_threshold < 0 or p_alias_threshold > 1) then
    raise exception 'invalid_threshold' using errcode = '22023';
  end if;
  if p_class_threshold is not null and (p_class_threshold < 0 or p_class_threshold > 1) then
    raise exception 'invalid_threshold' using errcode = '22023';
  end if;
  if p_daily_cap is not null and (p_daily_cap < 0 or p_daily_cap > 10000) then
    raise exception 'invalid_cap' using errcode = '22023';
  end if;

  update public.robot_settings
    set auto_apply_enabled = coalesce(p_auto_apply_enabled, auto_apply_enabled),
        alias_threshold = coalesce(p_alias_threshold, alias_threshold),
        class_threshold = coalesce(p_class_threshold, class_threshold),
        daily_cap = coalesce(p_daily_cap, daily_cap),
        updated_by = v_actor,
        updated_at = now()
    where id = true
    returning * into v_settings;

  return to_jsonb(v_settings);
end;
$$;

revoke all on function public.set_robot_settings(boolean, numeric, numeric, integer) from public, anon;
grant execute on function public.set_robot_settings(boolean, numeric, numeric, integer) to authenticated, service_role;
