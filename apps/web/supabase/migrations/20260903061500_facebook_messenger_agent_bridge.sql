-- Task4B: secure default-off Instinct email notification and signed reply bridge.
-- duplicate_inbound_one_email, destination_allowlisted, raw_psid_not_emailed, same_idempotency_one_outbox, ai_cannot_use_human_agent

alter table public.facebook_messenger_settings
  add column if not exists agent_email_forward_enabled boolean not null default false,
  add column if not exists agent_reply_enabled boolean not null default false,
  add column if not exists agent_email_processor_approved boolean not null default false,
  alter column agent_email_forward_enabled set default false,
  alter column agent_reply_enabled set default false;

alter table public.facebook_messenger_email_outbox
  add column if not exists provider_message_id text,
  add column if not exists response_payload jsonb not null default '{}'::jsonb,
  add column if not exists processing_started_at timestamptz,
  add column if not exists send_committed_at timestamptz,
  add column if not exists manual_reconciliation_required_at timestamptz,
  drop constraint if exists facebook_messenger_email_outbox_response_object_check,
  add constraint facebook_messenger_email_outbox_response_object_check check (jsonb_typeof(response_payload) = 'object'),
  drop constraint if exists facebook_messenger_email_outbox_safe_last_error_check,
  add constraint facebook_messenger_email_outbox_safe_last_error_check check (last_error is null or last_error ~ '^[a-z0-9_:-]{1,120}$'),
  drop constraint if exists facebook_messenger_email_outbox_status_check,
  add constraint facebook_messenger_email_outbox_status_check check (status in ('pending', 'processing', 'send_committed', 'sent', 'failed', 'manual_reconciliation_required', 'suppressed'));

create unique index if not exists facebook_messenger_email_provider_id_unique
  on public.facebook_messenger_email_outbox(provider_message_id)
  where provider_message_id is not null;

create index if not exists facebook_messenger_email_instinct_pending_conversation_idx
  on public.facebook_messenger_email_outbox(conversation_id, scheduled_for, created_at)
  where status = 'pending'
    and recipient_email = 'inboxoggxdk@agent.instinct.co'
    and payload->>'source' = 'facebook_messenger';

create index if not exists facebook_messenger_email_instinct_presend_conversation_idx
  on public.facebook_messenger_email_outbox(conversation_id, updated_at)
  where status in ('pending', 'processing')
    and recipient_email = 'inboxoggxdk@agent.instinct.co'
    and payload->>'source' = 'facebook_messenger';

create or replace function public.facebook_messenger_metadata_flag(p_metadata jsonb, p_key text)
returns boolean
language sql
stable
set search_path = public
as $$
  select lower(coalesce(p_metadata->>p_key, '')) in ('true', 't', '1', 'yes', 'y', 'on');
$$;
revoke all on function public.facebook_messenger_metadata_flag(jsonb, text) from public, anon, authenticated;
grant execute on function public.facebook_messenger_metadata_flag(jsonb, text) to service_role;

create or replace function public.facebook_messenger_conversation_is_suppressed(p_metadata jsonb)
returns boolean
language sql
stable
set search_path = public
as $$
  select public.facebook_messenger_metadata_flag(p_metadata, 'deleted')
      or public.facebook_messenger_metadata_flag(p_metadata, 'opted_out')
      or public.facebook_messenger_metadata_flag(p_metadata, 'quarantined')
      or public.facebook_messenger_metadata_flag(p_metadata, 'policy_blocked');
$$;
revoke all on function public.facebook_messenger_conversation_is_suppressed(jsonb) from public, anon, authenticated;
grant execute on function public.facebook_messenger_conversation_is_suppressed(jsonb) to service_role;

create or replace function public.facebook_suppress_pending_instinct_emails_for_conversation(p_conversation_id uuid, p_safe_reason text default 'suppressed_by_conversation_state')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  if p_safe_reason is null or p_safe_reason !~ '^[a-z0-9_:-]{1,120}$' then raise exception 'unsafe_reason' using errcode = '22023'; end if;
  update public.facebook_messenger_email_outbox eo
  set status = 'suppressed', last_error = p_safe_reason, failed_at = now(), updated_at = now()
  where eo.conversation_id = p_conversation_id
    and eo.status in ('pending', 'processing')
    and eo.recipient_email = 'inboxoggxdk@agent.instinct.co'
    and eo.payload->>'source' = 'facebook_messenger';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.facebook_suppress_pending_instinct_emails_for_conversation(uuid, text) from public, anon, authenticated;
