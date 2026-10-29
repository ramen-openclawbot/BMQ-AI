-- Email ảnh UNC cho nhà cung cấp sau khi duyệt chi + báo nhóm Zalo.
--
-- Additive only. Migration này:
--   (a) thêm 3 app_settings cho chế độ thử (mặc định 'test');
--   (b) đăng ký worker secret 'supplier-payment-notify' cho pg_cron;
--   (c) thêm public.supplier_payment_notifications — outbox 1 thông báo cho
--       mỗi payment có nhà cung cấp;
--   (d) trigger AFTER INSERT trên public.payment_unc_evidence: mỗi ảnh UNC mới
--       tạo/hoãn 1 thông báo pending (chỉ khi NCC có email). Trigger không bao
--       giờ làm hỏng việc lưu UNC;
--   (e) public.claim_supplier_payment_notifications(int) trả jsonb cho worker,
--       chỉ service_role;
--   (f) public.mark_supplier_payment_notification(...) ghi kết quả và, khi
--       thành công, xếp đúng 1 tin vào supplier_zalo_notifications;
--   (g) mở rộng supplier_zalo_notifications cho tin theo payment; hàm claim/mark
--       Zalo hiện có giữ nguyên;
--   (h) lịch pg_cron mỗi phút gọi edge function supplier-payment-notify bằng
--       x-worker-secret.
--
-- Không áp dụng migration này lên DB thật trong quá trình phát triển. Dry run
-- supabase/tests/supplier_payment_notifications_dryrun.sql chạy toàn bộ trong
-- transaction và rollback.

-- ===========================================================================
-- 1. app_settings — chế độ thử mặc định
-- ===========================================================================

insert into public.app_settings (key, value)
values ('supplier_payment_notify_mode', 'test')
on conflict (key) do nothing;

insert into public.app_settings (key, value)
values ('supplier_payment_notify_test_email', 'order@bmq.vn')
on conflict (key) do nothing;

insert into public.app_settings (key, value)
values ('supplier_payment_notify_test_zalo_group', '2263202896844008192')
on conflict (key) do nothing;

-- ===========================================================================
-- 2. Worker secret cho cron
-- ===========================================================================

insert into public.robot_worker_config (id)
values ('supplier-payment-notify')
on conflict (id) do nothing;

-- ===========================================================================
-- 3. Outbox thông báo thanh toán cho nhà cung cấp
-- ===========================================================================

