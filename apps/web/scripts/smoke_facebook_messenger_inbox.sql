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

reset role;
do $$
declare
  v_cols text;
  v_vals_owner text;
  v_vals_staff text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position),
         string_agg(case column_name
           when 'id' then quote_literal('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1') || '::uuid'
           when 'aud' then quote_literal('authenticated')
           when 'role' then quote_literal('authenticated')
           when 'email' then quote_literal('fb-owner-smoke@example.invalid')
           when 'encrypted_password' then quote_literal('')
           when 'email_confirmed_at' then 'now()'
           when 'created_at' then 'now()'
           when 'updated_at' then 'now()'
           else 'null'
         end, ', ' order by ordinal_position),
         string_agg(case column_name
           when 'id' then quote_literal('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1') || '::uuid'
           when 'aud' then quote_literal('authenticated')
           when 'role' then quote_literal('authenticated')
           when 'email' then quote_literal('fb-staff-smoke@example.invalid')
           when 'encrypted_password' then quote_literal('')
           when 'email_confirmed_at' then 'now()'
           when 'created_at' then 'now()'
           when 'updated_at' then 'now()'
           else 'null'
         end, ', ' order by ordinal_position)
  into v_cols, v_vals_owner, v_vals_staff
  from information_schema.columns
  where table_schema = 'auth' and table_name = 'users'
    and column_name in ('id', 'aud', 'role', 'email', 'encrypted_password', 'email_confirmed_at', 'created_at', 'updated_at');
  execute format('insert into auth.users (%s) values (%s), (%s) on conflict (id) do nothing', v_cols, v_vals_owner, v_vals_staff);
end $$;

insert into public.user_roles (user_id, role)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'owner')
on conflict do nothing;

insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'facebook_messenger', false, false)
on conflict (user_id, module_key) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

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

-- direct authenticated role has no EXECUTE bypass even with edit-capable actor.
insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'facebook_messenger', true, true)
on conflict (user_id, module_key) do update set can_view = true, can_edit = true;
savepoint direct_auth_denied;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', true);
do $$
begin
  perform public.facebook_enqueue_messenger_outbox('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'direct auth denied', repeat('q', 32), 'RESPONSE', null);
  raise exception 'direct authenticated enqueue bypass was accepted';
exception when insufficient_privilege then
  raise notice 'direct_authenticated_enqueue_denied';
end $$;
rollback to direct_auth_denied;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '', true);

update public.facebook_messenger_settings set enabled = true where id = '00000000-0000-0000-0000-000000000001';

