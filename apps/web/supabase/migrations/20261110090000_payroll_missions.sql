-- ============================================================================
-- Migration: Nhiệm vụ tháng + quà bất ngờ sau chấm công (payroll_bn)
--            (luong.banhmique.vn · chưa áp production)
--
-- Adds a generic, data-driven monthly mission campaign model:
--   * payroll_mission_campaigns   — title/window/eligible groups/items/rules/draw
--   * payroll_mission_offers      — per-employee gift toggle + accept/decline
--   * payroll_mission_reviews     — final manager confirmation / disqualification
--   * payroll_mission_draw_tickets— one quarterly ticket per earned employee
--   * payroll_mission_events      — append-only audit of every mission write
--
-- All campaign content (items, labels, rules, draw info) lives in data. No
-- mission text or amount is hard-coded in SQL or in application code. Reward
-- amounts are always read back from payroll_mission_campaigns.items; the review
-- RPC accepts only earned item keys, never a client-supplied amount.
--
-- The old payroll_bn_mission* tables from 20261011090000 are untouched and
-- unused by this feature. GPS attendance, consent evidence, locked payroll
-- periods and published payslips are not modified. This migration has NOT been
-- applied to production.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Campaign definition (all content is configuration)
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_mission_campaigns (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  summary text,
  starts_on date not null,
  ends_on date not null,
  eligible_groups text[] not null default '{}'::text[],
  items jsonb not null,
  rules text[] not null default '{}'::text[],
  draw jsonb,
  status text not null default 'draft',
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_mission_campaigns_code_not_blank
    check (length(btrim(code)) > 0),
  constraint payroll_mission_campaigns_title_not_blank
    check (length(btrim(title)) > 0),
  constraint payroll_mission_campaigns_range_check
    check (ends_on >= starts_on),
  constraint payroll_mission_campaigns_status_check
    check (status in ('draft', 'active', 'closed')),
  constraint payroll_mission_campaigns_items_array_check
    check (jsonb_typeof(items) = 'array'),
  constraint payroll_mission_campaigns_draw_object_check
    check (draw is null or jsonb_typeof(draw) = 'object')
);

create index if not exists payroll_mission_campaigns_window_idx
  on public.payroll_mission_campaigns(starts_on, ends_on);
create index if not exists payroll_mission_campaigns_status_idx
  on public.payroll_mission_campaigns(status, starts_on desc);

drop trigger if exists set_updated_at_payroll_mission_campaigns
  on public.payroll_mission_campaigns;
create trigger set_updated_at_payroll_mission_campaigns
before update on public.payroll_mission_campaigns
for each row execute function public.handle_updated_at();

comment on table public.payroll_mission_campaigns is
  'Data-driven monthly mission campaign. items/rules/draw are configuration edited by the Maestro through the owner/payroll.edit RPC; no mission content is hard-coded.';
comment on column public.payroll_mission_campaigns.items is
  'Array of {key,label,detail,kind,amount_vnd,params}. kind is attendance_regular|punctual|draw_ticket|manual. Keys are unique and amounts are non-negative.';
comment on column public.payroll_mission_campaigns.eligible_groups is
  'payroll_bn groups eligible for this campaign. Empty means every group (all payroll_bn employees).';

-- ---------------------------------------------------------------------------
-- 2) Per-employee offer + manager gift toggle
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_mission_offers (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.payroll_mission_campaigns(id) on delete cascade,
  employee_code text not null,
  gift_enabled boolean not null default true,
  status text not null default 'pending',
  shift_start time,
  offered_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint payroll_mission_offers_employee_code_not_blank
    check (length(btrim(employee_code)) > 0),
  constraint payroll_mission_offers_status_check
    check (status in ('pending', 'accepted', 'declined')),
  constraint payroll_mission_offers_response_check check (
    (status = 'pending' and responded_at is null)
    or (status in ('accepted', 'declined') and responded_at is not null)
  ),
  constraint payroll_mission_offers_unique
    unique (campaign_id, employee_code)
);

create index if not exists payroll_mission_offers_campaign_idx
  on public.payroll_mission_offers(campaign_id, status);
create index if not exists payroll_mission_offers_employee_idx
  on public.payroll_mission_offers(employee_code, offered_at desc);

comment on table public.payroll_mission_offers is
  'One offer row per campaign/employee. gift_enabled is the manager toggle: a disabled pending row is hidden from the employee; accepted/declined history is kept.';
comment on column public.payroll_mission_offers.shift_start is
  'Optional per-employee punctual cutoff override. NULL falls back to the punctual item params.cutoff (default 07:00).';

-- ---------------------------------------------------------------------------
-- 3) Final manager review (amounts derived from campaign items)
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_mission_reviews (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null unique references public.payroll_mission_offers(id) on delete cascade,
  earned jsonb not null default '[]'::jsonb,
  disqualified boolean not null default false,
  disqualify_reason text,
  reviewed_by uuid default auth.uid() references auth.users(id) on delete set null,
  reviewed_at timestamptz not null default now(),
  constraint payroll_mission_reviews_earned_array_check
    check (jsonb_typeof(earned) = 'array'),
  constraint payroll_mission_reviews_reason_check
    check (disqualify_reason is null or length(disqualify_reason) <= 1000)
);

