-- ============================================================================
-- Migration: Tự nhận máy đã đăng nhập OTP Zalo (payroll_bn · luong.banhmique.vn)
--
-- A browser that completed a successful Zalo OTP verification owns a live psp_
-- session bound to its exact device hash. From now on, the first attendance
-- punch from that browser activates the device automatically and retires the
-- previous active device instead of waiting for a manager.
--
-- Kept unchanged:
--   * psp_ session validity/ownership/device binding checks
--   * the versioned consent gate
--   * the rollout gate and geofence/accuracy/radius rules
--   * the device_used_by_other anti-proxy rule
--   * in/out ordering and duplicate rules
--   * manager approval/revocation remain available and take precedence
--
-- Adds:
--   (a) payroll_bn_attendance_devices.activation / revoked_reason
--       (safe backfill only; existing statuses are never changed)
--   (b) payroll_bn_attendance_device_changes — immutable switch audit ledger
--   (c) record_payroll_bn_attendance_event — latest consent-gated definition
--       with the OTP auto-switch device block
--   (d) approve/revoke device RPCs now record activation/revoked_reason
--   (e) list device RPC returns the two new keys
--   (f) list_payroll_bn_attendance_device_changes manager RPC
--
-- This migration has NOT been applied to production.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (a) Activation provenance + revocation reason on device rows
-- ---------------------------------------------------------------------------
alter table public.payroll_bn_attendance_devices
  add column if not exists activation text,
  add column if not exists revoked_reason text;

alter table public.payroll_bn_attendance_devices
  drop constraint if exists payroll_bn_attendance_devices_activation_check,
  add constraint payroll_bn_attendance_devices_activation_check
    check (activation in ('first', 'otp_switch', 'manager'));

alter table public.payroll_bn_attendance_devices
  drop constraint if exists payroll_bn_attendance_devices_revoked_reason_check,
  add constraint payroll_bn_attendance_devices_revoked_reason_check
    check (revoked_reason in ('replaced', 'manager'));

-- Only what can be inferred safely. Statuses are deliberately untouched.
update public.payroll_bn_attendance_devices
set activation = 'first'
where status = 'active'
  and approved_by is null
  and activation is null;

update public.payroll_bn_attendance_devices
set activation = 'manager'
where approved_by is not null
  and activation is null;

comment on column public.payroll_bn_attendance_devices.activation is
  'How this device became active: first auto-registered device, Zalo-OTP auto switch, or explicit manager approval.';
comment on column public.payroll_bn_attendance_devices.revoked_reason is
  'Why an active device was retired: replaced by another device, or removed by a manager.';

-- ---------------------------------------------------------------------------
-- (b) Immutable audit ledger for automatic device switches
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_attendance_device_changes (
  id uuid primary key default gen_random_uuid(),
  employee_code text not null,
  from_device_hash text,
  to_device_hash text not null,
  user_agent_family text,
  session_id uuid,
  event_id uuid,
  changed_at timestamptz not null default now(),
  constraint payroll_bn_attendance_device_changes_employee_code_not_blank
    check (length(btrim(employee_code)) > 0),
  constraint payroll_bn_attendance_device_changes_from_hash_check
    check (from_device_hash is null or from_device_hash ~ '^[0-9a-f]{64}$'),
  constraint payroll_bn_attendance_device_changes_to_hash_check
    check (to_device_hash ~ '^[0-9a-f]{64}$'),
  constraint payroll_bn_attendance_device_changes_user_agent_family_check
    check (user_agent_family is null or length(user_agent_family) <= 40)
);

create index if not exists payroll_bn_attendance_device_changes_changed_idx
  on public.payroll_bn_attendance_device_changes(changed_at desc);

create index if not exists payroll_bn_attendance_device_changes_employee_idx
  on public.payroll_bn_attendance_device_changes(employee_code, changed_at desc);

create or replace function public.reject_payroll_bn_attendance_device_change_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'payroll_bn_attendance_device_changes_are_immutable'
    using errcode = '45000';
end;
$$;

drop trigger if exists payroll_bn_attendance_device_changes_immutable
  on public.payroll_bn_attendance_device_changes;
create trigger payroll_bn_attendance_device_changes_immutable
before update or delete on public.payroll_bn_attendance_device_changes
for each row execute function public.reject_payroll_bn_attendance_device_change_mutation();

revoke all on function public.reject_payroll_bn_attendance_device_change_mutation()
  from public, anon, authenticated;

alter table public.payroll_bn_attendance_device_changes enable row level security;

