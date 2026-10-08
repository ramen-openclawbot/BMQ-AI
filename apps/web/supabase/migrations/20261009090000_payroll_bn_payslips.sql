-- ============================================================================
-- Migration: Bếp BN employee payslip portal (nền, chưa giao diện)
--
-- Adds the server-side foundation for employees to sign in with a phone number
-- + OTP and read their own published payslips of locked periods:
--   (a) payroll_bn_employee_contacts      — employee code ↔ phone (owner only)
--   (b) payroll_bn_payslips               — published payslips (owner read)
--   (c) payroll_bn_publish_payslips(...)  — owner/service-role publish RPC
--   (d) payroll_bn_payslip_otp_challenges / payroll_bn_payslip_sessions
--                                         — portal auth state (service_role only)
--
-- This migration has NOT been applied to production. The payslip engine and the
-- Excel/PDF export are untouched; this only persists what the engine computed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (a) payroll_bn_employee_contacts — which phone belongs to which employee
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_employee_contacts (
  employee_code text primary key,
  phone_normalized text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references auth.users(id) on delete set null
);

drop trigger if exists set_updated_at_payroll_bn_employee_contacts on public.payroll_bn_employee_contacts;
create trigger set_updated_at_payroll_bn_employee_contacts
  before update on public.payroll_bn_employee_contacts
  for each row execute function public.handle_updated_at();

alter table public.payroll_bn_employee_contacts enable row level security;

drop policy if exists payroll_bn_employee_contacts_select on public.payroll_bn_employee_contacts;
create policy payroll_bn_employee_contacts_select on public.payroll_bn_employee_contacts
  for select to authenticated
  using (public.has_role((select auth.uid()), 'owner'));

drop policy if exists payroll_bn_employee_contacts_insert on public.payroll_bn_employee_contacts;
create policy payroll_bn_employee_contacts_insert on public.payroll_bn_employee_contacts
  for insert to authenticated
  with check (public.has_role((select auth.uid()), 'owner'));

drop policy if exists payroll_bn_employee_contacts_update on public.payroll_bn_employee_contacts;
create policy payroll_bn_employee_contacts_update on public.payroll_bn_employee_contacts
  for update to authenticated
  using (public.has_role((select auth.uid()), 'owner'))
  with check (public.has_role((select auth.uid()), 'owner'));

drop policy if exists payroll_bn_employee_contacts_delete on public.payroll_bn_employee_contacts;
create policy payroll_bn_employee_contacts_delete on public.payroll_bn_employee_contacts
  for delete to authenticated
  using (public.has_role((select auth.uid()), 'owner'));

-- This project has no default table grants, so every grant stays explicit.
revoke all on public.payroll_bn_employee_contacts from public, anon, authenticated;
grant select, insert, update, delete on public.payroll_bn_employee_contacts to authenticated;
grant all on public.payroll_bn_employee_contacts to service_role;

-- ---------------------------------------------------------------------------
-- (b) payroll_bn_payslips — one published payslip per employee per period
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_payslips (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.payroll_bn_periods(id) on delete cascade,
  employee_code text not null,
  employee_name text not null,
  group_name text,
  period_name text not null,
  date_from date,
  date_to date,
  net_pay numeric(15,2) not null,
  lines jsonb not null,
  note text,
  published_at timestamptz not null default now(),
  published_by uuid,
  constraint payroll_bn_payslips_period_employee_unique unique (period_id, employee_code)
);

create index if not exists idx_payroll_bn_payslips_period
  on public.payroll_bn_payslips(period_id);
create index if not exists idx_payroll_bn_payslips_employee
  on public.payroll_bn_payslips(employee_code, published_at desc);

alter table public.payroll_bn_payslips enable row level security;

drop policy if exists payroll_bn_payslips_select on public.payroll_bn_payslips;
create policy payroll_bn_payslips_select on public.payroll_bn_payslips
  for select to authenticated
  using (public.has_role((select auth.uid()), 'owner'));

