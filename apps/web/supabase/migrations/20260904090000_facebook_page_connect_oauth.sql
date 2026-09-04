-- Facebook Page Connect OAuth.
-- Stores replay state in app tables and Page access auth material in Supabase Vault only.

create extension if not exists pgcrypto;
create extension if not exists supabase_vault with schema vault;

alter table public.facebook_messenger_settings
  alter column page_id drop not null,
  add column if not exists connection_status text not null default 'not_connected',
  add column if not exists connected_at timestamptz,
  add column if not exists connected_by uuid references auth.users(id) on delete set null,
  add column if not exists connection_error_code text,
  add column if not exists oauth_permissions text[] not null default '{}';

do $$
begin
  alter table public.facebook_messenger_settings
    add constraint facebook_messenger_settings_connection_status_check
    check (connection_status in ('not_connected', 'connected', 'error'));
exception when duplicate_object then null;
end $$;

insert into public.facebook_messenger_settings (id, page_id, enabled, connection_status)
values ('00000000-0000-0000-0000-000000000001'::uuid, null, false, 'not_connected')
on conflict (id) do nothing;

create table if not exists public.facebook_page_oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null,
  actor_id uuid not null references auth.users(id) on delete cascade,
  redirect_url text not null,
  expected_page_id text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint facebook_page_oauth_states_state_hash_unique unique (state_hash),
  constraint facebook_page_oauth_states_state_hash_check check (state_hash ~ '^[0-9a-f]{64}$'),
  constraint facebook_page_oauth_states_redirect_url_check check (redirect_url ~ '^https?://'),
  constraint facebook_page_oauth_states_expected_page_id_check check (expected_page_id is null or expected_page_id ~ '^[0-9]{5,32}$'),
  constraint facebook_page_oauth_states_expiry_check check (expires_at > created_at)
);

create index if not exists facebook_page_oauth_states_consume_idx
  on public.facebook_page_oauth_states(state_hash, expires_at)
  where consumed_at is null;
create index if not exists facebook_page_oauth_states_cleanup_idx
  on public.facebook_page_oauth_states(expires_at);

create table if not exists public.facebook_page_oauth_candidates (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  candidate_id text not null,
  actor_id uuid not null references auth.users(id) on delete cascade,
  page_id text not null,
  page_name text not null,
  page_id_suffix text not null,
  permissions text[] not null default '{}',
  auth_secret_name text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint facebook_page_oauth_candidates_candidate_id_unique unique (candidate_id),
  constraint facebook_page_oauth_candidates_candidate_id_check check (candidate_id ~ '^[0-9a-f]{36}$'),
  constraint facebook_page_oauth_candidates_page_id_check check (page_id ~ '^[0-9]{5,32}$'),
  constraint facebook_page_oauth_candidates_page_id_suffix_check check (page_id_suffix ~ '^[0-9]{1,4}$'),
  constraint facebook_page_oauth_candidates_secret_name_check check (auth_secret_name ~ '^facebook_messenger_page_candidate_[0-9a-f]{36}$'),
  constraint facebook_page_oauth_candidates_expiry_check check (expires_at > created_at)
);

create index if not exists facebook_page_oauth_candidates_actor_idx
  on public.facebook_page_oauth_candidates(actor_id, expires_at)
  where consumed_at is null;
create index if not exists facebook_page_oauth_candidates_cleanup_idx
  on public.facebook_page_oauth_candidates(expires_at);

alter table public.facebook_page_oauth_states enable row level security;
alter table public.facebook_page_oauth_candidates enable row level security;
revoke all on table public.facebook_page_oauth_states from public, anon, authenticated;
revoke all on table public.facebook_page_oauth_candidates from public, anon, authenticated;
grant select, insert, update, delete on table public.facebook_page_oauth_states to service_role;
grant select, insert, update, delete on table public.facebook_page_oauth_candidates to service_role;

