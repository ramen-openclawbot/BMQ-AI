-- Task7: safe mobile GPS attendance pilot dashboard and exception reconciliation.
-- One PL/pgSQL body only; no raw coordinates/IP/UA in default pilot payloads.

create or replace view public.mobile_gps_attendance_pilot_event_summaries as
select
  e.id,
  e.actor_type,
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
  e.work_date,
  e.decision,
  case
    when e.reason_code in ('duplicate_accepted', 'already_checked_in') then 'already_checked_in'
    else e.reason_code
  end as reason_code,
  round(e.distance_m, 0)::integer as distance_m_rounded,
  round(e.device_accuracy_m, 0)::integer as accuracy_m_rounded,
  e.geofence_code,
  e.geofence_name,
  e.geofence_location_type,
  e.geofence_radius_m,
  exists (
    select 1
    from public.mobile_gps_attendance_manual_overrides o
    where (
      o.gps_event_id = e.id
      or (
        o.gps_event_id is null
        and o.work_date = e.work_date
        and o.actor_type = e.actor_type
        and (
          (e.actor_type = 'report_staff' and o.kiosk_report_staff_id = e.kiosk_report_staff_id)
          or (e.actor_type = 'delivery_staff' and o.delivery_staff_id = e.delivery_staff_id)
        )
      )
    )
  ) as has_override,
  e.created_at
from public.mobile_gps_attendance_events e
left join public.kiosk_report_staff ks on ks.id = e.kiosk_report_staff_id
left join public.delivery_staff ds on ds.id = e.delivery_staff_id
where public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'attendance', 'view')
  or public.has_module_permission((select auth.uid()), 'attendance', 'edit');

revoke all on table public.mobile_gps_attendance_pilot_event_summaries from public, anon, authenticated;
grant select on table public.mobile_gps_attendance_pilot_event_summaries to authenticated;

create index if not exists mobile_gps_attendance_events_work_date_decision_actor_idx
  on public.mobile_gps_attendance_events(work_date desc, decision, actor_type, created_at desc);

create or replace function public.get_mobile_gps_attendance_pilot_dashboard(
  p_date_from date default null,
  p_date_to date default null,
  p_employee_query text default null,
  p_actor_type text default null,
  p_geofence_query text default null,
  p_decision text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_date_from date := coalesce(p_date_from, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_date_to date := coalesce(p_date_to, v_date_from);
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_payload jsonb;
begin
  if v_actor is null or not (
    public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'attendance', 'view')
    or public.has_module_permission(v_actor, 'attendance', 'edit')
  ) then
    raise exception 'mobile_gps_attendance_pilot_dashboard_forbidden' using errcode = '42501';
  end if;

  if v_date_to < v_date_from then
    raise exception 'mobile_gps_attendance_pilot_dashboard_invalid_date_range' using errcode = '22007';
  end if;

  if v_date_to - v_date_from > 89 then
    raise exception 'mobile_gps_attendance_pilot_dashboard_date_range_too_broad' using errcode = '22023';
  end if;

  if p_actor_type is not null and p_actor_type not in ('report_staff', 'delivery_staff') then
    raise exception 'mobile_gps_attendance_pilot_dashboard_invalid_actor_type' using errcode = '22023';
  end if;

  if p_decision is not null and p_decision not in ('accepted', 'rejected') then
    raise exception 'mobile_gps_attendance_pilot_dashboard_invalid_decision' using errcode = '22023';
  end if;

  with filtered as (
    select e.*
    from public.mobile_gps_attendance_pilot_event_summaries e
    where e.work_date between v_date_from and v_date_to
      and (p_actor_type is null or e.actor_type = p_actor_type)
      and (p_decision is null or e.decision = p_decision)
      and (
        nullif(btrim(coalesce(p_employee_query, '')), '') is null
        or e.employee_code ilike '%' || btrim(p_employee_query) || '%'
        or coalesce(e.employee_name, '') ilike '%' || btrim(p_employee_query) || '%'
      )
      and (
        nullif(btrim(coalesce(p_geofence_query, '')), '') is null
        or e.geofence_code ilike '%' || btrim(p_geofence_query) || '%'
        or e.geofence_name ilike '%' || btrim(p_geofence_query) || '%'
        or e.geofence_location_type ilike '%' || btrim(p_geofence_query) || '%'
      )
  ), numbered as (
    select
      filtered.*,
      row_number() over (order by work_date desc, created_at desc, id desc) as rn,
      count(*) over () as total_count
    from filtered
  ), page_rows as (
    select *
    from numbered
    where rn > v_offset
      and rn <= v_offset + v_limit
    order by rn
  ), metric_row as (
    select
      count(*)::integer as event_count,
      count(*) filter (where decision = 'accepted')::integer as accepted_count,
      count(*) filter (where decision = 'rejected')::integer as rejected_count,
      count(*) filter (where reason_code = 'low_accuracy')::integer as low_accuracy_count,
      count(*) filter (where reason_code = 'outside_radius')::integer as outside_radius_count,
      count(*) filter (where reason_code in ('duplicate_accepted', 'already_checked_in'))::integer as duplicate_count,
      count(*) filter (where has_override)::integer as override_count,
      case when count(*) = 0 then 0 else round((count(*) filter (where decision = 'accepted'))::numeric * 100 / count(*), 1) end as success_rate
    from filtered
  )
  select jsonb_build_object(
    'filters', jsonb_build_object(
      'date_from', v_date_from,
      'date_to', v_date_to,
      'employee_query', nullif(btrim(coalesce(p_employee_query, '')), ''),
      'actor_type', p_actor_type,
      'geofence_query', nullif(btrim(coalesce(p_geofence_query, '')), ''),
      'decision', p_decision,
      'limit', v_limit,
      'offset', v_offset
    ),
    'metrics', to_jsonb(metric_row),
    'events', coalesce(
      (
        select jsonb_agg(jsonb_build_object(
          'id', id,
          'actor_type', actor_type,
          'employee_code', employee_code,
          'employee_name', employee_name,
          'work_date', work_date,
          'decision', decision,
          'reason_code', reason_code,
          'distance_m_rounded', distance_m_rounded,
          'accuracy_m_rounded', accuracy_m_rounded,
          'geofence_code', geofence_code,
          'geofence_name', geofence_name,
          'geofence_location_type', geofence_location_type,
          'geofence_radius_m', geofence_radius_m,
          'has_override', has_override,
          'created_at', created_at
        ) order by rn)
        from page_rows
      ),
      '[]'::jsonb
    ),
    'pagination', jsonb_build_object(
      'limit', v_limit,
      'offset', v_offset,
      'returned_count', (select count(*) from page_rows),
      'total_count', coalesce((select max(total_count) from numbered), 0),
      'has_next_page', coalesce((select max(total_count) from numbered), 0) > v_offset + v_limit
    )
  ) into v_payload
  from metric_row;

  return v_payload;
end;
$$;

revoke all on function public.get_mobile_gps_attendance_pilot_dashboard(date, date, text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.get_mobile_gps_attendance_pilot_dashboard(date, date, text, text, text, text, integer, integer) to authenticated;

comment on view public.mobile_gps_attendance_pilot_event_summaries is
  'Task7 safe pilot attendance event summary: rounded distance/accuracy and no device/geofence coordinates, request IP hash, or user-agent.';
comment on function public.get_mobile_gps_attendance_pilot_dashboard(date, date, text, text, text, text, integer, integer) is
  'Task7 bounded SECURITY DEFINER pilot dashboard RPC for owner/attendance.view/attendance.edit only. Returns safe event summaries and metrics for exception reconciliation without map or continuous tracking.';