create index if not exists payroll_mission_reviews_reviewed_idx
  on public.payroll_mission_reviews(reviewed_at desc, offer_id);

comment on table public.payroll_mission_reviews is
  'Final manager confirmation for one accepted offer. earned is [{key,amount_vnd}] copied from the campaign items by the RPC, never from client input. A disqualified review always stores earned = [].';

-- ---------------------------------------------------------------------------
-- 4) Quarterly draw tickets
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_mission_draw_tickets (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.payroll_mission_campaigns(id) on delete cascade,
  employee_code text not null,
  quarter text not null,
  issued_at timestamptz not null default now(),
  void_reason text,
  constraint payroll_mission_draw_tickets_employee_code_not_blank
    check (length(btrim(employee_code)) > 0),
  constraint payroll_mission_draw_tickets_quarter_not_blank
    check (length(btrim(quarter)) > 0),
  constraint payroll_mission_draw_tickets_unique
    unique (campaign_id, employee_code)
);

create index if not exists payroll_mission_draw_tickets_quarter_idx
  on public.payroll_mission_draw_tickets(quarter, employee_code);

comment on table public.payroll_mission_draw_tickets is
  'One quarterly draw ticket per campaign/employee. Issued only with at least one earned item and a draw_ticket campaign item; void_reason records disqualification, zero earned items or an employee who left before the draw date.';

-- ---------------------------------------------------------------------------
-- 5) Append-only audit for every mission write
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_mission_events (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid,
  offer_id uuid,
  action text not null,
  actor_id uuid default auth.uid() references auth.users(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint payroll_mission_events_action_not_blank
    check (length(btrim(action)) > 0),
  constraint payroll_mission_events_payload_object_check
    check (jsonb_typeof(payload) = 'object')
);

create index if not exists payroll_mission_events_campaign_idx
  on public.payroll_mission_events(campaign_id, created_at desc);
create index if not exists payroll_mission_events_offer_idx
  on public.payroll_mission_events(offer_id, created_at desc);

create or replace function public.reject_payroll_mission_event_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'payroll_mission_events_are_append_only'
    using errcode = '45000';
end;
$$;

drop trigger if exists payroll_mission_events_append_only
  on public.payroll_mission_events;
create trigger payroll_mission_events_append_only
before update or delete on public.payroll_mission_events
for each row execute function public.reject_payroll_mission_event_mutation();

revoke all on function public.reject_payroll_mission_event_mutation()
  from public, anon, authenticated;

comment on table public.payroll_mission_events is
  'Append-only audit history for campaign, offer, review and draw-ticket writes. Rows can never be updated or deleted.';

-- ---------------------------------------------------------------------------
-- 6) Shared validation helpers
-- ---------------------------------------------------------------------------
create or replace function public.payroll_mission_validate_items(p_items jsonb)
returns void
language plpgsql
immutable
set search_path = public
as $$
declare
  v_item jsonb;
  v_index integer := 0;
  v_keys text[] := '{}'::text[];
  v_key text;
  v_kind text;
  v_amount numeric;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'payroll_mission_items_must_be_array' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_index := v_index + 1;

    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'payroll_mission_item_%_must_be_object', v_index using errcode = '22023';
    end if;

    v_key := btrim(coalesce(v_item->>'key', ''));
    if v_key = '' then
      raise exception 'payroll_mission_item_%_key_required', v_index using errcode = '22023';
    end if;
    if v_key = any(v_keys) then
      raise exception 'payroll_mission_item_duplicate_key: %', v_key using errcode = '22023';
    end if;
    v_keys := array_append(v_keys, v_key);

    if btrim(coalesce(v_item->>'label', '')) = '' then
      raise exception 'payroll_mission_item_%_label_required', v_index using errcode = '22023';
    end if;

    v_kind := btrim(coalesce(v_item->>'kind', ''));
    if v_kind not in ('attendance_regular', 'punctual', 'draw_ticket', 'manual') then
      raise exception 'payroll_mission_item_%_invalid_kind', v_index using errcode = '22023';
    end if;

    if not (v_item ? 'amount_vnd') or jsonb_typeof(v_item->'amount_vnd') <> 'number' then
      raise exception 'payroll_mission_item_%_amount_required', v_index using errcode = '22023';
    end if;
    v_amount := (v_item->>'amount_vnd')::numeric;
    if v_amount < 0 then
      raise exception 'payroll_mission_item_%_negative_amount', v_index using errcode = '22023';
    end if;

    if v_item ? 'params'
       and v_item->'params' <> 'null'::jsonb
       and jsonb_typeof(v_item->'params') <> 'object' then
      raise exception 'payroll_mission_item_%_params_must_be_object', v_index using errcode = '22023';
    end if;
  end loop;
end;
$$;

revoke all on function public.payroll_mission_validate_items(jsonb)
  from public, anon, authenticated;
grant execute on function public.payroll_mission_validate_items(jsonb)
  to service_role;

