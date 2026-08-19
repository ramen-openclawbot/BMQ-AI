-- Minimal disposable prerequisites for Task10 rollout-gate migration smoke only.
create schema if not exists auth;
create or replace function auth.uid()
returns uuid
language sql
stable
as $$ select '11111111-1111-1111-1111-111111111111'::uuid $$;

create or replace function public.has_role(p_actor uuid, p_role text)
returns boolean
language sql
stable
as $$ select p_actor is not null and p_role = 'owner' $$;

create or replace function public.has_module_permission(p_actor uuid, p_module text, p_action text)
returns boolean
language sql
stable
as $$ select p_actor is not null and p_module = 'attendance' and p_action = 'edit' $$;

create table if not exists public.kiosk_report_locations (
  id uuid primary key default gen_random_uuid(),
  location_code text,
  location_name text,
  address text,
  active boolean not null default true
);

create table if not exists public.kiosk_report_staff (
  id uuid primary key default gen_random_uuid(),
  full_name text,
  phone_normalized text,
  location_id uuid references public.kiosk_report_locations(id),
  active boolean not null default true
);

create table if not exists public.delivery_staff (
  id uuid primary key default gen_random_uuid(),
  full_name text,
  phone_normalized text,
  active boolean not null default true
);

create table if not exists public.attendance_geofence_locations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  location_type text not null,
  kiosk_location_id uuid references public.kiosk_report_locations(id),
  latitude numeric(9,6),
  longitude numeric(9,6),
  accepted_radius_m integer not null default 20,
  active boolean not null default true
);

insert into public.attendance_geofence_locations(code, name, location_type, kiosk_location_id, latitude, longitude, active)
values ('warehouse_tan_tao', 'Kho Tân Tạo', 'warehouse', null, null, null, true)
on conflict (code) do update set latitude = null, longitude = null, active = true;
