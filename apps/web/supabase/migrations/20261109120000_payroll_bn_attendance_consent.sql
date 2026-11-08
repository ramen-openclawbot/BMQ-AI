-- ============================================================================
-- Migration: Thoả thuận dữ liệu khuôn mặt và vị trí trước khi chấm công
--            (payroll_bn · luong.banhmique.vn)
--
-- Vietnam PDPL 91/2025/QH15 + Decree 356/2025: a facial image is sensitive
-- biometric data and a GPS location is personal data. GPS/selfie attendance
-- therefore requires explicit, versioned, withdrawable employee consent
-- BEFORE any location/camera use.
--
-- Adds:
--   (a) payroll_bn_attendance_consents        — append-only consent evidence
--   (b) payroll_bn_attendance_consent_config  — singleton current version +
--                                               selfie retention policy
--   (c) replaces record_payroll_bn_attendance_event with the consent gate
--   (d) service-role-only accept/withdraw RPCs
--   (e) list_payroll_bn_attendance returns per-employee consent state
--   (f) daily selfie-retention cron (03:30 Asia/Ho_Chi_Minh = 20:30 UTC)
--
-- Payroll calculation, kiosk/delivery GPS attendance and the existing
-- 20261109100000 event ledger are untouched: the ledger stays immutable and
-- selfie_path is never rewritten by retention. This migration has NOT been
-- applied to production.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (a) Append-only consent evidence
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_attendance_consents (
  id uuid primary key default gen_random_uuid(),
  employee_code text not null,
  consent_version text not null,
  accepted_at timestamptz not null default now(),
  device_hash text not null,
  session_id uuid references public.payroll_bn_payslip_sessions(id) on delete set null,
  user_agent_family text,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  constraint payroll_bn_attendance_consents_employee_code_not_blank
    check (length(btrim(employee_code)) > 0),
  constraint payroll_bn_attendance_consents_version_not_blank
    check (length(btrim(consent_version)) between 1 and 40),
  constraint payroll_bn_attendance_consents_device_hash_check
    check (device_hash ~ '^[0-9a-f]{64}$'),
  constraint payroll_bn_attendance_consents_user_agent_family_check
    check (user_agent_family is null or length(user_agent_family) <= 40),
  constraint payroll_bn_attendance_consents_withdrawn_after_accept_check
    check (withdrawn_at is null or withdrawn_at >= accepted_at)
);

-- One non-withdrawn consent per employee and agreement version. A withdrawal
-- frees the pair so the employee can accept the same version again later.
create unique index if not exists payroll_bn_attendance_consents_one_active
  on public.payroll_bn_attendance_consents(employee_code, consent_version)
  where withdrawn_at is null;

create index if not exists payroll_bn_attendance_consents_employee_idx
  on public.payroll_bn_attendance_consents(employee_code, accepted_at desc);

create or replace function public.enforce_payroll_bn_attendance_consent_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payroll_bn_attendance_consents_are_append_only'
      using errcode = '45000';
  end if;

  -- withdrawn_at may be set exactly once. Every other update is blocked.
  if old.withdrawn_at is not null then
    raise exception 'payroll_bn_attendance_consent_withdrawn_once'
      using errcode = '45000';
  end if;

  if new.withdrawn_at is null then
    raise exception 'payroll_bn_attendance_consent_update_blocked'
      using errcode = '45000';
  end if;

  if (to_jsonb(new) - 'withdrawn_at') is distinct from (to_jsonb(old) - 'withdrawn_at') then
    raise exception 'payroll_bn_attendance_consent_update_blocked'
      using errcode = '45000';
  end if;

  return new;
end;
$$;

drop trigger if exists payroll_bn_attendance_consents_append_only
  on public.payroll_bn_attendance_consents;
create trigger payroll_bn_attendance_consents_append_only
before update or delete on public.payroll_bn_attendance_consents
for each row execute function public.enforce_payroll_bn_attendance_consent_append_only();

revoke all on function public.enforce_payroll_bn_attendance_consent_append_only()
  from public, anon, authenticated;

alter table public.payroll_bn_attendance_consents enable row level security;

revoke all on table public.payroll_bn_attendance_consents
  from public, anon, authenticated;
grant all on table public.payroll_bn_attendance_consents to service_role;

