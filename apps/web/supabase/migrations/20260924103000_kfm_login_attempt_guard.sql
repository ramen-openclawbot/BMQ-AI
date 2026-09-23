-- Durable cross-isolate guard for KFM password login attempts.
-- The Edge function may use refresh tokens freely, but every password-login
-- probe must first win this service-role-only lease. Acquiring the lease starts
-- the cooldown, so failed/uncertain attempts cannot be retried by another Edge
-- isolate until the cooldown expires.

create table if not exists public.kfm_login_attempt_guards (
  guard_key text primary key,
  cooldown_until timestamptz not null default '-infinity'::timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_attempt_at timestamptz,
  last_outcome text,
  updated_at timestamptz not null default now(),
  constraint kfm_login_attempt_guard_key_check check (guard_key ~ '^[a-z0-9_:-]{1,80}$'),
  constraint kfm_login_attempt_guard_outcome_check check (
    last_outcome is null or last_outcome in ('leased', 'success', 'login', 'exchange', 'sso_form', 'error')
  ),
  constraint kfm_login_attempt_guard_lease_pair_check check (
    (lease_token is null and lease_expires_at is null) or
    (lease_token is not null and lease_expires_at is not null)
  )
);

alter table public.kfm_login_attempt_guards enable row level security;
revoke all on public.kfm_login_attempt_guards from public, anon, authenticated;
grant select, insert, update, delete on public.kfm_login_attempt_guards to service_role;

create or replace function public.kfm_login_guard_acquire(
  p_guard_key text,
  p_lease_token uuid,
  p_cooldown_seconds integer default 300,
  p_lease_seconds integer default 90
)
returns table (
  acquired boolean,
  lease_token uuid,
  retry_after_seconds integer,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.kfm_login_attempt_guards%rowtype;
  v_retry_until timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_guard_key is null or p_guard_key !~ '^[a-z0-9_:-]{1,80}$' then
    raise exception 'invalid_guard_key' using errcode = '22023';
  end if;
  if p_lease_token is null then
    raise exception 'invalid_lease_token' using errcode = '22023';
  end if;
  if p_cooldown_seconds is null or p_cooldown_seconds < 30 or p_cooldown_seconds > 3600 then
    raise exception 'invalid_cooldown' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 15 or p_lease_seconds > 600 then
    raise exception 'invalid_lease' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('kfm-login:' || p_guard_key, 0));

  insert into public.kfm_login_attempt_guards (guard_key)
  values (p_guard_key)
  on conflict (guard_key) do nothing;

  select *
    into v_row
    from public.kfm_login_attempt_guards
   where guard_key = p_guard_key
   for update;

  if v_row.lease_token is not null and v_row.lease_expires_at > v_now then
    v_retry_until := greatest(v_row.lease_expires_at, v_row.cooldown_until);
    return query select
      false,
      null::uuid,
      greatest(0, ceil(extract(epoch from (v_retry_until - v_now)))::integer),
      'in_flight'::text;
    return;
  end if;

  if v_row.cooldown_until > v_now then
    return query select
      false,
      null::uuid,
      greatest(0, ceil(extract(epoch from (v_row.cooldown_until - v_now)))::integer),
      'cooldown'::text;
    return;
  end if;

  update public.kfm_login_attempt_guards
     set lease_token = p_lease_token,
         lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
         cooldown_until = v_now + make_interval(secs => p_cooldown_seconds),
         last_attempt_at = v_now,
         last_outcome = 'leased',
         updated_at = v_now
   where guard_key = p_guard_key;

  return query select true, p_lease_token, 0, 'acquired'::text;
end;
$$;

create or replace function public.kfm_login_guard_release(
  p_guard_key text,
  p_lease_token uuid,
  p_outcome text default 'error'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
  v_outcome text := case
    when p_outcome in ('success', 'login', 'exchange', 'sso_form', 'error') then p_outcome
    else 'error'
  end;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_guard_key is null or p_guard_key !~ '^[a-z0-9_:-]{1,80}$' then
    raise exception 'invalid_guard_key' using errcode = '22023';
  end if;
  if p_lease_token is null then
    raise exception 'invalid_lease_token' using errcode = '22023';
  end if;

  update public.kfm_login_attempt_guards
     set lease_token = null,
         lease_expires_at = null,
         last_outcome = v_outcome,
         updated_at = clock_timestamp()
   where guard_key = p_guard_key
     and lease_token = p_lease_token;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.kfm_login_guard_acquire(text, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.kfm_login_guard_release(text, uuid, text) from public, anon, authenticated;
grant execute on function public.kfm_login_guard_acquire(text, uuid, integer, integer) to service_role;
grant execute on function public.kfm_login_guard_release(text, uuid, text) to service_role;