grant execute on function public.facebook_suppress_pending_instinct_emails_for_conversation(uuid, text) to service_role;

create or replace function public.facebook_suppress_pending_instinct_emails_for_settings(p_safe_reason text default 'suppressed_by_email_bridge_disabled')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  if p_safe_reason is null or p_safe_reason !~ '^[a-z0-9_:-]{1,120}$' then raise exception 'unsafe_reason' using errcode = '22023'; end if;
  update public.facebook_messenger_email_outbox eo
  set status = 'suppressed', last_error = p_safe_reason, failed_at = now(), updated_at = now()
  where eo.status in ('pending', 'processing')
    and eo.recipient_email = 'inboxoggxdk@agent.instinct.co'
    and eo.payload->>'source' = 'facebook_messenger';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.facebook_suppress_pending_instinct_emails_for_settings(text) from public, anon, authenticated;
grant execute on function public.facebook_suppress_pending_instinct_emails_for_settings(text) to service_role;

create or replace function public.facebook_conversation_suppress_instinct_email_fn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.facebook_messenger_conversation_is_suppressed(new.metadata)
     and not public.facebook_messenger_conversation_is_suppressed(old.metadata) then
    perform public.facebook_suppress_pending_instinct_emails_for_conversation(new.id, 'suppressed_by_conversation_state');
  end if;
  return new;
end;
$$;
revoke all on function public.facebook_conversation_suppress_instinct_email_fn() from public, anon, authenticated;

drop trigger if exists facebook_messenger_conversation_suppress_instinct_email_trigger on public.facebook_messenger_conversations;
create trigger facebook_messenger_conversation_suppress_instinct_email_trigger
after update of metadata on public.facebook_messenger_conversations
for each row
execute function public.facebook_conversation_suppress_instinct_email_fn();

create or replace function public.facebook_messenger_settings_suppress_instinct_email_trigger_fn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (old.agent_email_forward_enabled is distinct from false and new.agent_email_forward_enabled = false)
     or (old.agent_email_processor_approved is distinct from false and new.agent_email_processor_approved = false) then
    perform public.facebook_suppress_pending_instinct_emails_for_settings('suppressed_by_email_bridge_disabled');
  end if;
  return new;
end;
$$;
revoke all on function public.facebook_messenger_settings_suppress_instinct_email_trigger_fn() from public, anon, authenticated;

drop trigger if exists facebook_messenger_settings_suppress_instinct_email_trigger on public.facebook_messenger_settings;
create trigger facebook_messenger_settings_suppress_instinct_email_trigger
after update of agent_email_forward_enabled, agent_email_processor_approved on public.facebook_messenger_settings
for each row
execute function public.facebook_messenger_settings_suppress_instinct_email_trigger_fn();

