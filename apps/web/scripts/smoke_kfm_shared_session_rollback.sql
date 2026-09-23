-- Rollback-only probe for KFM shared access session migration.
-- Run against a disposable/staging Supabase database after applying:
--   20260924103000_kfm_login_attempt_guard.sql
--   20260924104500_kfm_shared_access_session.sql
--
-- psql -v ON_ERROR_STOP=1 -f apps/web/scripts/smoke_kfm_shared_session_rollback.sql

begin;

select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
begin
  perform public.kfm_shared_session_get('kfm_portal_probe');
  raise exception 'authenticated role unexpectedly read shared KFM session';
exception when insufficient_privilege then
  null;
end $$;

select 1 / case when not has_function_privilege('anon', 'public.kfm_shared_session_get(text)', 'execute') then 1 else 0 end as kfm_shared_get_anon_denied;
select 1 / case when not has_function_privilege('authenticated', 'public.kfm_shared_session_get(text)', 'execute') then 1 else 0 end as kfm_shared_get_authenticated_denied;
select 1 / case when not has_function_privilege('anon', 'public.kfm_shared_session_publish(text, uuid, text, timestamptz, integer)', 'execute') then 1 else 0 end as kfm_shared_publish_anon_denied;
select 1 / case when not has_function_privilege('authenticated', 'public.kfm_shared_session_publish(text, uuid, text, timestamptz, integer)', 'execute') then 1 else 0 end as kfm_shared_publish_authenticated_denied;
select 1 / case when not has_function_privilege('anon', 'public.kfm_shared_session_invalidate(text, uuid)', 'execute') then 1 else 0 end as kfm_shared_invalidate_anon_denied;
select 1 / case when not has_function_privilege('authenticated', 'public.kfm_shared_session_invalidate(text, uuid)', 'execute') then 1 else 0 end as kfm_shared_invalidate_authenticated_denied;
select 1 / case when relrowsecurity then 1 else 0 end as kfm_shared_table_rls_enabled
from pg_class
where oid = 'public.kfm_portal_shared_sessions'::regclass;
select 1 / case
  when position('vault.delete_secret' in pg_get_functiondef('public.kfm_shared_session_invalidate(text, uuid)'::regprocedure)) = 0
   and position('delete from vault.secrets' in lower(pg_get_functiondef('public.kfm_shared_session_invalidate(text, uuid)'::regprocedure))) > 0
  then 1 else 0 end as kfm_shared_invalidate_uses_scoped_vault_delete;

select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  v_guard_key text := 'kfm_portal_probe';
  v_lease uuid := gen_random_uuid();
  v_wrong_lease uuid := gen_random_uuid();
  v_generation uuid;
  v_wrong_generation uuid := gen_random_uuid();
  v_rows integer;
  v_expiry timestamptz;
  v_provider_token text;
begin
  perform public.kfm_login_guard_acquire(v_guard_key, v_lease, 300, 90);

  select generation, expires_at
    into v_generation, v_expiry
    from public.kfm_shared_session_publish(
      v_guard_key,
      v_lease,
      'ACCESS_PRIVATE_ROLLBACK_SESSION_0001',
      clock_timestamp(),
      900
    );

  if v_generation is null then
    raise exception 'publish with active lease did not return a generation';
  end if;
  if v_expiry <= clock_timestamp() or v_expiry > clock_timestamp() + interval '905 seconds' then
    raise exception 'publish TTL was not bounded to requested max: %', v_expiry;
  end if;

  select count(*)
    into v_rows
    from public.kfm_shared_session_get(v_guard_key)
   where token = 'ACCESS_PRIVATE_ROLLBACK_SESSION_0001'
     and generation = v_generation;
  if v_rows <> 1 then
    raise exception 'service-role get did not return the current shared token';
  end if;

  select count(*)
    into v_rows
    from public.kfm_shared_session_publish(
      v_guard_key,
      v_wrong_lease,
      'ACCESS_PRIVATE_ROLLBACK_STALE_OWNER',
      clock_timestamp(),
      900
    );
  if v_rows <> 0 then
    raise exception 'stale lease unexpectedly published a shared session';
  end if;

  if public.kfm_shared_session_invalidate(v_guard_key, v_wrong_generation) then
    raise exception 'wrong generation unexpectedly invalidated current session';
  end if;

  select count(*)
    into v_rows
    from public.kfm_shared_session_get(v_guard_key)
   where generation = v_generation;
  if v_rows <> 1 then
    raise exception 'wrong-generation invalidation removed current session';
  end if;

  if not public.kfm_shared_session_invalidate(v_guard_key, v_generation) then
    raise exception 'exact-generation invalidation failed';
  end if;

  select count(*)
    into v_rows
    from public.kfm_shared_session_get(v_guard_key);
  if v_rows <> 0 then
    raise exception 'invalidated shared session remained readable';
  end if;

  v_provider_token :=
    'header.' ||
    rtrim(translate(encode(convert_to(jsonb_build_object('exp', floor(extract(epoch from clock_timestamp() + interval '20 seconds')))::text, 'UTF8'), 'base64'), '+/', '-_'), '=') ||
    '.signature';

  select expires_at
    into v_expiry
    from public.kfm_shared_session_publish(
      v_guard_key,
      v_lease,
      v_provider_token,
      clock_timestamp(),
      60
    );

  if v_expiry > clock_timestamp() + interval '25 seconds' then
    raise exception 'provider exp did not clamp shared session TTL: %', v_expiry;
  end if;
end $$;

rollback;
