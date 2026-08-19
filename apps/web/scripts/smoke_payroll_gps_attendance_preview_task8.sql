-- Task8 rollback-only runtime smoke for GPS attendance payroll preview.
-- Execute after applying Task3-8 migrations in a disposable/local database.

begin;

-- Self-contained prerequisites for disposable/local rollback smoke when the full app schema is absent.
create extension if not exists pgcrypto;
create schema if not exists auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
do $$ begin
  if to_regprocedure('auth.uid()') is null then
    create function auth.uid() returns uuid language sql stable as $fn$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $fn$;
  end if;
end $$;
create table if not exists public.user_module_permissions(user_id uuid not null, module_key text not null, can_view boolean not null default false, can_edit boolean not null default false, primary key(user_id, module_key));
create or replace function public.has_role(p_user_id uuid, p_role text) returns boolean language sql stable as $$ select false $$;
create or replace function public.has_module_permission(p_user_id uuid, p_module text, p_action text) returns boolean language sql stable as $$
  select exists (
    select 1 from public.user_module_permissions p
    where p.user_id = p_user_id and p.module_key = p_module
      and ((p_action = 'view' and p.can_view) or (p_action = 'edit' and p.can_edit))
  )
$$;
create table if not exists public.payroll_runs(id uuid primary key, period_code text, period_name text, period_from date, period_to date, status text, total_gross numeric default 0, total_deductions numeric default 0, total_net numeric default 0);
create table if not exists public.payroll_lines(id uuid primary key, payroll_run_id uuid, employee_code text, employee_name text, wage_type_snapshot text, total_days_present integer, net_amount numeric, snapshot jsonb);
create unique index if not exists task8_smoke_payroll_lines_run_employee_idx on public.payroll_lines(payroll_run_id, employee_code);
create table if not exists public.kiosk_report_locations(id uuid primary key, location_code text, location_name text, active boolean);
create table if not exists public.kiosk_report_staff(id uuid primary key, full_name text, phone_raw text, phone_normalized text, location_id uuid, active boolean);
create table if not exists public.delivery_staff(id uuid primary key, full_name text, phone_raw text, phone_normalized text, active boolean);
create table if not exists public.kiosk_report_sessions(id uuid primary key, actor_type text, staff_id uuid, location_id uuid, delivery_staff_id uuid, token_hash text, expires_at timestamptz, created_at timestamptz);
create table if not exists public.attendance_geofence_locations(id uuid primary key, code text, name text, location_type text, kiosk_location_id uuid, latitude numeric, longitude numeric, accepted_radius_m integer, active boolean);
create table if not exists public.mobile_gps_attendance_events(id uuid primary key, actor_type text, kiosk_report_staff_id uuid, delivery_staff_id uuid, work_date date, device_latitude numeric, device_longitude numeric, device_accuracy_m numeric, device_captured_at timestamptz, geofence_location_id uuid, geofence_code text, geofence_name text, geofence_location_type text, geofence_latitude numeric, geofence_longitude numeric, geofence_radius_m integer, distance_m numeric, decision text, reason_code text, session_id uuid, request_ip_hash text, request_user_agent text, created_at timestamptz);
create table if not exists public.mobile_gps_attendance_manual_overrides(id uuid primary key, gps_event_id uuid, actor_type text, kiosk_report_staff_id uuid, delivery_staff_id uuid, work_date date, override_decision text, reason_code text, reason_note text, created_by uuid, created_at timestamptz);
create table if not exists public.attendance_records(id uuid primary key, employee_code text, employee_name text, work_date date, actual_check_in timestamptz, status text, source_type text, locked_by_hr boolean default false);
create unique index if not exists task8_smoke_attendance_records_employee_date_idx on public.attendance_records(employee_code, work_date);