comment on table public.payroll_bn_attendance_consents is
  'Append-only, versioned employee consent evidence for payroll_bn GPS/selfie attendance. Rows may only receive withdrawn_at once; browser roles cannot read or write this table.';

-- ---------------------------------------------------------------------------
-- (b) Singleton config: current agreement version + selfie retention policy
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_attendance_consent_config (
  id boolean primary key default true,
  current_version text not null,
  selfie_retention_days int not null default 90,
  worker_secret uuid not null default gen_random_uuid(),
  constraint payroll_bn_attendance_consent_config_singleton_check
    check (id is true),
  constraint payroll_bn_attendance_consent_config_version_not_blank
    check (length(btrim(current_version)) between 1 and 40),
  constraint payroll_bn_attendance_consent_config_retention_check
    check (selfie_retention_days between 30 and 365)
);

insert into public.payroll_bn_attendance_consent_config(
  id,
  current_version,
  selfie_retention_days
) values (
  true,
  '2026-11-09',
  90
)
on conflict (id) do nothing;

alter table public.payroll_bn_attendance_consent_config enable row level security;

revoke all on table public.payroll_bn_attendance_consent_config
  from public, anon, authenticated;
grant all on table public.payroll_bn_attendance_consent_config to service_role;

comment on table public.payroll_bn_attendance_consent_config is
  'Singleton consent agreement version and selfie retention policy (30..365 days, default 90). worker_secret guards the pg_cron -> Edge retention call.';

-- ---------------------------------------------------------------------------
-- (c) Replace the attendance RPC: explicit consent check right after the
--     session check. Signature, grants and every existing rule are preserved.
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

  -- Explicit, versioned and withdrawable consent is required BEFORE any
  -- location/camera attendance decision. A version bump invalidates every
  -- earlier acceptance until the employee accepts the new version.
  if v_decision = 'accepted' then
    if not exists (
      select 1
      from public.payroll_bn_attendance_consents c
      where c.employee_code = v_employee_code
        and c.withdrawn_at is null
        and c.consent_version = (
          select cfg.current_version
          from public.payroll_bn_attendance_consent_config cfg
          where cfg.id is true
        )
    ) then
      v_decision := 'rejected';
      v_reason := 'consent_required';
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
  'Service-role-only GPS attendance decision + immutable ledger insert for payroll_bn. Re-checks session/device binding, current employee consent, the rollout gate, active device, anti-proxy sharing and the server-side haversine radius.';

-- ---------------------------------------------------------------------------
-- (d) Service-role-only consent RPCs
-- ---------------------------------------------------------------------------
do $migration$
begin
  execute $sql$