create or replace function public.facebook_begin_page_oauth_state(
  p_state_hash text,
  p_actor_id uuid,
  p_redirect_url text,
  p_expected_page_id text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_state_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_state_hash' using errcode = '22023';
  end if;
  if p_expected_page_id is not null and p_expected_page_id !~ '^[0-9]{5,32}$' then
    raise exception 'invalid_expected_page_id' using errcode = '22023';
  end if;
  if p_expires_at <= now() then
    raise exception 'invalid_expiry' using errcode = '22023';
  end if;

  insert into public.facebook_page_oauth_states (
    state_hash, actor_id, redirect_url, expected_page_id, expires_at
  )
  values (
    p_state_hash, p_actor_id, p_redirect_url, p_expected_page_id, p_expires_at
  );
end;
$$;
revoke all on function public.facebook_begin_page_oauth_state(text, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.facebook_begin_page_oauth_state(text, uuid, text, text, timestamptz) to service_role;

create or replace function public.facebook_consume_page_oauth_state(p_state_hash text)
returns table(actor_id uuid, redirect_url text, expected_page_id text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  return query
  with picked as (
    select s.id
    from public.facebook_page_oauth_states s
    where s.state_hash = p_state_hash
      and s.consumed_at is null
      and s.expires_at > now()
    for update
  ), consumed as (
    update public.facebook_page_oauth_states s
    set consumed_at = now(),
        updated_at = now()
    from picked
    where s.id = picked.id
    returning s.actor_id, s.redirect_url, s.expected_page_id
  )
  select consumed.actor_id, consumed.redirect_url, consumed.expected_page_id
  from consumed;
end;
$$;
revoke all on function public.facebook_consume_page_oauth_state(text) from public, anon, authenticated;
grant execute on function public.facebook_consume_page_oauth_state(text) to service_role;

create or replace function public.facebook_delete_page_oauth_candidate_secret(p_secret_name text)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_secret_name !~ '^facebook_messenger_page_candidate_[0-9a-f]{36}$' then
    return false;
  end if;

  select id into v_secret_id
  from vault.decrypted_secrets
  where name = p_secret_name
  order by created_at desc
  limit 1;

  if v_secret_id is null then
    return false;
  end if;

  perform vault.delete_secret(v_secret_id);
  return true;
end;
$$;
revoke all on function public.facebook_delete_page_oauth_candidate_secret(text) from public, anon, authenticated;
grant execute on function public.facebook_delete_page_oauth_candidate_secret(text) to service_role;

create or replace function public.facebook_cleanup_page_oauth_candidates(p_actor_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_candidate record;
  v_retired integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  for v_candidate in
    select c.auth_secret_name
    from public.facebook_page_oauth_candidates c
    where c.consumed_at is null
      and c.expires_at <= now()
      and (p_actor_id is null or c.actor_id = p_actor_id)
    for update
  loop
    perform public.facebook_delete_page_oauth_candidate_secret(v_candidate.auth_secret_name);
    v_retired := v_retired + 1;
  end loop;

  update public.facebook_page_oauth_candidates c
  set consumed_at = now(),
      updated_at = now()
  where c.consumed_at is null
    and c.expires_at <= now()
    and (p_actor_id is null or c.actor_id = p_actor_id);

  return v_retired;
end;
$$;
revoke all on function public.facebook_cleanup_page_oauth_candidates(uuid) from public, anon, authenticated;
grant execute on function public.facebook_cleanup_page_oauth_candidates(uuid) to service_role;

create or replace function public.facebook_store_page_oauth_candidates(
  p_actor_id uuid,
  p_candidates jsonb,
  p_expires_at timestamptz
)
returns table(candidate_id text, page_name text, page_id_suffix text, permissions text[], expires_at timestamptz)
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_candidate jsonb;
  v_candidate_secret record;
  v_batch_id uuid := gen_random_uuid();
  v_candidate_id text;
  v_page_id text;
  v_page_name text;
  v_page_access_auth text;
  v_permissions text[];
  v_secret_name text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_expires_at <= now() then
    raise exception 'invalid_expiry' using errcode = '22023';
  end if;

  perform public.facebook_cleanup_page_oauth_candidates(p_actor_id);

  for v_candidate_secret in
    select c.auth_secret_name
    from public.facebook_page_oauth_candidates c
    where c.actor_id = p_actor_id
      and c.consumed_at is null
    for update
  loop
    perform public.facebook_delete_page_oauth_candidate_secret(v_candidate_secret.auth_secret_name);
  end loop;

  update public.facebook_page_oauth_candidates c
  set consumed_at = now(),
      updated_at = now()
  where c.actor_id = p_actor_id
    and c.consumed_at is null;

  for v_candidate in
    select value from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb))
  loop
    v_page_id := v_candidate->>'page_id';
    v_page_name := nullif(btrim(v_candidate->>'page_name'), '');
    v_page_access_auth := v_candidate->>'page_access_auth';
    v_permissions := coalesce(
      array(select jsonb_array_elements_text(coalesce(v_candidate->'permissions', '[]'::jsonb))),
      '{}'
    );
    if v_page_id !~ '^[0-9]{5,32}$' or v_page_name is null or length(coalesce(v_page_access_auth, '')) < 20 then
      raise exception 'invalid_page_candidate' using errcode = '22023';
    end if;

    v_candidate_id := encode(extensions.gen_random_bytes(18), 'hex');
    v_secret_name := 'facebook_messenger_page_candidate_' || v_candidate_id;
    perform vault.create_secret(v_page_access_auth, v_secret_name, 'Short-lived Facebook Page OAuth candidate auth material');

    insert into public.facebook_page_oauth_candidates (
      batch_id,
      candidate_id,
      actor_id,
      page_id,
      page_name,
      page_id_suffix,
      permissions,
      auth_secret_name,
      expires_at
    )
    values (
      v_batch_id,
      v_candidate_id,
      p_actor_id,
      v_page_id,
      left(v_page_name, 200),
      right(v_page_id, 4),
      v_permissions,
      v_secret_name,
      p_expires_at
    );
  end loop;

  return query
  select c.candidate_id, c.page_name, c.page_id_suffix, c.permissions, c.expires_at
  from public.facebook_page_oauth_candidates c
  where c.batch_id = v_batch_id
  order by c.page_name asc, c.page_id_suffix asc;
end;
$$;
revoke all on function public.facebook_store_page_oauth_candidates(uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.facebook_store_page_oauth_candidates(uuid, jsonb, timestamptz) to service_role;

create or replace function public.facebook_list_page_oauth_candidates(p_actor_id uuid)
returns table(candidate_id text, page_name text, page_id_suffix text, permissions text[], expires_at timestamptz)
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  perform public.facebook_cleanup_page_oauth_candidates(p_actor_id);

  return query
  select c.candidate_id, c.page_name, c.page_id_suffix, c.permissions, c.expires_at
  from public.facebook_page_oauth_candidates c
  where c.actor_id = p_actor_id
    and c.consumed_at is null
    and c.expires_at > now()
  order by c.page_name asc, c.page_id_suffix asc;
end;
$$;
revoke all on function public.facebook_list_page_oauth_candidates(uuid) from public, anon, authenticated;
grant execute on function public.facebook_list_page_oauth_candidates(uuid) to service_role;

create or replace function public.facebook_consume_page_oauth_candidate(
  p_actor_id uuid,
  p_candidate_id text
)
returns table(page_id text, page_name text, page_access_auth text, permissions text[])
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_candidate_secret record;
  v_page_id text;
  v_page_name text;
  v_page_access_auth text;
  v_permissions text[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  perform public.facebook_cleanup_page_oauth_candidates(p_actor_id);

  select c.page_id, c.page_name, decrypted.decrypted_secret, c.permissions
  into v_page_id, v_page_name, v_page_access_auth, v_permissions
  from public.facebook_page_oauth_candidates c
  left join vault.decrypted_secrets decrypted on decrypted.name = c.auth_secret_name
  where c.actor_id = p_actor_id
    and c.candidate_id = p_candidate_id
    and c.consumed_at is null
    and c.expires_at > now()
  for update of c;

  if not found then
    return;
  end if;

  for v_candidate_secret in
    select c.auth_secret_name
    from public.facebook_page_oauth_candidates c
    where c.actor_id = p_actor_id
      and c.consumed_at is null
    for update
  loop
    perform public.facebook_delete_page_oauth_candidate_secret(v_candidate_secret.auth_secret_name);
  end loop;

  update public.facebook_page_oauth_candidates c
  set consumed_at = now(),
      updated_at = now()
  where c.actor_id = p_actor_id
    and c.consumed_at is null;

  if length(coalesce(v_page_access_auth, '')) = 0 then
    return;
  end if;

  return query select v_page_id, v_page_name, v_page_access_auth, v_permissions;
end;
$$;
revoke all on function public.facebook_consume_page_oauth_candidate(uuid, text) from public, anon, authenticated;
grant execute on function public.facebook_consume_page_oauth_candidate(uuid, text) to service_role;

drop function if exists public.facebook_store_page_access_auth(text, text);
drop function if exists public.facebook_mark_page_oauth_connected(text, text, uuid, text[], timestamptz);
drop function if exists public.facebook_get_page_access_auth();

create or replace function public.facebook_commit_page_oauth_connection(
  p_page_id text,
  p_page_name text,
  p_auth_material text,
  p_actor_id uuid,
  p_permissions text[] default '{}',
  p_connected_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing uuid;
  v_name constant text := 'facebook_messenger_page_access';
  v_permissions text[] := coalesce(p_permissions, '{}');
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_page_id !~ '^[0-9]{5,32}$' or length(btrim(coalesce(p_page_name, ''))) = 0 or length(btrim(coalesce(p_auth_material, ''))) < 20 then
    raise exception 'invalid_page_auth_material' using errcode = '22023';
  end if;
  if not ('MESSAGING' = any(v_permissions) and 'MANAGE' = any(v_permissions)) then
    raise exception 'invalid_page_permissions' using errcode = '22023';
  end if;

  perform 1
  from public.facebook_messenger_settings
  where id = '00000000-0000-0000-0000-000000000001'::uuid
  for update;

  select id into v_existing
  from vault.decrypted_secrets
  where name = v_name
  order by created_at desc
  limit 1;

  if v_existing is null then
    perform vault.create_secret(p_auth_material, v_name, 'Facebook Messenger Page access auth material');
  else
    perform vault.update_secret(v_existing, p_auth_material, v_name, 'Facebook Messenger Page access auth material');
  end if;

  insert into public.facebook_messenger_settings (
    id,
    page_id,
    page_name,
    connection_status,
    connection_error_code,
    oauth_permissions,
    connected_at,
    connected_by,
    updated_at
  )
  values (
    '00000000-0000-0000-0000-000000000001'::uuid,
    p_page_id,
    left(p_page_name, 200),
    'connected',
    null,
    v_permissions,
    coalesce(p_connected_at, now()),
    p_actor_id,
    now()
  )
  on conflict (id) do update
  set page_id = excluded.page_id,
      page_name = excluded.page_name,
      connection_status = 'connected',
      connection_error_code = null,
      oauth_permissions = excluded.oauth_permissions,
      connected_at = excluded.connected_at,
      connected_by = excluded.connected_by,
      updated_at = now();
end;
$$;
revoke all on function public.facebook_commit_page_oauth_connection(text, text, text, uuid, text[], timestamptz) from public, anon, authenticated;
grant execute on function public.facebook_commit_page_oauth_connection(text, text, text, uuid, text[], timestamptz) to service_role;

create or replace function public.facebook_get_page_access_auth()
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_settings public.facebook_messenger_settings%rowtype;
  v_auth_material text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select * into v_settings
  from public.facebook_messenger_settings
  where id = '00000000-0000-0000-0000-000000000001'::uuid;

  if not found or v_settings.connection_status <> 'connected' or length(btrim(coalesce(v_settings.page_id, ''))) = 0 then
    return null;
  end if;

  select decrypted_secret into v_auth_material
  from vault.decrypted_secrets
  where name = 'facebook_messenger_page_access'
  order by created_at desc
  limit 1;

  if length(coalesce(v_auth_material, '')) = 0 then
    return null;
  end if;

  return jsonb_build_object(
    'page_id', v_settings.page_id,
    'page_access_auth', v_auth_material
  );
end;
$$;
revoke all on function public.facebook_get_page_access_auth() from public, anon, authenticated;
grant execute on function public.facebook_get_page_access_auth() to service_role;

create or replace function public.facebook_page_connection_status()
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_settings public.facebook_messenger_settings%rowtype;
  v_page_auth_present boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select * into v_settings
  from public.facebook_messenger_settings
  where id = '00000000-0000-0000-0000-000000000001'::uuid;

  select exists(
    select 1
    from vault.decrypted_secrets
    where name = 'facebook_messenger_page_access'
      and length(coalesce(decrypted_secret, '')) > 0
  ) into v_page_auth_present;

  return jsonb_build_object(
    'connected', coalesce(v_settings.connection_status = 'connected' and length(btrim(v_settings.page_id)) > 0 and v_page_auth_present, false),
    'feature_enabled', coalesce(v_settings.enabled, false),
    'page_name', v_settings.page_name,
    'page_id_suffix', case when v_settings.page_id is null then null else right(v_settings.page_id, 4) end,
    'connected_at', v_settings.connected_at,
    'connection_status', coalesce(v_settings.connection_status, 'not_connected')
  );
end;
$$;
revoke all on function public.facebook_page_connection_status() from public, anon, authenticated;
grant execute on function public.facebook_page_connection_status() to service_role;

create or replace function public.facebook_messenger_health_status()
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_settings public.facebook_messenger_settings%rowtype;
  v_settings_present boolean;
  v_page_auth_present boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select * into v_settings
  from public.facebook_messenger_settings
  where id = '00000000-0000-0000-0000-000000000001'::uuid;
  v_settings_present := found;

  select exists(
    select 1
    from vault.decrypted_secrets
    where name = 'facebook_messenger_page_access'
      and length(coalesce(decrypted_secret, '')) > 0
  ) into v_page_auth_present;

  return jsonb_build_object(
    'feature_enabled', coalesce(v_settings.enabled, false),
    'settings_present', v_settings_present,
    'page_configured', coalesce(v_settings.connection_status = 'connected' and length(btrim(v_settings.page_id)) > 0, false),
    'page_auth_present', v_page_auth_present,
    'can_enqueue', coalesce(v_settings.enabled, false)
      and coalesce(v_settings.connection_status = 'connected' and length(btrim(v_settings.page_id)) > 0, false)
      and v_page_auth_present
  );
end;
$$;
revoke all on function public.facebook_messenger_health_status() from public, anon, authenticated;
grant execute on function public.facebook_messenger_health_status() to service_role;

-- Inbox reads follow the singleton Page binding so a successful Page switch cannot
-- expose conversations retained for the previously connected Page.
create or replace function public.facebook_list_messenger_conversations()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_connected_page_id text;
  v_rows jsonb;
begin
  if auth.role() is distinct from 'service_role'
     and (v_actor is null or not public.facebook_messenger_has_permission(v_actor, 'view')) then
    raise exception 'facebook_messenger_view_required' using errcode = '42501';
  end if;

  select s.page_id into v_connected_page_id
  from public.facebook_messenger_settings s
  where s.id = '00000000-0000-0000-0000-000000000001'::uuid
    and s.connection_status = 'connected'
    and length(btrim(s.page_id)) > 0;

  if v_connected_page_id is null then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', bounded.id,
    'customer_name', bounded.customer_name,
    'last_message_at', bounded.last_message_at,
    'last_message_preview', bounded.last_message_preview,
    'reply_window_expires_at', bounded.reply_window_expires_at,
    'reply_window_expired', bounded.reply_window_expired,
    'human_agent_window_expires_at', bounded.human_agent_window_expires_at,
    'reply_blocked', bounded.reply_blocked,
    'reconciliation_status', bounded.reconciliation_status,
    'blocking_outbox_id', bounded.blocking_outbox_id
  ) order by bounded.last_message_at desc nulls last, bounded.id), '[]'::jsonb)
  into v_rows
  from (
    select c.id,
           c.customer_name,
           c.last_message_at,
           c.reply_window_expires_at,
           coalesce(c.reply_window_expires_at, c.last_inbound_message_at + interval '24 hours') < now() as reply_window_expired,
           c.human_agent_window_expires_at,
           left(coalesce((
             select m.message_text
             from public.facebook_messenger_messages m
             where m.conversation_id = c.id
             order by m.created_at desc, m.id desc
             limit 1
           ), ''), 240) as last_message_preview,
           (blocking.id is not null) as reply_blocked,
           blocking.status as reconciliation_status,
           blocking.id as blocking_outbox_id
    from public.facebook_messenger_conversations c
    left join lateral (
      select o.id, o.status
      from public.facebook_messenger_outbox o
      where o.conversation_id = c.id
        and o.status in ('send_committed', 'manual_reconciliation_required')
      order by coalesce(o.send_committed_at, o.updated_at, o.created_at) desc, o.created_at desc, o.id desc
      limit 1
    ) blocking on true
    where c.page_id = v_connected_page_id
    order by c.last_message_at desc nulls last, c.id
    limit 100
  ) bounded;

  return v_rows;
end;
$$;
revoke all on function public.facebook_list_messenger_conversations() from public, anon, authenticated;
grant execute on function public.facebook_list_messenger_conversations() to authenticated, service_role;

create or replace function public.facebook_read_messenger_conversation(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_connected_page_id text;
  v_result jsonb;
begin
  if auth.role() is distinct from 'service_role'
     and (v_actor is null or not public.facebook_messenger_has_permission(v_actor, 'view')) then
    raise exception 'facebook_messenger_view_required' using errcode = '42501';
  end if;

  select s.page_id into v_connected_page_id
  from public.facebook_messenger_settings s
  where s.id = '00000000-0000-0000-0000-000000000001'::uuid
    and s.connection_status = 'connected'
    and length(btrim(s.page_id)) > 0;

  if v_connected_page_id is null then
    return null;
  end if;

  select jsonb_build_object(
    'id', c.id,
    'customer_name', c.customer_name,
    'last_message_at', c.last_message_at,
    'last_message_preview', left(coalesce((
      select m.message_text
      from public.facebook_messenger_messages m
      where m.conversation_id = c.id
      order by m.created_at desc, m.id desc
      limit 1
    ), ''), 240),
    'reply_window_expires_at', c.reply_window_expires_at,
    'reply_window_expired', coalesce(c.reply_window_expires_at, c.last_inbound_message_at + interval '24 hours') < now(),
    'reply_blocked', blocking.id is not null,
    'reconciliation_status', blocking.status,
    'blocking_outbox_id', blocking.id,
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', bounded.id,
        'direction', bounded.direction,
        'message_text', bounded.message_text,
        'created_at', bounded.created_at
      ) order by bounded.created_at, bounded.id)
      from (
        select m.id, m.direction, m.message_text, m.created_at
        from public.facebook_messenger_messages m
        where m.conversation_id = c.id
        order by m.created_at desc, m.id desc
        limit 200
      ) bounded
    ), '[]'::jsonb)
  ) into v_result
  from public.facebook_messenger_conversations c
  left join lateral (
    select o.id, o.status
    from public.facebook_messenger_outbox o
    where o.conversation_id = c.id
      and o.status in ('send_committed', 'manual_reconciliation_required')
    order by coalesce(o.send_committed_at, o.updated_at, o.created_at) desc, o.created_at desc, o.id desc
    limit 1
  ) blocking on true
  where c.id = p_conversation_id
    and c.page_id = v_connected_page_id;

  return v_result;