create or replace function public.payroll_mission_groups_overlap(
  p_left text[],
  p_right text[]
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    -- Empty eligible_groups means "every payroll_bn group".
    when coalesce(array_length(p_left, 1), 0) = 0
      or coalesce(array_length(p_right, 1), 0) = 0 then true
    else exists (
      select 1
      from unnest(p_left) as left_group
      where left_group = any(p_right)
    )
  end;
$$;

revoke all on function public.payroll_mission_groups_overlap(text[], text[])
  from public, anon, authenticated;
grant execute on function public.payroll_mission_groups_overlap(text[], text[])
  to service_role;

create or replace function public.payroll_mission_admin_allowed(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or (
      p_uid is not null
      and (
        public.has_role(p_uid, 'owner')
        or public.has_module_permission(p_uid, 'payroll', 'edit')
      )
    );
$$;

revoke all on function public.payroll_mission_admin_allowed(uuid)
  from public, anon;
grant execute on function public.payroll_mission_admin_allowed(uuid)
  to authenticated, service_role;

create or replace function public.payroll_mission_assert_no_active_overlap(
  p_campaign_id uuid,
  p_starts_on date,
  p_ends_on date,
  p_groups text[]
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on then
    raise exception 'payroll_mission_campaign_invalid_window' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.payroll_mission_campaigns c
    where c.status = 'active'
      and (p_campaign_id is null or c.id <> p_campaign_id)
      and c.starts_on <= p_ends_on
      and c.ends_on >= p_starts_on
      and public.payroll_mission_groups_overlap(
        c.eligible_groups,
        coalesce(p_groups, '{}'::text[])
      )
  ) then
    raise exception 'payroll_mission_active_campaign_overlap' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.payroll_mission_assert_no_active_overlap(uuid, date, date, text[])
  from public, anon, authenticated;
grant execute on function public.payroll_mission_assert_no_active_overlap(uuid, date, date, text[])
  to service_role;

create or replace function public.payroll_mission_employee_left_before(
  p_employee_code text,
  p_draw_date date
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select (not coalesce(bool_or(e.end_date is null), false))
        and max(e.end_date) is not null
        and max(e.end_date) < p_draw_date
      from public.payroll_bn_period_employees e
      where e.employee_code = p_employee_code
    ),
    false
  );
$$;

revoke all on function public.payroll_mission_employee_left_before(text, date)
  from public, anon, authenticated;
grant execute on function public.payroll_mission_employee_left_before(text, date)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7) Progress from the immutable attendance ledger (provisional only)
-- ---------------------------------------------------------------------------
create or replace function public.payroll_mission_progress(p_offer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_offer public.payroll_mission_offers%rowtype;
  v_campaign public.payroll_mission_campaigns%rowtype;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_from date;
  v_to date;
  v_days_with_in integer := 0;
  v_days_complete integer := 0;
  v_days_missing_out integer := 0;
  v_on_time integer := 0;
  v_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_kind text;
  v_params jsonb;
  v_min_days integer;
  v_grace_minutes integer;
  v_cutoff time;
  v_cutoff_text text;
  v_met boolean;
begin
  select * into v_offer
  from public.payroll_mission_offers
  where id = p_offer_id;

  if v_offer.id is null then
    return '[]'::jsonb;
  end if;

  select * into v_campaign
  from public.payroll_mission_campaigns
  where id = v_offer.campaign_id;

  if v_campaign.id is null then
    return '[]'::jsonb;
  end if;

  -- A campaign can only count attendance from the day the employee accepted
  -- the offer, never before. The window also stops at today in Vietnam.
  v_from := greatest(
    v_campaign.starts_on,
    case
      when v_offer.status = 'accepted' and v_offer.responded_at is not null
        then (v_offer.responded_at at time zone 'Asia/Ho_Chi_Minh')::date
      else v_campaign.starts_on
    end
  );
  v_to := least(v_campaign.ends_on, v_today);

  if v_to >= v_from then
    with accepted_in as (
      select distinct on (e.work_date)
        e.work_date
      from public.payroll_bn_attendance_events e
      where e.employee_code = v_offer.employee_code
        and e.decision = 'accepted'
        and e.event_kind = 'in'
        and e.work_date between v_from and v_to
      order by e.work_date, e.server_received_at asc
    ), accepted_out as (
      select distinct e.work_date
      from public.payroll_bn_attendance_events e
      where e.employee_code = v_offer.employee_code
        and e.decision = 'accepted'
        and e.event_kind = 'out'
        and e.work_date between v_from and v_to
    )
    select
      count(*),
      count(*) filter (where o.work_date is not null),
      count(*) filter (where o.work_date is null)
    into v_days_with_in, v_days_complete, v_days_missing_out
    from accepted_in i
    left join accepted_out o using (work_date);
  end if;

  for v_item in select value from jsonb_array_elements(v_campaign.items) loop
    v_kind := v_item->>'kind';
    v_params := coalesce(v_item->'params', '{}'::jsonb);

    v_min_days := case
      when coalesce(v_params->>'min_days', '') ~ '^[0-9]+$'
        then (v_params->>'min_days')::integer
      else 1
    end;

    v_grace_minutes := case
      when coalesce(v_params->>'grace_minutes', '') ~ '^[0-9]+$'
        then (v_params->>'grace_minutes')::integer
      else 0
    end;

    if v_offer.shift_start is not null then
      v_cutoff := v_offer.shift_start;
    else
      v_cutoff_text := nullif(btrim(coalesce(v_params->>'cutoff', '')), '');
      if v_cutoff_text is null then
        v_cutoff := time '07:00';
      elsif v_cutoff_text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' then
        v_cutoff := v_cutoff_text::time;
      else
        v_cutoff := time '07:00';
      end if;
    end if;

    v_on_time := 0;
    if v_to >= v_from then
      select count(*)
      into v_on_time
      from (
        select distinct on (e.work_date)
          (e.server_received_at at time zone 'Asia/Ho_Chi_Minh')::time as local_in_time
        from public.payroll_bn_attendance_events e
        where e.employee_code = v_offer.employee_code
          and e.decision = 'accepted'
          and e.event_kind = 'in'
          and e.work_date between v_from and v_to
        order by e.work_date, e.server_received_at asc
      ) d
      where d.local_in_time <= v_cutoff + make_interval(mins => v_grace_minutes);
    end if;

    if v_kind = 'attendance_regular' then
      v_met := v_days_with_in >= v_min_days and v_days_missing_out = 0;
    elsif v_kind = 'punctual' then
      v_met := v_days_with_in >= 1 and v_on_time = v_days_with_in;
    else
      v_met := false;
    end if;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'key', v_item->>'key',
      'kind', v_kind,
      'met', v_met,
      'detail', jsonb_build_object(
        'days_with_in', v_days_with_in,
        'days_complete', v_days_complete,
        'days_missing_out', v_days_missing_out,
        'on_time_days', v_on_time,
        'min_days', v_min_days,
        'grace_minutes', v_grace_minutes,
        'cutoff', to_char(v_cutoff, 'HH24:MI'),
        'window_from', v_from,
        'window_to', v_to
      )
    ));
  end loop;

  return v_items;
