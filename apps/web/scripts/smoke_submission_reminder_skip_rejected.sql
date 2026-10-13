-- Rollback-only production smoke for migration
-- 20261031120000_submission_reminder_skip_rejected.sql.
--
-- Run as one file (from apps/web):
--   supabase db query --linked -f scripts/smoke_submission_reminder_skip_rejected.sql
--
-- One transaction. It applies the migration body inline, creates a temporary
-- submission with one rejected unpaid request and one pending unpaid request
-- (plus a submission whose only open line is rejected) exactly like
-- supabase/tests/payment_submission_reminders_smoke_checks.sql does, runs
-- public.enqueue_payment_submission_reminders(true) and asserts the saved
-- reminder rows and the pending finance_zalo_notifications outbox rows. The
-- final RAISE aborts the transaction, so nothing is applied and no real Zalo
-- message is ever sent or dispatched.
begin;

-- (1) Apply the migration body inline, byte-for-byte.
create or replace function public.build_finance_zalo_payment_submission_reminder_message(
  p_reminder_id uuid
)
returns text
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_rem public.payment_submission_reminders%rowtype;
  v_number text;
  v_lines text[];
  v_message_lines text[];
begin
  select * into v_rem
  from public.payment_submission_reminders
  where id = p_reminder_id;
  if not found then
    return null;
  end if;

  select s.submission_number into v_number
  from public.payment_submissions s
  where s.id = v_rem.submission_id;

  select array_agg(line order by position)
    into v_lines
  from (
    select i.position,
           format(
             '• %s – %s: %s (%s)',
             coalesce(sup.name, 'Chưa xác định'),
             pr.request_number,
             public.finance_format_vnd(
               coalesce(pr.total_amount, 0) - coalesce((
                 select sum(pa.amount)
                 from public.payment_allocations pa
                 where pa.payment_request_id = pr.id
               ), 0)
             ),
             -- Lần chi gần nhất = ngày chuyển khoản trên phiếu chi (payments.payment_date).
             -- paid_at chỉ là lúc app đánh dấu (có khi nhập bù hàng loạt), nên chỉ dùng khi
             -- nhà cung cấp chưa có phiếu chi nào.
             coalesce(
               'Lần chi gần nhất ' || to_char(
                 coalesce(
                   (select max(p.payment_date) from public.payments p where p.supplier_id = pr.supplier_id),
                   (select max((p2.paid_at at time zone 'Asia/Ho_Chi_Minh')::date)
                      from public.payment_requests p2
                     where p2.supplier_id = pr.supplier_id and p2.payment_status::text = 'paid')
                 ), 'DD/MM/YYYY'),
               'Chưa chi lần nào')
           ) as line
    from public.payment_submission_items i
    join public.payment_requests pr on pr.id = i.payment_request_id
    left join public.suppliers sup on sup.id = pr.supplier_id
    where i.submission_id = v_rem.submission_id
      and pr.payment_status::text in ('unpaid', 'partial')
      and pr.status::text <> 'rejected'
  ) lines;

  v_message_lines := array[
    '⏰ NHẮC CHI GẤP ' || coalesce(v_number, '') || ' (lần ' || v_rem.round::text || '/8)',
    v_rem.unpaid_count::text || ' phiếu chưa chi · Còn lại ' || public.finance_format_vnd(v_rem.remaining_amount)
  ];
  if v_lines is not null then
    v_message_lines := v_message_lines || v_lines[1:5];
  end if;
  if v_rem.unpaid_count > 5 then
    v_message_lines := v_message_lines || ('… và ' || (v_rem.unpaid_count - 5)::text || ' phiếu khác');
  end if;
  v_message_lines := v_message_lines || array[
    '',
    'https://ai.banhmique.vn/payment-requests/submissions/' || v_rem.submission_id::text
  ];

  return array_to_string(v_message_lines, E'\n');
end;
$$;

revoke all on function public.build_finance_zalo_payment_submission_reminder_message(uuid) from public, anon, authenticated;
grant execute on function public.build_finance_zalo_payment_submission_reminder_message(uuid) to service_role;

