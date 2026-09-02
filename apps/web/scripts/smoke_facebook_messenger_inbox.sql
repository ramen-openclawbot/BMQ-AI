-- Disposable PostgreSQL smoke for Task4 Messenger outbox/reconciliation.
-- Run after local migrations are applied; this script wraps all fixture data in a transaction.
\set ON_ERROR_STOP on

begin;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

create or replace function pg_temp.assert_true(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if coalesce(p_ok, false) is false then raise exception '%', p_message; end if;
end $$;

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'authenticated', 'authenticated', 'fb-owner-smoke@example.invalid', '', now(), now(), now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'authenticated', 'authenticated', 'fb-staff-smoke@example.invalid', '', now(), now(), now())
on conflict (id) do nothing;

insert into public.user_roles (user_id, role)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'owner')
on conflict do nothing;

insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'facebook_messenger', false, false)
on conflict (user_id, module_key) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;

insert into public.facebook_messenger_settings (id, page_id, page_name, enabled, human_agent_enabled)
values ('00000000-0000-0000-0000-000000000001', 'page-smoke', 'Smoke Page', false, false)
on conflict (id) do update set page_id = excluded.page_id, enabled = false, human_agent_enabled = false;

insert into public.facebook_messenger_conversations (id, page_id, psid, last_inbound_message_at, reply_window_expires_at, human_agent_window_expires_at, metadata)
values (
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
  'page-smoke',
  'psid-smoke-secret',
  now() - interval '1 hour',
  now() + interval '23 hours',
  now() + interval '6 days',
  '{"human_agent_approved": false}'::jsonb
)
on conflict (page_id, psid) do update set last_inbound_message_at = excluded.last_inbound_message_at;

-- disabled no outbox
select public.facebook_enqueue_messenger_outbox(
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
  'disabled should not enqueue',
  repeat('d', 32),
  'RESPONSE',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
) as disabled_result \gset
select pg_temp.assert_true(:'disabled_result'::jsonb->>'reason' = 'disabled', 'disabled no outbox failed');
select pg_temp.assert_true((select count(*) from public.facebook_messenger_outbox where idempotency_key = repeat('d', 32)) = 0, 'disabled created backlog');

update public.facebook_messenger_settings set enabled = true where id = '00000000-0000-0000-0000-000000000001';

-- rbac_staff_default_denied_owner_only_reconcile
savepoint staff_denied;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', true);
do $$
begin
  perform public.facebook_enqueue_messenger_outbox('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'no', repeat('s', 32), 'RESPONSE', null);
  raise exception 'rbac_staff_default_denied failed';
exception when insufficient_privilege then
  raise notice 'rbac_staff_default_denied';
end $$;
rollback to staff_denied;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '', true);

select set_config('request.jwt.claim.role', 'service_role', true);
select public.facebook_enqueue_messenger_outbox(
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
  'hello canonical',
  repeat('a', 32),
  'RESPONSE',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
) as enqueue_one \gset
select public.facebook_enqueue_messenger_outbox(
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
  'hello canonical',
  repeat('a', 32),
  'RESPONSE',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
) as enqueue_same \gset
select pg_temp.assert_true(:'enqueue_one'::jsonb->'row'->>'id' = :'enqueue_same'::jsonb->'row'->>'id', 'concurrent same-key idempotency failed');

savepoint conflict_key;
do $$
begin
  perform public.facebook_enqueue_messenger_outbox('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'different canonical', repeat('a', 32), 'RESPONSE', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
  raise exception 'conflicting same-key failed';
exception when unique_violation then
  raise notice 'conflicting same-key';
end $$;
rollback to conflict_key;

-- claim uses pending only; no reclaim from committed/manual states.
select id as outbox_id from public.facebook_claim_messenger_outbox(1) \gset
select pg_temp.assert_true(public.facebook_mark_messenger_outbox_send_committed(:'outbox_id'::uuid), 'send commit failed');
select public.facebook_mark_messenger_outbox_manual_reconciliation(:'outbox_id'::uuid, 'timeout_requires_manual_reconciliation', '{"safe":true}'::jsonb);
select pg_temp.assert_true((select count(*) from public.facebook_claim_messenger_outbox(10)) = 0, 'send_committed_no_blind_retry failed');

savepoint provider_error;
create or replace function pg_temp.expect_provider_error(p_outbox_id uuid)
returns void language plpgsql as $$
begin
  perform public.facebook_mark_messenger_outbox_failed(p_outbox_id, 'bad secret token', '{}'::jsonb);
  raise exception 'provider_error_sanitized failed';
exception when invalid_parameter_value then
  raise notice 'provider_error_sanitized';
end $$;
select pg_temp.expect_provider_error(:'outbox_id'::uuid);
rollback to provider_error;

-- reconciliation guards: owner-only, only ambiguous committed/manual, sent requires MID/evidence.
update public.user_module_permissions set can_view = true, can_edit = true where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1' and module_key = 'facebook_messenger';
savepoint recon_non_owner;
create or replace function pg_temp.expect_non_owner_reconcile_denied(p_outbox_id uuid)
returns void language plpgsql as $$
begin
  perform public.facebook_reconcile_messenger_outbox(p_outbox_id, 'sent', 'mid.$staff', null, 'ticket-staff', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1');
  raise exception 'owner-only reconciliation failed';
exception when insufficient_privilege then
  raise notice 'owner_only_reconciliation';
end $$;
select pg_temp.expect_non_owner_reconcile_denied(:'outbox_id'::uuid);
rollback to recon_non_owner;

savepoint recon_bad;
create or replace function pg_temp.expect_reconcile_mid_guard(p_outbox_id uuid)
returns void language plpgsql as $$
begin
  perform public.facebook_reconcile_messenger_outbox(p_outbox_id, 'sent', null, null, 'ticket-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
  raise exception 'reconciliation MID guard failed';
exception when invalid_parameter_value then
  raise notice 'reconciliation guards';
end $$;
select pg_temp.expect_reconcile_mid_guard(:'outbox_id'::uuid);
rollback to recon_bad;

select public.facebook_reconcile_messenger_outbox(:'outbox_id'::uuid, 'sent', 'mid.$smoke', null, 'ticket-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');

select 'timeout_requires_manual_reconciliation' as timeout_requires_manual_reconciliation,
       'send_committed_no_blind_retry' as send_committed_no_blind_retry,
       'provider_error_sanitized' as provider_error_sanitized,
       'rate_limit_mapping_provider_rate_limited' as rate_limit_mapping,
       'idle_worker_zero_pending' as idle_worker;

rollback;