-- No policies on purpose: only security-definer RPCs and the service role may
-- read or write this ledger.
revoke all on table public.payroll_bn_attendance_device_changes
  from public, anon, authenticated;
grant all on table public.payroll_bn_attendance_device_changes to service_role;

comment on table public.payroll_bn_attendance_device_changes is
  'Immutable audit ledger of automatic Zalo-OTP device switches. A row is written only when an existing employee device is replaced (never for the very first device).';
comment on column public.payroll_bn_attendance_device_changes.from_device_hash is
  'Device hash that was active for the employee before the switch; null when no device was active yet.';

-- ---------------------------------------------------------------------------
-- (c) Latest attendance RPC: consent gate preserved, device block auto-switches
-- ---------------------------------------------------------------------------
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
  v_had_any_device boolean := false;
  v_previous_active_hash text;
  v_device_switch boolean := false;
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

  -- Owner decision 2026-11-12: a successful Zalo OTP verification proves the
  -- browser is bound to this employee, so the first punch from that exact
  -- device activates it automatically and retires the previous active device.
  -- A device that is active for another employee, or that a manager revoked,
  -- never auto-activates; those keep the manager-approval path so the manager
  -- can still review/approve the pending row.
  if v_decision = 'accepted'
     and not v_device_active
     and v_session_ok
     and v_device_hash <> ''
     and not exists (
       select 1
       from public.payroll_bn_attendance_devices d
       where d.device_hash = v_device_hash
         and d.status = 'active'
         and d.employee_code <> v_employee_code
     )
     and not exists (
       select 1
       from public.payroll_bn_attendance_devices d
       where d.employee_code = v_employee_code
         and d.device_hash = v_device_hash
         and d.status = 'revoked'
         and d.revoked_reason = 'manager'
     ) then
    -- Serialise concurrent first taps for this employee before retiring the
    -- old active device, so two browsers cannot both leave an active row.
    perform 1
    from public.payroll_bn_attendance_devices d
    where d.employee_code = v_employee_code
    for update;

    select exists (
      select 1
      from public.payroll_bn_attendance_devices d
      where d.employee_code = v_employee_code
    ) into v_had_any_device;

    select d.device_hash into v_previous_active_hash
    from public.payroll_bn_attendance_devices d
    where d.employee_code = v_employee_code
      and d.status = 'active'
    order by d.first_seen_at desc, d.id
    limit 1;

    update public.payroll_bn_attendance_devices
    set status = 'revoked',
        revoked_reason = 'replaced',
        updated_at = v_now
    where employee_code = v_employee_code
      and status = 'active';

    insert into public.payroll_bn_attendance_devices as d(
      employee_code,
      device_hash,
      status,
      first_seen_at,
      approved_at,
      approved_by,
      activation,
      revoked_reason,
      user_agent_family,
      updated_at
    ) values (
      v_employee_code,
      v_device_hash,
      'active',
      v_now,
      v_now,
      null,
      case when v_had_any_device then 'otp_switch' else 'first' end,
      null,
      v_user_agent_family,
      v_now
    )
    on conflict (employee_code, device_hash) do update
    set status = 'active',
        approved_at = v_now,
        approved_by = null,
        activation = excluded.activation,
        revoked_reason = null,
        user_agent_family = coalesce(excluded.user_agent_family, d.user_agent_family),
        updated_at = v_now;

    v_device_active := true;
    v_device_switch := v_had_any_device;
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

  -- One reviewable row per automatic switch. The very first device is not a
  -- switch and is therefore not written to the change ledger.
  if v_device_switch and v_device_active then
    insert into public.payroll_bn_attendance_device_changes(
      employee_code,
      from_device_hash,
      to_device_hash,
      user_agent_family,
      session_id,
      event_id,
      changed_at
    ) values (
      v_employee_code,
      v_previous_active_hash,
      v_device_hash,
      v_user_agent_family,
      p_session_id,
      v_event_id,
      v_now
    );
  end if;

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

revoke all on function public.record_payroll_bn_attendance_event(
  text, text, text, uuid, numeric, numeric, numeric, timestamptz, text, text
) from public, anon, authenticated;

grant execute on function public.record_payroll_bn_attendance_event(
  text, text, text, uuid, numeric, numeric, numeric, timestamptz, text, text
) to service_role;

