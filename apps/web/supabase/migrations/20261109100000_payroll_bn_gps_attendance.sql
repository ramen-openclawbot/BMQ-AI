-- ============================================================================
-- Migration: Chấm công GPS + ảnh cho nhân viên Bếp Q7 (payroll_bn)
--
-- Adds the server-authoritative, fail-closed, immutable attendance ledger for
-- the employee portal (luong.banhmique.vn):
--   (a) attendance_geofence_locations gains the 'kitchen' type and the
--       kitchen_q7 site (coordinates intentionally NULL until the owner sets
--       them; the seed never invents a location).
--   (b) payroll_bn_attendance_gates        — default-off per-employee gate
--   (c) payroll_bn_attendance_devices      — one active device per employee
--   (d) payroll_bn_attendance_events       — immutable accepted/rejected ledger
--   (e) payroll_bn_attendance_day_overrides — manager approval of incomplete days
--   (f) private selfie bucket 'payroll-attendance-selfies'
--   (g) payroll_bn_payslip_sessions.device_hash
--
-- Kiosk/delivery GPS attendance (baocao.banhmique.vn) is untouched: this
-- migration only adds payroll_bn_* tables and a new attendance_geofence_locations
-- type. Payroll calculation, attendance upload and payslip publishing are not
-- changed. This migration has NOT been applied to production.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (a) Kitchen geofence type + kitchen_q7 seed (no invented coordinates)
-- ---------------------------------------------------------------------------
alter table public.attendance_geofence_locations
  drop constraint if exists attendance_geofence_locations_type_check,
  add constraint attendance_geofence_locations_type_check
    check (location_type in ('kiosk', 'warehouse', 'kitchen'));

alter table public.attendance_geofence_locations
  drop constraint if exists attendance_geofence_locations_kiosk_link_check,
  add constraint attendance_geofence_locations_kiosk_link_check check (
    (location_type = 'kiosk')
    or (location_type in ('warehouse', 'kitchen') and kiosk_location_id is null)
  );

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
  'kitchen_q7',
  'Bếp Q7',
  'kitchen',
  null,
  null,
  null,
  50,
  true,
  'GPS attendance target for payroll_bn kitchen-Q7 employees. Coordinates intentionally unset until the owner sets them through set_payroll_bn_kitchen_q7_site.'
)
on conflict (code) do nothing;

comment on column public.attendance_geofence_locations.location_type is
  'kiosk, warehouse or kitchen. Kitchen/warehouse rows never link a kiosk_location_id.';

-- ---------------------------------------------------------------------------
-- (b) Default-off per-employee rollout gate + audit log
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_attendance_gates (
  employee_code text primary key,
  enabled boolean not null default false,
  geofence_location_id uuid references public.attendance_geofence_locations(id) on delete restrict,
  updated_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_bn_attendance_gates_employee_code_not_blank
    check (length(btrim(employee_code)) > 0)
);

create table if not exists public.payroll_bn_attendance_gate_audit_logs (
  id uuid primary key default gen_random_uuid(),
  employee_code text not null,
  action text not null,
  actor_id uuid,
  before_payload jsonb,
  after_payload jsonb,
  created_at timestamptz not null default now(),
  constraint payroll_bn_attendance_gate_audit_action_check
    check (action in ('insert', 'update', 'delete'))
);

create index if not exists payroll_bn_attendance_gate_audit_employee_idx
  on public.payroll_bn_attendance_gate_audit_logs(employee_code, created_at desc);

drop trigger if exists set_updated_at_payroll_bn_attendance_gates on public.payroll_bn_attendance_gates;
create trigger set_updated_at_payroll_bn_attendance_gates
before update on public.payroll_bn_attendance_gates
for each row execute function public.handle_updated_at();

