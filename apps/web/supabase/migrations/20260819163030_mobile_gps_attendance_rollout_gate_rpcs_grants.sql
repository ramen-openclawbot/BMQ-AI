drop trigger if exists set_mobile_gps_attendance_pilot_actor_gate_updated_at on public.mobile_gps_attendance_pilot_actor_gates;
create trigger set_mobile_gps_attendance_pilot_actor_gate_updated_at
before update on public.mobile_gps_attendance_pilot_actor_gates
for each row execute function public.set_mobile_gps_attendance_pilot_actor_gate_updated_at();

drop trigger if exists audit_mobile_gps_attendance_pilot_actor_gate_changes on public.mobile_gps_attendance_pilot_actor_gates;
create trigger audit_mobile_gps_attendance_pilot_actor_gate_changes
after insert or update or delete on public.mobile_gps_attendance_pilot_actor_gates
for each row execute function public.audit_mobile_gps_attendance_pilot_actor_gate_change();

alter table public.mobile_gps_attendance_pilot_actor_gates enable row level security;
alter table public.mobile_gps_attendance_pilot_actor_gate_audit_logs enable row level security;

revoke all on table public.mobile_gps_attendance_pilot_actor_gates from public, anon, authenticated;
revoke all on table public.mobile_gps_attendance_pilot_actor_gate_audit_logs from public, anon, authenticated;
grant select, insert, update on table public.mobile_gps_attendance_pilot_actor_gates to authenticated;
grant select on table public.mobile_gps_attendance_pilot_actor_gate_audit_logs to authenticated;

drop policy if exists mobile_gps_att_pilot_gate_select_owner_att_edit on public.mobile_gps_attendance_pilot_actor_gates;
create policy mobile_gps_att_pilot_gate_select_owner_att_edit
on public.mobile_gps_attendance_pilot_actor_gates for select to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'attendance', 'edit')
);

drop policy if exists mobile_gps_att_pilot_gate_insert_owner_att_edit on public.mobile_gps_attendance_pilot_actor_gates;
create policy mobile_gps_att_pilot_gate_insert_owner_att_edit
on public.mobile_gps_attendance_pilot_actor_gates for insert to authenticated
with check (
  created_by = (select auth.uid())
  and updated_by = (select auth.uid())
  and (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'attendance', 'edit')
  )
);

drop policy if exists mobile_gps_att_pilot_gate_update_owner_att_edit on public.mobile_gps_attendance_pilot_actor_gates;
create policy mobile_gps_att_pilot_gate_update_owner_att_edit
on public.mobile_gps_attendance_pilot_actor_gates for update to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'attendance', 'edit')
)
with check (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'attendance', 'edit')
);

drop policy if exists mobile_gps_att_pilot_gate_audit_select_owner_att_edit on public.mobile_gps_attendance_pilot_actor_gate_audit_logs;
create policy mobile_gps_att_pilot_gate_audit_select_owner_att_edit
on public.mobile_gps_attendance_pilot_actor_gate_audit_logs for select to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'attendance', 'edit')
);

create or replace function public.get_mobile_gps_attendance_actor_gate(
  p_actor_type text,
  p_actor_id uuid
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((
    select g.enabled
    from public.mobile_gps_attendance_pilot_actor_gates g
    where g.actor_type = p_actor_type
      and g.actor_id = p_actor_id
    limit 1
  ), false);
$$;

revoke all on function public.get_mobile_gps_attendance_actor_gate(text, uuid) from public, anon, authenticated;
grant execute on function public.get_mobile_gps_attendance_actor_gate(text, uuid) to service_role;

create or replace function public.get_mobile_gps_attendance_rollout_readiness()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service_role boolean := coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role';
  v_payload jsonb;
begin
  if not v_is_service_role and (
    v_actor is null or not (
      public.has_role(v_actor, 'owner')
      or public.has_module_permission(v_actor, 'attendance', 'edit')
    )
  ) then
    raise exception 'mobile_gps_attendance_rollout_readiness_forbidden' using errcode = '42501';
  end if;

  with enabled_gates as (
    select actor_type, actor_id
    from public.mobile_gps_attendance_pilot_actor_gates
    where enabled is true
  ), actor_targets as (
    select
      g.actor_type,
      g.actor_id,
      case
        when g.actor_type = 'report_staff' then 'report_staff:' || g.actor_id::text
        when g.actor_type = 'delivery_staff' then 'delivery_staff:' || g.actor_id::text
      end as actor_code,
      gf.id as target_geofence_id
    from enabled_gates g
    left join public.kiosk_report_staff ks
      on g.actor_type = 'report_staff'
     and ks.id = g.actor_id
     and ks.active is true
    left join public.attendance_geofence_locations gf
      on (
        (g.actor_type = 'report_staff' and gf.location_type = 'kiosk' and gf.kiosk_location_id = ks.location_id and gf.active is true)
        or (g.actor_type = 'delivery_staff' and gf.location_type = 'warehouse' and gf.code = 'warehouse_tan_tao' and gf.active is true)
      )
  ), missing_actor_targets as (
    select actor_code
    from actor_targets
    where target_geofence_id is null
    order by actor_code
    limit 50
  ), missing_geofence_targets as (
    select code
    from public.attendance_geofence_locations
    where active is true
      and (latitude is null or longitude is null)
    order by code
    limit 50
  )
  select jsonb_build_object(
    'enabled_actor_count', (select count(*) from enabled_gates),
    'active_geofences_missing_coordinates_count', (
      select count(*)
      from public.attendance_geofence_locations
      where active is true
        and (latitude is null or longitude is null)
    ),
    'enabled_actors_missing_geofence_count', (select count(*) from actor_targets where target_geofence_id is null),
    'enabled_actors_missing_geofence_codes', coalesce((select jsonb_agg(actor_code) from missing_actor_targets), '[]'::jsonb),
    'geofences_missing_coordinates_codes', coalesce((select jsonb_agg(code) from missing_geofence_targets), '[]'::jsonb)
  ) into v_payload;

  return v_payload;
end;
$$;

revoke all on function public.get_mobile_gps_attendance_rollout_readiness() from public, anon, authenticated;
grant execute on function public.get_mobile_gps_attendance_rollout_readiness() to authenticated, service_role;

comment on table public.mobile_gps_attendance_pilot_actor_gates is
  'Default-off per-actor mobile GPS attendance rollout gates. No actor is enabled by migration or seed; owner/attendance.edit must explicitly manage pilot rows.';
comment on function public.get_mobile_gps_attendance_actor_gate(text, uuid) is
  'Service-role helper returning only whether a report or delivery actor is enabled for the mobile GPS attendance pilot; missing rows fail closed.';
comment on function public.get_mobile_gps_attendance_rollout_readiness() is
  'Owner/service-role rollout readiness summary for mobile GPS attendance. Returns counts and safe actor/geofence codes only, never precise coordinate values.';
