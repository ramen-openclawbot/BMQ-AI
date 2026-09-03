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

drop index if exists public.facebook_messenger_outbox_worker_claim_idx;
create index if not exists facebook_messenger_outbox_worker_claim_idx
  on public.facebook_messenger_outbox(status, scheduled_for, lease_expires_at, created_at)
  where status in ('pending', 'processing');
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
  v_actor uuid := p_actor_id;
  v_settings public.facebook_messenger_settings%rowtype;
  v_conv public.facebook_messenger_conversations%rowtype;
  v_payload jsonb;
  v_intent_hash text;
  v_inserted public.facebook_messenger_outbox%rowtype;
  v_existing public.facebook_messenger_outbox%rowtype;
  v_reply_window timestamptz;
  v_human_agent_window timestamptz;
  v_blocking_status text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
  if not exists (select 1 from auth.users u where u.id = v_actor) then
    raise exception 'authenticated_human_actor_required' using errcode = '42501';
  end if;
  if not public.facebook_messenger_has_permission(v_actor, 'edit') then
    -- rbac_staff_default_denied
    raise exception 'facebook_messenger_edit_required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.user_roles ur where ur.user_id = v_actor and ur.role in ('owner', 'staff')) then
    raise exception 'facebook_messenger_human_role_required' using errcode = '42501';
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

  select * into v_conv from public.facebook_messenger_conversations where id = p_conversation_id and page_id = v_settings.page_id for update;
  if not found then raise exception 'conversation_not_found' using errcode = 'P0002'; end if;

  select o.status into v_blocking_status
  from public.facebook_messenger_outbox o
  where o.conversation_id = v_conv.id
    and o.status in ('send_committed', 'manual_reconciliation_required')
  order by coalesce(o.send_committed_at, o.updated_at, o.created_at) desc, o.created_at desc, o.id desc
  limit 1;
  if v_blocking_status is not null then
    raise exception 'reconciliation_required' using errcode = 'P0001';
  end if;
  if v_conv.last_inbound_message_at is null then
    raise exception 'missing_last_user_message' using errcode = '22023';
  end if;

  v_reply_window := coalesce(v_conv.reply_window_expires_at, v_conv.last_inbound_message_at + interval '24 hours');
  v_human_agent_window := coalesce(v_conv.human_agent_window_expires_at, v_conv.last_inbound_message_at + interval '7 days');

  if p_tag = 'RESPONSE' and now() > v_reply_window then
    raise exception 'outside_standard_messaging_window' using errcode = '22023';
  end if;

  if p_tag = 'HUMAN_AGENT' then
    if coalesce(v_settings.human_agent_enabled, false) is false then
      raise exception 'human_agent_feature_disabled' using errcode = '22023';
    end if;
    if coalesce((v_conv.metadata->>'human_agent_approved')::boolean, false) is false then
      raise exception 'human_agent_not_approved' using errcode = '22023';
    end if;
    if now() > v_human_agent_window then
      raise exception 'outside_human_agent_window' using errcode = '22023';
    end if;
  end if;

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

