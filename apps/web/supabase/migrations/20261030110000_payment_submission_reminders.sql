-- Trình chi gấp: nhắc lại trên Zalo mỗi 6 tiếng khi còn phiếu chưa chi.
--
-- Additive only. This migration:
--   (a) adds public.payment_submission_reminders — one row per reminder round of a
--       submission (unique submission_id + round), owner-or-view RLS, no direct
--       client writes,
--   (b) extends the finance Zalo event check with 'payment_submission_reminder'
--       (the previous list is copied verbatim; no event is dropped),
--   (c) adds build_finance_zalo_payment_submission_reminder_message(reminder_id),
--   (d) adds enqueue_payment_submission_reminders(p_force_hours boolean default
--       false), service-role only: 6h after the created notice / last reminder,
--       quiet hours 22:00-07:00 Asia/Ho_Chi_Minh skipped, at most 8 rounds,
--       stops when no unpaid item remains, idempotent under an advisory lock,
--   (e) schedules the hourly job 'payment-submission-reminders-hourly' at :05.
--
-- It redefines no existing function, edits no earlier migration and reuses the
-- existing finance_zalo_notifications outbox + finance-zalo-notify dispatcher
-- (no edge change). Re-runnable: every object is created idempotently.

-- ---------------------------------------------------------------------------
-- 1. Reminder rounds snapshot for one submission.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_submission_reminders (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.payment_submissions(id) on delete cascade,
  round integer not null,
  unpaid_count integer not null,
  remaining_amount numeric not null,
  created_at timestamptz not null default now(),
  constraint payment_submission_reminders_round_check check (round between 1 and 8),
  constraint payment_submission_reminders_submission_round_key unique (submission_id, round)
);

alter table public.payment_submission_reminders enable row level security;

-- Written only through the SECURITY DEFINER enqueue function; clients may read
-- with the same rule as payment_submissions (owner or payment_requests view) and
-- can never insert/update/delete directly.
revoke all on public.payment_submission_reminders from public, anon, authenticated;
grant select on public.payment_submission_reminders to authenticated;
grant all on public.payment_submission_reminders to service_role;

drop policy if exists payment_submission_reminders_view_select on public.payment_submission_reminders;
create policy payment_submission_reminders_view_select
  on public.payment_submission_reminders
  for select
  to authenticated
  using (
    public.has_role(auth.uid(), 'owner')
    or public.has_module_permission(auth.uid(), 'payment_requests', 'view')
  );

-- ---------------------------------------------------------------------------
-- 2. Extend the finance Zalo event check with the reminder event. The list is
--    copied verbatim from the latest re-declaration (20261014100000) and only
--    'payment_submission_reminder' is appended; no existing event is removed.
-- ---------------------------------------------------------------------------
alter table public.finance_zalo_notifications
  drop constraint if exists finance_zalo_notifications_event_type_check;

alter table public.finance_zalo_notifications
  add constraint finance_zalo_notifications_event_type_check
  check (event_type in (
    'payment_request_created',
    'payment_request_paid',
    'goods_receipt_received',
    'goods_receipt_short',
    'payment_submission_created',
    'payment_cash_advanced',
    'payment_cash_settled',
    'salary_payout_created',
    'salary_payout_advanced',
    'salary_payout_completed',
    'auto_purchase_order_sent',
    'auto_purchase_daily_summary',
    'payment_submission_reminder'
  ));

-- ---------------------------------------------------------------------------
-- 3. build_finance_zalo_payment_submission_reminder_message: the reminder body.
--    Header + live count/remaining + up to five unpaid request lines in the same
--    style as the created message + the submission link.
-- ---------------------------------------------------------------------------
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
             '• %s – %s: %s',
             coalesce(sup.name, 'Chưa xác định'),
             pr.request_number,
             public.finance_format_vnd(
               coalesce(pr.total_amount, 0) - coalesce((
                 select sum(pa.amount)
                 from public.payment_allocations pa
                 where pa.payment_request_id = pr.id
               ), 0)
             )
           ) as line
    from public.payment_submission_items i
    join public.payment_requests pr on pr.id = i.payment_request_id
    left join public.suppliers sup on sup.id = pr.supplier_id
    where i.submission_id = v_rem.submission_id
      and pr.payment_status::text in ('unpaid', 'partial')
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

comment on function public.build_finance_zalo_payment_submission_reminder_message(uuid) is 'Service-role: finance Zalo reminder body for one payment_submission_reminders row (header with round/8, live unpaid count and remaining, up to five unpaid request lines and the submission link).';

-- ---------------------------------------------------------------------------
-- 4. enqueue_payment_submission_reminders: the scheduled decision. Security
--    definer, service_role / postgres only. p_force_hours is a test hook that
--    bypasses the Vietnam quiet-hour skip deterministically.
-- ---------------------------------------------------------------------------
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
      and pr.payment_status::text in ('unpaid', 'partial');

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

-- ---------------------------------------------------------------------------
-- 5. Hourly schedule at :05 (cron.schedule is idempotent via unschedule-first).
-- ---------------------------------------------------------------------------
do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'payment-submission-reminders-hourly'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'payment-submission-reminders-hourly',
    '5 * * * *',
    $job$ select public.enqueue_payment_submission_reminders(); $job$
  );
end;
$$;
