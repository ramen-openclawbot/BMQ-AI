-- Short-lived, server-only KFM access session shared across Edge isolates.
-- This does not store refresh tokens. Password-login lease/cooldown remains the
-- authority for new password attempts; this store only lets a later cold isolate
-- reuse a validated access token that a lease holder already established.

create extension if not exists pgcrypto;
create extension if not exists supabase_vault with schema vault;

create table if not exists public.kfm_portal_shared_sessions (
  guard_key text primary key,
  secret_name text not null unique,
  generation uuid not null default gen_random_uuid(),
  obtained_at timestamptz not null,
  expires_at timestamptz not null,
  invalidated_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint kfm_portal_shared_session_key_check check (guard_key ~ '^[a-z0-9_:-]{1,80}$'),
  constraint kfm_portal_shared_session_secret_check check (secret_name ~ '^kfm_portal_shared_session_[0-9a-f]{32}$'),
  constraint kfm_portal_shared_session_expiry_check check (expires_at > obtained_at)
);

alter table public.kfm_portal_shared_sessions enable row level security;
revoke all on public.kfm_portal_shared_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.kfm_portal_shared_sessions to service_role;

create or replace function public.kfm_jwt_expiry(p_access_token text)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_payload text;
  v_json jsonb;
  v_exp numeric;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_access_token is null or length(p_access_token) < 20 or array_length(string_to_array(p_access_token, '.'), 1) < 2 then
    return null;
  end if;

  begin
    v_payload := split_part(p_access_token, '.', 2);
    v_payload := replace(replace(v_payload, '-', '+'), '_', '/');
    v_payload := v_payload || repeat('=', (4 - length(v_payload) % 4) % 4);
    v_json := convert_from(decode(v_payload, 'base64'), 'UTF8')::jsonb;
    v_exp := nullif(v_json->>'exp', '')::numeric;
  exception when others then
    return null;
  end;

  if v_exp is null or v_exp <= 0 then
    return null;
  end if;
  return to_timestamp(v_exp);
end;
$$;

revoke all on function public.kfm_jwt_expiry(text) from public, anon, authenticated;
grant execute on function public.kfm_jwt_expiry(text) to service_role;

create or replace function public.kfm_shared_session_get(p_guard_key text)
returns table (
  token text,
  generation uuid,
  expires_at timestamptz,
  obtained_at timestamptz,
  mode text
)
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_row public.kfm_portal_shared_sessions%rowtype;
  v_token text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_guard_key is null or p_guard_key !~ '^[a-z0-9_:-]{1,80}$' then
    raise exception 'invalid_guard_key' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('kfm-shared-session:' || p_guard_key, 0));

  select *
    into v_row
    from public.kfm_portal_shared_sessions as s
   where s.guard_key = p_guard_key
     and s.invalidated_at is null
     and s.expires_at > clock_timestamp()
   for update;

  if not found then
    return;
  end if;

  select ds.decrypted_secret
    into v_token
    from vault.decrypted_secrets as ds
   where ds.name = v_row.secret_name
   order by ds.created_at desc
   limit 1;

  if length(coalesce(v_token, '')) = 0 then
    return;
  end if;

  return query select v_token, v_row.generation, v_row.expires_at, v_row.obtained_at, 'shared'::text;
end;
$$;

revoke all on function public.kfm_shared_session_get(text) from public, anon, authenticated;
grant execute on function public.kfm_shared_session_get(text) to service_role;

