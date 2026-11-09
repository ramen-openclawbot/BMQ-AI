-- ============================================================================
-- Migration: Bếp BN employee shift starts (manual, shared across periods)
--
-- Persists one manual shift start time per employee_code, independent of any
-- payroll period. payroll_mission_progress uses it as the punctual cutoff:
--   offer.shift_start -> employee shift start -> item params.cutoff -> 07:00
--
-- Authorization mirrors payroll_bn_employee_contacts: owner or payroll editors
-- can read/write; anon has no access. No UI is included and this migration has
-- NOT been applied to production.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Employee shift start — one row per employee code, shared across periods
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_employee_shifts (
  employee_code text primary key check (length(btrim(employee_code)) > 0),
  shift_start time not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references auth.users(id) on delete set null
);

drop trigger if exists set_updated_at_payroll_bn_employee_shifts on public.payroll_bn_employee_shifts;
create trigger set_updated_at_payroll_bn_employee_shifts
  before update on public.payroll_bn_employee_shifts
  for each row execute function public.handle_updated_at();

alter table public.payroll_bn_employee_shifts enable row level security;

-- Same who-can-do-what as payroll_bn_employee_contacts: owner or payroll.edit.
drop policy if exists payroll_bn_employee_shifts_select on public.payroll_bn_employee_shifts;
create policy payroll_bn_employee_shifts_select on public.payroll_bn_employee_shifts
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_employee_shifts_insert on public.payroll_bn_employee_shifts;
create policy payroll_bn_employee_shifts_insert on public.payroll_bn_employee_shifts
  for insert to authenticated
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_employee_shifts_update on public.payroll_bn_employee_shifts;
create policy payroll_bn_employee_shifts_update on public.payroll_bn_employee_shifts
  for update to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_employee_shifts_delete on public.payroll_bn_employee_shifts;
create policy payroll_bn_employee_shifts_delete on public.payroll_bn_employee_shifts
  for delete to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

-- This project has no default table grants, so every grant stays explicit.
revoke all on public.payroll_bn_employee_shifts from public, anon, authenticated;
grant select, insert, update, delete on public.payroll_bn_employee_shifts to authenticated;
grant all on public.payroll_bn_employee_shifts to service_role;

-- ---------------------------------------------------------------------------
-- Progress from the immutable attendance ledger (provisional only)
--
-- Identical to 20261110090000 except the punctual cutoff now falls back to the
-- employee's manual shift start before the item params.cutoff:
--   offer.shift_start -> payroll_bn_employee_shifts.shift_start -> params.cutoff
--   -> 07:00
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
      select s.shift_start
      into v_cutoff
      from public.payroll_bn_employee_shifts s
      where s.employee_code = v_offer.employee_code;

      if v_cutoff is null then
        v_cutoff_text := nullif(btrim(coalesce(v_params->>'cutoff', '')), '');
        if v_cutoff_text is null then
          v_cutoff := time '07:00';
        elsif v_cutoff_text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' then
          v_cutoff := v_cutoff_text::time;
        else
          v_cutoff := time '07:00';
        end if;
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
  'Provisional per-item mission progress from payroll_bn_attendance_events, starting at the accepted date. Punctual cutoff: offer shift_start, employee shift start, item params.cutoff, 07:00. The manager review is final.';
