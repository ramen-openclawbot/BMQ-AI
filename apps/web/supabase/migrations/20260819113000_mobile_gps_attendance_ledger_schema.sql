-- Task3 mobile GPS attendance immutable event ledger and manual override foundation.
-- Schema-only migration: no PL/pgSQL bodies for parser safety.

create table if not exists public.mobile_gps_attendance_events (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null,
  kiosk_report_staff_id uuid references public.kiosk_report_staff(id) on delete restrict,
  delivery_staff_id uuid references public.delivery_staff(id) on delete restrict,
  work_date date not null default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
  device_latitude numeric(9,6) not null,
  device_longitude numeric(9,6) not null,
  device_accuracy_m numeric(8,2) not null,
  device_captured_at timestamptz not null,
  geofence_location_id uuid references public.attendance_geofence_locations(id) on delete restrict,
  geofence_code text not null,
  geofence_name text not null,
  geofence_location_type text not null,
  geofence_latitude numeric(9,6) not null,
  geofence_longitude numeric(9,6) not null,
  geofence_radius_m integer not null,
  distance_m numeric(10,2) not null,
  decision text not null,
  reason_code text not null,
  session_id uuid references public.kiosk_report_sessions(id) on delete restrict,
  request_ip_hash text,
  request_user_agent text,
  created_at timestamptz not null default now(),
  constraint mobile_gps_attendance_events_actor_type_check check (actor_type in ('report_staff', 'delivery_staff')),
  constraint mobile_gps_attendance_events_actor_shape_check check (
    (actor_type = 'report_staff' and kiosk_report_staff_id is not null and delivery_staff_id is null)
    or
    (actor_type = 'delivery_staff' and delivery_staff_id is not null and kiosk_report_staff_id is null)
  ),
  constraint mobile_gps_attendance_events_device_latitude_check check (device_latitude between -90 and 90),
  constraint mobile_gps_attendance_events_device_longitude_check check (device_longitude between -180 and 180),
  constraint mobile_gps_attendance_events_device_accuracy_check check (device_accuracy_m >= 0 and device_accuracy_m < 100000),
  constraint mobile_gps_attendance_events_device_captured_reasonable_check check (device_captured_at >= timestamptz '2026-01-01'),
  constraint mobile_gps_attendance_events_geofence_latitude_check check (geofence_latitude between -90 and 90),
  constraint mobile_gps_attendance_events_geofence_longitude_check check (geofence_longitude between -180 and 180),
  constraint mobile_gps_attendance_events_geofence_radius_check check (geofence_radius_m between 1 and 500),
  constraint mobile_gps_attendance_events_distance_check check (distance_m >= 0),
  constraint mobile_gps_attendance_events_decision_check check (decision in ('accepted', 'rejected')),
  constraint mobile_gps_attendance_events_reason_code_check check (reason_code ~ '^[a-z0-9_]{2,80}$'),
  constraint mobile_gps_attendance_events_request_ip_hash_check check (request_ip_hash is null or request_ip_hash ~ '^[0-9a-f]{64}$'),
  constraint mobile_gps_attendance_events_request_user_agent_check check (request_user_agent is null or length(request_user_agent) <= 240),
  constraint mobile_gps_attendance_events_work_date_vn_check check (
    work_date = (created_at at time zone 'Asia/Ho_Chi_Minh')::date
  )
);

alter table public.mobile_gps_attendance_events
  alter column work_date set default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
  drop constraint if exists mobile_gps_attendance_events_work_date_vn_check,
  add constraint mobile_gps_attendance_events_work_date_vn_check
    check (work_date = (created_at at time zone 'Asia/Ho_Chi_Minh')::date);

create unique index if not exists mobile_gps_attendance_events_report_staff_one_accepted_per_day
  on public.mobile_gps_attendance_events(kiosk_report_staff_id, work_date)
  where decision = 'accepted' and actor_type = 'report_staff';

create unique index if not exists mobile_gps_att_events_delivery_one_accepted_day
  on public.mobile_gps_attendance_events(delivery_staff_id, work_date)
  where decision = 'accepted' and actor_type = 'delivery_staff';

create index if not exists mobile_gps_attendance_events_actor_day_idx
  on public.mobile_gps_attendance_events(actor_type, work_date, created_at desc);

create index if not exists mobile_gps_attendance_events_session_idx
  on public.mobile_gps_attendance_events(session_id, created_at desc);

create table if not exists public.mobile_gps_attendance_manual_overrides (
  id uuid primary key default gen_random_uuid(),
  gps_event_id uuid references public.mobile_gps_attendance_events(id) on delete restrict,
  actor_type text not null,
  kiosk_report_staff_id uuid references public.kiosk_report_staff(id) on delete restrict,
  delivery_staff_id uuid references public.delivery_staff(id) on delete restrict,
  work_date date not null,
  override_decision text not null,
  reason_code text not null,
  reason_note text not null,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint mobile_gps_attendance_manual_overrides_actor_type_check check (actor_type in ('report_staff', 'delivery_staff')),
  constraint mobile_gps_attendance_manual_overrides_actor_shape_check check (
    (actor_type = 'report_staff' and kiosk_report_staff_id is not null and delivery_staff_id is null)
    or
    (actor_type = 'delivery_staff' and delivery_staff_id is not null and kiosk_report_staff_id is null)
  ),
  constraint mobile_gps_attendance_manual_overrides_decision_check check (override_decision in ('accepted', 'rejected', 'excused')),
  constraint mobile_gps_attendance_manual_overrides_reason_code_check check (reason_code ~ '^[a-z0-9_]{2,80}$'),
  constraint mobile_gps_attendance_manual_overrides_reason_note_check check (length(btrim(reason_note)) between 8 and 1000)
);

