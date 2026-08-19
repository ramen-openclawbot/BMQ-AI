-- Attendance geofence master data for kiosk sales staff and Kho Tân Tạo delivery staff.
-- This migration creates configurable locations only; attendance matching is added later.

create table if not exists public.attendance_geofence_locations (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  location_type text not null,
  kiosk_location_id uuid references public.kiosk_report_locations(id) on delete restrict,
  latitude numeric(9,6),
  longitude numeric(9,6),
  accepted_radius_m integer not null default 20,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_geofence_locations_code_not_blank check (length(btrim(code)) > 0),
  constraint attendance_geofence_locations_name_not_blank check (length(btrim(name)) > 0),
  constraint attendance_geofence_locations_type_check check (location_type in ('kiosk', 'warehouse')),
  constraint attendance_geofence_locations_kiosk_link_check check (
    location_type = 'kiosk'
    or (location_type = 'warehouse' and kiosk_location_id is null)
  ),
  constraint attendance_geofence_locations_coordinates_pair_check check (
    (latitude is null and longitude is null)
    or (latitude is not null and longitude is not null)
  ),
  constraint attendance_geofence_locations_latitude_check check (latitude is null or latitude between -90 and 90),
  constraint attendance_geofence_locations_longitude_check check (longitude is null or longitude between -180 and 180),
  constraint attendance_geofence_locations_radius_check check (accepted_radius_m between 1 and 500)
);

create unique index if not exists attendance_geofence_locations_code_unique
  on public.attendance_geofence_locations(code);

create unique index if not exists attendance_geofence_locations_kiosk_location_unique
  on public.attendance_geofence_locations(kiosk_location_id)
  where kiosk_location_id is not null;

create index if not exists attendance_geofence_locations_type_active_idx
  on public.attendance_geofence_locations(location_type, active, code);

create table if not exists public.attendance_geofence_location_audit_logs (
  id uuid primary key default gen_random_uuid(),
  geofence_location_id uuid not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  actor_id uuid,
  before_payload jsonb,
  after_payload jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.set_attendance_geofence_location_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.audit_attendance_geofence_location_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.attendance_geofence_location_audit_logs(
    geofence_location_id,
    action,
    actor_id,
    before_payload,
    after_payload
  ) values (
    coalesce(new.id, old.id),
    lower(tg_op),
    auth.uid(),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists set_attendance_geofence_location_updated_at on public.attendance_geofence_locations;
create trigger set_attendance_geofence_location_updated_at
before update on public.attendance_geofence_locations
for each row execute function public.set_attendance_geofence_location_updated_at();

drop trigger if exists audit_attendance_geofence_location_changes on public.attendance_geofence_locations;
create trigger audit_attendance_geofence_location_changes
after insert or update or delete on public.attendance_geofence_locations
for each row execute function public.audit_attendance_geofence_location_change();

insert into public.attendance_geofence_locations(
  code,
  name,
  location_type,
  kiosk_location_id,
  latitude,
  longitude,
  accepted_radius_m,
  active,
  notes
) values (
  'warehouse_tan_tao',
  'Kho Tân Tạo',
  'warehouse',
  null,
  null, null,
  20,
  true,
  'Default delivery-staff attendance geofence target; coordinates intentionally unset until approved.'
)
on conflict (code) do update
set name = excluded.name,
    location_type = excluded.location_type,
    kiosk_location_id = excluded.kiosk_location_id,
    accepted_radius_m = 20,
    active = true,
    notes = excluded.notes;

comment on table public.attendance_geofence_locations is
  'CRM-managed attendance GPS geofence master data. Kiosk rows optionally link one-to-one to kiosk_report_locations; warehouse_tan_tao is used for delivery staff in later attendance tasks.';
comment on table public.attendance_geofence_location_audit_logs is
  'Immutable audit history for attendance geofence master-data changes.';
comment on column public.attendance_geofence_locations.accepted_radius_m is
  'Accepted GPS radius in meters. Default accepted radius is 20m.';
comment on index public.attendance_geofence_locations_code_unique is
  'Includes attendance_geofence_locations_seed_tan_tao conflict target for warehouse_tan_tao seed.';

alter table public.attendance_geofence_locations enable row level security;
alter table public.attendance_geofence_location_audit_logs enable row level security;

revoke all on table public.attendance_geofence_locations from public, anon;
revoke all on table public.attendance_geofence_location_audit_logs from public, anon;
grant select, insert, update on table public.attendance_geofence_locations to authenticated;
grant select on table public.attendance_geofence_location_audit_logs to authenticated;

drop policy if exists attendance_geofence_locations_select_crm on public.attendance_geofence_locations;
create policy attendance_geofence_locations_select_crm
on public.attendance_geofence_locations for select to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'crm', 'view')
  or public.has_module_permission((select auth.uid()), 'crm', 'edit')
);

drop policy if exists attendance_geofence_locations_insert_crm on public.attendance_geofence_locations;
create policy attendance_geofence_locations_insert_crm
on public.attendance_geofence_locations for insert to authenticated
with check (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'crm', 'edit')
);

drop policy if exists attendance_geofence_locations_update_crm on public.attendance_geofence_locations;
create policy attendance_geofence_locations_update_crm
on public.attendance_geofence_locations for update to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'crm', 'edit')
)
with check (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'crm', 'edit')
);

drop policy if exists attendance_geofence_location_audit_select_crm on public.attendance_geofence_location_audit_logs;
create policy attendance_geofence_location_audit_select_crm
on public.attendance_geofence_location_audit_logs for select to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'crm', 'edit')
);
