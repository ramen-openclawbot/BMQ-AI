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

revoke all on function public.consume_kiosk_report_auth_rate_limit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_kiosk_report_auth_rate_limit(text, text, integer, integer)
  to service_role;

create or replace function public.verify_kiosk_report_otp_atomic(
  p_challenge_id uuid,
  p_phone_normalized text,
  p_otp_hash text,
  p_session_token_hash text,
  p_session_expires_at timestamptz,
  p_request_ip text,
  p_user_agent text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as '
declare
  v_now timestamptz := clock_timestamp();
  v_challenge public.kiosk_report_otp_challenges%rowtype;
  v_staff public.kiosk_report_staff%rowtype;
  v_location public.kiosk_report_locations%rowtype;
  v_attempts integer;
  v_session public.kiosk_report_sessions%rowtype;
begin
  if coalesce(p_phone_normalized, '''') !~ ''^84(3|5|7|8|9)[0-9]{8}$''
    or coalesce(p_otp_hash, '''') !~ ''^[0-9a-f]{64}$''
    or coalesce(p_session_token_hash, '''') !~ ''^[0-9a-f]{64}$''
    or p_session_expires_at <= v_now
    or p_session_expires_at > v_now + interval ''24 hours'' then
    raise exception ''invalid_report_otp_verification_input'';
  end if;

  select *
    into v_challenge
  from public.kiosk_report_otp_challenges
  where id = p_challenge_id
    and phone_normalized = p_phone_normalized
  for update;

  if not found
    or v_challenge.consumed_at is not null
    or v_challenge.expires_at <= v_now then
    return jsonb_build_object(''status'', ''otp_invalid_or_expired'');
  end if;

  if v_challenge.attempts >= v_challenge.max_attempts then
    update public.kiosk_report_otp_challenges
    set consumed_at = coalesce(consumed_at, v_now),
        send_status = ''max_attempts''
    where id = v_challenge.id;

    return jsonb_build_object(''status'', ''otp_max_attempts'');
  end if;

  v_attempts := v_challenge.attempts + 1;

  if v_challenge.otp_hash is distinct from p_otp_hash then
    update public.kiosk_report_otp_challenges
    set attempts = v_attempts,
        consumed_at = case when v_attempts >= max_attempts then v_now else null end,
        send_status = case when v_attempts >= max_attempts then ''max_attempts'' else send_status end
    where id = v_challenge.id;

    return jsonb_build_object(
      ''status'',
      case when v_attempts >= v_challenge.max_attempts then ''otp_max_attempts'' else ''otp_invalid_or_expired'' end
    );
  end if;

  select *
    into v_staff
  from public.kiosk_report_staff
  where id = v_challenge.staff_id;

  select *
    into v_location
  from public.kiosk_report_locations
  where id = v_challenge.location_id;

  if v_staff.id is null
    or v_location.id is null
    or v_staff.active is not true
    or v_location.active is not true
    or v_staff.phone_normalized <> p_phone_normalized
    or v_staff.location_id <> v_location.id then
    update public.kiosk_report_otp_challenges
    set attempts = v_attempts,
        consumed_at = v_now,
        send_status = ''staff_inactive''
    where id = v_challenge.id;

    return jsonb_build_object(''status'', ''report_staff_inactive'');
  end if;

  update public.kiosk_report_otp_challenges
  set attempts = v_attempts,
      consumed_at = v_now,
      send_status = ''verified''
  where id = v_challenge.id;

  insert into public.kiosk_report_sessions (
    staff_id,
    location_id,
    token_hash,
    expires_at,
    last_seen_at,
    request_ip,
    user_agent
  )
  values (
    v_staff.id,
    v_location.id,
    p_session_token_hash,
    p_session_expires_at,
    v_now,
    nullif(trim(coalesce(p_request_ip, '''')), ''''),
    nullif(trim(coalesce(p_user_agent, '''')), '''')
  )
  returning * into v_session;

  return jsonb_build_object(
    ''status'', ''verified'',
    ''expires_at'', v_session.expires_at,
    ''staff'', jsonb_build_object(
      ''full_name'', v_staff.full_name
    ),
    ''location'', jsonb_build_object(
      ''code'', v_location.location_code,
      ''name'', v_location.location_name,
      ''address'', v_location.address
    )
  );
end;
';

revoke all on function public.verify_kiosk_report_otp_atomic(
  uuid, text, text, text, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.verify_kiosk_report_otp_atomic(
  uuid, text, text, text, timestamptz, text, text
) to service_role;

create or replace function public.save_kiosk_daily_report_atomic(
  p_location_id uuid,
  p_staff_id uuid,
  p_report_date date,
  p_status text,
  p_notes text,
  p_staff_name_snapshot text,
  p_staff_phone_normalized_snapshot text,
  p_location_code_snapshot text,
  p_location_name_snapshot text,
  p_location_address_snapshot text,
  p_inventory_rows jsonb,
  p_channel_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report_id uuid;
  v_existing_status text;
  v_report public.kiosk_daily_reports%rowtype;
begin
  if p_status not in ('draft', 'submitted') then
    raise exception 'invalid_report_status';
  end if;

  if not exists (
    select 1
    from public.kiosk_report_staff staff
    join public.kiosk_report_locations location on location.id = staff.location_id
    where staff.id = p_staff_id
      and staff.location_id = p_location_id
      and staff.active = true
      and location.active = true
  ) then
    raise exception 'report_assignment_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_location_id::text || ':' || p_report_date::text, 0));

  select id, status
    into v_report_id, v_existing_status
  from public.kiosk_daily_reports
  where location_id = p_location_id
    and report_date = p_report_date
  for update;

  if v_existing_status = 'submitted' then
    raise exception 'submitted_report_immutable';
  end if;

  if v_report_id is null then
    insert into public.kiosk_daily_reports (
      location_id,
      staff_id,
      report_date,
      status,
      notes,
      staff_name_snapshot,
      staff_phone_normalized_snapshot,
      location_code_snapshot,
      location_name_snapshot,
      location_address_snapshot,
      created_by_staff_id,
      updated_by_staff_id
    )
    values (
      p_location_id,
      p_staff_id,
      p_report_date,
      'draft',
      nullif(trim(coalesce(p_notes, '')), ''),
      p_staff_name_snapshot,
      p_staff_phone_normalized_snapshot,
      p_location_code_snapshot,
      p_location_name_snapshot,
      p_location_address_snapshot,
      p_staff_id,
      p_staff_id
    )
    returning id into v_report_id;
  else
    update public.kiosk_daily_reports
    set staff_id = p_staff_id,
        notes = nullif(trim(coalesce(p_notes, '')), ''),
        staff_name_snapshot = p_staff_name_snapshot,
        staff_phone_normalized_snapshot = p_staff_phone_normalized_snapshot,
        location_code_snapshot = p_location_code_snapshot,
        location_name_snapshot = p_location_name_snapshot,
        location_address_snapshot = p_location_address_snapshot,
        updated_by_staff_id = p_staff_id,
        submitted_at = null
    where id = v_report_id;
  end if;

  delete from public.kiosk_daily_report_inventory_rows where report_id = v_report_id;
  delete from public.kiosk_daily_report_channel_rows where report_id = v_report_id;

  insert into public.kiosk_daily_report_inventory_rows (
    report_id,
    product_code,
    product_name_snapshot,
    opening_quantity,
    received_quantity,
    shortage_quantity,
    transfer_quantity,
    waste_quantity,
    returns_quantity,
    sold_quantity,
    notes
  )
  select
    v_report_id,
    product.code,
    product.product_name,
    greatest(0, coalesce(nullif(input.row_data->>'opening_quantity', '')::numeric, 0)),
    greatest(0, coalesce(nullif(input.row_data->>'received_quantity', '')::numeric, 0)),
    greatest(0, coalesce(nullif(input.row_data->>'shortage_quantity', '')::numeric, 0)),
    coalesce(nullif(input.row_data->>'transfer_quantity', '')::numeric, 0),
    greatest(0, coalesce(nullif(input.row_data->>'waste_quantity', '')::numeric, 0)),
    greatest(0, coalesce(nullif(input.row_data->>'returns_quantity', '')::numeric, 0)),
    greatest(0, coalesce(nullif(input.row_data->>'sold_quantity', '')::numeric, 0)),
    nullif(trim(coalesce(input.row_data->>'notes', '')), '')
  from public.kiosk_report_products product
  left join lateral (
    select row_data
    from jsonb_array_elements(coalesce(p_inventory_rows, '[]'::jsonb)) row_data
    where row_data->>'product_code' = product.code
    limit 1
  ) input on true
  where product.active = true;

  insert into public.kiosk_daily_report_channel_rows (
    report_id,
    channel_code,
    channel_name_snapshot,
    quantity,
    amount_vnd,
    notes
  )
  select
    v_report_id,
    channel.code,
    channel.channel_name,
    greatest(0, coalesce(nullif(input.row_data->>'quantity', '')::numeric, 0)),
    greatest(0, coalesce(nullif(input.row_data->>'amount_vnd', '')::numeric, 0)),
    nullif(trim(coalesce(input.row_data->>'notes', '')), '')
  from public.kiosk_report_channels channel
  left join lateral (
    select row_data
    from jsonb_array_elements(coalesce(p_channel_rows, '[]'::jsonb)) row_data
    where row_data->>'channel_code' = channel.code
    limit 1
  ) input on true
  where channel.active = true;

  if p_status = 'submitted' then
    update public.kiosk_daily_reports
    set status = 'submitted',
        submitted_at = now(),
        updated_by_staff_id = p_staff_id
    where id = v_report_id
      and status = 'draft';
  end if;

  select * into v_report
  from public.kiosk_daily_reports
  where id = v_report_id;

  return jsonb_build_object(
    'report_date', v_report.report_date,
    'status', v_report.status,
    'notes', v_report.notes,
    'submitted_at', v_report.submitted_at,
    'updated_at', v_report.updated_at
  );
end;
$$;

revoke all on function public.save_kiosk_daily_report_atomic(
  uuid, uuid, date, text, text, text, text, text, text, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.save_kiosk_daily_report_atomic(
  uuid, uuid, date, text, text, text, text, text, text, text, jsonb, jsonb
) to service_role;

create or replace function public.set_kiosk_report_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_kiosk_report_locations_updated_at on public.kiosk_report_locations;
create trigger set_kiosk_report_locations_updated_at
before update on public.kiosk_report_locations
for each row execute function public.set_kiosk_report_updated_at();

drop trigger if exists set_kiosk_report_staff_updated_at on public.kiosk_report_staff;
create trigger set_kiosk_report_staff_updated_at
before update on public.kiosk_report_staff
for each row execute function public.set_kiosk_report_updated_at();

drop trigger if exists set_kiosk_daily_reports_updated_at on public.kiosk_daily_reports;
create trigger set_kiosk_daily_reports_updated_at
before update on public.kiosk_daily_reports
for each row execute function public.set_kiosk_report_updated_at();

drop trigger if exists set_kiosk_daily_report_inventory_updated_at on public.kiosk_daily_report_inventory_rows;
create trigger set_kiosk_daily_report_inventory_updated_at
before update on public.kiosk_daily_report_inventory_rows
for each row execute function public.set_kiosk_report_updated_at();

drop trigger if exists set_kiosk_daily_report_channel_updated_at on public.kiosk_daily_report_channel_rows;
create trigger set_kiosk_daily_report_channel_updated_at
before update on public.kiosk_daily_report_channel_rows
for each row execute function public.set_kiosk_report_updated_at();

create or replace function public.block_report_staff_dealer_contact_phone()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.active = true and exists (
    select 1
    from public.dealer_customer_contacts dcc
    where dcc.phone_normalized = new.phone_normalized
      and dcc.is_active = true
    limit 1
  ) then
    raise exception 'Phone % is already active for dealer ordering; report staff cannot access dathang.', new.phone_normalized;
  end if;

  return new;
end;
$$;

drop trigger if exists block_report_staff_dealer_contact_phone on public.kiosk_report_staff;
create trigger block_report_staff_dealer_contact_phone
before insert or update of phone_normalized, active on public.kiosk_report_staff
for each row execute function public.block_report_staff_dealer_contact_phone();

create or replace function public.block_dealer_contact_report_staff_phone()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_active = true and exists (
    select 1
    from public.kiosk_report_staff krs
    where krs.phone_normalized = new.phone_normalized
      and krs.active = true
    limit 1
  ) then
    raise exception 'Phone % is already active for kiosk reports; report staff cannot order at dathang.', new.phone_normalized;
  end if;

  return new;
end;
$$;

drop trigger if exists block_dealer_contact_report_staff_phone on public.dealer_customer_contacts;
create trigger block_dealer_contact_report_staff_phone
before insert or update of phone_normalized, is_active on public.dealer_customer_contacts
for each row execute function public.block_dealer_contact_report_staff_phone();

create or replace function public.revoke_active_report_sessions_for_staff()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.location_id is distinct from new.location_id
    or old.active is distinct from new.active
    or old.phone_normalized is distinct from new.phone_normalized then
    update public.kiosk_report_sessions
      set revoked_at = coalesce(revoked_at, now())
    where staff_id = new.id
      and revoked_at is null;
  end if;

  return new;
end;
$$;

drop trigger if exists revoke_active_report_sessions_for_staff on public.kiosk_report_staff;
create trigger revoke_active_report_sessions_for_staff
after update of location_id, active, phone_normalized on public.kiosk_report_staff
for each row execute function public.revoke_active_report_sessions_for_staff();

create or replace function public.prevent_submitted_kiosk_report_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'submitted' then
    raise exception 'Submitted kiosk reports are immutable.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_submitted_kiosk_report_update on public.kiosk_daily_reports;
create trigger prevent_submitted_kiosk_report_update
before update or delete on public.kiosk_daily_reports
for each row execute function public.prevent_submitted_kiosk_report_mutation();

create or replace function public.prevent_submitted_kiosk_report_child_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent_status text;
  target_report_id uuid;
begin
  target_report_id = case when tg_op = 'DELETE' then old.report_id else new.report_id end;

  select status
    into parent_status
  from public.kiosk_daily_reports
  where id = target_report_id;

  if parent_status = 'submitted' then
    raise exception 'Submitted kiosk report rows are immutable.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_submitted_kiosk_report_inventory_mutation on public.kiosk_daily_report_inventory_rows;
create trigger prevent_submitted_kiosk_report_inventory_mutation
before insert or update or delete on public.kiosk_daily_report_inventory_rows
for each row execute function public.prevent_submitted_kiosk_report_child_mutation();

drop trigger if exists prevent_submitted_kiosk_report_channel_mutation on public.kiosk_daily_report_channel_rows;
create trigger prevent_submitted_kiosk_report_channel_mutation
before insert or update or delete on public.kiosk_daily_report_channel_rows
for each row execute function public.prevent_submitted_kiosk_report_child_mutation();

alter table public.kiosk_report_locations enable row level security;
alter table public.kiosk_report_staff enable row level security;
alter table public.kiosk_report_products enable row level security;
alter table public.kiosk_report_channels enable row level security;
alter table public.kiosk_report_otp_challenges enable row level security;
alter table public.kiosk_report_auth_rate_limits enable row level security;
alter table public.kiosk_report_sessions enable row level security;
alter table public.kiosk_daily_reports enable row level security;
alter table public.kiosk_daily_report_inventory_rows enable row level security;
alter table public.kiosk_daily_report_channel_rows enable row level security;

-- No broad authenticated policies are added. Public and owner operations go through Edge Functions.

insert into public.kiosk_report_products (code, product_name, unit, display_order, active)
values
  ('banh_mi_que', 'Bánh mì que', 'que', 1, true),
  ('pate', 'Pate', 'hộp', 2, true),
  ('ot', 'Ớt', 'phần', 3, true),
  ('banh_mi_say', 'Bánh mì sấy', 'gói', 4, true)
on conflict (code) do update
set product_name = excluded.product_name,
    unit = excluded.unit,
    display_order = excluded.display_order,
    active = true,
    updated_at = now();

insert into public.kiosk_report_channels (code, channel_name, display_order, active)
values
  ('khach_le', 'Khách lẻ', 1, true),
  ('shopeefood', 'ShopeeFood', 2, true),
  ('grabfood', 'GrabFood', 3, true),
  ('befood', 'beFood', 4, true)
on conflict (code) do update
set channel_name = excluded.channel_name,
    display_order = excluded.display_order,
    active = true,
    updated_at = now();