create or replace function public.get_payroll_gps_attendance_preview(
  p_payroll_run_id uuid,
  p_preview_only boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_run public.payroll_runs%rowtype;
  v_payload jsonb;
  v_preview_setting text := lower(coalesce(nullif(current_setting('payroll.gps_preview_only', true), ''), 'on'));
begin
  if p_preview_only is not true or v_preview_setting in ('off', 'false', '0', 'disabled') then
    raise exception 'payroll_gps_preview_preview_only_required' using errcode = '42501';
  end if;

  if v_actor is null or not (
    public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'payroll', 'view')
    or public.has_module_permission(v_actor, 'payroll', 'edit')
  ) then
    raise exception 'payroll_gps_preview_forbidden' using errcode = '42501';
  end if;

  select * into v_run
  from public.payroll_runs
  where id = p_payroll_run_id;

  if v_run.id is null then
    raise exception 'payroll_gps_preview_run_not_found' using errcode = '22023';
  end if;

  if v_run.period_to < v_run.period_from then
    raise exception 'payroll_gps_preview_invalid_date_range' using errcode = '22007';
  end if;

  if v_run.period_to - v_run.period_from > 61
     and not (
       v_run.period_from = date_trunc('month', v_run.period_from::timestamp)::date
       and v_run.period_to = (date_trunc('month', v_run.period_from::timestamp) + interval '1 month - 1 day')::date
     ) then
    raise exception 'payroll_gps_preview_date_range_too_broad' using errcode = '22023';
  end if;

  with gps_events as (
    select
      case
        when e.actor_type = 'report_staff' then 'KIOSK:' || e.kiosk_report_staff_id::text
        when e.actor_type = 'delivery_staff' then 'DELIVERY:' || e.delivery_staff_id::text
        else e.actor_type || ':unknown'
      end as employee_code,
      case
        when e.actor_type = 'report_staff' then coalesce(nullif(btrim(ks.full_name), ''), 'KIOSK:' || e.kiosk_report_staff_id::text)
        when e.actor_type = 'delivery_staff' then coalesce(nullif(btrim(ds.full_name), ''), 'DELIVERY:' || e.delivery_staff_id::text)
        else null
      end as employee_name,
      e.actor_type,
      e.kiosk_report_staff_id,
      e.delivery_staff_id,
      e.work_date,
      e.decision,
      case
        when e.actor_type = 'report_staff' then 'report_staff:' || e.kiosk_report_staff_id::text
        when e.actor_type = 'delivery_staff' then 'delivery_staff:' || e.delivery_staff_id::text
        else e.actor_type || ':unknown'
      end as actor_key,
      case
        when e.actor_type = 'report_staff' then 'report_staff:' || e.kiosk_report_staff_id::text || ':' || e.work_date::text
        when e.actor_type = 'delivery_staff' then 'delivery_staff:' || e.delivery_staff_id::text || ':' || e.work_date::text
        else e.actor_type || ':unknown:' || e.work_date::text
      end as actor_day_key
    from public.mobile_gps_attendance_events e
    left join public.kiosk_report_staff ks on ks.id = e.kiosk_report_staff_id
    left join public.delivery_staff ds on ds.id = e.delivery_staff_id
    where e.work_date between v_run.period_from and v_run.period_to
  ), valid_override_days as (
    select
      case
        when o.actor_type = 'report_staff' then 'KIOSK:' || o.kiosk_report_staff_id::text
        when o.actor_type = 'delivery_staff' then 'DELIVERY:' || o.delivery_staff_id::text
        else o.actor_type || ':unknown'
      end as employee_code,
      case
        when o.actor_type = 'report_staff' then coalesce(nullif(btrim(ks.full_name), ''), 'KIOSK:' || o.kiosk_report_staff_id::text)
        when o.actor_type = 'delivery_staff' then coalesce(nullif(btrim(ds.full_name), ''), 'DELIVERY:' || o.delivery_staff_id::text)
        else null
      end as employee_name,
      o.actor_type,
      o.work_date,
      case
        when o.actor_type = 'report_staff' then 'report_staff:' || o.kiosk_report_staff_id::text
        when o.actor_type = 'delivery_staff' then 'delivery_staff:' || o.delivery_staff_id::text
        else o.actor_type || ':unknown'
      end as actor_key,
      case
        when o.actor_type = 'report_staff' then 'report_staff:' || o.kiosk_report_staff_id::text || ':' || o.work_date::text
        when o.actor_type = 'delivery_staff' then 'delivery_staff:' || o.delivery_staff_id::text || ':' || o.work_date::text
        else o.actor_type || ':unknown:' || o.work_date::text
      end as actor_day_key,
      o.gps_event_id is null as is_override_only
    from public.mobile_gps_attendance_manual_overrides o
    left join public.kiosk_report_staff ks on ks.id = o.kiosk_report_staff_id
    left join public.delivery_staff ds on ds.id = o.delivery_staff_id
    where o.work_date between v_run.period_from and v_run.period_to
      and o.override_decision in ('accepted', 'excused')
  ), valid_actor_days as (
    select employee_code, employee_name, actor_type, actor_key, actor_day_key, false as from_override
    from gps_events
    where decision = 'accepted'
      and (employee_code like 'KIOSK:%' or employee_code like 'DELIVERY:%')
    union all
    select employee_code, employee_name, actor_type, actor_key, actor_day_key, true as from_override
    from valid_override_days
    where employee_code like 'KIOSK:%' or employee_code like 'DELIVERY:%'
  ), valid_day_agg as (
    select
      employee_code,
      max(employee_name) as employee_name,
      max(actor_type) as actor_type,
      count(distinct actor_day_key)::integer as gps_valid_days,
      count(distinct actor_day_key) filter (where from_override)::integer as override_days
    from valid_actor_days
    group by employee_code
  ), gps_agg as (
    select
      employee_code,
      max(employee_name) as employee_name,
      max(actor_type) as actor_type,
      count(*)::integer as gps_event_count,
      count(*) filter (where decision = 'accepted')::integer as gps_accepted_events,
      count(*) filter (where decision = 'rejected')::integer as gps_rejected_events
    from gps_events
    where employee_code like 'KIOSK:%' or employee_code like 'DELIVERY:%'
    group by employee_code
  ), attendance_agg as (
    select
      r.employee_code,
      max(r.employee_name) as employee_name,
      count(*) filter (where r.status in ('present','late','early_leave','late_early_leave'))::integer as attendance_present_days,
      count(*) filter (where r.source_type = 'mobile_gps')::integer as attendance_gps_source_days,
      count(*) filter (where r.locked_by_hr)::integer as attendance_locked_days,
      count(*) filter (where coalesce(r.source_type::text, 'manual') <> 'mobile_gps')::integer as attendance_manual_days
    from public.attendance_records r
    where r.work_date between v_run.period_from and v_run.period_to
      and (r.employee_code like 'KIOSK:%' or r.employee_code like 'DELIVERY:%')
    group by r.employee_code
  ), line_agg as (
    select
      pl.employee_code,
      pl.employee_name,
      pl.total_days_present::integer as payroll_total_days_present,
      true as has_persisted_payroll_result,
      'persisted_result'::text as payroll_status
    from public.payroll_lines pl
    where pl.payroll_run_id = p_payroll_run_id
      and (pl.employee_code like 'KIOSK:%' or pl.employee_code like 'DELIVERY:%')
  ), employees as (
    select employee_code from valid_day_agg
    union
    select employee_code from gps_agg
    union
    select employee_code from attendance_agg
    union
    select employee_code from line_agg
  ), rows as (
    select
      e.employee_code,
      case when e.employee_code like 'KIOSK:%' then 'report_staff' else 'delivery_staff' end as actor_type,
      coalesce(v.employee_name, g.employee_name, a.employee_name, l.employee_name, e.employee_code) as employee_name,
      coalesce(v.gps_valid_days, 0) as gps_valid_days,
      coalesce(g.gps_event_count, 0) as gps_event_count,
      coalesce(g.gps_accepted_events, 0) as gps_accepted_events,
      coalesce(g.gps_rejected_events, 0) as gps_rejected_events,
      coalesce(a.attendance_present_days, 0) as attendance_present_days,
      coalesce(a.attendance_gps_source_days, 0) as attendance_gps_source_days,
      coalesce(l.payroll_total_days_present, 0) as payroll_total_days_present,
      coalesce(v.gps_valid_days, 0) - coalesce(a.attendance_present_days, 0) as gps_vs_attendance_days_delta,
      case when l.employee_code is null then null else coalesce(v.gps_valid_days, 0) - coalesce(l.payroll_total_days_present, 0) end as gps_vs_payroll_days_delta,
      coalesce(a.attendance_locked_days, 0) as attendance_locked_days,
      coalesce(a.attendance_manual_days, 0) as attendance_manual_days,
      coalesce(v.override_days, 0) as override_days,
      coalesce(l.payroll_status, 'not_calculated') as payroll_status,
      coalesce(l.has_persisted_payroll_result, false) as has_persisted_payroll_result
    from employees e
    left join valid_day_agg v using (employee_code)
    left join gps_agg g using (employee_code)
    left join attendance_agg a using (employee_code)
    left join line_agg l using (employee_code)
    order by e.employee_code
  ), metric_row as (
    select
      count(*)::integer as employee_count,
      coalesce(sum(gps_valid_days), 0)::integer as gps_valid_days,
      coalesce(sum(attendance_present_days), 0)::integer as attendance_present_days,
      coalesce(sum(payroll_total_days_present), 0)::integer as payroll_total_days_present,
      count(*) filter (where gps_vs_attendance_days_delta <> 0 or coalesce(gps_vs_payroll_days_delta, 0) <> 0)::integer as discrepancy_employee_count,
      coalesce(sum(attendance_locked_days), 0)::integer as attendance_locked_days,
      coalesce(sum(attendance_manual_days), 0)::integer as attendance_manual_days,
      coalesce(sum(override_days), 0)::integer as override_days,
      count(*) filter (where payroll_status = 'not_calculated')::integer as not_calculated_employee_count
    from rows
  )
  select jsonb_build_object(
    'preview_only', true,
    'warning', 'GPS attendance payroll preview only: no payroll action, no calculation, no close/lock.',
    'period', jsonb_build_object(
      'payroll_run_id', v_run.id,
      'period_code', v_run.period_code,
      'period_name', v_run.period_name,
      'period_from', v_run.period_from,
      'period_to', v_run.period_to,
      'run_status', v_run.status,
      'locked', v_run.status in ('approved', 'locked')
    ),
    'metrics', to_jsonb(metric_row),
    'rows', coalesce((select jsonb_agg(to_jsonb(rows) order by employee_code) from rows), '[]'::jsonb)
  ) into v_payload
  from metric_row;

  return v_payload;