create table if not exists public.facebook_instinct_reply_nonces (
  nonce_hash text primary key,
  first_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint facebook_instinct_reply_nonces_hash_check check (nonce_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists public.facebook_instinct_reply_audit (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  conversation_id uuid,
  idempotency_key text,
  status text not null,
  actor_source text not null default 'instinct_bridge',
  client_evidence jsonb not null default '{}'::jsonb,
  outbox_id uuid,
  created_at timestamptz not null default now(),
  constraint facebook_instinct_reply_audit_status_check check (status in ('accepted', 'rejected')),
  constraint facebook_instinct_reply_audit_actor_check check (actor_source = 'instinct_bridge'),
  constraint facebook_instinct_reply_audit_evidence_object_check check (jsonb_typeof(client_evidence) = 'object')
);

alter table public.facebook_instinct_reply_nonces enable row level security;
alter table public.facebook_instinct_reply_audit enable row level security;
revoke all on table public.facebook_instinct_reply_nonces from public, anon, authenticated;
revoke all on table public.facebook_instinct_reply_audit from public, anon, authenticated;
grant select, insert, update, delete on table public.facebook_instinct_reply_nonces to service_role;
grant select, insert, update, delete on table public.facebook_instinct_reply_audit to service_role;

create index if not exists facebook_instinct_reply_nonces_expires_idx on public.facebook_instinct_reply_nonces(expires_at);
create index if not exists facebook_instinct_reply_audit_rate_idx on public.facebook_instinct_reply_audit(conversation_id, created_at) where status = 'accepted';

create or replace function public.facebook_record_instinct_reply_nonce(p_nonce text, p_timestamp_seconds bigint)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_inserted integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{16,96}$' then raise exception 'invalid_nonce' using errcode = '22023'; end if;
  delete from public.facebook_instinct_reply_nonces
  where nonce_hash in (
    select nonce_hash from public.facebook_instinct_reply_nonces
    where expires_at < now()
    order by expires_at
    limit 500
  );
  v_hash := encode(digest(p_nonce, 'sha256'), 'hex');
  insert into public.facebook_instinct_reply_nonces(nonce_hash, expires_at)
  values (v_hash, to_timestamp(p_timestamp_seconds) + interval '10 minutes')
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;
revoke all on function public.facebook_record_instinct_reply_nonce(text, bigint) from public, anon, authenticated;
grant execute on function public.facebook_record_instinct_reply_nonce(text, bigint) to service_role;

create or replace function public.facebook_check_instinct_reply_rate_limit(p_thread_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  select count(*) into v_count
  from public.facebook_instinct_reply_audit
  where conversation_id = p_thread_id
    and status = 'accepted'
    and created_at > now() - interval '1 minute';
  return v_count < 10;
end;
$$;
revoke all on function public.facebook_check_instinct_reply_rate_limit(uuid) from public, anon, authenticated;
grant execute on function public.facebook_check_instinct_reply_rate_limit(uuid) to service_role;

create or replace function public.facebook_enqueue_instinct_messenger_reply(
  p_thread_id uuid,
  p_text text,
  p_idempotency_key text,
  p_request_id uuid,
  p_client_evidence jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_settings public.facebook_messenger_settings%rowtype;
  v_conv public.facebook_messenger_conversations%rowtype;
  v_payload jsonb;
  v_intent_hash text;
  v_inserted public.facebook_messenger_outbox%rowtype;
  v_existing public.facebook_messenger_outbox%rowtype;
  v_recent_count integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_text is null or length(btrim(p_text)) = 0 or length(btrim(p_text)) > 2000 then raise exception 'invalid_message_text' using errcode = '22023'; end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{32,128}$' then raise exception 'invalid_idempotency_key' using errcode = '22023'; end if;
  if p_client_evidence is null or jsonb_typeof(p_client_evidence) is distinct from 'object' then raise exception 'invalid_client_evidence' using errcode = '22023'; end if;

  select * into v_settings from public.facebook_messenger_settings where id = '00000000-0000-0000-0000-000000000001'::uuid for share;
  if not found or coalesce(v_settings.enabled, false) is false or coalesce(v_settings.agent_reply_enabled, false) is false then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;

  select * into v_conv from public.facebook_messenger_conversations where id = p_thread_id and page_id = v_settings.page_id for share;
  if not found then return jsonb_build_object('ok', false, 'reason', 'thread_not_found'); end if;
  if public.facebook_messenger_conversation_is_suppressed(v_conv.metadata) then
    return jsonb_build_object('ok', false, 'reason', 'suppressed');
  end if;
  if v_conv.last_inbound_message_at is null or v_conv.reply_window_expires_at is null or v_conv.reply_window_expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'outside_window');
  end if;

  -- Serialize quota reservation for this exact thread; idempotent replay is handled before quota consumption.
  perform pg_advisory_xact_lock(hashtextextended('facebook_instinct_reply_rate:' || p_thread_id::text, 424242));

  -- ai_cannot_use_human_agent: Instinct bridge can only create RESPONSE inside the standard 24h window.
  v_payload := jsonb_build_object('text_preview', left(btrim(p_text), 2000), 'tag', 'RESPONSE', 'source', 'instinct_bridge', 'request_id', p_request_id, 'client_evidence', p_client_evidence);
  v_intent_hash := encode(digest(p_thread_id::text || chr(31) || btrim(p_text) || chr(31) || 'RESPONSE', 'sha256'), 'hex');

  select * into v_existing from public.facebook_messenger_outbox where idempotency_key = p_idempotency_key for share;
  if found then
    if v_existing.intent_hash is distinct from v_intent_hash then
      insert into public.facebook_instinct_reply_audit(request_id, conversation_id, idempotency_key, status, client_evidence)
      values (p_request_id, p_thread_id, p_idempotency_key, 'rejected', jsonb_build_object('reason', 'idempotency_conflict'));
      raise exception 'idempotency_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('ok', true, 'row', jsonb_build_object('id', v_existing.id, 'status', v_existing.status, 'idempotency_key', v_existing.idempotency_key));
  end if;

  select count(*) into v_recent_count
  from public.facebook_instinct_reply_audit
  where conversation_id = p_thread_id
    and status = 'accepted'
    and created_at > now() - interval '1 minute';
  if v_recent_count >= 10 then
    insert into public.facebook_instinct_reply_audit(request_id, conversation_id, idempotency_key, status, client_evidence)
    values (p_request_id, p_thread_id, p_idempotency_key, 'rejected', p_client_evidence || jsonb_build_object('reason', 'rate_limited'));
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  insert into public.facebook_messenger_outbox(conversation_id, page_id, psid, idempotency_key, status, payload, message_text, messenger_tag, intent_hash, scheduled_for, created_by)
  values (v_conv.id, v_conv.page_id, v_conv.psid, p_idempotency_key, 'pending', v_payload, btrim(p_text), 'RESPONSE', v_intent_hash, now(), null)
  on conflict (idempotency_key) do nothing
  returning * into v_inserted;

  if v_inserted.id is null then
    select * into v_existing from public.facebook_messenger_outbox where idempotency_key = p_idempotency_key for share;
    if not found or v_existing.intent_hash is distinct from v_intent_hash then
      insert into public.facebook_instinct_reply_audit(request_id, conversation_id, idempotency_key, status, client_evidence)
      values (p_request_id, p_thread_id, p_idempotency_key, 'rejected', jsonb_build_object('reason', 'idempotency_conflict'));
      raise exception 'idempotency_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('ok', true, 'row', jsonb_build_object('id', v_existing.id, 'status', v_existing.status, 'idempotency_key', v_existing.idempotency_key));
  end if;

  insert into public.facebook_instinct_reply_audit(request_id, conversation_id, idempotency_key, status, client_evidence, outbox_id)
  values (p_request_id, p_thread_id, p_idempotency_key, 'accepted', p_client_evidence, v_inserted.id);
  return jsonb_build_object('ok', true, 'row', jsonb_build_object('id', v_inserted.id, 'status', v_inserted.status, 'idempotency_key', v_inserted.idempotency_key));
end;
$$;
revoke all on function public.facebook_enqueue_instinct_messenger_reply(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.facebook_enqueue_instinct_messenger_reply(uuid, text, text, uuid, jsonb) to service_role;

create or replace function public.facebook_claim_messenger_email_notifications(p_limit integer default 10)
returns table(id uuid, recipient_email text, subject text, payload jsonb, email_fingerprint text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;

  update public.facebook_messenger_email_outbox eo
  set status = 'suppressed',
      last_error = 'suppressed_by_email_bridge_disabled',
      failed_at = now(),
      updated_at = now()
  from public.facebook_messenger_settings s
  where eo.status in ('pending', 'processing')
    and eo.recipient_email = 'inboxoggxdk@agent.instinct.co'
    and eo.payload->>'source' = 'facebook_messenger'
    and s.id = '00000000-0000-0000-0000-000000000001'::uuid
    and (
      coalesce(s.agent_email_forward_enabled, false) is false
      or coalesce(s.agent_email_processor_approved, false) is false
    );

  update public.facebook_messenger_email_outbox eo
  set status = 'suppressed',
      last_error = 'suppressed_by_conversation_state',
      failed_at = now(),
      updated_at = now()
  from public.facebook_messenger_conversations c
  where eo.status in ('pending', 'processing')
    and eo.recipient_email = 'inboxoggxdk@agent.instinct.co'
    and eo.payload->>'source' = 'facebook_messenger'
    and c.id = eo.conversation_id
    and (
      public.facebook_messenger_metadata_flag(c.metadata, 'deleted')
      or public.facebook_messenger_metadata_flag(c.metadata, 'opted_out')
      or public.facebook_messenger_metadata_flag(c.metadata, 'quarantined')
      or public.facebook_messenger_metadata_flag(c.metadata, 'policy_blocked')
    );

  return query
  with claimed as (
    select eo.id
    from public.facebook_messenger_email_outbox eo
    join public.facebook_messenger_conversations c on c.id = eo.conversation_id
    join public.facebook_messenger_settings s on s.id = '00000000-0000-0000-0000-000000000001'::uuid
    where eo.status = 'pending'
      and eo.scheduled_for <= now()
      and s.agent_email_forward_enabled = true
      and s.agent_email_processor_approved = true
      and eo.recipient_email = 'inboxoggxdk@agent.instinct.co'
      and eo.payload->>'source' = 'facebook_messenger'
      and public.facebook_messenger_metadata_flag(c.metadata, 'deleted') is false
      and public.facebook_messenger_metadata_flag(c.metadata, 'opted_out') is false
      and public.facebook_messenger_metadata_flag(c.metadata, 'quarantined') is false
      and public.facebook_messenger_metadata_flag(c.metadata, 'policy_blocked') is false
    order by eo.scheduled_for, eo.created_at
    limit greatest(1, least(coalesce(p_limit, 10), 25))
    for update of eo skip locked
  )
  update public.facebook_messenger_email_outbox eo
  set status = 'processing', processing_started_at = now(), attempt_count = attempt_count + 1, updated_at = now()
  from claimed
  where eo.id = claimed.id
  returning eo.id, eo.recipient_email, eo.subject,
    jsonb_build_object(
      'thread_id', eo.payload->>'thread_id',
      'notification_id', eo.payload->>'notification_id',
      'sender_display', left(coalesce(eo.payload->>'sender_display', 'Facebook sender'), 120),
      'message_preview', left(coalesce(eo.payload->>'message_preview', ''), 1000),
      'received_at', eo.payload->>'received_at',
      'source', 'facebook_messenger'
    ), eo.email_fingerprint;
end;
$$;
revoke all on function public.facebook_claim_messenger_email_notifications(integer) from public, anon, authenticated;
grant execute on function public.facebook_claim_messenger_email_notifications(integer) to service_role;

create or replace function public.facebook_commit_messenger_email_send(p_email_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.facebook_messenger_email_outbox%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;

  update public.facebook_messenger_email_outbox eo
  set status = 'send_committed', send_committed_at = now(), updated_at = now()
  from public.facebook_messenger_conversations c,
       public.facebook_messenger_settings s
  where eo.id = p_email_id
    and eo.status = 'processing'
    and eo.recipient_email = 'inboxoggxdk@agent.instinct.co'
    and eo.payload->>'source' = 'facebook_messenger'
    and c.id = eo.conversation_id
    and s.id = '00000000-0000-0000-0000-000000000001'::uuid
    and c.page_id = s.page_id
    and coalesce(s.agent_email_forward_enabled, false) = true
    and coalesce(s.agent_email_processor_approved, false) = true
    and public.facebook_messenger_conversation_is_suppressed(c.metadata) = false
  returning eo.* into v_row;

  return found;
end;
$$;
revoke all on function public.facebook_commit_messenger_email_send(uuid) from public, anon, authenticated;
grant execute on function public.facebook_commit_messenger_email_send(uuid) to service_role;

create or replace function public.facebook_mark_messenger_email_sent(p_email_id uuid, p_provider_id text, p_evidence jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.facebook_messenger_email_outbox%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_provider_id is null or length(btrim(p_provider_id)) = 0 or length(p_provider_id) > 256 then raise exception 'provider_id_required' using errcode = '22023'; end if;
  update public.facebook_messenger_email_outbox
  set status = 'sent', provider_message_id = btrim(p_provider_id), response_payload = jsonb_strip_nulls(p_evidence), sent_at = now(), updated_at = now()
  where id = p_email_id and status = 'send_committed'
  returning * into v_row;
  if not found then raise exception 'not_eligible' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end;
$$;
revoke all on function public.facebook_mark_messenger_email_sent(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.facebook_mark_messenger_email_sent(uuid, text, jsonb) to service_role;

create or replace function public.facebook_mark_messenger_email_failed(p_email_id uuid, p_safe_reason text, p_evidence jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.facebook_messenger_email_outbox%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_safe_reason is null or p_safe_reason !~ '^[a-z0-9_:-]{1,120}$' then raise exception 'unsafe_reason' using errcode = '22023'; end if;
  update public.facebook_messenger_email_outbox
  set status = 'failed', last_error = p_safe_reason, response_payload = jsonb_strip_nulls(p_evidence), failed_at = now(), updated_at = now()
  where id = p_email_id and status in ('processing', 'send_committed')
  returning * into v_row;
  if not found then raise exception 'not_eligible' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end;
$$;
revoke all on function public.facebook_mark_messenger_email_failed(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.facebook_mark_messenger_email_failed(uuid, text, jsonb) to service_role;

create or replace function public.facebook_mark_messenger_email_manual_reconciliation(p_email_id uuid, p_safe_reason text, p_evidence jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.facebook_messenger_email_outbox%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_safe_reason is null or p_safe_reason !~ '^[a-z0-9_:-]{1,120}$' then raise exception 'unsafe_reason' using errcode = '22023'; end if;
  update public.facebook_messenger_email_outbox
  set status = 'manual_reconciliation_required', last_error = p_safe_reason, response_payload = jsonb_strip_nulls(p_evidence), manual_reconciliation_required_at = now(), updated_at = now()
  where id = p_email_id and status = 'send_committed'
  returning * into v_row;
  if not found then raise exception 'not_eligible' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end;
$$;
revoke all on function public.facebook_mark_messenger_email_manual_reconciliation(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.facebook_mark_messenger_email_manual_reconciliation(uuid, text, jsonb) to service_role;

create or replace function public.facebook_ingest_messenger_webhook_event(
  p_event_fingerprint text,
  p_page_id text,
  p_psid text,
  p_event_type text,
  p_event_timestamp timestamptz,
  p_messenger_message_id text default null,
  p_direction text default null,
  p_message_text text default null,
  p_event_payload jsonb default '{}'::jsonb,
  p_delivery_message_ids text default '[]',
  p_reply_window_expires_at timestamptz default null,
  p_human_agent_window_expires_at timestamptz default null,
  p_email_forward_enabled boolean default false,
  p_email_recipient text default null,
  p_email_fingerprint text default null,
  p_email_payload jsonb default null,
  p_watermark_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_settings public.facebook_messenger_settings%rowtype;
  v_inserted_event_id uuid;
  v_conversation_id uuid;
  v_message_id uuid;
  v_delivery_mids jsonb := '[]'::jsonb;
  v_mid text;
  v_email_allowed boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  if p_event_fingerprint is null or length(btrim(p_event_fingerprint)) < 32 then
    raise exception 'invalid_event_fingerprint' using errcode = '22023';
  end if;

  if p_page_id is null or length(btrim(p_page_id)) = 0 then
    raise exception 'invalid_page_id' using errcode = '22023';
  end if;

  if p_psid is null or length(btrim(p_psid)) = 0 then
    raise exception 'invalid_psid' using errcode = '22023';
  end if;

  if p_event_type not in ('message', 'message_echo', 'message_delivery', 'message_read', 'messaging_referral', 'messaging_postback', 'messaging_policy_enforcement') then
    raise exception 'invalid_event_type' using errcode = '22023';
  end if;

  if p_direction is not null and p_direction not in ('inbound', 'outbound') then
    raise exception 'invalid_direction' using errcode = '22023';
  end if;

  if p_event_payload is null or jsonb_typeof(p_event_payload) is distinct from 'object' then
    raise exception 'invalid_event_payload' using errcode = '22023';
  end if;

  if p_email_payload is not null and jsonb_typeof(p_email_payload) is distinct from 'object' then
    raise exception 'invalid_email_payload' using errcode = '22023';
  end if;

  if length(coalesce(p_message_text, '')) > 1000 then
    raise exception 'message_text_too_large' using errcode = '22023';
  end if;

  select * into v_settings
  from public.facebook_messenger_settings
  where id = '00000000-0000-0000-0000-000000000001'::uuid
  for share;

  if not found then
    raise exception 'facebook_messenger_settings_missing' using errcode = 'P0002';
  end if;

  if p_page_id is distinct from v_settings.page_id then
    -- wrong_page_rejected
    raise exception 'wrong_page_rejected' using errcode = '42501';
  end if;

  insert into public.facebook_messenger_webhook_events (
    event_fingerprint,
    page_id,
    psid,
    event_type,
    status,
    payload,
    received_at,
    processed_at
  )
  values (
    p_event_fingerprint,
    p_page_id,
    p_psid,
    p_event_type,
    'processing',
    jsonb_strip_nulls(p_event_payload),
    now(),
    null
  )
  on conflict (event_fingerprint) do nothing
  returning event_id into v_inserted_event_id;

  if v_inserted_event_id is null then
    -- duplicate_event_idempotent
    return jsonb_build_object('status', 'duplicate', 'duplicate', true);
  end if;

  insert into public.facebook_messenger_conversations (
    page_id,
    psid,
    last_message_at,
    last_inbound_message_at,
    last_outbound_message_at,
    reply_window_expires_at,
    human_agent_window_expires_at,
    metadata
  )
  values (
    p_page_id,
    p_psid,
    case when p_event_type in ('message', 'message_echo') then p_event_timestamp else null end,
    case when p_direction = 'inbound' then p_event_timestamp else null end,
    case when p_direction = 'outbound' then p_event_timestamp else null end,
    case when p_direction = 'inbound' then p_reply_window_expires_at else null end,
    case when p_direction = 'inbound' then p_human_agent_window_expires_at else null end,
    jsonb_build_object('conversation_ref', p_event_payload->>'conversation_ref')
  )
  on conflict (page_id, psid) do update set
    last_message_at = case
      when excluded.last_message_at is not null and (
        facebook_messenger_conversations.last_message_at is null or
        excluded.last_message_at >= facebook_messenger_conversations.last_message_at
      ) then excluded.last_message_at
      else facebook_messenger_conversations.last_message_at
    end,
    last_inbound_message_at = case
      when excluded.last_inbound_message_at is not null and (
        facebook_messenger_conversations.last_inbound_message_at is null or
        excluded.last_inbound_message_at >= facebook_messenger_conversations.last_inbound_message_at
      ) then excluded.last_inbound_message_at
      else facebook_messenger_conversations.last_inbound_message_at
    end,
    last_outbound_message_at = case
      when excluded.last_outbound_message_at is not null and (
        facebook_messenger_conversations.last_outbound_message_at is null or
        excluded.last_outbound_message_at >= facebook_messenger_conversations.last_outbound_message_at
      ) then excluded.last_outbound_message_at
      else facebook_messenger_conversations.last_outbound_message_at
    end,
    reply_window_expires_at = case
      when excluded.last_inbound_message_at is not null and (
        facebook_messenger_conversations.last_inbound_message_at is null or
        excluded.last_inbound_message_at >= facebook_messenger_conversations.last_inbound_message_at
      ) then excluded.reply_window_expires_at
      else facebook_messenger_conversations.reply_window_expires_at
    end,
    human_agent_window_expires_at = case
      when excluded.last_inbound_message_at is not null and (
        facebook_messenger_conversations.last_inbound_message_at is null or
        excluded.last_inbound_message_at >= facebook_messenger_conversations.last_inbound_message_at
      ) then excluded.human_agent_window_expires_at
      else facebook_messenger_conversations.human_agent_window_expires_at
    end,
    metadata = facebook_messenger_conversations.metadata || excluded.metadata,
    updated_at = case
      when excluded.last_message_at is not null and (
        facebook_messenger_conversations.last_message_at is null or
        excluded.last_message_at >= facebook_messenger_conversations.last_message_at
      ) then now()
      else facebook_messenger_conversations.updated_at
    end
  returning id into v_conversation_id;

  if p_event_type in ('message', 'message_echo') then
    insert into public.facebook_messenger_messages (
      conversation_id,
      page_id,
      psid,
      message_id,
      direction,
      processing_status,
      fingerprint,
      message_text,
      payload,
      received_at,
      sent_at
    )
    values (
      v_conversation_id,
      p_page_id,
      p_psid,
      nullif(p_messenger_message_id, ''),
      coalesce(p_direction, 'inbound'),
      'received',
      p_event_fingerprint,
      nullif(left(coalesce(p_message_text, ''), 1000), ''),
      jsonb_strip_nulls(p_event_payload),
      case when p_direction = 'inbound' then p_event_timestamp else now() end,
      case when p_direction = 'outbound' then p_event_timestamp else null end
    )
    on conflict do nothing
    returning id into v_message_id;

    if v_message_id is null then
      select id into v_message_id
      from public.facebook_messenger_messages
      where fingerprint = p_event_fingerprint
         or (p_messenger_message_id is not null and page_id = p_page_id and message_id = p_messenger_message_id)
      limit 1;
    end if;
  end if;

  if p_event_type in ('message_delivery', 'message_read') then
    begin
      v_delivery_mids := coalesce(p_delivery_message_ids::jsonb, '[]'::jsonb);
    exception when others then
      raise exception 'invalid_delivery_message_ids' using errcode = '22023';
    end;

    if jsonb_typeof(v_delivery_mids) <> 'array' or jsonb_array_length(v_delivery_mids) > 100 then
      raise exception 'invalid_delivery_message_ids' using errcode = '22023';
    end if;

    if p_event_type = 'message_delivery' then
      for v_mid in select jsonb_array_elements_text(v_delivery_mids)
      loop
        update public.facebook_messenger_messages
        set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
              'last_delivery_at',
              p_event_timestamp
            )
        where page_id = p_page_id
          and message_id = v_mid
          and direction = 'outbound'
          and case
            when not (coalesce(payload, '{}'::jsonb) ? 'last_delivery_at') then true
            when not ((payload->>'last_delivery_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ tT][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$') then true
            else p_event_timestamp > (payload->>'last_delivery_at')::timestamptz
          end;
      end loop;
    end if;

    if p_event_type = 'message_read' then
      if p_watermark_at is null then
        raise exception 'missing_read_watermark' using errcode = '22023';
      end if;

      update public.facebook_messenger_messages
      set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
            'last_read_at',
            p_event_timestamp
          )
      where conversation_id = v_conversation_id
        and page_id = p_page_id
        and psid = p_psid
        and direction = 'outbound'
        and coalesce(sent_at, received_at) <= p_watermark_at
        and case
          when not (coalesce(payload, '{}'::jsonb) ? 'last_read_at') then true
          when not ((payload->>'last_read_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ tT][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$') then true
          else p_event_timestamp > (payload->>'last_read_at')::timestamptz
        end;
    end if;
  end if;

  v_email_allowed := p_email_forward_enabled and coalesce(v_settings.agent_email_forward_enabled, false) and coalesce(v_settings.agent_email_processor_approved, false);
  if v_email_allowed then
    if p_email_recipient is distinct from 'inboxoggxdk@agent.instinct.co' then
      raise exception 'invalid_email_recipient' using errcode = '22023';
    end if;
    if p_email_fingerprint is null or length(btrim(p_email_fingerprint)) < 32 then
      raise exception 'invalid_email_fingerprint' using errcode = '22023';
    end if;
    if p_direction is distinct from 'inbound' or v_message_id is null then
      raise exception 'invalid_email_forward_event' using errcode = '22023';
    end if;

    insert into public.facebook_messenger_email_outbox (
      conversation_id,
      message_id,
      email_fingerprint,
      status,
      recipient_email,
      subject,
      payload,
      scheduled_for
    )
    select
      v_conversation_id,
      v_message_id,
      p_email_fingerprint,
      'pending',
      'inboxoggxdk@agent.instinct.co',
      'New Facebook Messenger message',
      jsonb_strip_nulls(jsonb_build_object(
        'thread_id', v_conversation_id,
        'notification_id', p_email_fingerprint,
        'sender_display', left(coalesce(p_email_payload->>'sender_display', 'Facebook sender'), 120),
        'message_preview', left(coalesce(p_email_payload->>'message_preview', p_message_text, ''), 1000),
        'received_at', p_event_timestamp,
        'source', 'facebook_messenger'
      )),
      now()
    where not exists (
      select 1
      from public.facebook_messenger_conversations c
      where c.id = v_conversation_id
        and public.facebook_messenger_conversation_is_suppressed(c.metadata)
    )
    on conflict (message_id) where message_id is not null do nothing;
  end if;

  update public.facebook_messenger_webhook_events
  set status = 'processed',
      processed_at = now(),
      error_message = null
  where event_id = v_inserted_event_id;

  return jsonb_build_object(
    'status', 'processed',
    'duplicate', false,
    'event_id', v_inserted_event_id,
    'conversation_id', v_conversation_id,
    'message_id', v_message_id
  );
exception
  when others then
    if v_inserted_event_id is not null then
      update public.facebook_messenger_webhook_events
      set status = 'failed',
          error_message = left(sqlstate || ':' || sqlerrm, 500),
          processed_at = now()
      where event_id = v_inserted_event_id;
    end if;
    raise;
end;
$$;

revoke all on function public.facebook_ingest_messenger_webhook_event(
  text,
  text,
  text,
  text,
  timestamptz,
  text,
  text,
  text,
  jsonb,
  text,
  timestamptz,
  timestamptz,
  boolean,
  text,
  text,
  jsonb,
  timestamptz
) from public, anon, authenticated;

grant execute on function public.facebook_ingest_messenger_webhook_event(
  text,
  text,
  text,
  text,
  timestamptz,
  text,
  text,
  text,
  jsonb,
  text,
  timestamptz,
  timestamptz,
  boolean,
  text,
  text,
  jsonb,
  timestamptz
) to service_role;
