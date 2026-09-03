-- Messenger privacy, data deletion, public status, and default-disabled retention controls.
-- This migration intentionally does not schedule retention jobs and does not store callback raw payloads.

alter table public.facebook_data_deletion_requests
  drop column if exists callback_payload;

alter table public.facebook_data_deletion_requests
  alter column confirmation_code_hash set not null;

create or replace function public.facebook_register_data_deletion_request(
  p_app_scoped_user_id text,
  p_confirmation_code_hash text,
  p_request_fingerprint text
)
returns table (
  status text,
  requested_at timestamptz,
  completed_at timestamptz,
  confirmation_code_hash text,
  repeated boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_request public.facebook_data_deletion_requests%rowtype;
  v_repeated boolean := false;
  v_matched_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  if p_app_scoped_user_id is null or p_app_scoped_user_id !~ '^[A-Za-z0-9_-]{1,128}$' then
    raise exception 'invalid_app_scoped_user_id' using errcode = '22023';
  end if;

  if p_confirmation_code_hash is null or p_confirmation_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_confirmation_code_hash' using errcode = '22023';
  end if;

  if p_request_fingerprint is null or length(btrim(p_request_fingerprint)) < 32 then
    raise exception 'invalid_request_fingerprint' using errcode = '22023';
  end if;

  insert into public.facebook_data_deletion_requests (
    app_scoped_user_id,
    confirmation_code_hash,
    request_fingerprint,
    status,
    notes
  ) values (
    p_app_scoped_user_id,
    p_confirmation_code_hash,
    p_request_fingerprint,
    'requested',
    'Registered from verified Meta signed_request; raw callback payload is not stored.'
  )
  on conflict (request_fingerprint) do nothing
  returning * into v_request;

  if v_request.id is null then
    v_repeated := true;
    select * into v_request
    from public.facebook_data_deletion_requests r
    where r.request_fingerprint = p_request_fingerprint
    for update;
  else
    select * into v_request
    from public.facebook_data_deletion_requests r
    where r.id = v_request.id
    for update;
  end if;

  if v_request.status = 'completed' then
    return query select
      v_request.status,
      v_request.requested_at,
      v_request.completed_at,
      v_request.confirmation_code_hash,
      v_repeated;
    return;
  end if;

  create temporary table if not exists pg_temp.facebook_data_deletion_exact_mappings (
    page_id text not null,
    psid text not null,
    primary key (page_id, psid)
  ) on commit drop;

  create temporary table if not exists pg_temp.facebook_data_deletion_mapped_conversation_ids (
    conversation_id uuid not null primary key
  ) on commit drop;

  create temporary table if not exists pg_temp.facebook_data_deletion_mapped_message_ids (
    message_id uuid not null primary key
  ) on commit drop;

  truncate table pg_temp.facebook_data_deletion_exact_mappings;
  truncate table pg_temp.facebook_data_deletion_mapped_conversation_ids;
  truncate table pg_temp.facebook_data_deletion_mapped_message_ids;

  insert into pg_temp.facebook_data_deletion_exact_mappings(page_id, psid)
  select fpi.page_id, fpi.psid
  from public.facebook_platform_identities fpi
  where fpi.app_scoped_user_id = p_app_scoped_user_id
    and fpi.verified_at is not null
    and length(btrim(fpi.page_id)) > 0
    and length(btrim(fpi.psid)) > 0
  for update;

  get diagnostics v_matched_count = row_count;

  if v_matched_count = 0 then
    update public.facebook_data_deletion_requests r
    set status = 'pending_manual_mapping',
        app_scoped_user_id = p_app_scoped_user_id,
        page_id = null,
        psid = null,
        processing_started_at = coalesce(r.processing_started_at, now()),
        completed_at = null,
        failed_at = null,
        updated_at = now(),
        notes = 'No verified deterministic facebook_platform_identities mapping exists; manual mapping is required before deletion can complete.'
    where r.id = v_request.id
    returning * into v_request;
  else
    insert into pg_temp.facebook_data_deletion_mapped_conversation_ids(conversation_id)
    select c.id
    from public.facebook_messenger_conversations c
    join pg_temp.facebook_data_deletion_exact_mappings m
      on m.page_id = c.page_id
     and m.psid = c.psid
    for update;

    insert into pg_temp.facebook_data_deletion_mapped_message_ids(message_id)
    select msg.id
    from public.facebook_messenger_messages msg
    join pg_temp.facebook_data_deletion_exact_mappings m
      on m.page_id = msg.page_id
     and m.psid = msg.psid
    for update;

    delete from public.facebook_messenger_email_outbox eo
    where eo.conversation_id in (select conversation_id from pg_temp.facebook_data_deletion_mapped_conversation_ids)
       or eo.message_id in (select message_id from pg_temp.facebook_data_deletion_mapped_message_ids);

    delete from public.facebook_messenger_outbox o
    using pg_temp.facebook_data_deletion_exact_mappings m
    where o.page_id = m.page_id
      and o.psid = m.psid;

    delete from public.facebook_messenger_messages msg
    using pg_temp.facebook_data_deletion_exact_mappings m
    where msg.page_id = m.page_id
      and msg.psid = m.psid;

    delete from public.facebook_messenger_webhook_events e
    using pg_temp.facebook_data_deletion_exact_mappings m
    where e.page_id = m.page_id
      and e.psid = m.psid;

    delete from public.facebook_platform_identities fpi
    using pg_temp.facebook_data_deletion_exact_mappings m
    where fpi.page_id = m.page_id
      and fpi.psid = m.psid;

    delete from public.facebook_messenger_conversations c
    using pg_temp.facebook_data_deletion_exact_mappings m
    where c.page_id = m.page_id
      and c.psid = m.psid;

    update public.facebook_data_deletion_requests r
    set app_scoped_user_id = null,
        page_id = null,
        psid = null,
        status = 'completed',
        processing_started_at = coalesce(r.processing_started_at, now()),
        completed_at = coalesce(r.completed_at, now()),
        failed_at = null,
        updated_at = now(),
        notes = 'Deterministically mapped Messenger platform data and direct identifiers were deleted. Confirmation code plaintext was not stored.'
    where r.id = v_request.id
    returning * into v_request;
  end if;

  return query select
    v_request.status,
    v_request.requested_at,
    v_request.completed_at,
    v_request.confirmation_code_hash,
    v_repeated;
end;
$$;

create or replace function public.facebook_lookup_data_deletion_status(
  p_confirmation_code_hash text
)
returns table (
  status text,
  requested_at timestamptz,
  completed_at timestamptz
)
language sql
security definer
set search_path = public, extensions
stable
as $$
  select r.status, r.requested_at, r.completed_at
  from public.facebook_data_deletion_requests r
  where r.confirmation_code_hash = p_confirmation_code_hash
    and p_confirmation_code_hash ~ '^[0-9a-f]{64}$'
  limit 1;
$$;

create or replace function public.facebook_apply_messenger_retention(
  p_enabled boolean default false,
  p_dry_run boolean default true,
  p_retention_interval interval default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_cutoff timestamptz;
  v_conversations integer := 0;
  v_messages integer := 0;
  v_outbox integer := 0;
  v_email_outbox integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  if p_enabled is not true then
    return jsonb_build_object('enabled', false, 'dry_run', true, 'reason', 'retention_disabled_pending_owner_approval');
  end if;

  if p_retention_interval is null then
    return jsonb_build_object('enabled', true, 'dry_run', true, 'reason', 'retention_duration_not_configured_pending_owner_approval');
  end if;

  if p_retention_interval <= interval '0 seconds' then
    raise exception 'invalid_retention_interval' using errcode = '22023';
  end if;

  v_cutoff := now() - p_retention_interval;

  create temporary table if not exists pg_temp.facebook_retention_candidate_conversation_ids (
    conversation_id uuid not null primary key
  ) on commit drop;

  create temporary table if not exists pg_temp.facebook_retention_candidate_message_ids (
    message_id uuid not null primary key
  ) on commit drop;

  truncate table pg_temp.facebook_retention_candidate_conversation_ids;
  truncate table pg_temp.facebook_retention_candidate_message_ids;

  insert into pg_temp.facebook_retention_candidate_conversation_ids(conversation_id)
  select c.id
  from public.facebook_messenger_conversations c
  where coalesce(c.last_message_at, c.created_at) < v_cutoff;

  insert into pg_temp.facebook_retention_candidate_message_ids(message_id)
  select msg.id
  from public.facebook_messenger_messages msg
  where msg.created_at < v_cutoff
     or msg.conversation_id in (select conversation_id from pg_temp.facebook_retention_candidate_conversation_ids);

  select count(*) into v_conversations
  from pg_temp.facebook_retention_candidate_conversation_ids;

  select count(*) into v_messages
  from pg_temp.facebook_retention_candidate_message_ids;

  select count(*) into v_outbox
  from public.facebook_messenger_outbox o
  where o.created_at < v_cutoff
     or o.conversation_id in (select conversation_id from pg_temp.facebook_retention_candidate_conversation_ids);

  select count(*) into v_email_outbox
  from public.facebook_messenger_email_outbox eo
  where eo.created_at < v_cutoff
     or eo.message_id in (select message_id from pg_temp.facebook_retention_candidate_message_ids)
     or eo.conversation_id in (select conversation_id from pg_temp.facebook_retention_candidate_conversation_ids);

  if p_dry_run is true then
    return jsonb_build_object(
      'enabled', true,
      'dry_run', true,
      'cutoff', v_cutoff,
      'candidate_conversations', v_conversations,
      'candidate_messages', v_messages,
      'candidate_outbox', v_outbox,
      'candidate_email_outbox', v_email_outbox
    );
  end if;

  delete from public.facebook_messenger_email_outbox eo
  where eo.created_at < v_cutoff
     or eo.message_id in (select message_id from pg_temp.facebook_retention_candidate_message_ids)
     or eo.conversation_id in (select conversation_id from pg_temp.facebook_retention_candidate_conversation_ids);
  get diagnostics v_email_outbox = row_count;

  delete from public.facebook_messenger_outbox o
  where o.created_at < v_cutoff
     or o.conversation_id in (select conversation_id from pg_temp.facebook_retention_candidate_conversation_ids);
  get diagnostics v_outbox = row_count;

  delete from public.facebook_messenger_messages msg
  where msg.id in (select message_id from pg_temp.facebook_retention_candidate_message_ids);
  get diagnostics v_messages = row_count;

  delete from public.facebook_messenger_conversations c
  where c.id in (select conversation_id from pg_temp.facebook_retention_candidate_conversation_ids);
  get diagnostics v_conversations = row_count;

  return jsonb_build_object(
    'enabled', true,
    'dry_run', false,
    'cutoff', v_cutoff,
    'deleted_conversations', v_conversations,
    'deleted_messages', v_messages,
    'deleted_outbox', v_outbox,
    'deleted_email_outbox', v_email_outbox
  );
end;
$$;

revoke all on function public.facebook_register_data_deletion_request(text, text, text) from public, anon, authenticated;
revoke all on function public.facebook_lookup_data_deletion_status(text) from public, anon, authenticated;
revoke all on function public.facebook_apply_messenger_retention(boolean, boolean, interval) from public, anon, authenticated;

grant execute on function public.facebook_register_data_deletion_request(text, text, text) to service_role;
grant execute on function public.facebook_lookup_data_deletion_status(text) to anon;
grant execute on function public.facebook_lookup_data_deletion_status(text) to service_role;
grant execute on function public.facebook_apply_messenger_retention(boolean, boolean, interval) to service_role;
