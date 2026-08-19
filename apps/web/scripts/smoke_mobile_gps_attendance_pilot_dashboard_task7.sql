-- Task7 rollback-only runtime smoke for mobile GPS attendance pilot dashboard.
-- Execute after applying Task3-7 migrations in a disposable/local database.

begin;

do $$
begin
  perform 'double_apply_idempotent';
end $$;

-- The migration itself is rerunnable via CREATE OR REPLACE view/function changes.
-- This smoke intentionally uses one transaction and rolls back all fixture rows.

-- Use stable test principals. Supabase auth.uid() reads request.jwt.claim.sub.
insert into public.user_module_permissions(user_id, module_key, can_view, can_edit)
values
  ('00000000-0000-0000-0000-000000007701', 'attendance', true, false),
  ('00000000-0000-0000-0000-000000007702', 'attendance', true, true)
on conflict (user_id, module_key) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;

insert into public.kiosk_report_locations(id, location_code, location_name, active)
values ('00000000-0000-0000-0000-000000007711', 'TASK7-KIOSK', 'Task7 kiosk', true)
on conflict do nothing;

insert into public.kiosk_report_staff(id, full_name, phone_raw, phone_normalized, location_id, active)
values ('00000000-0000-0000-0000-000000007721', 'Task7 Kiosk Staff', '0900007701', '84900007701', '00000000-0000-0000-0000-000000007711', true)
on conflict do nothing;

insert into public.delivery_staff(id, full_name, phone_raw, phone_normalized, active)
values ('00000000-0000-0000-0000-000000007722', 'Task7 Delivery Staff', '0900007702', '84900007702', true)
on conflict do nothing;

insert into public.kiosk_report_sessions(id, actor_type, staff_id, location_id, delivery_staff_id, token_hash, expires_at, created_at)
values
  ('00000000-0000-0000-0000-000000007761', 'report_staff', '00000000-0000-0000-0000-000000007721', '00000000-0000-0000-0000-000000007711', null, repeat('1', 64), now() + interval '1 hour', now()),
  ('00000000-0000-0000-0000-000000007762', 'delivery_staff', null, null, '00000000-0000-0000-0000-000000007722', repeat('2', 64), now() + interval '1 hour', now())
on conflict do nothing;

insert into public.attendance_geofence_locations(id, code, name, location_type, kiosk_location_id, latitude, longitude, accepted_radius_m, active)
values
  ('00000000-0000-0000-0000-000000007731', 'TASK7-KIOSK-GEOFENCE', 'Task7 Kiosk Geofence', 'kiosk', '00000000-0000-0000-0000-000000007711', 10.770000, 106.660000, 20, true),
  ('00000000-0000-0000-0000-000000007732', 'TASK7-WAREHOUSE', 'Task7 Warehouse', 'warehouse', null, 10.800000, 106.620000, 20, true)
on conflict do nothing;