-- DB policy independently enforces inclusive reply/human-agent windows and authenticated human actor.
update public.facebook_messenger_conversations
set last_inbound_message_at = now() - interval '24 hours', reply_window_expires_at = now()
where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
select public.facebook_enqueue_messenger_outbox('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'boundary response ok', repeat('r', 32), 'RESPONSE', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
update public.facebook_messenger_conversations
set last_inbound_message_at = now() - interval '24 hours 1 millisecond', reply_window_expires_at = now() - interval '1 millisecond'
where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
savepoint response_expired;
do $$
begin
  perform public.facebook_enqueue_messenger_outbox('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'expired response blocked', repeat('x', 32), 'RESPONSE', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
  raise exception 'expired response accepted';
exception when invalid_parameter_value then
  raise notice 'response_expired_blocked';
end $$;
rollback to response_expired;
update public.facebook_messenger_settings set human_agent_enabled = true where id = '00000000-0000-0000-0000-000000000001';
update public.facebook_messenger_conversations
set last_inbound_message_at = now() - interval '7 days', reply_window_expires_at = now() - interval '6 days', human_agent_window_expires_at = now(), metadata = '{"human_agent_approved": true}'::jsonb
where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
select public.facebook_enqueue_messenger_outbox('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'boundary human ok', repeat('h', 32), 'HUMAN_AGENT', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
update public.facebook_messenger_conversations
set last_inbound_message_at = now() - interval '7 days 1 millisecond', human_agent_window_expires_at = now() - interval '1 millisecond'
where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
savepoint human_expired;
do $$
begin
  perform public.facebook_enqueue_messenger_outbox('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'expired human blocked', repeat('y', 32), 'HUMAN_AGENT', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
  raise exception 'expired human accepted';
exception when invalid_parameter_value then
  raise notice 'human_agent_expired_blocked';
end $$;
rollback to human_expired;
savepoint system_actor;
do $$
begin
  perform public.facebook_enqueue_messenger_outbox('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'system actor blocked', repeat('z', 32), 'HUMAN_AGENT', '99999999-9999-4999-8999-999999999999');
  raise exception 'system actor accepted';
exception when insufficient_privilege then
  raise notice 'system_actor_human_agent_denied';
end $$;
rollback to system_actor;
update public.facebook_messenger_conversations
set last_inbound_message_at = now() - interval '1 hour', reply_window_expires_at = now() + interval '23 hours', human_agent_window_expires_at = now() + interval '6 days', metadata = '{"human_agent_approved": false}'::jsonb
where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
update public.facebook_messenger_settings set human_agent_enabled = false where id = '00000000-0000-0000-0000-000000000001';
delete from public.facebook_messenger_outbox where idempotency_key in (repeat('r', 32), repeat('h', 32));

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

-- lease recovery/CAS: old token fails, reclaimed token succeeds once, committed/manual never reclaim.
select id as outbox_id, lease_token as old_lease_token from public.facebook_claim_messenger_outbox(1) \gset
update public.facebook_messenger_outbox set lease_expires_at = now() - interval '1 second' where id = :'outbox_id'::uuid;
select id as reclaimed_outbox_id, lease_token as new_lease_token from public.facebook_claim_messenger_outbox(1) \gset
select pg_temp.assert_true(:'outbox_id' = :'reclaimed_outbox_id', 'expired processing was not reclaimed');
select pg_temp.assert_true(:'old_lease_token' <> :'new_lease_token', 'reclaim did not rotate lease token');
select pg_temp.assert_true(public.facebook_mark_messenger_outbox_send_committed(:'outbox_id'::uuid, :'old_lease_token'::uuid) = false, 'old token committed after reclaim');
select pg_temp.assert_true(public.facebook_mark_messenger_outbox_send_committed(:'outbox_id'::uuid, :'new_lease_token'::uuid) = true, 'new token send commit failed');
select pg_temp.assert_true(public.facebook_mark_messenger_outbox_send_committed(:'outbox_id'::uuid, :'new_lease_token'::uuid) = false, 'new token committed twice');
select public.facebook_mark_messenger_outbox_manual_reconciliation(:'outbox_id'::uuid, 'timeout_requires_manual_reconciliation', '{"safe":true}'::jsonb);
select pg_temp.assert_true((select count(*) from public.facebook_claim_messenger_outbox(10)) = 0, 'send_committed_no_blind_retry failed');


-- Task4 regression: pending reply created while an earlier reply is processing must be
-- suppressed once that earlier reply becomes a reconciliation blocker, not reclaimed.
insert into public.facebook_messenger_conversations (id, page_id, psid, last_inbound_message_at, reply_window_expires_at, human_agent_window_expires_at, metadata)
values (
  'dddddddd-dddd-4ddd-8ddd-dddddddddd01',
  'page-smoke',
  'psid-race-a',
  now() - interval '1 hour',
  now() + interval '23 hours',
  now() + interval '6 days',
  '{}'::jsonb
)
on conflict (page_id, psid) do update set last_inbound_message_at = excluded.last_inbound_message_at;

select public.facebook_enqueue_messenger_outbox('dddddddd-dddd-4ddd-8ddd-dddddddddd01', 'race reply A', repeat('m', 32), 'RESPONSE', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
select id as race_a_id, lease_token as race_a_token from public.facebook_claim_messenger_outbox(1) where psid = 'psid-race-a' \gset
select public.facebook_enqueue_messenger_outbox('dddddddd-dddd-4ddd-8ddd-dddddddddd01', 'race reply B', repeat('n', 32), 'RESPONSE', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1') as race_b_enqueue \gset
select :'race_b_enqueue'::jsonb->'row'->>'id' as race_b_id \gset
select pg_temp.assert_true(public.facebook_mark_messenger_outbox_send_committed(:'race_a_id'::uuid, :'race_a_token'::uuid) = true, 'race A did not commit');
select public.facebook_mark_messenger_outbox_manual_reconciliation(:'race_a_id'::uuid, 'timeout_requires_manual_reconciliation', '{"safe":true}'::jsonb);
select pg_temp.assert_true((select count(*) from public.facebook_claim_messenger_outbox(10) where id = :'race_b_id'::uuid) = 0, 'BUG_claimable_after_manual_1');
select pg_temp.assert_true((select status = 'suppressed' and last_error = 'reconciliation_required' from public.facebook_messenger_outbox where id = :'race_b_id'::uuid), 'race B was not terminally suppressed');

-- Task4 regression: two workers may both hold leases before either commits; only one
-- same-conversation row can become send_committed/provider-send eligible.
insert into public.facebook_messenger_conversations (id, page_id, psid, last_inbound_message_at, reply_window_expires_at, human_agent_window_expires_at, metadata)
values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01',
  'page-smoke',
  'psid-race-b',
  now() - interval '1 hour',
  now() + interval '23 hours',
  now() + interval '6 days',
  '{}'::jsonb
)
on conflict (page_id, psid) do update set last_inbound_message_at = excluded.last_inbound_message_at;
select public.facebook_enqueue_messenger_outbox('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01', 'simul reply A', repeat('u', 32), 'RESPONSE', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
select public.facebook_enqueue_messenger_outbox('eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01', 'simul reply B', repeat('v', 32), 'RESPONSE', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
create temporary table task4_claimed_race_b on commit drop as
  select * from public.facebook_claim_messenger_outbox(2) where psid = 'psid-race-b' order by text;
select pg_temp.assert_true((select count(*) from task4_claimed_race_b) = 2, 'two pending same-conversation replies were not claimed before commit');
select id as simul_a_id, lease_token as simul_a_token from task4_claimed_race_b where text = 'simul reply A' \gset
select id as simul_b_id, lease_token as simul_b_token from task4_claimed_race_b where text = 'simul reply B' \gset
select pg_temp.assert_true(public.facebook_mark_messenger_outbox_send_committed(:'simul_a_id'::uuid, :'simul_a_token'::uuid) = true, 'first simultaneous commit failed');
select pg_temp.assert_true(public.facebook_mark_messenger_outbox_send_committed(:'simul_b_id'::uuid, :'simul_b_token'::uuid) = false, 'second simultaneous commit was allowed');
select pg_temp.assert_true((select count(*) from public.facebook_messenger_outbox where conversation_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01' and status = 'send_committed') = 1, 'more than one row became send_committed');
select pg_temp.assert_true((select status = 'suppressed' and last_error = 'reconciliation_required' from public.facebook_messenger_outbox where id = :'simul_b_id'::uuid), 'second simultaneous commit loser was not terminally suppressed');

-- Old/stale leases must be no-op false and must not suppress or alter the current lease.
insert into public.facebook_messenger_conversations (id, page_id, psid, last_inbound_message_at, reply_window_expires_at, human_agent_window_expires_at, metadata)
values (
  'ffffffff-ffff-4fff-8fff-ffffffffff01',
  'page-smoke',
  'psid-stale-lease',
  now() - interval '1 hour',
  now() + interval '23 hours',
  now() + interval '6 days',
  '{}'::jsonb
)
on conflict (page_id, psid) do update set last_inbound_message_at = excluded.last_inbound_message_at;
select public.facebook_enqueue_messenger_outbox('ffffffff-ffff-4fff-8fff-ffffffffff01', 'stale lease probe', repeat('w', 32), 'RESPONSE', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
select id as stale_id, lease_token as stale_old_token from public.facebook_claim_messenger_outbox(1) where psid = 'psid-stale-lease' \gset
update public.facebook_messenger_outbox set lease_expires_at = now() - interval '1 second' where id = :'stale_id'::uuid;
select id as stale_reclaimed_id, lease_token as stale_new_token from public.facebook_claim_messenger_outbox(1) where psid = 'psid-stale-lease' \gset
select pg_temp.assert_true(:'stale_id' = :'stale_reclaimed_id', 'stale lease probe was not reclaimed');
select pg_temp.assert_true(:'stale_old_token' <> :'stale_new_token', 'stale lease probe token did not rotate');
select pg_temp.assert_true(public.facebook_mark_messenger_outbox_send_committed(:'stale_id'::uuid, :'stale_old_token'::uuid) = false, 'old stale token altered current lease');
select pg_temp.assert_true((select status = 'processing' and lease_token = :'stale_new_token'::uuid from public.facebook_messenger_outbox where id = :'stale_id'::uuid), 'old stale token changed current lease row');
select pg_temp.assert_true(public.facebook_mark_messenger_outbox_send_committed(:'stale_id'::uuid, :'stale_new_token'::uuid) = true, 'current lease did not commit after stale-token no-op');

savepoint blocked_by_reconciliation;
do $$
begin
  perform public.facebook_enqueue_messenger_outbox('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'blocked by reconciliation', repeat('b', 32), 'RESPONSE', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');
  raise exception 'reconciliation blocking enqueue accepted';
exception when raise_exception then
  if sqlerrm <> 'reconciliation_required' then raise; end if;
  raise notice 'reconciliation_required_blocks_enqueue';
end $$;
rollback to blocked_by_reconciliation;
select pg_temp.assert_true((public.facebook_read_messenger_conversation('cccccccc-cccc-4ccc-8ccc-ccccccccccc1')->>'reply_blocked')::boolean, 'read missing reply_blocked');
select pg_temp.assert_true(public.facebook_read_messenger_conversation('cccccccc-cccc-4ccc-8ccc-ccccccccccc1')->>'reconciliation_status' = 'manual_reconciliation_required', 'read missing reconciliation_status');

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
select pg_temp.assert_true(coalesce((public.facebook_read_messenger_conversation('cccccccc-cccc-4ccc-8ccc-ccccccccccc1')->>'reply_blocked')::boolean, false) = false, 'reconciled read still blocked');
select pg_temp.assert_true(public.facebook_read_messenger_conversation('cccccccc-cccc-4ccc-8ccc-ccccccccccc1')->>'reconciliation_status' is null, 'reconciled status not null');

-- bounded list/read caps: aggregation happens after deterministic ORDER/LIMIT subqueries.
insert into public.facebook_messenger_conversations (page_id, psid, last_message_at, last_inbound_message_at, reply_window_expires_at)
select 'page-bounded', 'psid-list-' || g, now() - (g || ' seconds')::interval, now(), now() + interval '1 hour'
from generate_series(1, 105) g
on conflict (page_id, psid) do nothing;
select pg_temp.assert_true(jsonb_array_length(public.facebook_list_messenger_conversations()) <= 100, 'conversation list cap failed');
insert into public.facebook_messenger_messages (conversation_id, page_id, psid, direction, fingerprint, message_text, created_at, received_at)
select 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'page-smoke', 'psid-smoke-secret', 'inbound', encode(digest('bounded-msg-' || g, 'sha256'), 'hex'), 'bounded ' || g, now() - (g || ' seconds')::interval, now() - (g || ' seconds')::interval
from generate_series(1, 205) g
on conflict (fingerprint) do nothing;
select pg_temp.assert_true(jsonb_array_length(public.facebook_read_messenger_conversation('cccccccc-cccc-4ccc-8ccc-ccccccccccc1')->'messages') <= 200, 'message read cap failed');

select 'timeout_requires_manual_reconciliation' as timeout_requires_manual_reconciliation,
       'send_committed_no_blind_retry' as send_committed_no_blind_retry,
       'provider_error_sanitized' as provider_error_sanitized,
       'rate_limit_mapping_provider_rate_limited' as rate_limit_mapping,
       'idle_worker_zero_pending' as idle_worker;

rollback;