end;
$$;

revoke all on function public.get_payroll_gps_attendance_preview(uuid, boolean) from public, anon, authenticated;
grant execute on function public.get_payroll_gps_attendance_preview(uuid, boolean) to authenticated;


do $$ begin perform 'double_apply_idempotent'; end $$;

insert into public.user_module_permissions(user_id, module_key, can_view, can_edit)
values
  ('00000000-0000-0000-0000-000000008801', 'payroll', true, false),
  ('00000000-0000-0000-0000-000000008802', 'payroll', true, true)
on conflict (user_id, module_key) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;

insert into public.kiosk_report_locations(id, location_code, location_name, active)
values ('00000000-0000-0000-0000-000000008811', 'TASK8-KIOSK', 'Task8 kiosk', true)
on conflict do nothing;

insert into public.kiosk_report_staff(id, full_name, phone_raw, phone_normalized, location_id, active)
values ('00000000-0000-0000-0000-000000008821', 'Task8 Kiosk Staff', '0900008801', '84900008801', '00000000-0000-0000-0000-000000008811', true)
on conflict do nothing;

insert into public.delivery_staff(id, full_name, phone_raw, phone_normalized, active)
values
  ('00000000-0000-0000-0000-000000008822', 'Task8 Delivery Staff', '0900008802', '84900008802', true),
  ('00000000-0000-0000-0000-000000008823', 'Task8 Override Only Delivery', '0900008803', '84900008803', true)