end;
$$;

revoke all on function public.payroll_mission_progress(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_mission_progress(uuid)
  to service_role;

comment on function public.payroll_mission_progress(uuid) is
  'Provisional per-item mission progress from payroll_bn_attendance_events, starting at the accepted date. The manager review is final.';

-- ---------------------------------------------------------------------------
-- 8) Owner/manager RPCs
-- ---------------------------------------------------------------------------
create or replace function public.upsert_payroll_mission_campaign(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_existing public.payroll_mission_campaigns%rowtype;
  v_campaign public.payroll_mission_campaigns%rowtype;
  v_id uuid;
  v_code text;
  v_title text;
  v_summary text;
  v_starts_on date;
  v_ends_on date;
  v_groups text[];
  v_items jsonb;
  v_rules text[];
  v_draw jsonb;
  v_status text;
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_mission_forbidden' using errcode = '42501';
  end if;

  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'payroll_mission_campaign_payload_required' using errcode = '22023';
  end if;

  v_id := nullif(btrim(coalesce(p->>'id', '')), '')::uuid;

  if v_id is not null then
    select * into v_existing
    from public.payroll_mission_campaigns
    where id = v_id
    for update;

    if v_existing.id is null then
      raise exception 'payroll_mission_campaign_not_found' using errcode = 'P0002';
    end if;
  else
    v_code := nullif(btrim(coalesce(p->>'code', '')), '');
    if v_code is not null then
      select * into v_existing
      from public.payroll_mission_campaigns
      where code = v_code
      for update;
    end if;
  end if;

  if v_existing.id is not null and v_existing.status = 'closed' then
    raise exception 'payroll_mission_campaign_closed' using errcode = '22023';
  end if;

  v_code := coalesce(nullif(btrim(coalesce(p->>'code', '')), ''), v_existing.code);
  if v_code is null or v_code = '' then
    raise exception 'payroll_mission_campaign_code_required' using errcode = '22023';
  end if;

  v_title := coalesce(nullif(btrim(coalesce(p->>'title', '')), ''), v_existing.title);
  if v_title is null or v_title = '' then
    raise exception 'payroll_mission_campaign_title_required' using errcode = '22023';
  end if;

  v_summary := case when p ? 'summary' then nullif(btrim(coalesce(p->>'summary', '')), '') else v_existing.summary end;

  v_starts_on := coalesce(
    nullif(btrim(coalesce(p->>'starts_on', '')), '')::date,
    v_existing.starts_on
  );
  v_ends_on := coalesce(
    nullif(btrim(coalesce(p->>'ends_on', '')), '')::date,
    v_existing.ends_on
  );
  if v_starts_on is null or v_ends_on is null or v_ends_on < v_starts_on then
    raise exception 'payroll_mission_campaign_invalid_window' using errcode = '22023';
  end if;

  if p ? 'eligible_groups' and p->'eligible_groups' <> 'null'::jsonb then
    if jsonb_typeof(p->'eligible_groups') <> 'array' then
      raise exception 'payroll_mission_eligible_groups_must_be_array' using errcode = '22023';
    end if;
    v_groups := array(
      select btrim(value)
      from jsonb_array_elements_text(p->'eligible_groups') as value
      where btrim(value) <> ''
    );
  else
    v_groups := coalesce(v_existing.eligible_groups, '{}'::text[]);
  end if;

  v_items := case when p ? 'items' then p->'items' else v_existing.items end;
  perform public.payroll_mission_validate_items(v_items);

  if p ? 'rules' and p->'rules' <> 'null'::jsonb then
    if jsonb_typeof(p->'rules') <> 'array' then
      raise exception 'payroll_mission_rules_must_be_array' using errcode = '22023';
    end if;
    v_rules := array(
      select value
      from jsonb_array_elements_text(p->'rules') as value
    );
  else
    v_rules := coalesce(v_existing.rules, '{}'::text[]);
  end if;

  if p ? 'draw' and p->'draw' <> 'null'::jsonb then
    if jsonb_typeof(p->'draw') <> 'object' then
      raise exception 'payroll_mission_draw_must_be_object' using errcode = '22023';
    end if;
    v_draw := p->'draw';
  elsif p ? 'draw' then
    v_draw := null;
  else
    v_draw := v_existing.draw;
  end if;

  v_status := coalesce(nullif(btrim(coalesce(p->>'status', '')), ''), v_existing.status, 'draft');
  if v_status not in ('draft', 'active') then
    raise exception 'payroll_mission_invalid_status' using errcode = '22023';
  end if;

  if v_status = 'active' then
    perform public.payroll_mission_assert_no_active_overlap(
      v_existing.id,
      v_starts_on,
      v_ends_on,
      v_groups
    );
  end if;

  if v_existing.id is null then
    insert into public.payroll_mission_campaigns(
      code,
      title,
      summary,
      starts_on,
      ends_on,
      eligible_groups,
      items,
      rules,
      draw,
      status,
      created_by
    ) values (
      v_code,
      v_title,
      v_summary,
      v_starts_on,
      v_ends_on,
      v_groups,
      v_items,
      v_rules,
      v_draw,
      v_status,
      v_uid
    )
    returning * into v_campaign;
  else
    update public.payroll_mission_campaigns
    set code = v_code,
        title = v_title,
        summary = v_summary,
        starts_on = v_starts_on,
        ends_on = v_ends_on,
        eligible_groups = v_groups,
        items = v_items,
        rules = v_rules,
        draw = v_draw,
        status = v_status,
        updated_at = now()
    where id = v_existing.id
    returning * into v_campaign;
  end if;

  return jsonb_build_object('campaign', to_jsonb(v_campaign));
end;
$$;

revoke all on function public.upsert_payroll_mission_campaign(jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_payroll_mission_campaign(jsonb)
  to authenticated, service_role;

create or replace function public.set_payroll_mission_campaign_status(
  p_campaign_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_campaign public.payroll_mission_campaigns%rowtype;
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_mission_forbidden' using errcode = '42501';
  end if;

  if v_status not in ('draft', 'active', 'closed') then
    raise exception 'payroll_mission_invalid_status' using errcode = '22023';
  end if;

  select * into v_campaign
  from public.payroll_mission_campaigns
  where id = p_campaign_id
  for update;

  if v_campaign.id is null then
    raise exception 'payroll_mission_campaign_not_found' using errcode = 'P0002';
  end if;

  if v_status = 'active' then
    perform public.payroll_mission_assert_no_active_overlap(
      v_campaign.id,
      v_campaign.starts_on,
      v_campaign.ends_on,
      v_campaign.eligible_groups
    );
  end if;

  update public.payroll_mission_campaigns
  set status = v_status,
      updated_at = now()
  where id = v_campaign.id
  returning * into v_campaign;

  return jsonb_build_object('campaign', to_jsonb(v_campaign));
end;
$$;

revoke all on function public.set_payroll_mission_campaign_status(uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_payroll_mission_campaign_status(uuid, text)
  to authenticated, service_role;

create or replace function public.set_payroll_mission_gift(
  p_campaign_id uuid,
  p_employee_code text,
  p_enabled boolean,
  p_shift_start time default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_employee_code text := btrim(coalesce(p_employee_code, ''));
  v_campaign public.payroll_mission_campaigns%rowtype;
  v_offer public.payroll_mission_offers%rowtype;
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_mission_forbidden' using errcode = '42501';
  end if;

  if v_employee_code = '' then
    raise exception 'payroll_mission_employee_required' using errcode = '22023';
  end if;

  select * into v_campaign
  from public.payroll_mission_campaigns
  where id = p_campaign_id;

  if v_campaign.id is null then
    raise exception 'payroll_mission_campaign_not_found' using errcode = 'P0002';
  end if;

  if v_campaign.status = 'closed' then
    raise exception 'payroll_mission_campaign_closed' using errcode = '22023';
  end if;

  insert into public.payroll_mission_offers as offer(
    campaign_id,
    employee_code,
    gift_enabled,
    status,
    shift_start,
    offered_at
  ) values (
    v_campaign.id,
    v_employee_code,
    coalesce(p_enabled, false),
    'pending',
    p_shift_start,
    now()
  )
  on conflict (campaign_id, employee_code) do update
  set gift_enabled = excluded.gift_enabled,
      -- A later bulk toggle must not wipe a per-employee cutoff override.
      shift_start = coalesce(excluded.shift_start, offer.shift_start),
      offered_at = case
        when excluded.gift_enabled and offer.status = 'pending'
          then now()
        else offer.offered_at
      end
  returning * into v_offer;

  return jsonb_build_object('offer', to_jsonb(v_offer));
end;
$$;

revoke all on function public.set_payroll_mission_gift(uuid, text, boolean, time)
  from public, anon, authenticated;
grant execute on function public.set_payroll_mission_gift(uuid, text, boolean, time)
  to authenticated, service_role;

create or replace function public.set_payroll_mission_gift_bulk(
  p_campaign_id uuid,
  p_employee_codes text[],
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_employee_code text;
  v_count integer := 0;
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_mission_forbidden' using errcode = '42501';
  end if;

  if p_employee_codes is null then
    raise exception 'payroll_mission_employee_codes_required' using errcode = '22023';
  end if;

  for v_employee_code in
    select distinct btrim(value)
    from unnest(p_employee_codes) as value
    where btrim(value) <> ''
  loop
    perform public.set_payroll_mission_gift(
      p_campaign_id,
      v_employee_code,
      p_enabled,
      null
    );
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('updated', v_count);
end;
$$;

revoke all on function public.set_payroll_mission_gift_bulk(uuid, text[], boolean)
  from public, anon, authenticated;
grant execute on function public.set_payroll_mission_gift_bulk(uuid, text[], boolean)
  to authenticated, service_role;

create or replace function public.list_payroll_missions(p_campaign_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_campaigns jsonb;
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_mission_forbidden' using errcode = '42501';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'code', c.code,
        'title', c.title,
        'summary', c.summary,
        'starts_on', c.starts_on,
        'ends_on', c.ends_on,
        'eligible_groups', to_jsonb(c.eligible_groups),
        'items', c.items,
        'rules', to_jsonb(c.rules),
        'draw', c.draw,
        'status', c.status,
        'created_by', c.created_by,
        'created_at', c.created_at,
        'updated_at', c.updated_at,
        'offers', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', o.id,
              'campaign_id', o.campaign_id,
              'employee_code', o.employee_code,
              'gift_enabled', o.gift_enabled,
              'status', o.status,
              'shift_start', o.shift_start,
              'offered_at', o.offered_at,
              'responded_at', o.responded_at,
              'progress', public.payroll_mission_progress(o.id),
              'review', (
                select jsonb_build_object(
                  'earned', r.earned,
                  'disqualified', r.disqualified,
                  'disqualify_reason', r.disqualify_reason,
                  'reviewed_by', r.reviewed_by,
                  'reviewed_at', r.reviewed_at
                )
                from public.payroll_mission_reviews r
                where r.offer_id = o.id
              ),
              'ticket', (
                select jsonb_build_object(
                  'quarter', t.quarter,
                  'issued_at', t.issued_at,
                  'void_reason', t.void_reason
                )
                from public.payroll_mission_draw_tickets t
                where t.campaign_id = o.campaign_id
                  and t.employee_code = o.employee_code
              )
            )
            order by o.employee_code
          )
          from public.payroll_mission_offers o
          where o.campaign_id = c.id
        ), '[]'::jsonb)
      )
      order by c.starts_on desc, c.code
    ),
    '[]'::jsonb
  )
  into v_campaigns
  from public.payroll_mission_campaigns c
  where p_campaign_id is null or c.id = p_campaign_id;

  return jsonb_build_object('campaigns', v_campaigns);
