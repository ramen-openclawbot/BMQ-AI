-- Task8: GPS attendance payroll preview only. No payroll mutations.

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

comment on function public.get_payroll_gps_attendance_preview(uuid, boolean) is
  'Task8 preview-only GPS attendance payroll comparison for owner/payroll.view/payroll.edit. Reads attendance counts and persisted payroll result status only; never returns pay amounts or mutates payroll tables.';