on conflict do nothing;

insert into public.kiosk_report_sessions(id, actor_type, staff_id, location_id, delivery_staff_id, token_hash, expires_at, created_at)
values
  ('00000000-0000-0000-0000-000000008861', 'report_staff', '00000000-0000-0000-0000-000000008821', '00000000-0000-0000-0000-000000008811', null, repeat('8', 64), now() + interval '1 hour', now()),
  ('00000000-0000-0000-0000-000000008862', 'delivery_staff', null, null, '00000000-0000-0000-0000-000000008822', repeat('9', 64), now() + interval '1 hour', now())
on conflict do nothing;

insert into public.attendance_geofence_locations(id, code, name, location_type, kiosk_location_id, latitude, longitude, accepted_radius_m, active)
values
  ('00000000-0000-0000-0000-000000008831', 'TASK8-KIOSK-GEOFENCE', 'Task8 Kiosk Geofence', 'kiosk', '00000000-0000-0000-0000-000000008811', 10.770000, 106.660000, 20, true),
  ('00000000-0000-0000-0000-000000008832', 'TASK8-WAREHOUSE', 'Task8 Warehouse', 'warehouse', null, 10.800000, 106.620000, 20, true)
on conflict do nothing;

insert into public.payroll_runs(id, period_code, period_name, period_from, period_to, status, total_gross, total_deductions, total_net)
values
  ('00000000-0000-0000-0000-000000008871', 'TASK8-2026-08', 'Task8 August payroll', date '2026-08-01', date '2026-08-31', 'locked', 1000, 10, 990),
  ('00000000-0000-0000-0000-000000008872', 'TASK8-BROAD', 'Task8 broad payroll', date '2026-01-01', date '2026-04-15', 'draft', 0, 0, 0)
