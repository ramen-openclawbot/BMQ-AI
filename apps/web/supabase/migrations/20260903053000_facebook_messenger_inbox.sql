-- Facebook Messenger inbox foundation.
-- Service-authoritative only: no page tokens, app secrets, credentials, or webhook secrets are persisted here.

create table if not exists public.facebook_messenger_settings (
  id uuid primary key default '00000000-0000-0000-0000-000000000001'::uuid,
  page_id text not null,
  page_name text,
  graph_version text not null default 'v26.0',
  enabled boolean not null default false,
  human_agent_enabled boolean not null default false,
  agent_email_forward_enabled boolean not null default false,
  agent_reply_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint facebook_messenger_settings_singleton_check
    check (id = '00000000-0000-0000-0000-000000000001'::uuid),
  constraint facebook_messenger_settings_page_id_unique unique (page_id),
  constraint facebook_messenger_settings_page_id_not_blank check (length(btrim(page_id)) > 0),
  constraint facebook_messenger_settings_graph_version_check check (graph_version ~ '^v[0-9]+\.[0-9]+$')
);

create table if not exists public.facebook_messenger_conversations (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  psid text not null,
  customer_name text,
  last_message_at timestamptz,
  last_inbound_message_at timestamptz,
  last_outbound_message_at timestamptz,
  reply_window_expires_at timestamptz,
  human_agent_window_expires_at timestamptz,
  assigned_owner_id uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint facebook_messenger_conversations_page_psid_unique unique (page_id, psid),
  constraint facebook_messenger_conversations_page_id_not_blank check (length(btrim(page_id)) > 0),
  constraint facebook_messenger_conversations_psid_not_blank check (length(btrim(psid)) > 0),
  constraint facebook_messenger_conversations_metadata_object_check check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.facebook_platform_identities (
  id uuid primary key default gen_random_uuid(),
  page_id text not null,
  psid text not null,
  app_scoped_user_id text,
  mapping_source text not null default 'webhook',
  verified_at timestamptz,
  raw_identity jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint facebook_platform_identities_page_psid_unique unique (page_id, psid),
  constraint facebook_platform_identities_page_id_not_blank check (length(btrim(page_id)) > 0),
  constraint facebook_platform_identities_psid_not_blank check (length(btrim(psid)) > 0),
  constraint facebook_platform_identities_mapping_source_check
    check (mapping_source in ('webhook', 'customer_profile_api', 'data_deletion_callback', 'manual_review')),
  constraint facebook_platform_identities_app_user_verified_check
    check (app_scoped_user_id is null or verified_at is not null),
  constraint facebook_platform_identities_raw_identity_object_check check (jsonb_typeof(raw_identity) = 'object')
);

create table if not exists public.facebook_messenger_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.facebook_messenger_conversations(id) on delete restrict,
  page_id text not null,
  psid text not null,
  message_id text,
  direction text not null,
  processing_status text not null default 'received',
  fingerprint text not null,
  message_text text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint facebook_messenger_messages_message_id_unique unique (page_id, message_id),
  constraint facebook_messenger_messages_fingerprint_unique unique (fingerprint),
  constraint facebook_messenger_messages_page_id_not_blank check (length(btrim(page_id)) > 0),
  constraint facebook_messenger_messages_psid_not_blank check (length(btrim(psid)) > 0),
  constraint facebook_messenger_messages_fingerprint_not_blank check (length(btrim(fingerprint)) >= 32),
  constraint facebook_messenger_messages_direction_check check (direction in ('inbound', 'outbound')),
  constraint facebook_messenger_messages_processing_status_check
    check (processing_status in ('received', 'queued', 'processed', 'failed', 'suppressed')),
  constraint facebook_messenger_messages_payload_object_check check (jsonb_typeof(payload) = 'object')
);

create table if not exists public.facebook_messenger_webhook_events (
  event_id uuid primary key default gen_random_uuid(),
  event_fingerprint text not null,
  page_id text,
  psid text,
  event_type text not null default 'message',
  status text not null default 'received',
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  constraint facebook_messenger_webhook_events_fingerprint_unique unique (event_fingerprint),
  constraint facebook_messenger_webhook_events_fingerprint_not_blank check (length(btrim(event_fingerprint)) >= 32),
  constraint facebook_messenger_webhook_events_status_check
    check (status in ('received', 'processing', 'processed', 'ignored', 'failed')),
  constraint facebook_messenger_webhook_events_payload_object_check check (jsonb_typeof(payload) = 'object')
);

create table if not exists public.facebook_messenger_outbox (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.facebook_messenger_conversations(id) on delete restrict,
  page_id text not null,
  psid text not null,
  idempotency_key text not null,
  status text not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  platform_message_id text,
  attempt_count integer not null default 0,
  scheduled_for timestamptz not null default now(),
  processing_started_at timestamptz,
  send_committed_at timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  last_error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint facebook_messenger_outbox_idempotency_key_unique unique (idempotency_key),
  constraint facebook_messenger_outbox_page_id_not_blank check (length(btrim(page_id)) > 0),
  constraint facebook_messenger_outbox_psid_not_blank check (length(btrim(psid)) > 0),
  constraint facebook_messenger_outbox_idempotency_key_not_blank check (length(btrim(idempotency_key)) >= 32),
  constraint facebook_messenger_outbox_attempt_count_check check (attempt_count >= 0 and attempt_count <= 25),
  constraint facebook_messenger_outbox_status_check
    check (status in ('pending', 'processing', 'send_committed', 'sent', 'failed', 'manual_reconciliation_required', 'suppressed')),
  constraint facebook_messenger_outbox_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint facebook_messenger_outbox_response_payload_object_check check (jsonb_typeof(response_payload) = 'object')
);

