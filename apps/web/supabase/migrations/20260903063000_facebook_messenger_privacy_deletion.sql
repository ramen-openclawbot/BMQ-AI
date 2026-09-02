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
  v_existing public.facebook_data_deletion_requests%rowtype;
  v_request public.facebook_data_deletion_requests%rowtype;
  v_identity record;
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

  select * into v_existing
  from public.facebook_data_deletion_requests r
  where r.request_fingerprint = p_request_fingerprint
  for update;

  if found then
    update public.facebook_data_deletion_requests r
    set confirmation_code_hash = p_confirmation_code_hash,
        updated_at = now()
    where r.id = v_existing.id
    returning * into v_request;
  else
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
    on conflict (request_fingerprint) do update
      set confirmation_code_hash = excluded.confirmation_code_hash,
          updated_at = now()
    returning * into v_request;
  end if;

  for v_identity in
    select fpi.page_id, fpi.psid
    from public.facebook_platform_identities fpi
    where fpi.app_scoped_user_id = p_app_scoped_user_id
      and fpi.verified_at is not null
      and length(btrim(fpi.page_id)) > 0
      and length(btrim(fpi.psid)) > 0
    order by fpi.page_id, fpi.psid
  loop
    v_matched_count := v_matched_count + 1;

    update public.facebook_messenger_messages m
    set message_text = null,
        payload = jsonb_build_object('deleted_by_facebook_data_deletion', true, 'deleted_at', now(), 'request_id', v_request.id),
        processing_status = case when m.processing_status = 'received' then 'processed' else m.processing_status end
    where m.page_id = v_identity.page_id
      and m.psid = v_identity.psid;

    update public.facebook_messenger_outbox o
    set payload = jsonb_build_object('deleted_by_facebook_data_deletion', true, 'deleted_at', now(), 'request_id', v_request.id),
        response_payload = jsonb_build_object('deleted_by_facebook_data_deletion', true, 'deleted_at', now(), 'request_id', v_request.id),
        last_error = null,
        updated_at = now()
    where o.page_id = v_identity.page_id
      and o.psid = v_identity.psid;

    update public.facebook_messenger_email_outbox eo
    set payload = jsonb_build_object('deleted_by_facebook_data_deletion', true, 'deleted_at', now(), 'request_id', v_request.id),
        subject = '[Messenger data deleted]',
        updated_at = now()
    where eo.conversation_id in (
      select c.id
      from public.facebook_messenger_conversations c
      where c.page_id = v_identity.page_id
        and c.psid = v_identity.psid
    );

    update public.facebook_messenger_conversations c
    set customer_name = null,
        assigned_owner_id = null,
        metadata = jsonb_build_object('deleted_by_facebook_data_deletion', true, 'deleted_at', now(), 'request_id', v_request.id),
        updated_at = now()
    where c.page_id = v_identity.page_id
      and c.psid = v_identity.psid;

    update public.facebook_platform_identities fpi
    set raw_identity = jsonb_build_object(
          'deleted_by_facebook_data_deletion', true,
          'deleted_at', now(),
          'request_id', v_request.id
        ),
        updated_at = now()
    where fpi.page_id = v_identity.page_id
      and fpi.psid = v_identity.psid;
  end loop;

  if v_matched_count = 0 then
    update public.facebook_data_deletion_requests r
    set status = 'pending_manual_mapping',
        page_id = null,
        psid = null,
        processing_started_at = coalesce(r.processing_started_at, now()),
        completed_at = null,
        failed_at = null,
        updated_at = now(),
        notes = 'No verified deterministic facebook_platform_identities mapping exists; manual mapping is not implemented by this callback.'
    where r.id = v_request.id
    returning * into v_request;
  else
    update public.facebook_data_deletion_requests r
    set status = 'completed',
        page_id = case when v_matched_count = 1 then (
          select fpi.page_id
          from public.facebook_platform_identities fpi
          where fpi.app_scoped_user_id = p_app_scoped_user_id
            and fpi.verified_at is not null
          order by fpi.page_id, fpi.psid
          limit 1
        ) else null end,
        psid = case when v_matched_count = 1 then (
          select fpi.psid
          from public.facebook_platform_identities fpi
          where fpi.app_scoped_user_id = p_app_scoped_user_id
            and fpi.verified_at is not null
          order by fpi.page_id, fpi.psid
          limit 1
        ) else null end,
        processing_started_at = coalesce(r.processing_started_at, now()),
        completed_at = coalesce(r.completed_at, now()),
        failed_at = null,
        updated_at = now(),
        notes = 'Deterministically mapped Messenger platform data was anonymized. Confirmation code plaintext was not stored.'
    where r.id = v_request.id
    returning * into v_request;
  end if;

  return query select
    v_request.status,
    v_request.requested_at,
    v_request.completed_at,
    v_request.confirmation_code_hash,
    (v_existing.id is not null) as repeated;
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

  select count(*) into v_conversations
  from public.facebook_messenger_conversations c
  where coalesce(c.last_message_at, c.created_at) < v_cutoff;

  select count(*) into v_messages
  from public.facebook_messenger_messages m
  where m.created_at < v_cutoff;

  select count(*) into v_outbox
  from public.facebook_messenger_outbox o
  where o.created_at < v_cutoff;

  select count(*) into v_email_outbox
  from public.facebook_messenger_email_outbox eo
  where eo.created_at < v_cutoff;

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

  update public.facebook_messenger_messages m
  set message_text = null,
      payload = jsonb_build_object('deleted_by_facebook_retention', true, 'deleted_at', now())
  where m.created_at < v_cutoff;
  get diagnostics v_messages = row_count;

  update public.facebook_messenger_outbox o
  set payload = jsonb_build_object('deleted_by_facebook_retention', true, 'deleted_at', now()),
      response_payload = jsonb_build_object('deleted_by_facebook_retention', true, 'deleted_at', now()),
      last_error = null,
      updated_at = now()
  where o.created_at < v_cutoff;
  get diagnostics v_outbox = row_count;

  update public.facebook_messenger_email_outbox eo
  set payload = jsonb_build_object('deleted_by_facebook_retention', true, 'deleted_at', now()),
      subject = '[Messenger data retained/anonymized]',
      updated_at = now()
  where eo.created_at < v_cutoff;
  get diagnostics v_email_outbox = row_count;

  update public.facebook_messenger_conversations c
  set customer_name = null,
      assigned_owner_id = null,
      metadata = jsonb_build_object('deleted_by_facebook_retention', true, 'deleted_at', now()),
      updated_at = now()
  where coalesce(c.last_message_at, c.created_at) < v_cutoff;
  get diagnostics v_conversations = row_count;

  return jsonb_build_object(
    'enabled', true,
    'dry_run', false,
    'cutoff', v_cutoff,
    'anonymized_conversations', v_conversations,
    'anonymized_messages', v_messages,
    'anonymized_outbox', v_outbox,
    'anonymized_email_outbox', v_email_outbox
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