insert into public.mobile_gps_attendance_events(
  id, actor_type, kiosk_report_staff_id, delivery_staff_id, work_date,
  device_latitude, device_longitude, device_accuracy_m, device_captured_at,
  geofence_location_id, geofence_code, geofence_name, geofence_location_type,
  geofence_latitude, geofence_longitude, geofence_radius_m, distance_m,
  decision, reason_code, session_id, request_ip_hash, request_user_agent, created_at
) values
  ('00000000-0000-0000-0000-000000007741', 'report_staff', '00000000-0000-0000-0000-000000007721', null, date '2026-08-19', 10.770001, 106.660001, 12, timestamptz '2026-08-19 01:00:00+00', '00000000-0000-0000-0000-000000007731', 'TASK7-KIOSK-GEOFENCE', 'Task7 Kiosk Geofence', 'kiosk', 10.770000, 106.660000, 20, 7.4, 'accepted', 'accepted', '00000000-0000-0000-0000-000000007761', repeat('a', 64), 'Task7 UA hidden', timestamptz '2026-08-19 01:00:00+00'),
  ('00000000-0000-0000-0000-000000007742', 'report_staff', '00000000-0000-0000-0000-000000007721', null, date '2026-08-19', 10.771000, 106.661000, 10, timestamptz '2026-08-19 02:00:00+00', '00000000-0000-0000-0000-000000007731', 'TASK7-KIOSK-GEOFENCE', 'Task7 Kiosk Geofence', 'kiosk', 10.770000, 106.660000, 20, 144.2, 'rejected', 'outside_radius', '00000000-0000-0000-0000-000000007761', repeat('b', 64), 'Task7 UA hidden', timestamptz '2026-08-19 02:00:00+00'),
  ('00000000-0000-0000-0000-000000007743', 'delivery_staff', null, '00000000-0000-0000-0000-000000007722', date '2026-08-19', 10.800001, 106.620001, 80, timestamptz '2026-08-19 03:00:00+00', '00000000-0000-0000-0000-000000007732', 'TASK7-WAREHOUSE', 'Task7 Warehouse', 'warehouse', 10.800000, 106.620000, 20, 5.1, 'rejected', 'low_accuracy', '00000000-0000-0000-0000-000000007762', repeat('c', 64), 'Task7 UA hidden', timestamptz '2026-08-19 03:00:00+00'),
  ('00000000-0000-0000-0000-000000007744', 'delivery_staff', null, '00000000-0000-0000-0000-000000007722', date '2026-08-19', 10.800001, 106.620001, 10, timestamptz '2026-08-19 04:00:00+00', '00000000-0000-0000-0000-000000007732', 'TASK7-WAREHOUSE', 'Task7 Warehouse', 'warehouse', 10.800000, 106.620000, 20, 4.9, 'rejected', 'already_checked_in', '00000000-0000-0000-0000-000000007762', repeat('d', 64), 'Task7 UA hidden', timestamptz '2026-08-19 04:00:00+00');

insert into public.mobile_gps_attendance_manual_overrides(id, gps_event_id, actor_type, kiosk_report_staff_id, delivery_staff_id, work_date, override_decision, reason_code, reason_note, created_by, created_at)
values ('00000000-0000-0000-0000-000000007751', '00000000-0000-0000-0000-000000007742', 'report_staff', '00000000-0000-0000-0000-000000007721', null, date '2026-08-19', 'accepted', 'pilot_exception', 'Task7 pilot exception review note', '00000000-0000-0000-0000-000000007702', now())
on conflict do nothing;

set local role authenticated;

-- viewer_can_read_safe_summary
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000007701', true);
do $$
declare
  v jsonb;