create table if not exists public.supplier_payment_notifications (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null unique references public.payments(id) on delete cascade,
  supplier_id uuid not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed')),
  not_before timestamptz not null default now() + interval '2 minutes',
  attempts int not null default 0,
  last_error text,
  mode text,
  to_email text,
  gmail_message_id text,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_supplier_payment_notifications_claim
  on public.supplier_payment_notifications(status, not_before, claimed_at);

alter table public.supplier_payment_notifications enable row level security;

revoke all on table public.supplier_payment_notifications
  from public, anon, authenticated;
grant all on table public.supplier_payment_notifications to service_role;

-- ===========================================================================
-- 4. Trigger: ảnh UNC mới -> 1 thông báo pending cho payment
-- ===========================================================================

create or replace function public.enqueue_supplier_payment_notification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment public.payments%rowtype;
  v_email text;
begin
  if NEW.payment_id is null then
    return NEW;
  end if;

  begin
    select *
      into v_payment
    from public.payments
    where id = NEW.payment_id;

    if not found or v_payment.supplier_id is null then
      return NEW;
    end if;

    select nullif(btrim(coalesce(email, '')), '')
      into v_email
    from public.suppliers
    where id = v_payment.supplier_id;

    if v_email is null then
      return NEW;
    end if;

    insert into public.supplier_payment_notifications as n (
      payment_id,
      supplier_id
    ) values (
      NEW.payment_id,
      v_payment.supplier_id
    )
    on conflict (payment_id) do update
      set not_before = now() + interval '2 minutes'
      where n.status = 'pending';
  exception when others then
    raise warning
      'supplier_payment_notification_enqueue_failed payment=% error=%',
      NEW.payment_id, sqlerrm;
  end;

  return NEW;
end;
$$;

drop trigger if exists trg_payment_unc_evidence_supplier_payment_notification
  on public.payment_unc_evidence;
create trigger trg_payment_unc_evidence_supplier_payment_notification
  after insert on public.payment_unc_evidence
  for each row
  execute function public.enqueue_supplier_payment_notification();

-- ===========================================================================
-- 5. PO / phiếu đề nghị của một payment (dùng chung cho claim và mark)
-- ===========================================================================

create or replace function public.supplier_payment_allocation_labels(
  p_payment_id uuid
)
returns table (po_numbers text[], request_numbers text[])
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce((
      select array_agg(label order by ord)
      from (
        select distinct on (label) label, ord
        from (
          select
            coalesce(nullif(btrim(po.po_number), ''), pr.request_number) as label,
            row_number() over (order by pa.created_at, pa.id) as ord
          from public.payment_allocations pa
          join public.payment_requests pr on pr.id = pa.payment_request_id
          left join public.purchase_orders po on po.id = pr.purchase_order_id
          where pa.payment_id = p_payment_id
        ) ranked
        order by label, ord
      ) picked
    ), '{}'::text[]),
    coalesce((
      select array_agg(request_number order by ord)
      from (
        select distinct on (request_number) request_number, ord
        from (
          select
            pr.request_number,
            row_number() over (order by pa.created_at, pa.id) as ord
          from public.payment_allocations pa
          join public.payment_requests pr on pr.id = pa.payment_request_id
          where pa.payment_id = p_payment_id
        ) ranked
        order by request_number, ord
      ) picked
    ), '{}'::text[]);
$$;

-- ===========================================================================
-- 6. Claim cho worker (chỉ service_role)
-- ===========================================================================

create or replace function public.claim_supplier_payment_notifications(
  p_limit int default 3
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode text;
  v_test_email text;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select coalesce(nullif(btrim(value), ''), 'test')
    into v_mode
  from public.app_settings
  where key = 'supplier_payment_notify_mode';
  v_mode := coalesce(v_mode, 'test');

  select value
    into v_test_email
  from public.app_settings
  where key = 'supplier_payment_notify_test_email';

  with picked as (
    select n.id
    from public.supplier_payment_notifications n
    where (n.status = 'pending' and n.not_before <= now())
       or (
         n.status = 'sending'
         and n.claimed_at < now() - interval '10 minutes'
       )
       or (
         n.status = 'failed'
         and n.attempts < 3
         and n.claimed_at < now() - interval '10 minutes'
       )
    order by n.created_at, n.id
    limit greatest(coalesce(p_limit, 0), 0)
    for update skip locked
  ),
  claimed as (
    update public.supplier_payment_notifications n
       set status = 'sending',
           claimed_at = now(),
           attempts = n.attempts + 1
      from picked p
     where n.id = p.id
    returning n.*
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', c.id,
      'payment_id', c.payment_id,
      'payment_number', pay.payment_number,
      'amount', pay.amount,
      'payment_date', pay.payment_date,
      'reference_number', pay.reference_number,
      'supplier_name', s.name,
      'supplier_email', s.email,
      'mode', v_mode,
      'test_email', v_test_email,
      'po_numbers', to_jsonb(l.po_numbers),
      'request_numbers', to_jsonb(l.request_numbers),
      'unc_paths', coalesce((
        select jsonb_agg(e.storage_path order by e.created_at, e.id)
        from public.payment_unc_evidence e
        where e.payment_id = c.payment_id
          and e.storage_path is not null
      ), '[]'::jsonb),
      'ocr_reference', (
        select e.ocr_reference
        from public.payment_unc_evidence e
        where e.payment_id = c.payment_id
        order by e.created_at desc, e.id desc
        limit 1
      )
    )
    order by c.created_at, c.id
  ), '[]'::jsonb)
  into v_result
  from claimed c
  join public.payments pay on pay.id = c.payment_id
  join public.suppliers s on s.id = c.supplier_id
  cross join lateral public.supplier_payment_allocation_labels(c.payment_id) l;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- 7. Mark kết quả + xếp tin Zalo (chỉ service_role)
-- ===========================================================================

