-- Trình chi gấp reminder: each request line now ends with the supplier's last payment date
-- "(Lần chi gần nhất DD/MM/YYYY)" — the bank date payments.payment_date (paid_at only when the supplier
-- has no payment record at all) — or "(Chưa chi lần nào)". Same function, same grants; message only.
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