create or replace function public.enqueue_payment_submission_reminders(
  p_force_hours boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_local_hour integer;
  v_checked integer := 0;
  v_enqueued integer := 0;
  v_sub record;
  v_unpaid_count integer;
  v_remaining numeric;
  v_round integer;
  v_reminder_id uuid;
  v_last_at timestamptz;
  v_body text;
begin
  -- Serialise concurrent scheduler runs so two runs cannot double-insert.
  perform pg_advisory_xact_lock(hashtext('payment_submission_reminders'));

  -- Quiet hours 22:00-07:00 Asia/Ho_Chi_Minh: skip the whole run. A reminder
  -- that came due in that window is sent by the first run at/after 07:00.
  if not coalesce(p_force_hours, false) then
    v_local_hour := extract(hour from (now() at time zone 'Asia/Ho_Chi_Minh'))::integer;
    if v_local_hour >= 22 or v_local_hour < 7 then
      return jsonb_build_object('checked', 0, 'enqueued', 0, 'skipped_quiet_hours', true);
    end if;
  end if;

  for v_sub in
    select
      s.id,
      s.created_at,
      (
        select max(r.created_at)
        from public.payment_submission_reminders r
        where r.submission_id = s.id
      ) as last_reminder_at,
      (
        select count(*)
        from public.payment_submission_reminders r
        where r.submission_id = s.id
      ) as reminder_count
    from public.payment_submissions s
    where s.created_at >= now() - interval '14 days'
      and exists (
        select 1
        from public.payment_submission_items i
        join public.payment_requests pr on pr.id = i.payment_request_id
        where i.submission_id = s.id
          and pr.payment_status::text in ('unpaid', 'partial')
          and pr.status::text <> 'rejected'
      )
    order by s.created_at, s.id
  loop
    v_checked := v_checked + 1;

    -- At most 8 reminders per submission.
    if v_sub.reminder_count >= 8 then
      continue;
    end if;

    -- 6 hours since the created notice or the last reminder (GREATEST ignores
    -- the NULL from max() when there is no reminder yet).
    v_last_at := greatest(v_sub.created_at, v_sub.last_reminder_at);
    if now() - v_last_at < interval '6 hours' then
      continue;
    end if;

    select count(*)::integer, coalesce(sum(
             coalesce(pr.total_amount, 0) - coalesce((
               select sum(pa.amount)
               from public.payment_allocations pa
               where pa.payment_request_id = pr.id
             ), 0)
           ), 0)
      into v_unpaid_count, v_remaining
    from public.payment_submission_items i
    join public.payment_requests pr on pr.id = i.payment_request_id
    where i.submission_id = v_sub.id
      and pr.payment_status::text in ('unpaid', 'partial')
      and pr.status::text <> 'rejected';

    -- Nothing left to remind.
    if v_unpaid_count = 0 then
      continue;
    end if;

    v_round := (v_sub.reminder_count + 1)::integer;
    v_reminder_id := null;

    insert into public.payment_submission_reminders (
      submission_id, round, unpaid_count, remaining_amount
    ) values (
      v_sub.id, v_round, v_unpaid_count, v_remaining
    )
    on conflict (submission_id, round) do nothing
    returning id into v_reminder_id;

    if v_reminder_id is null then
      continue;
    end if;

    v_body := public.build_finance_zalo_payment_submission_reminder_message(v_reminder_id);
    if v_body is null then
      continue;
    end if;

    insert into public.finance_zalo_notifications (
      event_type, entity_id, group_key, message_body, status
    ) values (
      'payment_submission_reminder', v_reminder_id, 'finance', v_body, 'pending'
    )
    on conflict (event_type, entity_id) do nothing;

    v_enqueued := v_enqueued + 1;
  end loop;

  return jsonb_build_object(
    'checked', v_checked,
    'enqueued', v_enqueued,
    'skipped_quiet_hours', false
  );
end;
$$;

revoke all on function public.enqueue_payment_submission_reminders(boolean) from public, anon, authenticated;
grant execute on function public.enqueue_payment_submission_reminders(boolean) to service_role;

comment on function public.enqueue_payment_submission_reminders(boolean) is 'Service-role / postgres: enqueue a finance Zalo payment_submission_reminder every 6 hours after the created notice or the last reminder for submissions created in the last 14 days that still have an unpaid/partial item; quiet hours 22:00-07:00 Asia/Ho_Chi_Minh, max 8 rounds, advisory-locked and idempotent. p_force_hours (tests only) bypasses the quiet-hour skip.';

-- (2) Rollback-only fixtures + checks: rejected requests must be ignored.
do $$
declare
  v_owner uuid;
  v_pr_rejected uuid := gen_random_uuid();
  v_pr_pending uuid := gen_random_uuid();
  v_pr_only_rejected uuid := gen_random_uuid();
  v_sub_mixed uuid := gen_random_uuid();
  v_sub_rejected_only uuid := gen_random_uuid();
  v_rejected_number text;
  v_pending_number text;
  v_result jsonb;
  v_reminder_id uuid;
  v_count integer;
  v_unpaid integer;
  v_remaining numeric;
  v_body text;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL no_owner';
  end if;

  v_rejected_number := 'SMOKE-REJ-' || left(v_pr_rejected::text, 8);
  v_pending_number := 'SMOKE-PEND-' || left(v_pr_pending::text, 8);

  -- The production bug: a rejected request keeps payment_status 'unpaid'.
  insert into public.payment_requests (
    id, request_number, title, total_amount, status, payment_status,
    rejection_reason, approved_at, created_by
  ) values
    (v_pr_rejected, v_rejected_number, 'Smoke phiếu bị từ chối', 1000000,
     'rejected', 'unpaid', 'Smoke: PO đã hủy', now(), v_owner),
    (v_pr_pending, v_pending_number, 'Smoke phiếu chờ chi', 2000000,
     'pending', 'unpaid', null, null, v_owner),
    (v_pr_only_rejected, 'SMOKE-REJONLY-' || left(v_pr_only_rejected::text, 8),
     'Smoke chỉ phiếu bị từ chối', 3000000,
     'rejected', 'unpaid', 'Smoke: từ chối', now(), v_owner);

  insert into public.payment_submissions (
    id, submission_number, note, total_amount, created_by, created_at
  ) values
    (v_sub_mixed, 'TC-999998-01', 'Smoke bỏ qua phiếu từ chối', 3000000, v_owner, now() - interval '7 hours'),
    (v_sub_rejected_only, 'TC-999998-02', 'Smoke chỉ có phiếu từ chối', 3000000, v_owner, now() - interval '7 hours');

  insert into public.payment_submission_items (
    submission_id, payment_request_id, remaining_at_submit, position
  ) values
    (v_sub_mixed, v_pr_rejected, 1000000, 1),
    (v_sub_mixed, v_pr_pending, 2000000, 2),
    (v_sub_rejected_only, v_pr_only_rejected, 3000000, 1);

  v_result := public.enqueue_payment_submission_reminders(true);
  if coalesce((v_result->>'skipped_quiet_hours')::boolean, true) then
    raise exception 'SMOKE_RESULT FAIL forced_run_reported_quiet_hours';
  end if;

  -- Exactly one reminder for the mixed submission.
  select count(*) into v_count
  from public.payment_submission_reminders
  where submission_id = v_sub_mixed;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL mixed_reminder_count=%', v_count;
  end if;

  -- unpaid_count / remaining_amount count only the pending request.
  select id, unpaid_count, remaining_amount
    into v_reminder_id, v_unpaid, v_remaining
  from public.payment_submission_reminders
  where submission_id = v_sub_mixed;

  if v_unpaid <> 1 then
    raise exception 'SMOKE_RESULT FAIL unpaid_count=% (rejected request counted)', v_unpaid;
  end if;
  if v_remaining <> 2000000 then
    raise exception 'SMOKE_RESULT FAIL remaining_amount=% (rejected request counted)', v_remaining;
  end if;

  -- The pending outbox row exists; its body lists only the pending request.
  select count(*) into v_count
  from public.finance_zalo_notifications
  where event_type = 'payment_submission_reminder'
    and entity_id = v_reminder_id
    and status = 'pending';
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL pending_outbox_rows=%', v_count;
  end if;

  select message_body into v_body
  from public.finance_zalo_notifications
  where event_type = 'payment_submission_reminder' and entity_id = v_reminder_id;

  if v_body is null
     or strpos(v_body, v_pending_number) = 0
     or strpos(v_body, v_rejected_number) > 0 then
    raise exception 'SMOKE_RESULT FAIL message_lines body=%', v_body;
  end if;
  if strpos(v_body, '1 phiếu chưa chi') = 0 then
    raise exception 'SMOKE_RESULT FAIL unpaid_count_line body=%', v_body;
  end if;

  -- A submission whose only open line is rejected produces no reminder.
  if exists (
    select 1 from public.payment_submission_reminders
    where submission_id = v_sub_rejected_only
  ) then
    raise exception 'SMOKE_RESULT FAIL rejected_only_submission_got_reminder';
  end if;

  raise exception 'SMOKE_RESULT PASS: submission reminder skip rejected';
end $$;