create table if not exists public.facebook_messenger_email_outbox (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.facebook_messenger_conversations(id) on delete restrict,
  message_id uuid references public.facebook_messenger_messages(id) on delete restrict,
  email_fingerprint text not null,
  status text not null default 'pending',
  recipient_email text not null,
  subject text not null,
  payload jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  scheduled_for timestamptz not null default now(),
  sent_at timestamptz,
  failed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint facebook_messenger_email_outbox_fingerprint_unique unique (email_fingerprint),
  constraint facebook_messenger_email_outbox_fingerprint_not_blank check (length(btrim(email_fingerprint)) >= 32),
  constraint facebook_messenger_email_outbox_recipient_check check (recipient_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint facebook_messenger_email_outbox_attempt_count_check check (attempt_count >= 0 and attempt_count <= 25),
  constraint facebook_messenger_email_outbox_status_check
    check (status in ('pending', 'processing', 'sent', 'failed', 'suppressed')),
  constraint facebook_messenger_email_outbox_payload_object_check check (jsonb_typeof(payload) = 'object')
);

create table if not exists public.facebook_data_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  page_id text,
  psid text,
  app_scoped_user_id text,
  confirmation_code_hash text not null,
  request_fingerprint text not null,
  status text not null default 'requested',
  requested_at timestamptz not null default now(),
  processing_started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  callback_payload jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint facebook_data_deletion_requests_confirmation_code_hash_unique unique (confirmation_code_hash),
  constraint facebook_data_deletion_requests_fingerprint_unique unique (request_fingerprint),
  constraint facebook_data_deletion_requests_confirmation_code_hash_check
    check (confirmation_code_hash ~ '^[0-9a-f]{64}$'),
  constraint facebook_data_deletion_requests_fingerprint_not_blank check (length(btrim(request_fingerprint)) >= 32),
  constraint facebook_data_deletion_requests_status_check
    check (status in ('requested', 'processing', 'pending_manual_mapping', 'completed', 'failed')),
  constraint facebook_data_deletion_requests_callback_payload_object_check check (jsonb_typeof(callback_payload) = 'object')
);

create index if not exists facebook_messenger_conversations_last_message_idx
  on public.facebook_messenger_conversations(last_message_at desc);
create index if not exists facebook_platform_identities_app_scoped_user_idx
  on public.facebook_platform_identities(app_scoped_user_id)
  where app_scoped_user_id is not null;
create index if not exists facebook_messenger_messages_conversation_created_idx
  on public.facebook_messenger_messages(conversation_id, created_at desc);
create index if not exists facebook_messenger_messages_page_psid_created_idx
  on public.facebook_messenger_messages(page_id, psid, created_at desc);
create index if not exists facebook_messenger_webhook_events_status_idx
  on public.facebook_messenger_webhook_events(status, received_at)
  where status in ('received', 'processing');
create index if not exists facebook_messenger_outbox_pending_idx
  on public.facebook_messenger_outbox(status, scheduled_for, created_at)
  where status = 'pending';
create unique index if not exists facebook_messenger_outbox_platform_message_id_unique
  on public.facebook_messenger_outbox(page_id, platform_message_id)
  where platform_message_id is not null;
create index if not exists facebook_messenger_email_outbox_pending_idx
  on public.facebook_messenger_email_outbox(status, scheduled_for, created_at)
  where status in ('pending', 'processing');
create index if not exists facebook_data_deletion_requests_status_idx
  on public.facebook_data_deletion_requests(status, requested_at)
  where status in ('requested', 'processing', 'pending_manual_mapping');

alter table public.facebook_messenger_settings enable row level security;
alter table public.facebook_messenger_conversations enable row level security;
alter table public.facebook_platform_identities enable row level security;
alter table public.facebook_messenger_messages enable row level security;
alter table public.facebook_messenger_webhook_events enable row level security;
alter table public.facebook_messenger_outbox enable row level security;
alter table public.facebook_messenger_email_outbox enable row level security;
alter table public.facebook_data_deletion_requests enable row level security;

revoke all on table public.facebook_messenger_settings from public, anon, authenticated;
revoke all on table public.facebook_messenger_conversations from public, anon, authenticated;
revoke all on table public.facebook_platform_identities from public, anon, authenticated;
revoke all on table public.facebook_messenger_messages from public, anon, authenticated;
revoke all on table public.facebook_messenger_webhook_events from public, anon, authenticated;
revoke all on table public.facebook_messenger_outbox from public, anon, authenticated;
revoke all on table public.facebook_messenger_email_outbox from public, anon, authenticated;
revoke all on table public.facebook_data_deletion_requests from public, anon, authenticated;

grant select, insert, update, delete on table public.facebook_messenger_settings to service_role;
grant select, insert, update, delete on table public.facebook_messenger_conversations to service_role;
grant select, insert, update, delete on table public.facebook_platform_identities to service_role;
grant select, insert, update, delete on table public.facebook_messenger_messages to service_role;
grant select, insert, update, delete on table public.facebook_messenger_webhook_events to service_role;
grant select, insert, update, delete on table public.facebook_messenger_outbox to service_role;
grant select, insert, update, delete on table public.facebook_messenger_email_outbox to service_role;
grant select, insert, update, delete on table public.facebook_data_deletion_requests to service_role;

insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
select ur.user_id,
       'facebook_messenger' as module_key,
       false as can_view,
       false as can_edit
from public.user_roles ur
join auth.users au on au.id = ur.user_id
where ur.role <> 'owner'
on conflict (user_id, module_key) do nothing;