on conflict (id) do nothing;

insert into public.payroll_lines(id, payroll_run_id, employee_code, employee_name, wage_type_snapshot, total_days_present, net_amount, snapshot)
values ('00000000-0000-0000-0000-000000008873', '00000000-0000-0000-0000-000000008871', 'KIOSK:00000000-0000-0000-0000-000000008821', 'Task8 Kiosk Staff', 'monthly', 3, 123456, '{"persisted":"snapshot"}'::jsonb)
on conflict (payroll_run_id, employee_code) do nothing;

insert into public.mobile_gps_attendance_events(
  id, actor_type, kiosk_report_staff_id, delivery_staff_id, work_date,
  device_latitude, device_longitude, device_accuracy_m, device_captured_at,
  geofence_location_id, geofence_code, geofence_name, geofence_location_type,
  geofence_latitude, geofence_longitude, geofence_radius_m, distance_m,
  decision, reason_code, session_id, request_ip_hash, request_user_agent, created_at
) values
  ('00000000-0000-0000-0000-000000008841', 'report_staff', '00000000-0000-0000-0000-000000008821', null, date '2026-08-19', 10.770001, 106.660001, 12, timestamptz '2026-08-19 01:00:00+00', '00000000-0000-0000-0000-000000008831', 'TASK8-KIOSK-GEOFENCE', 'Task8 Kiosk Geofence', 'kiosk', 10.770000, 106.660000, 20, 7.4, 'accepted', 'accepted', '00000000-0000-0000-0000-000000008861', repeat('a', 64), 'Task8 UA hidden', timestamptz '2026-08-19 01:00:00+00'),
  ('00000000-0000-0000-0000-000000008842', 'report_staff', '00000000-0000-0000-0000-000000008821', null, date '2026-08-20', 10.771000, 106.661000, 10, timestamptz '2026-08-20 02:00:00+00', '00000000-0000-0000-0000-000000008831', 'TASK8-KIOSK-GEOFENCE', 'Task8 Kiosk Geofence', 'kiosk', 10.770000, 106.660000, 20, 144.2, 'rejected', 'outside_radius', '00000000-0000-0000-0000-000000008861', repeat('b', 64), 'Task8 UA hidden', timestamptz '2026-08-20 02:00:00+00'),
  ('00000000-0000-0000-0000-000000008844', 'report_staff', '00000000-0000-0000-0000-000000008821', null, date '2026-08-22', 10.772000, 106.662000, 10, timestamptz '2026-08-22 02:00:00+00', '00000000-0000-0000-0000-000000008831', 'TASK8-KIOSK-GEOFENCE', 'Task8 Kiosk Geofence', 'kiosk', 10.770000, 106.660000, 20, 180.0, 'rejected', 'outside_radius', '00000000-0000-0000-0000-000000008861', repeat('d', 64), 'Task8 UA hidden', timestamptz '2026-08-22 02:00:00+00'),
  ('00000000-0000-0000-0000-000000008843', 'delivery_staff', null, '00000000-0000-0000-0000-000000008822', date '2026-08-19', 10.800001, 106.620001, 10, timestamptz '2026-08-19 03:00:00+00', '00000000-0000-0000-0000-000000008832', 'TASK8-WAREHOUSE', 'Task8 Warehouse', 'warehouse', 10.800000, 106.620000, 20, 5.1, 'accepted', 'accepted', '00000000-0000-0000-0000-000000008862', repeat('c', 64), 'Task8 UA hidden', timestamptz '2026-08-19 03:00:00+00');

