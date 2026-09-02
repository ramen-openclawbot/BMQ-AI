-- Task4 Messenger reply outbox, authenticated inbox RPCs, worker transitions, and reconciliation.
-- Extends the foundation without changing historical Task2/Task6 migrations.

alter table public.facebook_messenger_outbox
  add column if not exists message_text text,
  add column if not exists messenger_tag text not null default 'RESPONSE',
  add column if not exists intent_hash text,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists committed_by_worker_at timestamptz,
  add column if not exists committed_attempt integer,
  add column if not exists reconciliation_actor_id uuid references auth.users(id) on delete set null,
  add column if not exists reconciliation_at timestamptz,
  add column if not exists reconciliation_evidence_ref text;

alter table public.facebook_messenger_outbox
  drop constraint if exists facebook_messenger_outbox_tag_check,
  add constraint facebook_messenger_outbox_tag_check check (messenger_tag in ('RESPONSE', 'HUMAN_AGENT')),
  drop constraint if exists facebook_messenger_outbox_message_text_check,
  add constraint facebook_messenger_outbox_message_text_check check (message_text is null or (length(btrim(message_text)) between 1 and 2000)),
  drop constraint if exists facebook_messenger_outbox_intent_hash_check,
  add constraint facebook_messenger_outbox_intent_hash_check check (intent_hash is null or intent_hash ~ '^[0-9a-f]{64}$'),
  drop constraint if exists facebook_messenger_outbox_safe_last_error_check,
  add constraint facebook_messenger_outbox_safe_last_error_check check (last_error is null or last_error ~ '^[a-z0-9_:-]{1,120}$');

create index if not exists facebook_messenger_outbox_worker_claim_idx
  on public.facebook_messenger_outbox(status, scheduled_for, created_at)
  where status = 'pending';
create index if not exists facebook_messenger_outbox_manual_recon_idx
  on public.facebook_messenger_outbox(status, send_committed_at)
  where status in ('send_committed', 'manual_reconciliation_required');

create or replace function public.facebook_messenger_has_permission(
  p_user_id uuid,
  p_mode text default 'view'
)
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce(exists (
    select 1 from public.user_roles ur
    where ur.user_id = p_user_id and ur.role = 'owner'
  ), false)
  or coalesce(exists (
    select 1 from public.user_module_permissions ump
    where ump.user_id = p_user_id
      and ump.module_key = 'facebook_messenger'
      and case when p_mode = 'edit' then ump.can_edit else (ump.can_view or ump.can_edit) end
  ), false);
$$;

revoke all on function public.facebook_messenger_has_permission(uuid, text) from public, anon, authenticated;
grant execute on function public.facebook_messenger_has_permission(uuid, text) to service_role;