end;
$$;
revoke all on function public.facebook_read_messenger_conversation(uuid) from public, anon, authenticated;
grant execute on function public.facebook_read_messenger_conversation(uuid) to authenticated, service_role;

-- Keep SQL authorization aligned with the Edge owner-or-edit policy. Authenticated
-- callers are attributed from auth.uid(); service-role callers must pass the actor
-- already verified by the Edge boundary.
create or replace function public.facebook_reconcile_messenger_outbox(
  p_outbox_id uuid,
  p_status text,
  p_provider_message_id text default null,
  p_safe_reason text default null,
  p_evidence_ref text default null,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_row public.facebook_messenger_outbox%rowtype;
begin
  v_actor := case when auth.role() = 'service_role' then p_actor_id else auth.uid() end;
  if v_actor is null
     or (
       not public.facebook_messenger_has_permission(v_actor, 'edit')
       and not public.facebook_messenger_is_owner(v_actor)
     ) then
    raise exception 'facebook_messenger_edit_required' using errcode = '42501';
  end if;
  if p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0 or length(p_evidence_ref) > 256 then
    raise exception 'evidence_ref_required' using errcode = '22023';
  end if;

  if p_status = 'sent' then
    if p_provider_message_id is null or length(btrim(p_provider_message_id)) = 0 or length(p_provider_message_id) > 256 then
      raise exception 'provider_mid_required' using errcode = '22023';
    end if;
    update public.facebook_messenger_outbox
    set status = 'sent',
        platform_message_id = btrim(p_provider_message_id),
        sent_at = now(),
        reconciliation_actor_id = v_actor,
        reconciliation_at = now(),
        reconciliation_evidence_ref = btrim(p_evidence_ref),
        updated_at = now()
    where id = p_outbox_id
      and status in ('send_committed', 'manual_reconciliation_required')
    returning * into v_row;
  elsif p_status = 'failed' then
    if p_safe_reason is null or p_safe_reason !~ '^[a-z0-9_:-]{1,120}$' then
      raise exception 'safe_reason_required' using errcode = '22023';
    end if;
    update public.facebook_messenger_outbox
    set status = 'failed',
        last_error = p_safe_reason,
        failed_at = now(),
        reconciliation_actor_id = v_actor,
        reconciliation_at = now(),
        reconciliation_evidence_ref = btrim(p_evidence_ref),
        updated_at = now()
    where id = p_outbox_id
      and status in ('send_committed', 'manual_reconciliation_required')
    returning * into v_row;
  else
    raise exception 'invalid_reconciliation_status' using errcode = '22023';
  end if;

  if not found then
    raise exception 'not_eligible' using errcode = 'P0001';
  end if;
  return jsonb_build_object('row', jsonb_build_object('id', v_row.id, 'status', v_row.status));
end;
$$;
revoke all on function public.facebook_reconcile_messenger_outbox(uuid, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.facebook_reconcile_messenger_outbox(uuid, text, text, text, text, uuid) to authenticated, service_role;

-- Retire the unsafe gate that could not bind a worker's token snapshot to the
-- current singleton Page. The replacement linearizes Page switches by locking
-- the settings row immediately before the outbox send commit.
revoke all on function public.facebook_mark_messenger_outbox_send_committed(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.facebook_mark_messenger_outbox_send_committed(p_outbox_id uuid, p_lease_token uuid, p_expected_page_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.facebook_messenger_outbox%rowtype;
  v_conversation_id uuid;
  v_connected_page_id text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_expected_page_id is null or p_expected_page_id !~ '^[0-9]{5,32}$' then
    raise exception 'invalid_expected_page_id' using errcode = '22023';
  end if;

  select s.page_id into v_connected_page_id
  from public.facebook_messenger_settings s
  where s.id = '00000000-0000-0000-0000-000000000001'::uuid
    and s.connection_status = 'connected'
    and s.page_id = p_expected_page_id
  for update;

  if not found then
    return false;
  end if;

  select * into v_row
  from public.facebook_messenger_outbox o
  where o.id = p_outbox_id
    and o.page_id = p_expected_page_id
    and o.status = 'processing'
    and o.lease_token = p_lease_token
    and o.lease_expires_at > now();

  if not found then
    return false;
  end if;

  select c.id into v_conversation_id
  from public.facebook_messenger_conversations c
  where c.id = v_row.conversation_id
    and c.page_id = p_expected_page_id
    and c.psid = v_row.psid
  for update;

  if not found then
    return false;
  end if;

  if exists (
    select 1
    from public.facebook_messenger_outbox blocker
    where blocker.conversation_id = v_row.conversation_id
      and blocker.id <> v_row.id
      and blocker.status in ('send_committed', 'manual_reconciliation_required')
  ) then
    update public.facebook_messenger_outbox
    set status = 'suppressed',
        last_error = 'reconciliation_required',
        updated_at = now()
    where id = v_row.id
      and page_id = p_expected_page_id
      and status = 'processing'
      and lease_token = p_lease_token
      and lease_expires_at > now();
    return false;
  end if;

  update public.facebook_messenger_outbox
  set status = 'send_committed',
      send_committed_at = now(),
      committed_by_worker_at = now(),
      committed_attempt = attempt_count + 1,
      attempt_count = attempt_count + 1,
      updated_at = now()
  where id = v_row.id
    and page_id = p_expected_page_id
    and status = 'processing'
    and lease_token = p_lease_token
    and lease_expires_at > now();

  if not found then
    return false;
  end if;

  perform public.facebook_suppress_messenger_outbox_for_blocker(v_row.conversation_id, v_row.id, 'reconciliation_required');
  return true;
end;
$$;
revoke all on function public.facebook_mark_messenger_outbox_send_committed(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.facebook_mark_messenger_outbox_send_committed(uuid, uuid, text) to service_role;