insert into public.mobile_gps_attendance_manual_overrides(id, gps_event_id, actor_type, kiosk_report_staff_id, delivery_staff_id, work_date, override_decision, reason_code, reason_note, created_by, created_at)
values
  ('00000000-0000-0000-0000-000000008851', '00000000-0000-0000-0000-000000008842', 'report_staff', '00000000-0000-0000-0000-000000008821', null, date '2026-08-20', 'accepted', 'payroll_preview_exception', 'Task8 payroll preview exception note', '00000000-0000-0000-0000-000000008802', now()),
  ('00000000-0000-0000-0000-000000008852', '00000000-0000-0000-0000-000000008843', 'delivery_staff', null, '00000000-0000-0000-0000-000000008822', date '2026-08-19', 'excused', 'payroll_preview_exception', 'Task8 attached override double count guard', '00000000-0000-0000-0000-000000008802', now()),
  ('00000000-0000-0000-0000-000000008853', null, 'delivery_staff', null, '00000000-0000-0000-0000-000000008823', date '2026-08-21', 'accepted', 'payroll_preview_exception', 'Task8 override only delivery day', '00000000-0000-0000-0000-000000008802', now())
on conflict do nothing;

insert into public.attendance_records(id, employee_code, employee_name, work_date, actual_check_in, status, locked_by_hr)
values
  ('00000000-0000-0000-0000-000000008881', 'KIOSK:00000000-0000-0000-0000-000000008821', 'Task8 Kiosk Staff', date '2026-08-19', timestamptz '2026-08-19 01:00:00+00', 'present', true),
  ('00000000-0000-0000-0000-000000008882', 'KIOSK:00000000-0000-0000-0000-000000008821', 'Task8 Kiosk Staff', date '2026-08-20', timestamptz '2026-08-20 01:00:00+00', 'present', false),
  ('00000000-0000-0000-0000-000000008883', 'DELIVERY:00000000-0000-0000-0000-000000008822', 'Task8 Delivery Staff', date '2026-08-19', timestamptz '2026-08-19 03:00:00+00', 'present', false)
on conflict (employee_code, work_date) do nothing;

grant select on table public.payroll_runs, public.payroll_lines to authenticated;

set local role authenticated;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000008801', true);
do $$
declare
  v jsonb;
  v_line_before jsonb;
  v_run_before jsonb;
  v_line_after jsonb;
  v_run_after jsonb;