create or replace function public.kfm_shared_session_publish(
  p_guard_key text,
  p_lease_token uuid,
  p_access_token text,
  p_obtained_at timestamptz default now(),
  p_max_ttl_seconds integer default 900
)
returns table (
  token text,
  generation uuid,
  expires_at timestamptz,
  obtained_at timestamptz,
  mode text
)
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_now timestamptz;
  v_secret_name text;
  v_secret_id uuid;
  v_generation uuid := gen_random_uuid();
  v_provider_exp timestamptz;
  v_expires_at timestamptz;
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
  if length(coalesce(p_access_token, '')) < 20 then
    raise exception 'invalid_access_session' using errcode = '22023';
  end if;
  if p_max_ttl_seconds is null or p_max_ttl_seconds < 15 or p_max_ttl_seconds > 900 then
    raise exception 'invalid_session_ttl' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('kfm-shared-session:' || p_guard_key, 0));
  v_now := clock_timestamp();

  perform 1
    from public.kfm_login_attempt_guards as g
   where g.guard_key = p_guard_key
     and g.lease_token = p_lease_token
     and g.lease_expires_at > v_now
   for update;
  if not found then
    return;
  end if;

  v_provider_exp := public.kfm_jwt_expiry(p_access_token);
  v_expires_at := v_now + make_interval(secs => p_max_ttl_seconds);
  if v_provider_exp is not null then
    v_expires_at := least(v_expires_at, v_provider_exp);
  end if;
  if v_expires_at <= v_now then
    raise exception 'expired_access_session' using errcode = '22023';
  end if;

  select secret_name
    into v_secret_name
    from public.kfm_portal_shared_sessions as s
   where s.guard_key = p_guard_key
   for update;

  if v_secret_name is null then
    v_secret_name := 'kfm_portal_shared_session_' || replace(gen_random_uuid()::text, '-', '');
    perform vault.create_secret(p_access_token, v_secret_name, 'Short-lived KFM portal access session');
  else
    select ds.id
      into v_secret_id
      from vault.decrypted_secrets as ds
     where ds.name = v_secret_name
     order by ds.created_at desc
     limit 1;
    if v_secret_id is null then
      perform vault.create_secret(p_access_token, v_secret_name, 'Short-lived KFM portal access session');
    else
      perform vault.update_secret(v_secret_id, p_access_token, v_secret_name, 'Short-lived KFM portal access session');
    end if;
  end if;

  insert into public.kfm_portal_shared_sessions (
    guard_key,
    secret_name,
    generation,
    obtained_at,
    expires_at,
    invalidated_at,
    updated_at
  )
  values (
    p_guard_key,
    v_secret_name,
    v_generation,
    coalesce(p_obtained_at, v_now),
    v_expires_at,
    null,
    v_now
  )
  on conflict (guard_key) do update
  set generation = excluded.generation,
      obtained_at = excluded.obtained_at,
      expires_at = excluded.expires_at,
      invalidated_at = null,
      updated_at = v_now;

  return query select p_access_token, v_generation, v_expires_at, coalesce(p_obtained_at, v_now), 'shared'::text;
end;
$$;

revoke all on function public.kfm_shared_session_publish(text, uuid, text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.kfm_shared_session_publish(text, uuid, text, timestamptz, integer) to service_role;

create or replace function public.kfm_shared_session_invalidate(
  p_guard_key text,
  p_generation uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_name text;
  v_secret_id uuid;
  v_updated integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_guard_key is null or p_guard_key !~ '^[a-z0-9_:-]{1,80}$' then
    raise exception 'invalid_guard_key' using errcode = '22023';
  end if;
  if p_generation is null then
    raise exception 'invalid_generation' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('kfm-shared-session:' || p_guard_key, 0));

  update public.kfm_portal_shared_sessions as s
     set invalidated_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where s.guard_key = p_guard_key
     and s.generation = p_generation
     and s.invalidated_at is null
   returning s.secret_name into v_secret_name;

  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    return false;
  end if;

  select ds.id
    into v_secret_id
    from vault.decrypted_secrets as ds
   where ds.name = v_secret_name
   order by ds.created_at desc
   limit 1;

  if v_secret_id is not null then
    delete from vault.secrets as s
     where s.id = v_secret_id;
  end if;

  return true;
end;
$$;

revoke all on function public.kfm_shared_session_invalidate(text, uuid) from public, anon, authenticated;
grant execute on function public.kfm_shared_session_invalidate(text, uuid) to service_role;