create or replace function public.accept_payroll_bn_attendance_consent(
  p_employee_code text,
  p_version text,
  p_device_hash text,
  p_session_id uuid,
  p_user_agent_family text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_code text := btrim(coalesce(p_employee_code, ''));
  v_version text := btrim(coalesce(p_version, ''));
  v_device_hash text := lower(btrim(coalesce(p_device_hash, '')));
  v_user_agent_family text := nullif(left(btrim(coalesce(p_user_agent_family, '')), 40), '');
  v_current_version text;
  v_row public.payroll_bn_attendance_consents%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'payroll_bn_attendance_service_role_required' using errcode = '42501';
  end if;

  if v_employee_code = '' then
    raise exception 'payroll_bn_attendance_employee_required' using errcode = '22023';
  end if;

  if v_version = '' then
    raise exception 'payroll_bn_attendance_consent_version_required' using errcode = '22023';
  end if;

  if v_device_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'payroll_bn_attendance_invalid_device_hash' using errcode = '22023';
  end if;

  select current_version into v_current_version
  from public.payroll_bn_attendance_consent_config
  where id is true;

  if v_current_version is null or v_version <> v_current_version then
    raise exception 'payroll_bn_attendance_consent_version_not_current' using errcode = '22023';
  end if;

  -- Idempotent: an already-active acceptance of the current version returns
  -- the existing evidence row instead of creating a duplicate.
  select * into v_row
  from public.payroll_bn_attendance_consents
  where employee_code = v_employee_code
    and consent_version = v_version
    and withdrawn_at is null
  order by accepted_at desc, id desc
  limit 1;

  if v_row.id is not null then
    return jsonb_build_object('consent', to_jsonb(v_row));
  end if;

  insert into public.payroll_bn_attendance_consents(
    employee_code,
    consent_version,
    accepted_at,
    device_hash,
    session_id,
    user_agent_family
  ) values (
    v_employee_code,
    v_version,
    statement_timestamp(),
    v_device_hash,
    p_session_id,
    v_user_agent_family
  )
  returning * into v_row;

  return jsonb_build_object('consent', to_jsonb(v_row));
exception when unique_violation then
  select * into v_row
  from public.payroll_bn_attendance_consents
  where employee_code = v_employee_code
    and consent_version = v_version
    and withdrawn_at is null
  order by accepted_at desc, id desc
  limit 1;

  return jsonb_build_object('consent', to_jsonb(v_row));
end;
$$;
$sql$;

  revoke all on function public.accept_payroll_bn_attendance_consent(
    text, text, text, uuid, text
  ) from public, anon, authenticated;

  grant execute on function public.accept_payroll_bn_attendance_consent(
    text, text, text, uuid, text
  ) to service_role;
end
$migration$;

do $migration$
begin
  execute $sql$
create or replace function public.withdraw_payroll_bn_attendance_consent(
  p_employee_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_code text := btrim(coalesce(p_employee_code, ''));
  v_withdrawn_count integer := 0;
  v_row public.payroll_bn_attendance_consents%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'payroll_bn_attendance_service_role_required' using errcode = '42501';
  end if;

  if v_employee_code = '' then
    raise exception 'payroll_bn_attendance_employee_required' using errcode = '22023';
  end if;

  update public.payroll_bn_attendance_consents
  set withdrawn_at = statement_timestamp()
  where employee_code = v_employee_code
    and withdrawn_at is null;

  get diagnostics v_withdrawn_count = row_count;

  select * into v_row
  from public.payroll_bn_attendance_consents
  where employee_code = v_employee_code
  order by accepted_at desc, id desc
  limit 1;

  return jsonb_build_object(
    'consent', case when v_row.id is null then null else to_jsonb(v_row) end,
    'withdrawn_count', v_withdrawn_count
  );
end;
$$;
$sql$;

  revoke all on function public.withdraw_payroll_bn_attendance_consent(text)
    from public, anon, authenticated;
  grant execute on function public.withdraw_payroll_bn_attendance_consent(text)
    to service_role;
end
$migration$;

comment on function public.accept_payroll_bn_attendance_consent(text, text, text, uuid, text) is
  'Service-role-only, version-checked, idempotent employee consent acceptance for payroll_bn GPS/selfie attendance.';
comment on function public.withdraw_payroll_bn_attendance_consent(text) is
  'Service-role-only withdrawal of every active payroll_bn GPS/selfie consent row for one employee. Files and the attendance ledger are untouched.';

-- ---------------------------------------------------------------------------
-- (e) Manager list now includes the latest consent row per employee
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
      'consents', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'employee_code', c.employee_code,
            'consent_version', c.consent_version,
            'accepted_at', c.accepted_at,
            'withdrawn_at', c.withdrawn_at
          )
          order by c.employee_code
        )
        from (
          select distinct on (employee_code)
            employee_code,
            consent_version,
            accepted_at,
            withdrawn_at
          from public.payroll_bn_attendance_consents
          order by employee_code, accepted_at desc, id desc
        ) c
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

comment on function public.list_payroll_bn_attendance(date, date) is
  'Manager list of payroll_bn GPS attendance events plus per-day status and the latest consent row per employee. Owner or payroll.edit only.';

-- ---------------------------------------------------------------------------
-- (f) Daily selfie retention: 03:30 Asia/Ho_Chi_Minh = 20:30 UTC.
--     The worker deletes storage objects only; the immutable events table and
--     its selfie_path value stay exactly as recorded.
-- ---------------------------------------------------------------------------
do $payroll_attendance_retention_cron$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job
    where jobname = 'payroll-attendance-selfie-retention-daily'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'payroll-attendance-selfie-retention-daily',
    '30 20 * * *',
    $job$
      select net.http_post(
        url := 'https://cxntbdvfsikwmitapony.supabase.co/functions/v1/payroll-attendance-selfie-retention',
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'x-worker-secret', (
            select worker_secret::text
            from public.payroll_bn_attendance_consent_config
            where id is true
          )
        ),
        body := jsonb_build_object('trigger', 'cron'),
        timeout_milliseconds := 120000
      );
    $job$
  );
end;
$payroll_attendance_retention_cron$;