end;
$$;

revoke all on function public.list_payroll_missions(uuid)
  from public, anon, authenticated;
grant execute on function public.list_payroll_missions(uuid)
  to authenticated, service_role;

create or replace function public.review_payroll_mission_offer(
  p_offer_id uuid,
  p_earned_keys text[],
  p_disqualified boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_offer public.payroll_mission_offers%rowtype;
  v_campaign public.payroll_mission_campaigns%rowtype;
  v_disqualified boolean := coalesce(p_disqualified, false);
  v_earned jsonb := '[]'::jsonb;
  v_review public.payroll_mission_reviews%rowtype;
  v_ticket public.payroll_mission_draw_tickets%rowtype;
  v_unknown_keys text[];
  v_has_draw_item boolean := false;
  v_earned_count integer := 0;
  v_quarter text;
  v_draw_date date;
  v_draw_date_text text;
  v_left boolean := false;
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_mission_forbidden' using errcode = '42501';
  end if;

  select * into v_offer
  from public.payroll_mission_offers
  where id = p_offer_id
  for update;

  if v_offer.id is null then
    raise exception 'payroll_mission_offer_not_found' using errcode = 'P0002';
  end if;

  select * into v_campaign
  from public.payroll_mission_campaigns
  where id = v_offer.campaign_id;

  if v_campaign.id is null then
    raise exception 'payroll_mission_campaign_not_found' using errcode = 'P0002';
  end if;

  if v_offer.status <> 'accepted' then
    raise exception 'payroll_mission_offer_not_accepted' using errcode = '22023';
  end if;

  -- Amounts never come from the client. Validate the requested keys and copy
  -- label/amount/params from the campaign item itself.
  if not v_disqualified and coalesce(array_length(p_earned_keys, 1), 0) > 0 then
    select array_agg(DISTINCT k)
    into v_unknown_keys
    from unnest(p_earned_keys) as k
    where not exists (
      select 1
      from jsonb_array_elements(v_campaign.items) as item
      where item->>'key' = k
    );

    if v_unknown_keys is not null then
      raise exception 'payroll_mission_unknown_item: %', array_to_string(v_unknown_keys, ',')
        using errcode = '22023';
    end if;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'key', item->>'key',
          'amount_vnd', (item->>'amount_vnd')::numeric
        )
        order by item->>'key'
      ),
      '[]'::jsonb
    )
    into v_earned
    from jsonb_array_elements(v_campaign.items) as item
    where item->>'key' = any(coalesce(p_earned_keys, '{}'::text[]));
  end if;

  if v_disqualified then
    v_earned := '[]'::jsonb;
  end if;

  insert into public.payroll_mission_reviews(
    offer_id,
    earned,
    disqualified,
    disqualify_reason,
    reviewed_by,
    reviewed_at
  ) values (
    v_offer.id,
    v_earned,
    v_disqualified,
    case
      when v_disqualified then nullif(btrim(coalesce(p_reason, '')), '')
      else null
    end,
    v_uid,
    now()
  )
  on conflict (offer_id) do update
  set earned = excluded.earned,
      disqualified = excluded.disqualified,
      disqualify_reason = excluded.disqualify_reason,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at
  returning * into v_review;

  v_earned_count := jsonb_array_length(v_earned);
  select exists (
    select 1
    from jsonb_array_elements(v_campaign.items) as item
    where item->>'kind' = 'draw_ticket'
  ) into v_has_draw_item;

  v_ticket := null;

  if not v_disqualified and v_earned_count > 0 and v_has_draw_item then
    v_quarter := nullif(btrim(coalesce(v_campaign.draw->>'quarter', '')), '');
    if v_quarter is null then
      v_quarter := to_char(v_campaign.ends_on, 'YYYY-"Q"Q');
    end if;

    v_draw_date := null;
    if v_campaign.draw is not null then
      v_draw_date_text := nullif(
        btrim(coalesce(v_campaign.draw->>'draw_after', v_campaign.draw->>'draw_date', '')),
        ''
      );
      if v_draw_date_text is not null then
        begin
          v_draw_date := v_draw_date_text::date;
        exception when others then
          v_draw_date := null;
        end;
      end if;
    end if;

    v_left := public.payroll_mission_employee_left_before(
      v_offer.employee_code,
      v_draw_date
    );

    insert into public.payroll_mission_draw_tickets(
      campaign_id,
      employee_code,
      quarter,
      issued_at,
      void_reason
    ) values (
      v_campaign.id,
      v_offer.employee_code,
      v_quarter,
      now(),
      case when v_left then 'employee_left_before_draw' else null end
    )
    on conflict (campaign_id, employee_code) do update
    set quarter = excluded.quarter,
        issued_at = excluded.issued_at,
        void_reason = excluded.void_reason
    returning * into v_ticket;
  else
    update public.payroll_mission_draw_tickets
    set void_reason = case
      when v_disqualified then 'disqualified'
      when v_earned_count = 0 then 'no_earned_items'
      else 'no_draw_item'
    end
    where campaign_id = v_campaign.id
      and employee_code = v_offer.employee_code
    returning * into v_ticket;
  end if;

  return jsonb_build_object(
    'review', to_jsonb(v_review),
    'ticket', case when v_ticket.id is null then null else to_jsonb(v_ticket) end
  );
