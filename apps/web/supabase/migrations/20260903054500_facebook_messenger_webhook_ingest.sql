-- Durable Facebook Messenger webhook ingest RPC.
-- Meta authentication happens in the public Edge Function; this RPC is service-role only.

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
  p_email_payload jsonb default null
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

  if p_event_type not in ('message', 'message_echo', 'message_delivery', 'message_read', 'messaging_postback', 'messaging_policy_enforcement') then
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

    for v_mid in select jsonb_array_elements_text(v_delivery_mids)
    loop
      update public.facebook_messenger_messages
      set payload = payload || jsonb_build_object(
            case when p_event_type = 'message_delivery' then 'last_delivery_at' else 'last_read_at' end,
            p_event_timestamp
          )
      where page_id = p_page_id
        and message_id = v_mid;
    end loop;
  end if;

  if p_email_forward_enabled then
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
    values (
      v_conversation_id,
      v_message_id,
      p_email_fingerprint,
      'pending',
      'inboxoggxdk@agent.instinct.co',
      'New Facebook Messenger message',
      jsonb_strip_nulls(jsonb_build_object(
        'conversation_ref', coalesce(p_email_payload->>'conversation_ref', p_event_payload->>'conversation_ref'),
        'sender_display', coalesce(p_email_payload->>'sender_display', 'Facebook sender'),
        'message_preview', left(coalesce(p_email_payload->>'message_preview', p_message_text, ''), 1000),
        'received_at', p_event_timestamp,
        'source', 'facebook_messenger'
      )),
      now()
    )
    on conflict (email_fingerprint) do nothing;
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
  jsonb
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
  jsonb
) to service_role;