begin
  v := public.get_mobile_gps_attendance_pilot_dashboard(date '2026-08-19', date '2026-08-19', null, null, null, null, 50, 0);
  if (v #>> '{metrics,event_count}')::int <> 4 then raise exception 'viewer_can_read_safe_summary expected 4 events: %', v; end if;
  if v::text like '%10.770001%' or v::text like '%request_ip_hash%' or v::text like '%Task7 UA hidden%' then raise exception 'safe_payload_has_no_coordinates_ip_ua leaked sensitive payload: %', v; end if;
end $$;

-- attendance_editor_can_read_safe_summary
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000007702', true);
do $$
declare
  v jsonb;
begin
  v := public.get_mobile_gps_attendance_pilot_dashboard(date '2026-08-19', date '2026-08-19', null, null, null, null, 50, 0);
  if (v #>> '{metrics,rejected_count}')::int <> 3 then raise exception 'attendance_editor_can_read_safe_summary rejected count mismatch: %', v; end if;
end $$;

-- date_employee_actor_geofence_decision_filters
-- metrics_success_low_accuracy_outside_duplicate_override
-- pagination_is_bounded
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000007701', true);
do $$
declare
  v jsonb;
begin
  v := public.get_mobile_gps_attendance_pilot_dashboard(date '2026-08-19', date '2026-08-19', 'Delivery', 'delivery_staff', 'WAREHOUSE', 'rejected', 1, 0);
  if (v #>> '{metrics,event_count}')::int <> 2 then raise exception 'date_employee_actor_geofence_decision_filters count mismatch: %', v; end if;
  if (v #>> '{metrics,low_accuracy_count}')::int <> 1 then raise exception 'metrics_success_low_accuracy_outside_duplicate_override low_accuracy mismatch: %', v; end if;
  if (v #>> '{metrics,duplicate_count}')::int <> 1 then raise exception 'metrics_success_low_accuracy_outside_duplicate_override duplicate mismatch: %', v; end if;
  if (v #>> '{pagination,returned_count}')::int <> 1 or (v #>> '{pagination,has_next_page}')::boolean is not true then raise exception 'pagination_is_bounded mismatch: %', v; end if;

  v := public.get_mobile_gps_attendance_pilot_dashboard(date '2026-08-19', date '2026-08-19', null, null, null, null, 50, 0);
  if (v #>> '{metrics,accepted_count}')::int <> 1 or (v #>> '{metrics,outside_radius_count}')::int <> 1 or (v #>> '{metrics,override_count}')::int <> 1 then
    raise exception 'metrics_success_low_accuracy_outside_duplicate_override aggregate mismatch: %', v;
  end if;
  if (v #>> '{metrics,success_rate}')::numeric <> 25.0 then raise exception 'metrics success rate mismatch: %', v; end if;
end $$;

-- detail_coordinates_only_allowlist_view: safe RPC omits raw details; explicit coordinate detail view remains separate.
do $$
declare
  v_safe_cols text;
  v_detail_cols text;
begin
  select string_agg(column_name, ',') into v_safe_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'mobile_gps_attendance_pilot_event_summaries';
  if v_safe_cols like '%device_latitude%' or v_safe_cols like '%geofence_longitude%' or v_safe_cols like '%request_user_agent%' then
    raise exception 'safe_payload_has_no_coordinates_ip_ua safe view columns leaked: %', v_safe_cols;
  end if;
  select string_agg(column_name, ',') into v_detail_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'mobile_gps_attendance_event_coordinate_details';
  if v_detail_cols not like '%device_latitude%' or v_detail_cols not like '%geofence_longitude%' then
    raise exception 'detail_coordinates_only_allowlist_view missing explicit detail columns: %', v_detail_cols;
  end if;
end $$;

-- invalid_date_range_rejected
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000007701', true);
do $$
begin
  perform public.get_mobile_gps_attendance_pilot_dashboard(date '2026-08-20', date '2026-08-19', null, null, null, null, 50, 0);
  raise exception 'invalid_date_range_rejected expected 22007';
exception when invalid_datetime_format then
  null;
end $$;

-- broad_date_range_rejected
do $$
begin
  perform public.get_mobile_gps_attendance_pilot_dashboard(date '2026-05-01', date '2026-08-19', null, null, null, null, 50, 0);
  raise exception 'broad_date_range_rejected expected 22023';
exception when invalid_parameter_value then
  null;
end $$;

-- valid_90_day_range_accepted
do $$
declare
  v jsonb;
begin
  v := public.get_mobile_gps_attendance_pilot_dashboard(date '2026-05-22', date '2026-08-19', null, null, null, null, 50, 0);
  if (v #>> '{metrics,event_count}')::int <> 4 then raise exception 'valid_90_day_range_accepted count mismatch: %', v; end if;
end $$;

-- unauthorized_user_rejected
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000007799', true);
do $$
begin
  perform public.get_mobile_gps_attendance_pilot_dashboard(date '2026-08-19', date '2026-08-19', null, null, null, null, 50, 0);
  raise exception 'unauthorized_user_rejected expected 42501';
exception when insufficient_privilege then
  null;
end $$;

reset role;
rollback;