create or replace function public.audit_payroll_bn_attendance_gate_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.payroll_bn_attendance_gate_audit_logs(
    employee_code,
    action,
    actor_id,
    before_payload,
    after_payload
  ) values (
    coalesce(new.employee_code, old.employee_code),
    lower(tg_op),
    auth.uid(),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists audit_payroll_bn_attendance_gate_changes on public.payroll_bn_attendance_gates;
create trigger audit_payroll_bn_attendance_gate_changes
after insert or update or delete on public.payroll_bn_attendance_gates
for each row execute function public.audit_payroll_bn_attendance_gate_change();

revoke all on function public.audit_payroll_bn_attendance_gate_change()
  from public, anon, authenticated;

comment on table public.payroll_bn_attendance_gates is
  'Default-off per-employee GPS attendance gate for payroll_bn. Missing rows and disabled rows both fail closed.';
comment on table public.payroll_bn_attendance_gate_audit_logs is
  'Immutable audit history for payroll_bn GPS attendance gate changes.';

-- ---------------------------------------------------------------------------
-- (c) Device binding: one active device per employee
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_attendance_devices (
  id uuid primary key default gen_random_uuid(),
  employee_code text not null,
  device_hash text not null,
  status text not null default 'pending',
  first_seen_at timestamptz not null default now(),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  user_agent_family text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_bn_attendance_devices_employee_code_not_blank
    check (length(btrim(employee_code)) > 0),
  constraint payroll_bn_attendance_devices_hash_check
    check (device_hash ~ '^[0-9a-f]{64}$'),
  constraint payroll_bn_attendance_devices_status_check
    check (status in ('active', 'pending', 'revoked')),
  constraint payroll_bn_attendance_devices_user_agent_family_check
    check (user_agent_family is null or length(user_agent_family) <= 40),
  constraint payroll_bn_attendance_devices_employee_device_unique
    unique (employee_code, device_hash)
);

-- At most one active device per employee; old rows stay as history.
create unique index if not exists payroll_bn_attendance_devices_one_active
  on public.payroll_bn_attendance_devices(employee_code)
  where status = 'active';

create index if not exists payroll_bn_attendance_devices_employee_idx
  on public.payroll_bn_attendance_devices(employee_code, first_seen_at desc);

drop trigger if exists set_updated_at_payroll_bn_attendance_devices on public.payroll_bn_attendance_devices;
create trigger set_updated_at_payroll_bn_attendance_devices
before update on public.payroll_bn_attendance_devices
for each row execute function public.handle_updated_at();

comment on table public.payroll_bn_attendance_devices is
  'Employee-bound attendance devices. A pending row waits for a manager; only one active device is allowed per employee.';

-- ---------------------------------------------------------------------------
-- (d) Immutable attendance event ledger
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_attendance_events (
  id uuid primary key default gen_random_uuid(),
  employee_code text not null,
  event_kind text not null,
  work_date date not null default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
  server_received_at timestamptz not null default now(),
  device_captured_at timestamptz,
  latitude numeric(9,6),
  longitude numeric(9,6),
  accuracy_m numeric(8,2),
  geofence_location_id uuid references public.attendance_geofence_locations(id) on delete restrict,
  distance_m numeric(10,2),
  decision text not null,
  reject_reason text,
  suspected_proxy boolean not null default false,
  device_hash text,
  session_id uuid references public.payroll_bn_payslip_sessions(id) on delete restrict,
  selfie_path text,
  created_at timestamptz not null default now(),
  constraint payroll_bn_attendance_events_employee_code_not_blank
    check (length(btrim(employee_code)) > 0),
  constraint payroll_bn_attendance_events_kind_check
    check (event_kind in ('in', 'out')),
  constraint payroll_bn_attendance_events_decision_check
    check (decision in ('accepted', 'rejected')),
  constraint payroll_bn_attendance_events_reject_reason_check
    check (reject_reason is null or reject_reason ~ '^[a-z0-9_]{2,80}$'),
  constraint payroll_bn_attendance_events_device_hash_check
    check (device_hash is null or device_hash ~ '^[0-9a-f]{64}$'),
  constraint payroll_bn_attendance_events_latitude_check
    check (latitude is null or latitude between -90 and 90),
  constraint payroll_bn_attendance_events_longitude_check
    check (longitude is null or longitude between -180 and 180),
  constraint payroll_bn_attendance_events_coordinates_pair_check
    check ((latitude is null and longitude is null) or (latitude is not null and longitude is not null)),
  constraint payroll_bn_attendance_events_accuracy_check
    check (accuracy_m is null or (accuracy_m >= 0 and accuracy_m < 100000)),
  constraint payroll_bn_attendance_events_distance_check
    check (distance_m is null or distance_m >= 0),
  constraint payroll_bn_attendance_events_selfie_path_check
    check (selfie_path is null or length(selfie_path) <= 500),
  constraint payroll_bn_attendance_events_work_date_vn_check
    check (work_date = (server_received_at at time zone 'Asia/Ho_Chi_Minh')::date)
);

create index if not exists payroll_bn_attendance_events_employee_day_idx
  on public.payroll_bn_attendance_events(employee_code, work_date, server_received_at desc);

create index if not exists payroll_bn_attendance_events_device_day_idx
  on public.payroll_bn_attendance_events(device_hash, work_date)
  where device_hash is not null;

create index if not exists payroll_bn_attendance_events_session_idx
  on public.payroll_bn_attendance_events(session_id, created_at desc);

create unique index if not exists payroll_bn_attendance_events_one_accepted_in
  on public.payroll_bn_attendance_events(employee_code, work_date)
  where decision = 'accepted' and event_kind = 'in';

create unique index if not exists payroll_bn_attendance_events_one_accepted_out
  on public.payroll_bn_attendance_events(employee_code, work_date)
  where decision = 'accepted' and event_kind = 'out';

create or replace function public.reject_payroll_bn_attendance_event_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'payroll_bn_attendance_events_are_immutable'
    using errcode = '45000';
end;
$$;

drop trigger if exists payroll_bn_attendance_events_immutable on public.payroll_bn_attendance_events;
create trigger payroll_bn_attendance_events_immutable
before update or delete on public.payroll_bn_attendance_events
for each row execute function public.reject_payroll_bn_attendance_event_mutation();

revoke all on function public.reject_payroll_bn_attendance_event_mutation()
  from public, anon, authenticated;

comment on table public.payroll_bn_attendance_events is
  'Immutable payroll_bn GPS attendance evidence ledger. Accepted and rejected attempts are preserved; the only mutation path is the service-role insert RPC.';
comment on column public.payroll_bn_attendance_events.work_date is
  'Vietnam-local work date computed on the server from server_received_at.';

-- ---------------------------------------------------------------------------
-- (e) Manager approval of incomplete days
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_attendance_day_overrides (
  id uuid primary key default gen_random_uuid(),
  employee_code text not null,
  work_date date not null,
  reason text not null,
  approved_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint payroll_bn_attendance_day_overrides_employee_code_not_blank
    check (length(btrim(employee_code)) > 0),
  constraint payroll_bn_attendance_day_overrides_reason_check
    check (length(btrim(reason)) between 8 and 1000),
  constraint payroll_bn_attendance_day_overrides_unique
    unique (employee_code, work_date)
);

create index if not exists payroll_bn_attendance_day_overrides_day_idx
  on public.payroll_bn_attendance_day_overrides(work_date desc, employee_code);

comment on table public.payroll_bn_attendance_day_overrides is
  'Manager approval for an incomplete payroll_bn attendance day. Overrides do not mutate the immutable event ledger.';

-- ---------------------------------------------------------------------------
-- (f) Private selfie bucket (no public read, 600 KB, JPEG/WebP)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payroll-attendance-selfies',
  'payroll-attendance-selfies',
  false,
  614400,
  array['image/jpeg', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists payroll_bn_attendance_selfies_select_manager on storage.objects;
create policy payroll_bn_attendance_selfies_select_manager
on storage.objects for select to authenticated
using (
  bucket_id = 'payroll-attendance-selfies'
  and (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  )
);

-- ---------------------------------------------------------------------------
-- (g) Sessions remember the SHA-256 of the browser device id
-- ---------------------------------------------------------------------------
alter table public.payroll_bn_payslip_sessions
  add column if not exists device_hash text;

alter table public.payroll_bn_payslip_sessions
  drop constraint if exists payroll_bn_payslip_sessions_device_hash_check,
  add constraint payroll_bn_payslip_sessions_device_hash_check
    check (device_hash is null or device_hash ~ '^[0-9a-f]{64}$');

create index if not exists payroll_bn_payslip_sessions_device_idx
  on public.payroll_bn_payslip_sessions(device_hash)
  where device_hash is not null;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_haversine_meters(
  p_lat1 numeric,
  p_lng1 numeric,
  p_lat2 numeric,
  p_lng2 numeric
)
returns numeric
language sql
immutable
set search_path = public
as $$
  select (6371008.8 * 2 * asin(
    least(
      1,
      sqrt(
        power(sin(radians(p_lat2 - p_lat1) / 2), 2)
        + cos(radians(p_lat1)) * cos(radians(p_lat2))
          * power(sin(radians(p_lng2 - p_lng1) / 2), 2)
      )
    )
  ))::numeric;
$$;

revoke all on function public.payroll_bn_haversine_meters(numeric, numeric, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.payroll_bn_haversine_meters(numeric, numeric, numeric, numeric)
  to service_role;

create or replace function public.payroll_bn_attendance_admin_allowed(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_uid is not null and (
    public.has_role(p_uid, 'owner')
    or public.has_module_permission(p_uid, 'payroll', 'edit')
  );
$$;

revoke all on function public.payroll_bn_attendance_admin_allowed(uuid)
  from public, anon;
grant execute on function public.payroll_bn_attendance_admin_allowed(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS + grants. Browser roles can read manager-facing configuration, but the
-- immutable event ledger and all writes stay service-role-only.
-- ---------------------------------------------------------------------------
alter table public.payroll_bn_attendance_gates enable row level security;
alter table public.payroll_bn_attendance_gate_audit_logs enable row level security;
alter table public.payroll_bn_attendance_devices enable row level security;
alter table public.payroll_bn_attendance_events enable row level security;
alter table public.payroll_bn_attendance_day_overrides enable row level security;

revoke all on table public.payroll_bn_attendance_gates from public, anon, authenticated;
revoke all on table public.payroll_bn_attendance_gate_audit_logs from public, anon, authenticated;
revoke all on table public.payroll_bn_attendance_devices from public, anon, authenticated;
revoke all on table public.payroll_bn_attendance_events from public, anon, authenticated;
revoke all on table public.payroll_bn_attendance_day_overrides from public, anon, authenticated;

grant select on table public.payroll_bn_attendance_gates to authenticated;
grant select on table public.payroll_bn_attendance_gate_audit_logs to authenticated;
grant select on table public.payroll_bn_attendance_devices to authenticated;
grant select on table public.payroll_bn_attendance_day_overrides to authenticated;
grant select on table public.payroll_bn_attendance_events to service_role;

grant all on table public.payroll_bn_attendance_gates to service_role;
grant all on table public.payroll_bn_attendance_gate_audit_logs to service_role;
grant all on table public.payroll_bn_attendance_devices to service_role;
grant all on table public.payroll_bn_attendance_day_overrides to service_role;

drop policy if exists payroll_bn_attendance_gates_select_manager on public.payroll_bn_attendance_gates;
create policy payroll_bn_attendance_gates_select_manager
on public.payroll_bn_attendance_gates for select to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
);

drop policy if exists payroll_bn_attendance_gate_audit_select_manager on public.payroll_bn_attendance_gate_audit_logs;
create policy payroll_bn_attendance_gate_audit_select_manager
on public.payroll_bn_attendance_gate_audit_logs for select to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
);

drop policy if exists payroll_bn_attendance_devices_select_manager on public.payroll_bn_attendance_devices;
create policy payroll_bn_attendance_devices_select_manager
on public.payroll_bn_attendance_devices for select to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
);

drop policy if exists payroll_bn_attendance_overrides_select_manager on public.payroll_bn_attendance_day_overrides;
create policy payroll_bn_attendance_overrides_select_manager
on public.payroll_bn_attendance_day_overrides for select to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
);

-- ---------------------------------------------------------------------------
-- Service-role-only attendance decision + insert RPC
-- ---------------------------------------------------------------------------
do $migration$
begin
  execute $sql$
create or replace function public.record_payroll_bn_attendance_event(
  p_employee_code text,
  p_event_kind text,
  p_device_hash text,
  p_session_id uuid,
  p_latitude numeric,
  p_longitude numeric,
  p_accuracy_m numeric,
  p_device_captured_at timestamptz,
  p_selfie_path text,
  p_user_agent_family text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_code text := btrim(coalesce(p_employee_code, ''));
  v_event_kind text := lower(btrim(coalesce(p_event_kind, '')));
  v_device_hash text := lower(btrim(coalesce(p_device_hash, '')));
  v_user_agent_family text := nullif(left(btrim(coalesce(p_user_agent_family, '')), 40), '');
  v_now timestamptz := statement_timestamp();
  v_work_date date;
  v_gate public.payroll_bn_attendance_gates%rowtype;
  v_site public.attendance_geofence_locations%rowtype;
  v_session public.payroll_bn_payslip_sessions%rowtype;
  v_session_ok boolean := false;
  v_device_active boolean := false;
  v_device_used_by_other boolean := false;
  v_has_in boolean := false;
  v_has_out boolean := false;
  v_coordinates_valid boolean := p_latitude is not null
    and p_longitude is not null
    and p_latitude between -90 and 90
    and p_longitude between -180 and 180;
  v_accuracy_valid boolean := p_accuracy_m is not null
    and p_accuracy_m >= 0
    and p_accuracy_m < 100000;
  v_distance_raw numeric;
  v_distance numeric;
  v_decision text := 'accepted';
  v_reason text := 'accepted';
  v_suspected_proxy boolean := false;
  v_event_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'payroll_bn_attendance_service_role_required' using errcode = '42501';
  end if;

  if v_employee_code = '' then
    raise exception 'payroll_bn_attendance_employee_required' using errcode = '22023';
  end if;

  if v_event_kind not in ('in', 'out') then
    raise exception 'payroll_bn_attendance_invalid_event_kind' using errcode = '22023';
  end if;

  if v_device_hash <> '' and v_device_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'payroll_bn_attendance_invalid_device_hash' using errcode = '22023';
  end if;

  v_work_date := (v_now at time zone 'Asia/Ho_Chi_Minh')::date;

  -- The psp_ session must exist, be live, belong to this employee and be
  -- bound to the exact device hash presented by the Edge Function.
  if p_session_id is null then
    v_decision := 'rejected';
    v_reason := 'session_invalid';
  else
    select * into v_session
    from public.payroll_bn_payslip_sessions
    where id = p_session_id;

    if v_session.id is null
       or v_session.employee_code <> v_employee_code
       or v_session.revoked_at is not null
       or v_session.expires_at <= v_now
       or v_session.device_hash is null
       or v_session.device_hash is distinct from v_device_hash then
      v_decision := 'rejected';
      v_reason := 'session_invalid';
    else
      v_session_ok := true;
    end if;
  end if;

  -- Rollout gate + site configuration.
  if v_decision = 'accepted' then
    select * into v_gate
    from public.payroll_bn_attendance_gates
    where employee_code = v_employee_code;

    if v_gate.employee_code is null or v_gate.enabled is not true then
      v_decision := 'rejected';
      v_reason := 'gate_disabled';
    else
      select * into v_site
      from public.attendance_geofence_locations
      where id = v_gate.geofence_location_id;

      if v_site.id is null
         or v_site.active is not true
         or v_site.latitude is null
         or v_site.longitude is null then
        v_decision := 'rejected';
        v_reason := 'site_not_configured';
      end if;
    end if;
  end if;

  -- Device fix quality; the server recomputes distance, never trusts a client.
  if v_decision = 'accepted' then
    if p_latitude is null
       or p_longitude is null
       or p_latitude not between -90 and 90
       or p_longitude not between -180 and 180 then
      v_decision := 'rejected';
      v_reason := 'no_location';
    elsif p_accuracy_m is null or p_accuracy_m < 0 or p_accuracy_m > 100 then
      v_decision := 'rejected';
      v_reason := 'low_accuracy';
    else
      v_distance_raw := public.payroll_bn_haversine_meters(
        p_latitude,
        p_longitude,
        v_site.latitude,
        v_site.longitude
      )::numeric;
      v_distance := round(v_distance_raw, 2);
    end if;
  end if;

  -- Device approval and anti-proxy check.
  if v_device_hash <> '' then
    select exists (
      select 1
      from public.payroll_bn_attendance_devices d
      where d.employee_code = v_employee_code
        and d.device_hash = v_device_hash
        and d.status = 'active'
    ) into v_device_active;

    select exists (
      select 1
      from public.payroll_bn_attendance_events e
      where e.device_hash = v_device_hash
        and e.work_date = v_work_date
        and e.employee_code <> v_employee_code
        and e.decision = 'accepted'
    ) into v_device_used_by_other;
  end if;

  if v_decision = 'accepted' and v_device_used_by_other then
    v_decision := 'rejected';
    v_reason := 'device_used_by_other';
    v_suspected_proxy := true;
  end if;

  -- Owner decision 2026-11-09: the employee's FIRST device is registered as
  -- active automatically. Only when the employee has never had any device row
  -- (active, pending or revoked) and that device is not already active for
  -- another employee. Every later device waits for a manager.
  if v_decision = 'accepted'
     and not v_device_active
     and v_device_hash <> ''
     and not exists (
       select 1 from public.payroll_bn_attendance_devices d
       where d.employee_code = v_employee_code
     )
     and not exists (
       select 1 from public.payroll_bn_attendance_devices d
       where d.device_hash = v_device_hash
         and d.status = 'active'
         and d.employee_code <> v_employee_code
     ) then
    insert into public.payroll_bn_attendance_devices(
      employee_code, device_hash, status, first_seen_at, approved_at, user_agent_family
    ) values (
      v_employee_code, v_device_hash, 'active', v_now, v_now, v_user_agent_family
    )
    on conflict do nothing;

    select exists (
      select 1 from public.payroll_bn_attendance_devices d
      where d.employee_code = v_employee_code
        and d.device_hash = v_device_hash
        and d.status = 'active'
    ) into v_device_active;
  end if;

  if v_decision = 'accepted' and not v_device_active then
    v_decision := 'rejected';
    v_reason := 'device_not_approved';
  end if;

  -- In/out ordering and duplicate rules.
  if v_decision = 'accepted' then
    select exists (
      select 1 from public.payroll_bn_attendance_events e
      where e.employee_code = v_employee_code
        and e.work_date = v_work_date
        and e.event_kind = 'in'
        and e.decision = 'accepted'
    ) into v_has_in;

    select exists (
      select 1 from public.payroll_bn_attendance_events e
      where e.employee_code = v_employee_code
        and e.work_date = v_work_date
        and e.event_kind = 'out'
        and e.decision = 'accepted'
    ) into v_has_out;

    if v_event_kind = 'out' and not v_has_in then
      v_decision := 'rejected';
      v_reason := 'checkout_before_checkin';
    elsif (v_event_kind = 'in' and v_has_in) or (v_event_kind = 'out' and v_has_out) then
      v_decision := 'rejected';
      v_reason := 'already_recorded';
    elsif v_distance_raw is null or v_distance_raw > v_site.accepted_radius_m then
      v_decision := 'rejected';
      v_reason := 'outside_geofence';
    end if;
  end if;

  insert into public.payroll_bn_attendance_events(
    employee_code,
    event_kind,
    work_date,
    server_received_at,
    device_captured_at,
    latitude,
    longitude,
    accuracy_m,
    geofence_location_id,
    distance_m,
    decision,
    reject_reason,
    suspected_proxy,
    device_hash,
    session_id,
    selfie_path,
    created_at
  ) values (
    v_employee_code,
    v_event_kind,
    v_work_date,
    v_now,
    p_device_captured_at,
    case when v_coordinates_valid then p_latitude else null end,
    case when v_coordinates_valid then p_longitude else null end,
    case when v_accuracy_valid then p_accuracy_m else null end,
    v_gate.geofence_location_id,
    v_distance,
    v_decision,
    case when v_decision = 'accepted' then null else v_reason end,
    v_suspected_proxy,
    nullif(v_device_hash, ''),
    case when v_session_ok then p_session_id else null end,
    nullif(btrim(coalesce(p_selfie_path, '')), ''),
    v_now
  )
  returning id into v_event_id;

  -- An unapproved device waits for a manager; keep one pending row.
  if v_reason = 'device_not_approved' and v_device_hash <> '' then
    insert into public.payroll_bn_attendance_devices as d(
      employee_code,
      device_hash,
      status,
      first_seen_at,
      user_agent_family
    ) values (
      v_employee_code,
      v_device_hash,
      'pending',
      v_now,
      v_user_agent_family
    )
    on conflict (employee_code, device_hash) do update
    set user_agent_family = coalesce(excluded.user_agent_family, d.user_agent_family)
    where d.status = 'pending';
  end if;

  return jsonb_build_object(
    'event_id', v_event_id,
    'employee_code', v_employee_code,
    'event_kind', v_event_kind,
    'work_date', v_work_date,
    'decision', v_decision,
    'reason_code', case when v_decision = 'accepted' then null else v_reason end,
    'suspected_proxy', v_suspected_proxy,
    'distance_m', v_distance,
    'server_received_at', v_now
  );
exception when unique_violation then
  return jsonb_build_object(
    'event_id', null,
    'employee_code', v_employee_code,
    'event_kind', v_event_kind,
    'work_date', v_work_date,
    'decision', 'rejected',
    'reason_code', 'already_recorded',
    'suspected_proxy', v_suspected_proxy,
    'distance_m', v_distance,
    'server_received_at', v_now
  );
end;
$$;
$sql$;

  revoke all on function public.record_payroll_bn_attendance_event(
    text, text, text, uuid, numeric, numeric, numeric, timestamptz, text, text
  ) from public, anon, authenticated;

  grant execute on function public.record_payroll_bn_attendance_event(
    text, text, text, uuid, numeric, numeric, numeric, timestamptz, text, text
  ) to service_role;
end
$migration$;

comment on function public.record_payroll_bn_attendance_event(
  text, text, text, uuid, numeric, numeric, numeric, timestamptz, text, text
) is
  'Service-role-only GPS attendance decision + immutable ledger insert for payroll_bn. Re-checks session/device binding, the rollout gate, active device, anti-proxy sharing and the server-side haversine radius.';

-- ---------------------------------------------------------------------------
-- Admin RPCs (owner or existing payroll_bn edit permission)
-- ---------------------------------------------------------------------------
do $migration$
begin
  execute $sql$
create or replace function public.list_payroll_bn_attendance(
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_to date := coalesce(p_to, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_from date := coalesce(p_from, coalesce(p_to, (now() at time zone 'Asia/Ho_Chi_Minh')::date) - 34);
  v_payload jsonb;
begin
  if not public.payroll_bn_attendance_admin_allowed(v_uid) then
    raise exception 'payroll_bn_attendance_forbidden' using errcode = '42501';
  end if;

  if v_to < v_from then
    raise exception 'payroll_bn_attendance_invalid_date_range' using errcode = '22007';
  end if;

  if v_to - v_from > 366 then
    raise exception 'payroll_bn_attendance_date_range_too_broad' using errcode = '22023';
  end if;

  with day_events as (
      select
        e.employee_code,
        e.work_date,
        bool_or(e.decision = 'accepted' and e.event_kind = 'in') as has_accepted_in,
        bool_or(e.decision = 'accepted' and e.event_kind = 'out') as has_accepted_out,
        bool_or(e.suspected_proxy) as suspected_proxy
      from public.payroll_bn_attendance_events e
      where e.work_date between v_from and v_to
      group by e.employee_code, e.work_date
    ), override_days as (
      select o.employee_code, o.work_date
      from public.payroll_bn_attendance_day_overrides o
      where o.work_date between v_from and v_to
    ), days as (
      select
        d.employee_code,
        d.work_date,
        case
          when d.has_accepted_in and d.has_accepted_out then 'complete'
          when o.employee_code is not null then 'approved_override'
          when d.has_accepted_in then 'missing_out'
          else 'missing_in'
        end as status,
        d.has_accepted_in,
        d.has_accepted_out,
        o.employee_code is not null as approved_override,
        d.suspected_proxy
      from day_events d
      left join override_days o using (employee_code, work_date)
    )
    select jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'events', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', e.id,
            'employee_code', e.employee_code,
            'event_kind', e.event_kind,
            'work_date', e.work_date,
            'server_received_at', e.server_received_at,
            'device_captured_at', e.device_captured_at,
            'latitude', e.latitude,
            'longitude', e.longitude,
            'accuracy_m', e.accuracy_m,
            'geofence_location_id', e.geofence_location_id,
            'distance_m', e.distance_m,
            'decision', e.decision,
            'reject_reason', e.reject_reason,
            'suspected_proxy', e.suspected_proxy,
            'device_hash', e.device_hash,
            'session_id', e.session_id,
            'selfie_path', e.selfie_path,
            'created_at', e.created_at
          )
          order by e.server_received_at desc, e.id
        )
        from public.payroll_bn_attendance_events e
        where e.work_date between v_from and v_to
      ), '[]'::jsonb),
      'days', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'employee_code', days.employee_code,
            'work_date', days.work_date,
            'status', days.status,
            'has_accepted_in', days.has_accepted_in,
            'has_accepted_out', days.has_accepted_out,
            'approved_override', days.approved_override,
            'suspected_proxy', days.suspected_proxy
          )
          order by days.work_date desc, days.employee_code
        )
        from days
      ), '[]'::jsonb),
      'gates', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'employee_code', g.employee_code,
            'enabled', g.enabled,
            'geofence_location_id', g.geofence_location_id,
            'updated_at', g.updated_at
          )
          order by g.employee_code
        )
        from public.payroll_bn_attendance_gates g
      ), '[]'::jsonb),
      'site', (
        select jsonb_build_object(
          'id', s.id,
          'code', s.code,
          'name', s.name,
          'latitude', s.latitude,
          'longitude', s.longitude,
          'radius_m', s.accepted_radius_m,
          'active', s.active,
          'configured', (s.latitude is not null and s.longitude is not null)
        )
        from public.attendance_geofence_locations s
        where s.code = 'kitchen_q7'
      )
    )
  into v_payload;

  return v_payload;