end;
$$;

revoke all on function public.review_payroll_mission_offer(uuid, text[], boolean, text)
  from public, anon, authenticated;
grant execute on function public.review_payroll_mission_offer(uuid, text[], boolean, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9) Payroll engine link (confirmed, non-disqualified reviews only)
-- ---------------------------------------------------------------------------
create or replace function public.list_payroll_mission_bonus_for_period(p_period_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_period public.payroll_bn_periods%rowtype;
  v_bonuses jsonb;
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_mission_forbidden' using errcode = '42501';
  end if;

  select * into v_period
  from public.payroll_bn_periods
  where id = p_period_id;

  if v_period.id is null then
    raise exception 'payroll_bn_period_not_found' using errcode = 'P0002';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'employee_code', summary.employee_code,
        'amount_vnd', summary.amount_vnd
      )
      order by summary.employee_code
    ),
    '[]'::jsonb
  )
  into v_bonuses
  from (
    select
      o.employee_code,
      sum((earned_item.value->>'amount_vnd')::numeric) as amount_vnd
    from public.payroll_mission_reviews r
    join public.payroll_mission_offers o on o.id = r.offer_id
    join public.payroll_mission_campaigns c on c.id = o.campaign_id
    cross join lateral jsonb_array_elements(r.earned) as earned_item(value)
    where r.disqualified is false
      and o.status = 'accepted'
      and c.starts_on <= v_period.date_to
      and c.ends_on >= v_period.date_from
      and coalesce(earned_item.value->>'amount_vnd', '') ~ '^[0-9]+([.][0-9]+)?$'
    group by o.employee_code
  ) as summary;

  return v_bonuses;