alter table public.mobile_gps_attendance_manual_overrides
  alter column created_by set default auth.uid(),
  alter column created_by set not null;

create index if not exists mobile_gps_attendance_manual_overrides_actor_day_idx
  on public.mobile_gps_attendance_manual_overrides(actor_type, work_date, created_at desc);

create unique index if not exists mobile_gps_att_overrides_report_staff_one_per_day
  on public.mobile_gps_attendance_manual_overrides(kiosk_report_staff_id, work_date)
  where actor_type = 'report_staff';

create unique index if not exists mobile_gps_att_overrides_delivery_one_per_day
  on public.mobile_gps_attendance_manual_overrides(delivery_staff_id, work_date)
  where actor_type = 'delivery_staff';

create or replace view public.mobile_gps_attendance_event_summaries as
select
  id,
  actor_type,
  kiosk_report_staff_id,
  delivery_staff_id,
  work_date,
  decision,
  reason_code,
  device_accuracy_m,
  geofence_code,
  geofence_name,
  geofence_location_type,
  geofence_radius_m,
  distance_m,
  session_id,
  created_at
from public.mobile_gps_attendance_events
where public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'attendance', 'view')
  or public.has_module_permission((select auth.uid()), 'attendance', 'edit')
  or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  or public.has_module_permission((select auth.uid()), 'payroll', 'edit');

create or replace view public.mobile_gps_attendance_event_coordinate_details as
select
  id,
  actor_type,
  kiosk_report_staff_id,
  delivery_staff_id,
  work_date,
  decision,
  reason_code,
  device_latitude,
  device_longitude,
  device_accuracy_m,
  device_captured_at,
  geofence_location_id,
  geofence_code,
  geofence_name,
  geofence_location_type,
  geofence_latitude,
  geofence_longitude,
  geofence_radius_m,
  distance_m,
  session_id,
  created_at
from public.mobile_gps_attendance_events
where public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'attendance', 'edit')
  or public.has_module_permission((select auth.uid()), 'payroll', 'edit');

alter table public.mobile_gps_attendance_events enable row level security;
alter table public.mobile_gps_attendance_manual_overrides enable row level security;

revoke all on table public.mobile_gps_attendance_events from service_role;
revoke insert, update, delete, truncate on table public.mobile_gps_attendance_events from public, anon, authenticated;
revoke all on table public.mobile_gps_attendance_events from public, anon, authenticated;
revoke all on table public.mobile_gps_attendance_manual_overrides from public, anon, authenticated;
revoke all on public.mobile_gps_attendance_event_summaries from public, anon;
revoke all on public.mobile_gps_attendance_event_coordinate_details from public, anon;

grant select on table public.mobile_gps_attendance_events to service_role;
grant select on table public.mobile_gps_attendance_events to authenticated;
grant select on table public.mobile_gps_attendance_manual_overrides to authenticated;
grant insert on table public.mobile_gps_attendance_manual_overrides to authenticated;
grant select on public.mobile_gps_attendance_event_summaries to authenticated;
grant select on public.mobile_gps_attendance_event_coordinate_details to authenticated;

drop policy if exists mobile_gps_attendance_events_select_attendance_payroll on public.mobile_gps_attendance_events;
create policy mobile_gps_attendance_events_select_attendance_payroll
on public.mobile_gps_attendance_events for select to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'attendance', 'edit')
  or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
);

-- mobile_gps_attendance_event_coordinate_details_select is enforced inside the coordinate-detail view predicate.
comment on view public.mobile_gps_attendance_event_coordinate_details is
  'mobile_gps_attendance_event_coordinate_details_select: detailed GPS coordinates are limited to owner, attendance.edit, or payroll.edit.';

drop policy if exists mgps_att_overrides_sel_att_payroll on public.mobile_gps_attendance_manual_overrides;
create policy mgps_att_overrides_sel_att_payroll
on public.mobile_gps_attendance_manual_overrides for select to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'attendance', 'view')
  or public.has_module_permission((select auth.uid()), 'attendance', 'edit')
  or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
);

drop policy if exists mgps_att_overrides_ins_att_payroll on public.mobile_gps_attendance_manual_overrides;
create policy mgps_att_overrides_ins_att_payroll
on public.mobile_gps_attendance_manual_overrides for insert to authenticated
with check (
  created_by is not null
  and created_by = (select auth.uid())
  and (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'attendance', 'edit')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  )
);

comment on table public.mobile_gps_attendance_events is
  'Immutable mobile GPS attendance evidence ledger. Accepted and rejected attempts are preserved; Task4 will compute decisions before calling the narrow insert RPC.';
comment on table public.mobile_gps_attendance_manual_overrides is
  'Audited manual attendance override foundation. Overrides are separate from immutable GPS evidence and do not mutate ledger rows.';
comment on column public.mobile_gps_attendance_events.work_date is
  'Vietnam-local attendance work date computed by the server boundary.';
comment on column public.mobile_gps_attendance_events.request_ip_hash is
  'SHA-256 hash of request IP; raw IP is not stored in this ledger.';