end;
$$;
$sql$;

  revoke all on function public.list_payroll_bn_attendance(date, date) from public, anon, authenticated;
  grant execute on function public.list_payroll_bn_attendance(date, date) to authenticated, service_role;
end
$migration$;

do $migration$
begin
  execute $sql$
create or replace function public.list_payroll_bn_attendance_devices(
  p_employee_code text default null,
  p_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_employee_code text := nullif(btrim(coalesce(p_employee_code, '')), '');
  v_status text := nullif(lower(btrim(coalesce(p_status, ''))), '');
begin
  if not public.payroll_bn_attendance_admin_allowed(v_uid) then
    raise exception 'payroll_bn_attendance_forbidden' using errcode = '42501';
  end if;

  if v_status is not null and v_status not in ('active', 'pending', 'revoked') then
    raise exception 'payroll_bn_attendance_invalid_device_status' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'devices', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', d.id,
          'employee_code', d.employee_code,
          'device_hash', d.device_hash,
          'status', d.status,
          'first_seen_at', d.first_seen_at,
          'approved_by', d.approved_by,
          'approved_at', d.approved_at,
          'user_agent_family', d.user_agent_family
        )
        order by d.first_seen_at desc, d.id
      )
      from public.payroll_bn_attendance_devices d
      where (v_employee_code is null or d.employee_code = v_employee_code)
        and (v_status is null or d.status = v_status)
    ), '[]'::jsonb)
  );