begin
  select to_jsonb(pr) into v_run_before from public.payroll_runs pr where id = '00000000-0000-0000-0000-000000008871';
  select jsonb_agg(to_jsonb(pl) order by id) into v_line_before from public.payroll_lines pl where payroll_run_id = '00000000-0000-0000-0000-000000008871';
  v := public.get_payroll_gps_attendance_preview('00000000-0000-0000-0000-000000008871', true);
  if (v #>> '{preview_only}')::boolean is not true then raise exception 'viewer_can_preview_payroll preview flag mismatch: %', v; end if;
  if (v #>> '{metrics,employee_count}')::int <> 3 then raise exception 'kiosk_and_delivery_actor_rows expected 3 employees including override-only actor: %', v; end if;
  if (v #>> '{metrics,gps_valid_days}')::int <> 4 or (v #>> '{metrics,override_days}')::int <> 3 then raise exception 'accepted_rejected_overrides_aggregate mismatch: %', v; end if;
  if not exists (select 1 from jsonb_to_recordset(v->'rows') as r(employee_code text, gps_valid_days int, gps_event_count int, override_days int) where r.employee_code = 'DELIVERY:00000000-0000-0000-0000-000000008823' and r.gps_valid_days = 1 and r.gps_event_count = 0 and r.override_days = 1) then raise exception 'override_only_day_included delivery_override_only_actor_row mismatch: %', v; end if;
  if not exists (select 1 from jsonb_to_recordset(v->'rows') as r(employee_code text, gps_valid_days int, gps_rejected_events int, override_days int) where r.employee_code = 'KIOSK:00000000-0000-0000-0000-000000008821' and r.gps_valid_days = 2 and r.gps_rejected_events = 2 and r.override_days = 1) then raise exception 'attached_override_validates_rejected_gps rejected_without_override_invalid mismatch: %', v; end if;
  if not exists (select 1 from jsonb_to_recordset(v->'rows') as r(employee_code text, gps_valid_days int, gps_event_count int, override_days int) where r.employee_code = 'DELIVERY:00000000-0000-0000-0000-000000008822' and r.gps_valid_days = 1 and r.gps_event_count = 1 and r.override_days = 1) then raise exception 'double_count_prevented mismatch: %', v; end if;
  if (v::text like '%existing_net_amount%' or v::text like '%existing_payroll_snapshot%' or v::text like '%base_monthly_salary%' or v::text like '%hourly_rate%' or v::text like '%per_shift_rate%' or v::text like '%"snapshot"%' or v::text like '%net_amount%') then raise exception 'safe_payload_has_no_salary_snapshot_keys leaked salary/snapshot payload: %', v; end if;
  if (v #>> '{metrics,attendance_locked_days}')::int <> 1 or (v #>> '{metrics,attendance_manual_days}')::int < 1 then raise exception 'locked_manual_override_context mismatch: %', v; end if;
  if (v #>> '{metrics,discrepancy_employee_count}')::int < 1 then raise exception 'preview_discrepancies_compare_attendance_and_payroll missing: %', v; end if;
  if v::text like '%10.770001%' or v::text like '%request_ip_hash%' or v::text like '%Task8 UA hidden%' then raise exception 'safe_payload_has_no_coordinates_ip_ua leaked sensitive payload: %', v; end if;
  select to_jsonb(pr) into v_run_after from public.payroll_runs pr where id = '00000000-0000-0000-0000-000000008871';
  select jsonb_agg(to_jsonb(pl) order by id) into v_line_after from public.payroll_lines pl where payroll_run_id = '00000000-0000-0000-0000-000000008871';
  if v_run_before <> v_run_after or v_line_before <> v_line_after then raise exception 'payroll_tables_unchanged_by_rpc before % after % lines % %', v_run_before, v_run_after, v_line_before, v_line_after; end if;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000008802', true);
do $$
declare
  v jsonb;
begin
  v := public.get_payroll_gps_attendance_preview('00000000-0000-0000-0000-000000008871', true);
  if (v #>> '{period,run_status}') <> 'locked' then raise exception 'editor_can_preview_payroll locked context mismatch: %', v; end if;
  if v::text not like '%not_calculated%' then raise exception 'editor_can_preview_payroll expected not_calculated delivery row: %', v; end if;
end $$;

-- preview_only_false_rejected
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000008801', true);
do $$ begin
  perform public.get_payroll_gps_attendance_preview('00000000-0000-0000-0000-000000008871', false);
  raise exception 'preview_only_false_rejected expected 42501';
exception when insufficient_privilege then null; end $$;

-- broad_date_range_rejected
do $$ begin
  perform public.get_payroll_gps_attendance_preview('00000000-0000-0000-0000-000000008872', true);
  raise exception 'broad_date_range_rejected expected 22023';
exception when invalid_parameter_value then null; end $$;

-- unauthorized_user_rejected
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000008899', true);
do $$ begin
  perform public.get_payroll_gps_attendance_preview('00000000-0000-0000-0000-000000008871', true);
  raise exception 'unauthorized_user_rejected expected 42501';
exception when insufficient_privilege then null; end $$;

reset role;
rollback;
