-- Kiosk daily report portal foundation.
-- Report staff are intentionally separate from dealer contacts and internal users.

create table if not exists public.kiosk_report_locations (
  id uuid primary key default gen_random_uuid(),
  location_code text not null,
  location_name text not null,
  address text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kiosk_report_locations_code_not_blank check (length(trim(location_code)) > 0),
  constraint kiosk_report_locations_name_not_blank check (length(trim(location_name)) > 0)
);

create unique index if not exists kiosk_report_locations_code_unique
  on public.kiosk_report_locations (lower(location_code));

create index if not exists kiosk_report_locations_active_idx
  on public.kiosk_report_locations (active, location_code);

create table if not exists public.kiosk_report_staff (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone_raw text not null,
  phone_normalized text not null,
  location_id uuid not null references public.kiosk_report_locations(id) on delete restrict,
  monthly_salary_vnd numeric(14,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kiosk_report_staff_full_name_not_blank check (length(trim(full_name)) > 0),
  constraint kiosk_report_staff_phone_raw_not_blank check (length(trim(phone_raw)) > 0),
  constraint kiosk_report_staff_phone_normalized_check
    check (phone_normalized ~ '^84(3|5|7|8|9)[0-9]{8}$'),
  constraint kiosk_report_staff_salary_nonnegative check (monthly_salary_vnd >= 0)
);

create index if not exists kiosk_report_staff_location_idx
  on public.kiosk_report_staff (location_id);

create index if not exists kiosk_report_staff_phone_idx
  on public.kiosk_report_staff (phone_normalized);

create unique index if not exists kiosk_report_staff_active_phone_unique
  on public.kiosk_report_staff (phone_normalized)
  where active = true;

create table if not exists public.kiosk_report_products (
  code text primary key,
  product_name text not null unique,
  unit text not null default 'đơn vị',
  display_order integer not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists kiosk_report_products_order_unique
  on public.kiosk_report_products (display_order);

create table if not exists public.kiosk_report_channels (
  code text primary key,
  channel_name text not null unique,
  display_order integer not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists kiosk_report_channels_order_unique
  on public.kiosk_report_channels (display_order);

create table if not exists public.kiosk_report_otp_challenges (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.kiosk_report_staff(id) on delete cascade,
  location_id uuid not null references public.kiosk_report_locations(id) on delete restrict,
  phone_normalized text not null,
  otp_hash text not null,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  sent_at timestamptz,
  send_provider text,
  send_status text not null default 'pending',
  send_error text,
  request_ip text,
  user_agent text,
  created_at timestamptz not null default now(),
  constraint kiosk_report_otp_attempts_check check (attempts >= 0),
  constraint kiosk_report_otp_max_attempts_check check (max_attempts between 1 and 20),
  constraint kiosk_report_otp_phone_normalized_check
    check (phone_normalized ~ '^84(3|5|7|8|9)[0-9]{8}$')
);

create index if not exists kiosk_report_otp_phone_active_idx
  on public.kiosk_report_otp_challenges (phone_normalized, created_at desc)
  where consumed_at is null;

create index if not exists kiosk_report_otp_staff_idx
  on public.kiosk_report_otp_challenges (staff_id, created_at desc);

create index if not exists kiosk_report_otp_expires_idx
  on public.kiosk_report_otp_challenges (expires_at);

create table if not exists public.kiosk_report_sessions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.kiosk_report_staff(id) on delete cascade,
  location_id uuid not null references public.kiosk_report_locations(id) on delete restrict,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  request_ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists kiosk_report_sessions_staff_idx
  on public.kiosk_report_sessions (staff_id, created_at desc);

create index if not exists kiosk_report_sessions_active_idx
  on public.kiosk_report_sessions (expires_at)
  where revoked_at is null;

create table if not exists public.kiosk_daily_reports (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.kiosk_report_locations(id) on delete restrict,
  staff_id uuid references public.kiosk_report_staff(id) on delete set null,
  report_date date not null,
  status text not null default 'draft',
  notes text,
  submitted_at timestamptz,
  staff_name_snapshot text not null,
  staff_phone_normalized_snapshot text not null,
  location_code_snapshot text,
  location_name_snapshot text not null,
  location_address_snapshot text,
  created_by_staff_id uuid references public.kiosk_report_staff(id) on delete set null,
  updated_by_staff_id uuid references public.kiosk_report_staff(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kiosk_daily_reports_location_date_unique unique (location_id, report_date),
  constraint kiosk_daily_reports_status_check check (status in ('draft', 'submitted')),
  constraint kiosk_daily_reports_submitted_at_check
    check (status <> 'submitted' or submitted_at is not null)
);

create index if not exists kiosk_daily_reports_staff_date_idx
  on public.kiosk_daily_reports (staff_id, report_date desc);

create table if not exists public.kiosk_daily_report_inventory_rows (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.kiosk_daily_reports(id) on delete cascade,
  product_code text not null references public.kiosk_report_products(code) on delete restrict,
  product_name_snapshot text not null,
  opening_quantity numeric(12,3) not null default 0,
  received_quantity numeric(12,3) not null default 0,
  shortage_quantity numeric(12,3) not null default 0,
  transfer_quantity numeric(12,3) not null default 0,
  waste_quantity numeric(12,3) not null default 0,
  returns_quantity numeric(12,3) not null default 0,
  sold_quantity numeric(12,3) not null default 0,
  closing_quantity numeric(12,3) generated always as
    (opening_quantity + received_quantity - shortage_quantity + transfer_quantity - waste_quantity - returns_quantity - sold_quantity) stored,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kiosk_daily_report_inventory_unique unique (report_id, product_code),
  constraint kiosk_daily_report_inventory_nonnegative check (
    opening_quantity >= 0
    and received_quantity >= 0
    and shortage_quantity >= 0
    and waste_quantity >= 0
    and returns_quantity >= 0
    and sold_quantity >= 0
  )
);

create table if not exists public.kiosk_daily_report_channel_rows (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.kiosk_daily_reports(id) on delete cascade,
  channel_code text not null references public.kiosk_report_channels(code) on delete restrict,
  channel_name_snapshot text not null,
  quantity numeric(12,3) not null default 0,
  amount_vnd numeric(14,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kiosk_daily_report_channels_unique unique (report_id, channel_code),
  constraint kiosk_daily_report_channels_nonnegative check (quantity >= 0 and amount_vnd >= 0)
);

create table if not exists public.kiosk_report_auth_rate_limits (
  scope text not null,
  key_hash text not null,
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (scope, key_hash),
  constraint kiosk_report_auth_rate_limits_scope_not_blank check (length(trim(scope)) > 0),
  constraint kiosk_report_auth_rate_limits_key_hash_check check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint kiosk_report_auth_rate_limits_attempt_count_check check (attempt_count >= 0)
);

create index if not exists kiosk_report_auth_rate_limits_updated_idx
  on public.kiosk_report_auth_rate_limits (updated_at);

create or replace function public.consume_kiosk_report_auth_rate_limit(
  p_scope text,
  p_key_hash text,
  p_max_attempts integer,
  p_window_seconds integer
)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window_started_at timestamptz;
  v_attempt_count integer;
begin
  if length(trim(coalesce(p_scope, ''))) = 0
    or coalesce(p_key_hash, '') !~ '^[0-9a-f]{64}$'
    or p_max_attempts < 1
    or p_window_seconds < 1 then
    raise exception 'invalid_report_auth_rate_limit';
  end if;

  insert into public.kiosk_report_auth_rate_limits as limits (
    scope,
    key_hash,
    window_started_at,
    attempt_count,
    updated_at
  )
  values (p_scope, p_key_hash, v_now, 1, v_now)
  on conflict (scope, key_hash) do update
  set window_started_at = case
        when limits.window_started_at + make_interval(secs => p_window_seconds) <= v_now then v_now
        else limits.window_started_at
      end,
      attempt_count = case
        when limits.window_started_at + make_interval(secs => p_window_seconds) <= v_now then 1
        else limits.attempt_count + 1
      end,
      updated_at = v_now
  returning window_started_at, attempt_count
    into v_window_started_at, v_attempt_count;

  allowed := v_attempt_count <= p_max_attempts;
  retry_after_seconds := greatest(
    1,
    ceil(extract(epoch from (v_window_started_at + make_interval(secs => p_window_seconds) - v_now)))::integer
  );
  return next;
end;
$$;
