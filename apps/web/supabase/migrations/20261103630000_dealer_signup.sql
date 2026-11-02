-- 2026-11-03 — Đăng ký đại lý mới: vị trí đại lý, hồ sơ đăng ký và rate limit.
--
-- Additive only. No production data is changed and no migration is applied by
-- this checkout. The new application table is written only by service_role;
-- authenticated CRM users may read it (owner or CRM view/edit permission).

-- ===========================================================================
-- A. Dealer location columns on mini_crm_customers
-- ===========================================================================
alter table public.mini_crm_customers
  add column if not exists location_lat numeric(9, 6),
  add column if not exists location_lng numeric(9, 6),
  add column if not exists location_source text,
  add column if not exists location_verified_at timestamptz;

alter table public.mini_crm_customers
  drop constraint if exists mini_crm_customers_location_lat_check;
alter table public.mini_crm_customers
  add constraint mini_crm_customers_location_lat_check
  check (location_lat is null or (location_lat >= -90 and location_lat <= 90));

alter table public.mini_crm_customers
  drop constraint if exists mini_crm_customers_location_lng_check;
alter table public.mini_crm_customers
  add constraint mini_crm_customers_location_lng_check
  check (location_lng is null or (location_lng >= -180 and location_lng <= 180));

create index if not exists idx_mini_crm_customers_active_dealer_location
  on public.mini_crm_customers (customer_group, location_lat, location_lng)
  where is_active = true;

comment on column public.mini_crm_customers.location_lat is
  'Verified dealer latitude, set only by service_role after review.';
comment on column public.mini_crm_customers.location_lng is
  'Verified dealer longitude, set only by service_role after review.';
comment on column public.mini_crm_customers.location_source is
  'Where the verified location came from, e.g. geocode_reviewed.';
comment on column public.mini_crm_customers.location_verified_at is
  'When an operator verified the dealer location.';

-- ===========================================================================
-- B. dealer_signup_applications
-- ===========================================================================
-- Human-readable code, unique per application. Numeric sequence keeps the
-- database default deterministic and collision-safe even if an Edge Function
-- calls it concurrently.
create sequence if not exists public.dealer_signup_application_code_seq
  as integer
  maxvalue 9999
  cycle;

create or replace function public.dealer_signup_next_application_code()
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  return 'DLM-'
    || to_char((now() at time zone 'Asia/Ho_Chi_Minh'), 'YYYYMMDD')
    || '-'
    || lpad((nextval('public.dealer_signup_application_code_seq') % 10000)::text, 4, '0');
end;
$$;

revoke all on function public.dealer_signup_next_application_code() from public, anon, authenticated;
grant execute on function public.dealer_signup_next_application_code() to service_role;

create table if not exists public.dealer_signup_applications (
  id uuid primary key default gen_random_uuid(),
  application_code text not null unique
    default public.dealer_signup_next_application_code(),
  status text not null
    check (status in ('rejected_too_close', 'manual_review', 'contract_sent', 'email_failed')),
  applicant_name text not null,
  cccd text not null,
  cccd_valid_until date not null,
  phone text not null,
  email text not null,
  business_name text not null,
  address_text text not null,
  lat numeric(9, 6) not null,
  lng numeric(9, 6) not null,
  nearest_dealer_customer_id uuid
    references public.mini_crm_customers(id) on delete set null,
  nearest_distance_m integer,
  distance_provider text,
  unlocated_dealer_count integer not null default 0,
  idempotency_key text not null unique,
  client_ip_hash text,
  contract_sent_at timestamptz,
  email_message_id text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dealer_signup_applications_code_format
    check (application_code ~ '^DLM-[0-9]{8}-[A-Z0-9]{4}$'),
  constraint dealer_signup_applications_lat_range
    check (lat >= -90 and lat <= 90),
  constraint dealer_signup_applications_lng_range
    check (lng >= -180 and lng <= 180),
  constraint dealer_signup_applications_cccd_format
    check (cccd ~ '^[0-9]{9}$' or cccd ~ '^[0-9]{12}$'),
  constraint dealer_signup_applications_distance_nonnegative
    check (nearest_distance_m is null or nearest_distance_m >= 0),
  constraint dealer_signup_applications_unlocated_nonnegative
    check (unlocated_dealer_count >= 0)
);