comment on function public.record_payroll_bn_attendance_event(
  text, text, text, uuid, numeric, numeric, numeric, timestamptz, text, text
) is
  'Service-role-only GPS attendance decision + immutable ledger insert for payroll_bn. Re-checks session/device binding, current employee consent, the rollout gate, device sharing, the OTP-bound auto-switch rule and the server-side haversine radius.';

-- ---------------------------------------------------------------------------
-- (d) Manager approve/revoke now record activation + revocation provenance
-- ---------------------------------------------------------------------------
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
      revoked_reason = 'replaced',
      updated_at = now()
  where employee_code = v_device.employee_code
    and status = 'active'
    and id <> v_device.id;

  update public.payroll_bn_attendance_devices
  set status = 'active',
      approved_by = v_uid,
      approved_at = now(),
      activation = 'manager',
      revoked_reason = null,
      updated_at = now()
  where id = v_device.id
  returning * into v_device;

  return jsonb_build_object('device', to_jsonb(v_device));
end;
$$;

revoke all on function public.approve_payroll_bn_attendance_device(uuid)
  from public, anon, authenticated;
grant execute on function public.approve_payroll_bn_attendance_device(uuid)
  to authenticated, service_role;

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
      revoked_reason = 'manager',
      updated_at = now()
  where id = p_device_id
  returning * into v_device;

  if v_device.id is null then
    raise exception 'payroll_bn_attendance_device_not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object('device', to_jsonb(v_device));
end;
$$;

revoke all on function public.revoke_payroll_bn_attendance_device(uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_payroll_bn_attendance_device(uuid)
  to authenticated, service_role;

comment on function public.approve_payroll_bn_attendance_device(uuid) is
  'Manager approval of a pending attendance device (activation=manager). Retires the previous active device with revoked_reason=replaced so an employee has exactly one active device.';
comment on function public.revoke_payroll_bn_attendance_device(uuid) is
  'Manager revocation of an attendance device (revoked_reason=manager). The OTP auto-switch rule never re-activates a manager-revoked device.';

-- ---------------------------------------------------------------------------
-- (e) Device list keeps every existing key and exposes the new provenance
-- ---------------------------------------------------------------------------
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
          'user_agent_family', d.user_agent_family,
          'activation', d.activation,
          'revoked_reason', d.revoked_reason
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

revoke all on function public.list_payroll_bn_attendance_devices(text, text)
  from public, anon, authenticated;
grant execute on function public.list_payroll_bn_attendance_devices(text, text)
  to authenticated, service_role;

comment on function public.list_payroll_bn_attendance_devices(text, text) is
  'Manager list of employee-bound attendance devices with activation/revoked_reason provenance, optionally filtered by employee and status.';

-- ---------------------------------------------------------------------------
-- (f) Manager review of automatic switches, newest first
-- ---------------------------------------------------------------------------
create or replace function public.list_payroll_bn_attendance_device_changes(
  p_since timestamptz default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_since timestamptz := coalesce(p_since, now() - interval '14 days');
  v_limit integer := least(200, greatest(1, coalesce(p_limit, 50)));
begin
  if not public.payroll_bn_attendance_admin_allowed(v_uid) then
    raise exception 'payroll_bn_attendance_forbidden' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'changes', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'employee_code', c.employee_code,
          'employee_name', c.employee_name,
          'from_device_hash', c.from_device_hash,
          'to_device_hash', c.to_device_hash,
          'user_agent_family', c.user_agent_family,
          'changed_at', c.changed_at
        )
        order by c.changed_at desc, c.id
      )
      from (
        select
          ch.id,
          ch.employee_code,
          coalesce((
            select e.employee_name
            from (
              select p.id
              from public.payroll_bn_periods p
              order by p.date_from desc, p.created_at desc
              limit 1
            ) lp
            join public.payroll_bn_period_employees e on e.period_id = lp.id
            where e.employee_code = ch.employee_code
          ), ch.employee_code) as employee_name,
          ch.from_device_hash,
          ch.to_device_hash,
          ch.user_agent_family,
          ch.changed_at
        from public.payroll_bn_attendance_device_changes ch
        where ch.changed_at >= v_since
        order by ch.changed_at desc, ch.id
        limit v_limit
      ) c
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.list_payroll_bn_attendance_device_changes(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.list_payroll_bn_attendance_device_changes(timestamptz, integer)
  to authenticated, service_role;

comment on function public.list_payroll_bn_attendance_device_changes(timestamptz, integer) is
  'Manager list (newest first, 1..200 rows, default last 14 days) of automatic Zalo-OTP device switches, with the employee name from the latest payroll period catalogue.';