end;
$$;

revoke all on function public.list_payroll_mission_bonus_for_period(uuid)
  from public, anon, authenticated;
grant execute on function public.list_payroll_mission_bonus_for_period(uuid)
  to authenticated, service_role;

comment on function public.list_payroll_mission_bonus_for_period(uuid) is
  'Confirmed, non-disqualified mission rewards for one payroll period. The amount is summed from review.earned, which the review RPC copied from campaign items.';

-- ---------------------------------------------------------------------------
-- 10) Audit triggers: every mission write is recorded, including the employee
--     accept/decline update made by the payslip-mission Edge Function.
-- ---------------------------------------------------------------------------
create or replace function public.audit_payroll_mission_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_campaign_id uuid;
  v_offer_id uuid;
  v_action_prefix text;
  v_payload jsonb;
begin
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;

  v_action_prefix := case tg_table_name
    when 'payroll_mission_campaigns' then 'campaign'
    when 'payroll_mission_offers' then 'offer'
    when 'payroll_mission_reviews' then 'review'
    when 'payroll_mission_draw_tickets' then 'ticket'
    else 'mission'
  end;

  if tg_table_name = 'payroll_mission_campaigns' then
    v_campaign_id := (v_row->>'id')::uuid;
  elsif tg_table_name = 'payroll_mission_offers' then
    v_campaign_id := (v_row->>'campaign_id')::uuid;
    v_offer_id := (v_row->>'id')::uuid;
  elsif tg_table_name = 'payroll_mission_reviews' then
    v_offer_id := (v_row->>'offer_id')::uuid;
    select o.campaign_id into v_campaign_id
    from public.payroll_mission_offers o
    where o.id = v_offer_id;
  elsif tg_table_name = 'payroll_mission_draw_tickets' then
    v_campaign_id := (v_row->>'campaign_id')::uuid;
    select o.id into v_offer_id
    from public.payroll_mission_offers o
    where o.campaign_id = v_campaign_id
      and o.employee_code = (v_row->>'employee_code');
  end if;

  v_payload := jsonb_build_object(
    'before', case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    'after', case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );

  insert into public.payroll_mission_events(
    campaign_id,
    offer_id,
    action,
    actor_id,
    payload
  ) values (
    v_campaign_id,
    v_offer_id,
    v_action_prefix || '_' || lower(tg_op),
    auth.uid(),
    v_payload
  );

  return coalesce(new, old);