create or replace function public.facebook_suppress_messenger_outbox_for_blocker(
  p_conversation_id uuid,
  p_current_outbox_id uuid default null,
  p_safe_reason text default 'reconciliation_required'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_suppressed integer;
begin
  if p_safe_reason is null or p_safe_reason !~ '^[a-z0-9_:-]{1,120}$' then raise exception 'unsafe_reason' using errcode = '22023'; end if;

  update public.facebook_messenger_outbox o
  set status = 'suppressed',
      last_error = p_safe_reason,
      updated_at = now()
  where o.conversation_id = p_conversation_id
    and (p_current_outbox_id is null or o.id <> p_current_outbox_id)
    and o.status in ('pending', 'processing');

  get diagnostics v_suppressed = row_count;
  return v_suppressed;
end;
$$;
revoke all on function public.facebook_suppress_messenger_outbox_for_blocker(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.facebook_suppress_messenger_outbox_for_blocker(uuid, uuid, text) to service_role;

drop function if exists public.facebook_claim_messenger_outbox(integer);
create or replace function public.facebook_claim_messenger_outbox(p_limit integer default 10)
returns table(id uuid, page_id text, psid text, text text, tag text, attempt_count integer, lease_token uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;

  -- Defensive barrier: if a conversation is already awaiting provider/manual evidence,
  -- terminally suppress pre-send backlog before scanning so workers do not reclaim it.
  update public.facebook_messenger_outbox o
  set status = 'suppressed',
      last_error = 'reconciliation_required',
      updated_at = now()
  where o.status in ('pending', 'processing')
    and exists (
      select 1
      from public.facebook_messenger_outbox blocker
      where blocker.conversation_id = o.conversation_id
        and blocker.id <> o.id
        and blocker.status in ('send_committed', 'manual_reconciliation_required')
    );

  return query
  with claimed as (
    select o.id
    from public.facebook_messenger_outbox o
    join public.facebook_messenger_settings s on s.page_id = o.page_id
    where (
        (o.status = 'pending' and o.scheduled_for <= now())
        or (o.status = 'processing' and o.lease_expires_at < now())
      )
      and s.enabled = true
      and not exists (
        select 1
        from public.facebook_messenger_outbox blocker
        where blocker.conversation_id = o.conversation_id
          and blocker.id <> o.id
          and blocker.status in ('send_committed', 'manual_reconciliation_required')
      )
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
  returning o.id, o.page_id, o.psid, o.message_text, o.messenger_tag, o.attempt_count, o.lease_token;
end;
$$;
revoke all on function public.facebook_claim_messenger_outbox(integer) from public, anon, authenticated;
grant execute on function public.facebook_claim_messenger_outbox(integer) to service_role;

drop function if exists public.facebook_mark_messenger_outbox_send_committed(uuid);
create or replace function public.facebook_mark_messenger_outbox_send_committed(p_outbox_id uuid, p_lease_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.facebook_messenger_outbox%rowtype;
  v_conversation_id uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;

  -- Validate the exact current lease without taking the outbox row lock first.
  -- The conversation row is the linearization lock; taking it before row updates
  -- avoids two workers deadlocking as row-A->conversation and row-B->conversation.
  -- Invalid/old/stale leases are no-op false and must not suppress or mutate the
  -- current owner lease.
  select * into v_row
  from public.facebook_messenger_outbox
  where id = p_outbox_id
    and status = 'processing'
    and lease_token = p_lease_token
    and lease_expires_at > now();

  if not found then
    return false;
  end if;

  select c.id into v_conversation_id
  from public.facebook_messenger_conversations c
  where c.id = v_row.conversation_id
    and c.page_id = v_row.page_id
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
      and status = 'processing'
      and lease_token = p_lease_token
      and lease_expires_at > now();

    if not found then
      return false;
    end if;

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
revoke all on function public.facebook_mark_messenger_outbox_send_committed(uuid, uuid) from public, anon, authenticated;
grant execute on function public.facebook_mark_messenger_outbox_send_committed(uuid, uuid) to service_role;

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
declare
  v_row public.facebook_messenger_outbox%rowtype;
  v_current public.facebook_messenger_outbox%rowtype;
  v_conversation_id uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_safe_reason is null or p_safe_reason !~ '^[a-z0-9_:-]{1,120}$' then raise exception 'unsafe_reason' using errcode = '22023'; end if;
  -- timeout_requires_manual_reconciliation; no blind retry from send_committed.

  select * into v_current
  from public.facebook_messenger_outbox
  where id = p_outbox_id
    and status = 'send_committed'
  for update;

  if not found then raise exception 'not_eligible' using errcode = 'P0001'; end if;

  select c.id into v_conversation_id
  from public.facebook_messenger_conversations c
  where c.id = v_current.conversation_id
    and c.page_id = v_current.page_id
    and c.psid = v_current.psid
  for update;

  update public.facebook_messenger_outbox
  set status = 'manual_reconciliation_required', last_error = p_safe_reason, response_payload = jsonb_strip_nulls(p_evidence), updated_at = now()
  where id = p_outbox_id and status = 'send_committed'
  returning * into v_row;
  if not found then raise exception 'not_eligible' using errcode = 'P0001'; end if;
  perform public.facebook_suppress_messenger_outbox_for_blocker(v_row.conversation_id, v_row.id, 'reconciliation_required');
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
             select m.message_text from public.facebook_messenger_messages m
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
      where o.conversation_id = c.id and o.status in ('send_committed', 'manual_reconciliation_required')
      order by coalesce(o.send_committed_at, o.updated_at, o.created_at) desc, o.created_at desc, o.id desc
      limit 1
    ) blocking on true
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
declare v_actor uuid := auth.uid(); v_result jsonb;
begin
  if auth.role() <> 'service_role' and (v_actor is null or not public.facebook_messenger_has_permission(v_actor, 'view')) then
    raise exception 'facebook_messenger_view_required' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'id', c.id,
    'customer_name', c.customer_name,
    'last_message_at', c.last_message_at,
    'last_message_preview', left(coalesce((
      select m.message_text from public.facebook_messenger_messages m
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
      select jsonb_agg(jsonb_build_object('id', bounded.id, 'direction', bounded.direction, 'message_text', bounded.message_text, 'created_at', bounded.created_at) order by bounded.created_at, bounded.id)
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
    where o.conversation_id = c.id and o.status in ('send_committed', 'manual_reconciliation_required')
    order by coalesce(o.send_committed_at, o.updated_at, o.created_at) desc, o.created_at desc, o.id desc
    limit 1
  ) blocking on true
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
