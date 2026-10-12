-- Rollback-only production smoke CHECKS for migration
-- 20261030110000_payment_submission_reminders.sql.
--
-- Run as one file: `begin; <migration>; <this file>` (the caller wraps the
-- migration and these checks in a transaction). This file contains CHECKS ONLY
-- and never copies the migration. The final RAISE ends the transaction, so every
-- fixture created here is rolled back. It assumes production has exactly 1 owner.
--
-- The reminder decision is time-based; the enqueue function accepts a test-only
-- p_force_hours flag so these checks bypass the Vietnam quiet-hour skip
-- deterministically. `now()` is constant inside one transaction, so the two
-- consecutive runs prove the 6-hour idempotency.
do $$
declare
  v_owner uuid;
  v_pr uuid := gen_random_uuid();
  v_pr2 uuid := gen_random_uuid();
  v_sub uuid := gen_random_uuid();
  v_sub2 uuid := gen_random_uuid();
  v_reminder_id uuid;
  v_result jsonb;
  v_count integer;
  v_body text;
  v_ok boolean;
  v_job_schedule text;
  v_log text := '';
begin
  -- -------------------------------------------------------------------------
  -- 1. Schema / grants / RLS / constraints / signatures.
  -- -------------------------------------------------------------------------
  if not exists (
    select 1 from pg_class
    where oid = 'public.payment_submission_reminders'::regclass and relrowsecurity
  ) then
    raise exception 'CHECK FAIL: RLS off or missing payment_submission_reminders';
  end if;

  if not has_table_privilege('authenticated', 'public.payment_submission_reminders', 'select')
     or has_table_privilege('authenticated', 'public.payment_submission_reminders', 'insert')
     or has_table_privilege('authenticated', 'public.payment_submission_reminders', 'update')
     or has_table_privilege('authenticated', 'public.payment_submission_reminders', 'delete') then
    raise exception 'CHECK FAIL: payment_submission_reminders grants are not select-only for authenticated';
  end if;
  if has_table_privilege('anon', 'public.payment_submission_reminders', 'select') then
    raise exception 'CHECK FAIL: anon can read payment_submission_reminders';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'payment_submission_reminders'
      and cmd = 'SELECT'
      and qual like '%payment_requests%'
  ) then
    raise exception 'CHECK FAIL: payment_submission_reminders select policy is not the payment_requests view rule';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_submission_reminders'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) like '%(submission_id, round)%'
  ) then
    raise exception 'CHECK FAIL: payment_submission_reminders unique(submission_id, round) missing';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_submission_reminders'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%round%1%8%'
  ) then
    raise exception 'CHECK FAIL: payment_submission_reminders round 1..8 check missing';
  end if;

  if to_regprocedure('public.build_finance_zalo_payment_submission_reminder_message(uuid)') is null then
    raise exception 'CHECK FAIL: build_finance_zalo_payment_submission_reminder_message(uuid) missing';
  end if;
  if to_regprocedure('public.enqueue_payment_submission_reminders(boolean)') is null then
    raise exception 'CHECK FAIL: enqueue_payment_submission_reminders(boolean) missing';
  end if;
  if has_function_privilege('authenticated', 'public.enqueue_payment_submission_reminders(boolean)', 'execute')
     or has_function_privilege('anon', 'public.enqueue_payment_submission_reminders(boolean)', 'execute') then
    raise exception 'CHECK FAIL: the enqueue function is executable by a client role';
  end if;
  if has_function_privilege('authenticated', 'public.build_finance_zalo_payment_submission_reminder_message(uuid)', 'execute') then
    raise exception 'CHECK FAIL: the reminder message builder is executable by authenticated';
  end if;

  select schedule into v_job_schedule
  from cron.job
  where jobname = 'payment-submission-reminders-hourly';
  if v_job_schedule is distinct from '5 * * * *' then
    raise exception 'CHECK FAIL: payment-submission-reminders-hourly schedule = %', v_job_schedule;
  end if;

  -- The event check accepts the new event and still accepts the created event.
  begin
    insert into public.finance_zalo_notifications (event_type, entity_id, message_body)
    values ('payment_submission_reminder', gen_random_uuid(), 'smoke reminder event');
  exception when check_violation then
    raise exception 'CHECK FAIL: finance event check rejects payment_submission_reminder';
  end;
  begin
    insert into public.finance_zalo_notifications (event_type, entity_id, message_body)
    values ('payment_submission_created', gen_random_uuid(), 'smoke created event');
  exception when check_violation then
    raise exception 'CHECK FAIL: finance event check rejects payment_submission_created';
  end;
  v_log := v_log || 'schema/grants/rls/events/job ok; ';

  -- -------------------------------------------------------------------------
  -- 2. Fixtures (rollback only): one unpaid request for a 7-hour-old submission
  --    and one for a 1-hour-old submission.
  -- -------------------------------------------------------------------------
  select user_id into v_owner from public.user_roles where role = 'owner' limit 1;
  if v_owner is null then
    raise exception 'CHECK FAIL: no owner user';
  end if;
  if (select count(*) from public.user_roles where role = 'owner') <> 1 then
    raise exception 'CHECK FAIL: production smoke expects exactly 1 owner';
  end if;

  insert into public.payment_requests (
    id, request_number, title, total_amount, status, payment_status, created_by
  ) values
    (v_pr, 'SMOKE-REM-OLD-' || left(v_pr::text, 8), 'Smoke nhắc chi cũ', 1000000, 'pending', 'unpaid', v_owner),
    (v_pr2, 'SMOKE-REM-NEW-' || left(v_pr2::text, 8), 'Smoke nhắc chi mới', 2000000, 'pending', 'unpaid', v_owner);

  insert into public.payment_submissions (
    id, submission_number, note, total_amount, created_by, created_at
  ) values
    (v_sub, 'TC-999999-01', 'Smoke nhắc chi 7h', 1000000, v_owner, now() - interval '7 hours'),
    (v_sub2, 'TC-999999-02', 'Smoke nhắc chi 1h', 2000000, v_owner, now() - interval '1 hour');

  insert into public.payment_submission_items (
    submission_id, payment_request_id, remaining_at_submit, position
  ) values
    (v_sub, v_pr, 1000000, 1),
    (v_sub2, v_pr2, 2000000, 1);
  v_log := v_log || 'fixtures ok; ';

  -- -------------------------------------------------------------------------
  -- 3. First forced run: exactly 1 reminder for the 7-hour-old submission and
  --    exactly 1 pending outbox row carrying the expected message.
  -- -------------------------------------------------------------------------
  v_result := public.enqueue_payment_submission_reminders(true);
  if coalesce((v_result->>'enqueued')::int, 0) < 1 then
    raise exception 'CHECK FAIL: first run enqueued = %', v_result;
  end if;
  if coalesce((v_result->>'skipped_quiet_hours')::boolean, true) then
    raise exception 'CHECK FAIL: forced run reported quiet hours';
  end if;

  select count(*) into v_count
  from public.payment_submission_reminders
  where submission_id = v_sub;
  if v_count <> 1 then
    raise exception 'CHECK FAIL: expected 1 reminder row for the 7-hour submission, got %', v_count;
  end if;

  select id into v_reminder_id
  from public.payment_submission_reminders
  where submission_id = v_sub;
  if (select round from public.payment_submission_reminders where id = v_reminder_id) <> 1 then
    raise exception 'CHECK FAIL: first reminder round is not 1';
  end if;
  if (select unpaid_count from public.payment_submission_reminders where id = v_reminder_id) <> 1 then
    raise exception 'CHECK FAIL: first reminder unpaid_count is not 1';
  end if;
  if (select remaining_amount from public.payment_submission_reminders where id = v_reminder_id) <> 1000000 then
    raise exception 'CHECK FAIL: first reminder remaining_amount is not 1000000';
  end if;

  select count(*) into v_count
  from public.finance_zalo_notifications
  where event_type = 'payment_submission_reminder'
    and entity_id = v_reminder_id
    and status = 'pending';
  if v_count <> 1 then
    raise exception 'CHECK FAIL: expected 1 pending reminder outbox row, got %', v_count;
  end if;

  select message_body into v_body
  from public.finance_zalo_notifications
  where event_type = 'payment_submission_reminder' and entity_id = v_reminder_id;
  if v_body is null
     or strpos(v_body, 'TC-999999-01') = 0
     or strpos(v_body, 'lần 1/8') = 0
     or strpos(v_body, 'https://ai.banhmique.vn/payment-requests/submissions/' || v_sub::text) = 0 then
    raise exception 'CHECK FAIL: reminder message body = %', v_body;
  end if;

  -- The 1-hour-old submission is not due yet.
  if exists (select 1 from public.payment_submission_reminders where submission_id = v_sub2) then
    raise exception 'CHECK FAIL: a 1-hour-old submission got a reminder';
  end if;
  v_log := v_log || 'first run -> 1 reminder + pending message; ';

  -- -------------------------------------------------------------------------
  -- 4. Second run immediately: no new rows (6-hour idempotency).
  -- -------------------------------------------------------------------------
  v_result := public.enqueue_payment_submission_reminders(true);
  if coalesce((v_result->>'enqueued')::int, -1) <> 0 then
    raise exception 'CHECK FAIL: second run enqueued = %', v_result;
  end if;
  if (select count(*) from public.payment_submission_reminders where submission_id = v_sub) <> 1 then
    raise exception 'CHECK FAIL: second run added a reminder inside 6 hours';
  end if;
  if (select count(*) from public.finance_zalo_notifications
      where event_type = 'payment_submission_reminder' and entity_id = v_reminder_id) <> 1 then
    raise exception 'CHECK FAIL: second run added a reminder outbox row';
  end if;
  v_log := v_log || 'second run -> 0 new; ';

  -- -------------------------------------------------------------------------
  -- 5. Mark the request paid: the submission drops out, no new rows.
  -- -------------------------------------------------------------------------
  update public.payment_requests set payment_status = 'paid' where id = v_pr;

  v_result := public.enqueue_payment_submission_reminders(true);
  if coalesce((v_result->>'enqueued')::int, -1) <> 0 then
    raise exception 'CHECK FAIL: paid run enqueued = %', v_result;
  end if;
  if (select count(*) from public.payment_submission_reminders where submission_id = v_sub) <> 1 then
    raise exception 'CHECK FAIL: a paid submission got another reminder';
  end if;
  v_log := v_log || 'paid -> 0 new; ';

  -- -------------------------------------------------------------------------
  -- 6. authenticated cannot execute the enqueue function.
  -- -------------------------------------------------------------------------
  perform set_config('role', 'authenticated', true);
  v_ok := false;
  begin
    perform public.enqueue_payment_submission_reminders(true);
  exception when others then
    v_ok := sqlstate = '42501' or sqlerrm like '%permission denied%';
  end;
  perform set_config('role', 'postgres', true);
  if not v_ok then
    raise exception 'CHECK FAIL: authenticated executed the enqueue function';
  end if;
  v_log := v_log || 'authenticated denied; ';

  raise exception 'SMOKE_RESULT PASS: %', v_log;
end $$;