create index if not exists idx_dealer_signup_applications_created_at
  on public.dealer_signup_applications (created_at desc);
create index if not exists idx_dealer_signup_applications_status
  on public.dealer_signup_applications (status, created_at desc);

-- Touch updated_at on every write without relying on the caller.
create or replace function public.dealer_signup_touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists dealer_signup_applications_touch_updated_at
  on public.dealer_signup_applications;
create trigger dealer_signup_applications_touch_updated_at
  before update on public.dealer_signup_applications
  for each row execute function public.dealer_signup_touch_updated_at();

alter table public.dealer_signup_applications enable row level security;

-- Direct writes are never allowed. Only service_role (edge functions) may
-- insert/update/delete; anon gets no privilege at all.
revoke all on table public.dealer_signup_applications from public, anon, authenticated;
grant select on table public.dealer_signup_applications to authenticated;
grant select, insert, update, delete on table public.dealer_signup_applications to service_role;

drop policy if exists dealer_signup_applications_crm_read
  on public.dealer_signup_applications;
create policy dealer_signup_applications_crm_read
  on public.dealer_signup_applications
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'crm', 'view')
    or public.has_module_permission((select auth.uid()), 'crm', 'edit')
  );

-- ===========================================================================
-- C. Persistent hourly rate limits, keyed by a SHA-256 client IP hash
-- ===========================================================================
create table if not exists public.dealer_signup_rate_limits (
  id bigserial primary key,
  ip_hash text not null,
  action text not null
    check (action in ('check', 'submit')),
  window_start timestamptz not null,
  request_count integer not null default 0,
  unique (ip_hash, action, window_start)
);

alter table public.dealer_signup_rate_limits enable row level security;

revoke all on table public.dealer_signup_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.dealer_signup_rate_limits to service_role;

create or replace function public.dealer_signup_record_rate_limit(
  p_ip_hash text,
  p_action text,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window_start timestamptz := date_trunc('hour', now());
  v_count integer;
  v_retry_after integer;
begin
  if p_ip_hash is null or length(btrim(p_ip_hash)) < 16 then
    raise exception 'ip_hash_required' using errcode = '22023';
  end if;

  if p_action is null or p_action not in ('check', 'submit') then
    raise exception 'invalid_rate_limit_action' using errcode = '22023';
  end if;

  if p_limit is null or p_limit < 1 then
    raise exception 'invalid_rate_limit' using errcode = '22023';
  end if;

  -- Keep the table bounded; only the current and previous windows matter.
  delete from public.dealer_signup_rate_limits
  where window_start < now() - interval '2 days';

  insert into public.dealer_signup_rate_limits (ip_hash, action, window_start, request_count)
  values (btrim(p_ip_hash), p_action, v_window_start, 1)
  on conflict (ip_hash, action, window_start)
  do update set request_count = dealer_signup_rate_limits.request_count + 1
  returning request_count into v_count;

  v_retry_after := case
    when v_count > p_limit then greatest(
      1,
      ceil(extract(epoch from (v_window_start + interval '1 hour' - now())))::integer
    )
    else 0
  end;

  return jsonb_build_object(
    'allowed', v_count <= p_limit,
    'remaining', greatest(0, p_limit - v_count),
    'retry_after_seconds', v_retry_after,
    'window_start', v_window_start
  );
end;
$$;

revoke all on function public.dealer_signup_record_rate_limit(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.dealer_signup_record_rate_limit(text, text, integer)
  to service_role;