create or replace function public.mark_supplier_payment_notification(
  p_id uuid,
  p_ok boolean,
  p_to_email text,
  p_gmail_message_id text,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode text;
  v_row public.supplier_payment_notifications%rowtype;
  v_test_group text;
  v_group text;
  v_po_numbers text[];
  v_request_numbers text[];
  v_po_text text;
  v_payment_number text;
  v_amount numeric;
  v_digits text;
  v_grouped text;
  v_index integer;
  v_message text;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_id is null then
    return;
  end if;

  select coalesce(nullif(btrim(value), ''), 'test')
    into v_mode
  from public.app_settings
  where key = 'supplier_payment_notify_mode';
  v_mode := coalesce(v_mode, 'test');

  if p_ok then
    update public.supplier_payment_notifications
       set status = 'sent',
           sent_at = now(),
           to_email = nullif(btrim(coalesce(p_to_email, '')), ''),
           gmail_message_id = p_gmail_message_id,
           mode = v_mode,
           last_error = null
     where id = p_id
    returning * into v_row;

    if not found then
      return;
    end if;

    if v_mode = 'test' then
      select nullif(btrim(value), '')
        into v_test_group
      from public.app_settings
      where key = 'supplier_payment_notify_test_zalo_group';
      v_group := v_test_group;
    else
      select nullif(btrim(z.zalo_group_id), '')
        into v_group
      from public.supplier_zalo_groups z
      where z.supplier_id = v_row.supplier_id
        and z.enabled
      limit 1;
    end if;

    if v_group is not null then
      select l.po_numbers, l.request_numbers
        into v_po_numbers, v_request_numbers
      from public.supplier_payment_allocation_labels(v_row.payment_id) l;

      select p.payment_number, p.amount
        into v_payment_number, v_amount
      from public.payments p
      where p.id = v_row.payment_id;

      v_po_text := array_to_string(v_po_numbers, ', ');
      if nullif(btrim(coalesce(v_po_text, '')), '') is null then
        v_po_text := array_to_string(v_request_numbers, ', ');
      end if;
      if nullif(btrim(coalesce(v_po_text, '')), '') is null then
        v_po_text := coalesce(v_payment_number, v_row.payment_id::text);
      end if;

      v_digits := round(abs(coalesce(v_amount, 0)))::bigint::text;
      v_grouped := '';
      for v_index in 1..length(v_digits) loop
        if v_index > 1
           and ((length(v_digits) - v_index + 1) % 3) = 0 then
          v_grouped := v_grouped || '.';
        end if;
        v_grouped := v_grouped || substr(v_digits, v_index, 1);
      end loop;
      if coalesce(v_amount, 0) < 0 then
        v_grouped := '-' || v_grouped;
      end if;

      v_message := case when v_mode = 'test' then '[THỬ] ' else '' end
        || 'BMQ đã thanh toán ' || v_po_text
        || ', số tiền ' || v_grouped
        || ' đ. Anh vui lòng kiểm tra email để xem ảnh UNC. Trân trọng.';

      insert into public.supplier_zalo_notifications (
        payment_id,
        supplier_id,
        zalo_group_id,
        message
      ) values (
        v_row.payment_id,
        v_row.supplier_id,
        v_group,
        v_message
      )
      on conflict (payment_id) do nothing;
    end if;
  else
    update public.supplier_payment_notifications
       set status = 'failed',
           last_error = left(coalesce(p_error, ''), 500)
     where id = p_id;
  end if;
end;
$$;

-- ===========================================================================
-- 8. Cho phép supplier_zalo_notifications mang tin theo payment
-- ===========================================================================

alter table public.supplier_zalo_notifications
  alter column order_request_id drop not null;

alter table public.supplier_zalo_notifications
  add column if not exists payment_id uuid unique
    references public.payments(id) on delete cascade;

alter table public.supplier_zalo_notifications
  drop constraint if exists supplier_zalo_notifications_target_check;
alter table public.supplier_zalo_notifications
  add constraint supplier_zalo_notifications_target_check
  check (order_request_id is not null or payment_id is not null);

-- ===========================================================================
-- 9. Privileges
-- ===========================================================================

revoke all on function public.enqueue_supplier_payment_notification()
  from public, anon, authenticated;
grant execute on function public.enqueue_supplier_payment_notification()
  to service_role;

revoke all on function public.supplier_payment_allocation_labels(uuid)
  from public, anon, authenticated;
grant execute on function public.supplier_payment_allocation_labels(uuid)
  to service_role;

revoke all on function public.claim_supplier_payment_notifications(int)
  from public, anon, authenticated;
grant execute on function public.claim_supplier_payment_notifications(int)
  to service_role;

revoke all on function public.mark_supplier_payment_notification(
  uuid, boolean, text, text, text
) from public, anon, authenticated;
grant execute on function public.mark_supplier_payment_notification(
  uuid, boolean, text, text, text
) to service_role;

-- ===========================================================================
-- 10. pg_cron mỗi phút: edge function supplier-payment-notify
-- ===========================================================================

do $schedule$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid
    from cron.job
    where jobname = 'supplier-payment-notify-every-minute'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'supplier-payment-notify-every-minute',
    '* * * * *',
    $job$
      do $run$
      begin
        perform net.http_post(
          url := 'https://cxntbdvfsikwmitapony.supabase.co/functions/v1/supplier-payment-notify',
          headers := jsonb_build_object(
            'content-type', 'application/json',
            'x-worker-secret', (
              select worker_secret::text
              from public.robot_worker_config
              where id = 'supplier-payment-notify'
            )
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 120000
        );
      end;
      $run$;
    $job$
  );
end;
$schedule$;
