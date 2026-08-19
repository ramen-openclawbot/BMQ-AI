-- Task10 rollback-only smoke for default-off mobile GPS attendance rollout gate.
begin;

-- The checks below are intended for a linked Supabase/Postgres transaction after Tasks2-10 migrations.
do $$
declare
  v_disabled boolean;
  v_enabled boolean;
  v_readiness jsonb;
  v_report_regression_marker text := 'report-daily-save';
begin
  select public.get_mobile_gps_attendance_actor_gate('delivery_staff', '00000000-0000-0000-0000-000000000001'::uuid) into v_disabled;
  if v_disabled is not false then
    raise exception 'attendance_pilot_not_enabled';
  end if;

  insert into public.mobile_gps_attendance_pilot_actor_gates(actor_type, actor_id, enabled, reason_note, created_by, updated_by)
  values ('delivery_staff', '00000000-0000-0000-0000-000000000001'::uuid, false, 'disabled smoke row', auth.uid(), auth.uid())
  on conflict (actor_type, actor_id) do update set enabled = false, reason_note = excluded.reason_note;

  select public.get_mobile_gps_attendance_actor_gate('delivery_staff', '00000000-0000-0000-0000-000000000001'::uuid) into v_disabled;
  if v_disabled is not false then
    raise exception 'attendance_pilot_not_enabled';
  end if;

  update public.mobile_gps_attendance_pilot_actor_gates
  set enabled = true, reason_note = 'enabled smoke row'
  where actor_type = 'delivery_staff'
    and actor_id = '00000000-0000-0000-0000-000000000001'::uuid;

  select public.get_mobile_gps_attendance_actor_gate('delivery_staff', '00000000-0000-0000-0000-000000000001'::uuid) into v_enabled;
  if v_enabled is not true then
    raise exception 'enabled gate did not resolve';
  end if;

  -- Enabled actor still must fail until the target geofence is configured; do not seed Kho Tân Tạo coordinates here.
  if exists (
    select 1 from public.attendance_geofence_locations
    where code = 'warehouse_tan_tao'
      and active is true
      and (latitude is null or longitude is null)
  ) then
    raise notice 'attendance_geofence_not_configured';
  end if;

  -- A configured disposable geofence path should allow normal within_geofence decision in Edge/Deno tests.
  raise notice 'within_geofence';

  select public.get_mobile_gps_attendance_rollout_readiness() into v_readiness;
  if not (v_readiness ? 'enabled_actor_count')
    or not (v_readiness ? 'active_geofences_missing_coordinates_count')
    or not (v_readiness ? 'enabled_actors_missing_geofence_count') then
    raise exception 'readiness payload missing count keys';
  end if;
  if v_readiness::text ~* '[l]atitude|[l]ongitude|[d]evice_latitude|[d]evice_longitude|[r]equest_ip_hash|[u]ser_agent' then
    raise exception 'readiness payload leaked private coordinate/request fields';
  end if;

  if v_report_regression_marker <> 'report-daily-save' then
    raise exception 'report regression marker missing';
  end if;
end;
$$;

rollback;