end;
$$;
$sql$;

  revoke all on function public.list_payroll_bn_attendance_devices(text, text) from public, anon, authenticated;
  grant execute on function public.list_payroll_bn_attendance_devices(text, text) to authenticated, service_role;
end
$migration$;

do $migration$
begin
  execute $sql$
create or replace function public.approve_payroll_bn_attendance_device(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_device public.payroll_bn_attendance_devices%rowtype;
begin
  if not public.payroll_bn_attendance_admin_allowed(v_uid) then
    raise exception 'payroll_bn_attendance_forbidden' using errcode = '42501';
  end if;

  select * into v_device
  from public.payroll_bn_attendance_devices
  where id = p_device_id
  for update;

  if v_device.id is null then
    raise exception 'payroll_bn_attendance_device_not_found' using errcode = 'P0002';
  end if;

  -- One active device per employee: retire the previous active row.
  update public.payroll_bn_attendance_devices
  set status = 'revoked',
      updated_at = now()
  where employee_code = v_device.employee_code
    and status = 'active'
    and id <> v_device.id;

  update public.payroll_bn_attendance_devices
  set status = 'active',
      approved_by = v_uid,
      approved_at = now(),
      updated_at = now()
  where id = v_device.id
  returning * into v_device;

  return jsonb_build_object('device', to_jsonb(v_device));
end;
$$;
$sql$;

  revoke all on function public.approve_payroll_bn_attendance_device(uuid) from public, anon, authenticated;
  grant execute on function public.approve_payroll_bn_attendance_device(uuid) to authenticated, service_role;
end
$migration$;

do $migration$
begin
  execute $sql$
create or replace function public.revoke_payroll_bn_attendance_device(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_device public.payroll_bn_attendance_devices%rowtype;
begin
  if not public.payroll_bn_attendance_admin_allowed(v_uid) then
    raise exception 'payroll_bn_attendance_forbidden' using errcode = '42501';
  end if;

  update public.payroll_bn_attendance_devices
  set status = 'revoked',
      updated_at = now()
  where id = p_device_id
  returning * into v_device;

  if v_device.id is null then
    raise exception 'payroll_bn_attendance_device_not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object('device', to_jsonb(v_device));
end;
$$;
$sql$;

  revoke all on function public.revoke_payroll_bn_attendance_device(uuid) from public, anon, authenticated;
  grant execute on function public.revoke_payroll_bn_attendance_device(uuid) to authenticated, service_role;
end
$migration$;

do $migration$
begin
  execute $sql$
create or replace function public.set_payroll_bn_attendance_gate(
  p_employee_code text,
  p_enabled boolean,
  p_geofence_location_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_employee_code text := btrim(coalesce(p_employee_code, ''));
  v_gate public.payroll_bn_attendance_gates%rowtype;
begin
  if not public.payroll_bn_attendance_admin_allowed(v_uid) then
    raise exception 'payroll_bn_attendance_forbidden' using errcode = '42501';
  end if;

  if v_employee_code = '' then
    raise exception 'payroll_bn_attendance_employee_required' using errcode = '22023';
  end if;

  if p_geofence_location_id is not null and not exists (
    select 1
    from public.attendance_geofence_locations
    where id = p_geofence_location_id
      and active is true
  ) then
    raise exception 'payroll_bn_attendance_site_not_found' using errcode = '22023';
  end if;

  insert into public.payroll_bn_attendance_gates(
    employee_code,
    enabled,
    geofence_location_id,
    updated_by,
    updated_at
  ) values (
    v_employee_code,
    coalesce(p_enabled, false),
    p_geofence_location_id,
    v_uid,
    now()
  )
  on conflict (employee_code) do update
  set enabled = excluded.enabled,
      geofence_location_id = excluded.geofence_location_id,
      updated_by = excluded.updated_by,
      updated_at = now()
  returning * into v_gate;

  return jsonb_build_object('gate', to_jsonb(v_gate));
end;
$$;
$sql$;

  revoke all on function public.set_payroll_bn_attendance_gate(text, boolean, uuid) from public, anon, authenticated;
  grant execute on function public.set_payroll_bn_attendance_gate(text, boolean, uuid) to authenticated, service_role;
end
$migration$;

do $migration$
begin
  execute $sql$
create or replace function public.approve_payroll_bn_attendance_day(
  p_employee_code text,
  p_work_date date,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_employee_code text := btrim(coalesce(p_employee_code, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_override public.payroll_bn_attendance_day_overrides%rowtype;
begin
  if not public.payroll_bn_attendance_admin_allowed(v_uid) then
    raise exception 'payroll_bn_attendance_forbidden' using errcode = '42501';
  end if;

  if v_employee_code = '' then
    raise exception 'payroll_bn_attendance_employee_required' using errcode = '22023';
  end if;

  if p_work_date is null then
    raise exception 'payroll_bn_attendance_work_date_required' using errcode = '22023';
  end if;

  if length(v_reason) < 8 or length(v_reason) > 1000 then
    raise exception 'payroll_bn_attendance_reason_invalid' using errcode = '22023';
  end if;

  insert into public.payroll_bn_attendance_day_overrides(
    employee_code,
    work_date,
    reason,
    approved_by
  ) values (
    v_employee_code,
    p_work_date,
    v_reason,
    v_uid
  )
  on conflict (employee_code, work_date) do update
  set reason = excluded.reason,
      approved_by = excluded.approved_by,
      created_at = now()
  returning * into v_override;

  return jsonb_build_object('override', to_jsonb(v_override));
end;
$$;
$sql$;

  revoke all on function public.approve_payroll_bn_attendance_day(text, date, text) from public, anon, authenticated;
  grant execute on function public.approve_payroll_bn_attendance_day(text, date, text) to authenticated, service_role;
end
$migration$;

do $migration$
begin
  execute $sql$
create or replace function public.set_payroll_bn_kitchen_q7_site(
  p_latitude numeric,
  p_longitude numeric,
  p_radius_m integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_site public.attendance_geofence_locations%rowtype;
begin
  if not public.payroll_bn_attendance_admin_allowed(v_uid) then
    raise exception 'payroll_bn_attendance_forbidden' using errcode = '42501';
  end if;

  if p_latitude is null or p_longitude is null
     or p_latitude not between -90 and 90
     or p_longitude not between -180 and 180 then
    raise exception 'payroll_bn_attendance_invalid_coordinates' using errcode = '22023';
  end if;

  if p_radius_m is null or p_radius_m < 1 or p_radius_m > 500 then
    raise exception 'payroll_bn_attendance_invalid_radius' using errcode = '22023';
  end if;

  update public.attendance_geofence_locations
  set latitude = p_latitude,
      longitude = p_longitude,
      accepted_radius_m = p_radius_m,
      updated_at = now()
  where code = 'kitchen_q7'
  returning * into v_site;

  if v_site.id is null then
    raise exception 'payroll_bn_attendance_kitchen_site_not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object('site', to_jsonb(v_site));
end;
$$;
$sql$;

  revoke all on function public.set_payroll_bn_kitchen_q7_site(numeric, numeric, integer) from public, anon, authenticated;
  grant execute on function public.set_payroll_bn_kitchen_q7_site(numeric, numeric, integer) to authenticated, service_role;
end
$migration$;

comment on function public.list_payroll_bn_attendance(date, date) is
  'Manager list of payroll_bn GPS attendance events plus per-day complete/missing_in/missing_out/approved_override status. Owner or payroll.edit only.';
comment on function public.list_payroll_bn_attendance_devices(text, text) is
  'Manager list of employee-bound attendance devices, optionally filtered by employee and status.';
comment on function public.approve_payroll_bn_attendance_device(uuid) is
  'Manager approval of a pending attendance device. Retires the previous active device so an employee has exactly one active device.';
comment on function public.revoke_payroll_bn_attendance_device(uuid) is
  'Manager revocation of an attendance device.';
comment on function public.set_payroll_bn_attendance_gate(text, boolean, uuid) is
  'Owner/payroll.edit rollout gate for one employee. Missing or disabled gates fail closed in the attendance RPC.';
comment on function public.approve_payroll_bn_attendance_day(text, date, text) is
  'Manager approval of an incomplete attendance day; the immutable event ledger is not modified.';
comment on function public.set_payroll_bn_kitchen_q7_site(numeric, numeric, integer) is
  'Owner/payroll.edit setting of the kitchen_q7 coordinates and radius. Audited by attendance_geofence_location_audit_logs; never seeded by migration.';