create or replace function public.facebook_messenger_is_owner(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select coalesce(exists (
    select 1 from public.user_roles ur
    where ur.user_id = p_user_id and ur.role = 'owner'
  ), false);
$$;

revoke all on function public.facebook_messenger_is_owner(uuid) from public, anon, authenticated;
grant execute on function public.facebook_messenger_is_owner(uuid) to service_role;

create or replace function public.facebook_get_messenger_conversation_policy(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conv public.facebook_messenger_conversations%rowtype;
  v_settings public.facebook_messenger_settings%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select * into v_conv from public.facebook_messenger_conversations where id = p_conversation_id;
  if not found then return null; end if;
  select * into v_settings from public.facebook_messenger_settings where id = '00000000-0000-0000-0000-000000000001'::uuid;

  return jsonb_build_object(
    'id', v_conv.id,
    'last_user_message_at_ms', case when v_conv.last_inbound_message_at is null then null else floor(extract(epoch from v_conv.last_inbound_message_at) * 1000)::bigint end,
    'human_agent_enabled', coalesce(v_settings.human_agent_enabled, false),
    'human_agent_approved', coalesce((v_conv.metadata->>'human_agent_approved')::boolean, false)
  );
end;
$$;
revoke all on function public.facebook_get_messenger_conversation_policy(uuid) from public, anon, authenticated;
grant execute on function public.facebook_get_messenger_conversation_policy(uuid) to service_role;

create or replace function public.facebook_enqueue_messenger_outbox(
  p_conversation_id uuid,
  p_text text,
  p_idempotency_key text,
  p_tag text default 'RESPONSE',
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor uuid;
  v_settings public.facebook_messenger_settings%rowtype;
  v_conv public.facebook_messenger_conversations%rowtype;
  v_payload jsonb;
  v_intent_hash text;
  v_inserted public.facebook_messenger_outbox%rowtype;
  v_existing public.facebook_messenger_outbox%rowtype;
begin
  v_actor := case when auth.role() = 'service_role' then p_actor_id else auth.uid() end;
  if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
  if not public.facebook_messenger_has_permission(v_actor, 'edit') then
    -- rbac_staff_default_denied
    raise exception 'facebook_messenger_edit_required' using errcode = '42501';
  end if;

  select * into v_settings from public.facebook_messenger_settings where id = '00000000-0000-0000-0000-000000000001'::uuid for share;
  if not found or coalesce(v_settings.enabled, false) is false then
    -- disabled no outbox
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;

  if p_text is null or length(btrim(p_text)) = 0 or length(btrim(p_text)) > 2000 then
    raise exception 'invalid_message_text' using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{32,128}$' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  if p_tag is distinct from 'RESPONSE' and p_tag is distinct from 'HUMAN_AGENT' then
    raise exception 'invalid_tag' using errcode = '22023';
  end if;

  select * into v_conv from public.facebook_messenger_conversations where id = p_conversation_id and page_id = v_settings.page_id for share;
  if not found then raise exception 'conversation_not_found' using errcode = 'P0002'; end if;

  v_payload := jsonb_build_object('text_preview', left(btrim(p_text), 2000), 'tag', p_tag, 'created_by_actor', v_actor);
  v_intent_hash := encode(digest(p_conversation_id::text || chr(31) || btrim(p_text) || chr(31) || p_tag, 'sha256'), 'hex');

  insert into public.facebook_messenger_outbox(
    conversation_id, page_id, psid, idempotency_key, status, payload, message_text, messenger_tag, intent_hash, scheduled_for, created_by
  ) values (
    v_conv.id, v_conv.page_id, v_conv.psid, p_idempotency_key, 'pending', v_payload, btrim(p_text), p_tag, v_intent_hash, now(), v_actor
  )
  on conflict (idempotency_key) do nothing
  returning * into v_inserted;

  if v_inserted.id is null then
    select * into v_existing from public.facebook_messenger_outbox where idempotency_key = p_idempotency_key for share;
    if not found or v_existing.intent_hash is distinct from v_intent_hash then
      raise exception 'idempotency_conflict' using errcode = '23505';
    end if;
    v_inserted := v_existing;
  end if;

  return jsonb_build_object('ok', true, 'row', jsonb_build_object('id', v_inserted.id, 'status', v_inserted.status, 'idempotency_key', v_inserted.idempotency_key));
end;
$$;
revoke all on function public.facebook_enqueue_messenger_outbox(uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.facebook_enqueue_messenger_outbox(uuid, text, text, text, uuid) to service_role;

do $$
begin
  if to_regprocedure('public.facebook_enqueue_messenger_outbox(uuid,text,text,text,uuid)') is not null then
    grant execute on function public.facebook_enqueue_messenger_outbox(uuid, text, text, text, uuid) to authenticated;
  end if;
end $$;

create or replace function public.facebook_claim_messenger_outbox(p_limit integer default 10)
returns table(id uuid, page_id text, psid text, text text, tag text, attempt_count integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  return query
  with claimed as (
    select o.id
    from public.facebook_messenger_outbox o
    join public.facebook_messenger_settings s on s.page_id = o.page_id
    where o.status = 'pending'
      and o.scheduled_for <= now()
      and s.enabled = true
    order by o.scheduled_for, o.created_at
    limit greatest(1, least(coalesce(p_limit, 10), 25))
    for update of o skip locked
  )
  update public.facebook_messenger_outbox o
  set status = 'processing',
      processing_started_at = now(),
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + interval '5 minutes',
      updated_at = now()
  from claimed
  where o.id = claimed.id
  returning o.id, o.page_id, o.psid, o.message_text, o.messenger_tag, o.attempt_count;
end;
$$;
revoke all on function public.facebook_claim_messenger_outbox(integer) from public, anon, authenticated;
grant execute on function public.facebook_claim_messenger_outbox(integer) to service_role;

create or replace function public.facebook_mark_messenger_outbox_send_committed(p_outbox_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  update public.facebook_messenger_outbox
  set status = 'send_committed',
      send_committed_at = now(),
      committed_by_worker_at = now(),
      committed_attempt = attempt_count + 1,
      attempt_count = attempt_count + 1,
      updated_at = now()
  where id = p_outbox_id and status = 'processing'
  returning 1 into v_count;
  return found;
end;
$$;
revoke all on function public.facebook_mark_messenger_outbox_send_committed(uuid) from public, anon, authenticated;
grant execute on function public.facebook_mark_messenger_outbox_send_committed(uuid) to service_role;

create or replace function public.facebook_mark_messenger_outbox_sent(p_outbox_id uuid, p_provider_message_id text, p_evidence jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.facebook_messenger_outbox%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_provider_message_id is null or length(btrim(p_provider_message_id)) = 0 or length(p_provider_message_id) > 256 then raise exception 'provider_mid_required' using errcode = '22023'; end if;
  update public.facebook_messenger_outbox
  set status = 'sent', platform_message_id = btrim(p_provider_message_id), response_payload = jsonb_strip_nulls(p_evidence), sent_at = now(), updated_at = now()
  where id = p_outbox_id and status = 'send_committed'
  returning * into v_row;
  if not found then raise exception 'not_eligible' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end;
$$;
revoke all on function public.facebook_mark_messenger_outbox_sent(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.facebook_mark_messenger_outbox_sent(uuid, text, jsonb) to service_role;

create or replace function public.facebook_mark_messenger_outbox_failed(p_outbox_id uuid, p_safe_reason text, p_evidence jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.facebook_messenger_outbox%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_safe_reason is null or p_safe_reason !~ '^[a-z0-9_:-]{1,120}$' then raise exception 'unsafe_reason' using errcode = '22023'; end if;
  update public.facebook_messenger_outbox
  set status = 'failed', last_error = p_safe_reason, response_payload = jsonb_strip_nulls(p_evidence), failed_at = now(), updated_at = now()
  where id = p_outbox_id and status in ('processing', 'send_committed')
  returning * into v_row;
  if not found then raise exception 'not_eligible' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end;
$$;
revoke all on function public.facebook_mark_messenger_outbox_failed(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.facebook_mark_messenger_outbox_failed(uuid, text, jsonb) to service_role;

create or replace function public.facebook_mark_messenger_outbox_manual_reconciliation(p_outbox_id uuid, p_safe_reason text, p_evidence jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.facebook_messenger_outbox%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_safe_reason is null or p_safe_reason !~ '^[a-z0-9_:-]{1,120}$' then raise exception 'unsafe_reason' using errcode = '22023'; end if;
  -- timeout_requires_manual_reconciliation; no blind retry from send_committed.
  update public.facebook_messenger_outbox
  set status = 'manual_reconciliation_required', last_error = p_safe_reason, response_payload = jsonb_strip_nulls(p_evidence), updated_at = now()
  where id = p_outbox_id and status = 'send_committed'
  returning * into v_row;
  if not found then raise exception 'not_eligible' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end;
$$;
revoke all on function public.facebook_mark_messenger_outbox_manual_reconciliation(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.facebook_mark_messenger_outbox_manual_reconciliation(uuid, text, jsonb) to service_role;

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
  if v_actor is null or not public.facebook_messenger_has_permission(v_actor, 'edit') or not public.facebook_messenger_is_owner(v_actor) then
    raise exception 'facebook_messenger_owner_required' using errcode = '42501';
  end if;
  if p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0 or length(p_evidence_ref) > 256 then raise exception 'evidence_ref_required' using errcode = '22023'; end if;

  if p_status = 'sent' then
    if p_provider_message_id is null or length(btrim(p_provider_message_id)) = 0 or length(p_provider_message_id) > 256 then raise exception 'provider_mid_required' using errcode = '22023'; end if;
    update public.facebook_messenger_outbox
    set status = 'sent', platform_message_id = btrim(p_provider_message_id), sent_at = now(), reconciliation_actor_id = v_actor, reconciliation_at = now(), reconciliation_evidence_ref = btrim(p_evidence_ref), updated_at = now()
    where id = p_outbox_id and status in ('send_committed', 'manual_reconciliation_required')
    returning * into v_row;
  elsif p_status = 'failed' then
    if p_safe_reason is null or p_safe_reason !~ '^[a-z0-9_:-]{1,120}$' then raise exception 'safe_reason_required' using errcode = '22023'; end if;
    update public.facebook_messenger_outbox
    set status = 'failed', last_error = p_safe_reason, failed_at = now(), reconciliation_actor_id = v_actor, reconciliation_at = now(), reconciliation_evidence_ref = btrim(p_evidence_ref), updated_at = now()
    where id = p_outbox_id and status in ('send_committed', 'manual_reconciliation_required')
    returning * into v_row;
  else
    raise exception 'invalid_reconciliation_status' using errcode = '22023';
  end if;
  if not found then raise exception 'not_eligible' using errcode = 'P0001'; end if;
  return jsonb_build_object('row', jsonb_build_object('id', v_row.id, 'status', v_row.status));
end;
$$;
revoke all on function public.facebook_reconcile_messenger_outbox(uuid, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.facebook_reconcile_messenger_outbox(uuid, text, text, text, text, uuid) to service_role;

do $$
begin
  grant execute on function public.facebook_reconcile_messenger_outbox(uuid, text, text, text, text, uuid) to authenticated;
end $$;

create or replace function public.facebook_list_messenger_conversations()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_actor uuid := auth.uid(); v_rows jsonb;
begin
  if auth.role() <> 'service_role' and (v_actor is null or not public.facebook_messenger_has_permission(v_actor, 'view')) then
    raise exception 'facebook_messenger_view_required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'customer_name', c.customer_name,
    'last_message_at', c.last_message_at,
    'reply_window_expires_at', c.reply_window_expires_at,
    'human_agent_window_expires_at', c.human_agent_window_expires_at
  ) order by c.last_message_at desc nulls last), '[]'::jsonb)
  into v_rows
  from public.facebook_messenger_conversations c
  limit 100;
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
declare v_actor uuid := auth.uid(); v_result jsonb;
begin
  if auth.role() <> 'service_role' and (v_actor is null or not public.facebook_messenger_has_permission(v_actor, 'view')) then
    raise exception 'facebook_messenger_view_required' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'id', c.id,
    'customer_name', c.customer_name,
    'last_message_at', c.last_message_at,
    'reply_window_expires_at', c.reply_window_expires_at,
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'direction', m.direction, 'message_text', m.message_text, 'received_at', m.received_at, 'sent_at', m.sent_at) order by m.created_at) from public.facebook_messenger_messages m where m.conversation_id = c.id limit 100), '[]'::jsonb)
  ) into v_result
  from public.facebook_messenger_conversations c
  where c.id = p_conversation_id;
  return v_result;
end;
$$;
revoke all on function public.facebook_read_messenger_conversation(uuid) from public, anon, authenticated;
grant execute on function public.facebook_read_messenger_conversation(uuid) to authenticated, service_role;

create or replace function public.facebook_messenger_health_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_settings public.facebook_messenger_settings%rowtype; v_settings_present boolean;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  select * into v_settings from public.facebook_messenger_settings where id = '00000000-0000-0000-0000-000000000001'::uuid;
  v_settings_present := found;
  return jsonb_build_object(
    'feature_enabled', coalesce(v_settings.enabled, false),
    'settings_present', v_settings_present,
    'page_configured', coalesce(length(btrim(v_settings.page_id)) > 0, false),
    'can_enqueue', coalesce(v_settings.enabled, false)
  );
end;
$$;
revoke all on function public.facebook_messenger_health_status() from public, anon, authenticated;
grant execute on function public.facebook_messenger_health_status() to service_role;