-- Employees read their own payslips through an Edge Function (service_role);
-- the browser role only needs the owner read grant below, never a write.
revoke all on public.payroll_bn_payslips from public, anon, authenticated;
grant select on public.payroll_bn_payslips to authenticated;
grant all on public.payroll_bn_payslips to service_role;

-- ---------------------------------------------------------------------------
-- (c) payroll_bn_publish_payslips — replace a locked period's payslips
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_publish_payslips(
  _period_id uuid,
  _payslips jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  v_count integer := 0;
begin
  if not (public.has_role(v_uid, 'owner') or auth.role() = 'service_role') then
    raise exception 'payroll_bn_publish_owner_only' using errcode = '42501';
  end if;

  select status into v_status from public.payroll_bn_periods where id = _period_id;
  if v_status is distinct from 'locked' then
    raise exception 'payroll_bn_period_not_locked' using errcode = '55006';
  end if;

  if _payslips is null or jsonb_typeof(_payslips) <> 'array' then
    raise exception 'payroll_bn_invalid_payslips' using errcode = '22023';
  end if;

  -- Every element must name an employee that belongs to this period.
  if exists (
    select 1
    from jsonb_array_elements(_payslips) as p(value)
    where nullif(p.value->>'employee_code', '') is null
       or not exists (
         select 1
         from public.payroll_bn_period_employees e
         where e.period_id = _period_id
           and e.employee_code = p.value->>'employee_code'
       )
  ) then
    raise exception 'payroll_bn_payslip_employee_not_in_period' using errcode = '22023';
  end if;

  -- Republishing a period replaces the previous issuance atomically.
  delete from public.payroll_bn_payslips where period_id = _period_id;

  insert into public.payroll_bn_payslips(
    period_id,
    employee_code,
    employee_name,
    group_name,
    period_name,
    date_from,
    date_to,
    net_pay,
    lines,
    note,
    published_by
  )
  select
    _period_id,
    p.value->>'employee_code',
    coalesce(p.value->>'employee_name', ''),
    nullif(p.value->>'group_name', ''),
    coalesce(p.value->>'period_name', ''),
    nullif(p.value->>'date_from', '')::date,
    nullif(p.value->>'date_to', '')::date,
    coalesce((p.value->>'net_pay')::numeric, 0),
    coalesce(p.value->'lines', '[]'::jsonb),
    nullif(p.value->>'note', ''),
    v_uid
  from jsonb_array_elements(_payslips) as p(value);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.payroll_bn_publish_payslips(uuid, jsonb)
  is 'Publish (replace) the payslips of a locked Bếp BN period. Owner or service_role only; every employee_code must belong to the period.';

revoke all on function public.payroll_bn_publish_payslips(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.payroll_bn_publish_payslips(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- (d) portal auth state — service_role only, no browser access at all
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_payslip_otp_challenges (
  id uuid primary key default gen_random_uuid(),
  phone_normalized text not null,
  employee_code text not null,
  otp_hash text not null,
  expires_at timestamptz not null,
  attempt_count integer not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint payroll_bn_payslip_otp_attempt_count_check check (attempt_count >= 0)
);

create index if not exists idx_payroll_bn_payslip_otp_phone_active
  on public.payroll_bn_payslip_otp_challenges(phone_normalized, created_at desc)
  where consumed_at is null;

create table if not exists public.payroll_bn_payslip_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  employee_code text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_payroll_bn_payslip_sessions_employee
  on public.payroll_bn_payslip_sessions(employee_code, created_at desc);

create index if not exists idx_payroll_bn_payslip_sessions_active
  on public.payroll_bn_payslip_sessions(expires_at)
  where revoked_at is null;

alter table public.payroll_bn_payslip_otp_challenges enable row level security;
alter table public.payroll_bn_payslip_sessions enable row level security;

-- No policies on purpose: only the Edge Functions (service_role) may touch them.
revoke all on public.payroll_bn_payslip_otp_challenges from public, anon, authenticated;
revoke all on public.payroll_bn_payslip_sessions from public, anon, authenticated;
grant all on public.payroll_bn_payslip_otp_challenges to service_role;
grant all on public.payroll_bn_payslip_sessions to service_role;