end;
$$;

revoke all on function public.audit_payroll_mission_change()
  from public, anon, authenticated;

drop trigger if exists audit_payroll_mission_campaign_changes
  on public.payroll_mission_campaigns;
create trigger audit_payroll_mission_campaign_changes
after insert or update or delete on public.payroll_mission_campaigns
for each row execute function public.audit_payroll_mission_change();

drop trigger if exists audit_payroll_mission_offer_changes
  on public.payroll_mission_offers;
create trigger audit_payroll_mission_offer_changes
after insert or update or delete on public.payroll_mission_offers
for each row execute function public.audit_payroll_mission_change();

drop trigger if exists audit_payroll_mission_review_changes
  on public.payroll_mission_reviews;
create trigger audit_payroll_mission_review_changes
after insert or update or delete on public.payroll_mission_reviews
for each row execute function public.audit_payroll_mission_change();

drop trigger if exists audit_payroll_mission_ticket_changes
  on public.payroll_mission_draw_tickets;
create trigger audit_payroll_mission_ticket_changes
after insert or update or delete on public.payroll_mission_draw_tickets
for each row execute function public.audit_payroll_mission_change();

-- ---------------------------------------------------------------------------
-- 11) RLS + grants: service_role only. Managers use the SECURITY DEFINER RPCs.
-- ---------------------------------------------------------------------------
alter table public.payroll_mission_campaigns enable row level security;
alter table public.payroll_mission_offers enable row level security;
alter table public.payroll_mission_reviews enable row level security;
alter table public.payroll_mission_draw_tickets enable row level security;
alter table public.payroll_mission_events enable row level security;

revoke all on table public.payroll_mission_campaigns from public, anon, authenticated;
revoke all on table public.payroll_mission_offers from public, anon, authenticated;
revoke all on table public.payroll_mission_reviews from public, anon, authenticated;
revoke all on table public.payroll_mission_draw_tickets from public, anon, authenticated;
revoke all on table public.payroll_mission_events from public, anon, authenticated;

grant all on table public.payroll_mission_campaigns to service_role;
grant all on table public.payroll_mission_offers to service_role;
grant all on table public.payroll_mission_reviews to service_role;
grant all on table public.payroll_mission_draw_tickets to service_role;
grant all on table public.payroll_mission_events to service_role;

comment on function public.upsert_payroll_mission_campaign(jsonb) is
  'Create/update a draft or active campaign. Owner or payroll.edit only. Validates every item (unique keys, known kinds, non-negative amounts).';
comment on function public.set_payroll_mission_campaign_status(uuid, text) is
  'Switch a campaign between draft/active/closed. Activation rejects an overlapping active campaign for any shared eligible group.';
comment on function public.set_payroll_mission_gift(uuid, text, boolean, time) is
  'Manager gift toggle for one employee. Enabling creates a pending offer; disabling a pending offer hides it while accepted/declined history remains.';
comment on function public.set_payroll_mission_gift_bulk(uuid, text[], boolean) is
  'Manager "Gửi quà cho toàn bộ": apply the gift toggle to a list of employees.';
comment on function public.list_payroll_missions(uuid) is
  'Manager list of campaigns with offers, provisional progress, final review and draw ticket.';
comment on function public.review_payroll_mission_offer(uuid, text[], boolean, text) is
  'Final review of an accepted offer. Earned amounts come only from campaign items; disqualified forces earned=[] and voids the ticket.';
