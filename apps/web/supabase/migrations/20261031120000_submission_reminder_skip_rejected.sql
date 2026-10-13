-- Trình chi gấp: nhắc lại bỏ qua phiếu đã từ chối (phần dữ liệu).
--
-- Owner 13/10 — PR-5F2E9327 (Toàn Phát) was rejected 12/10 but stayed in the
-- urgent list and reminders. A rejected request keeps payment_status
-- unpaid/partial, and the reminder reads filter only on payment_status, so the
-- rejected request was still counted in unpaid_count/remaining_amount, still
-- produced a message line and still kept the submission in the 6-hour loop.
--
-- This migration re-creates the two reminder functions from their newest
-- definitions (20261030130000_payment_submission_reminder_last_paid_v2.sql for
-- the message builder, 20261030110000_payment_submission_reminders.sql for the
-- enqueue) and changes ONLY the open-line predicates to also require
-- pr.status::text <> 'rejected'. Signatures, security, search_path, body
-- comments and the revoke/grant pairs are byte-for-byte identical otherwise.
-- No table, index, policy, schedule or other function is touched.
--
-- Not applied by the author; the Maestro applies it.

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
