-- Nhóm Zalo "BMQ - Duyệt chi" (owner 21/11/2026): gửi tin Trình chi gấp, đã chi,
-- chi tiền mặt và chi lương. Tin tạo phiếu đề nghị chi, nhận hàng, đặt hàng tự động...
-- vẫn được ghi vào hàng đợi nhưng với trạng thái 'suppressed' nên không gửi. Danh sách loại tin được gửi nằm ở
-- app_settings.finance_zalo_allowed_events (phân cách bằng dấu phẩy) để bật lại khi cần.
-- Tin báo nhà cung cấp (supplier_*_notifications) không đi qua bảng này, không đổi.

insert into public.app_settings (key, value)
values ('finance_zalo_allowed_events', 'payment_submission_created,payment_request_paid,payment_cash_advanced,payment_cash_settled,salary_payout_created,salary_payout_advanced,salary_payout_completed')
on conflict (key) do nothing;

create or replace function public.finance_zalo_filter_allowed_events()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_allowed text;
begin
  if new.status is distinct from 'pending' then
    return new;
  end if;
  select value into v_allowed from public.app_settings where key = 'finance_zalo_allowed_events';
  if v_allowed is null then
    return new;
  end if;
  if not (new.event_type = any (string_to_array(regexp_replace(v_allowed, '\s', '', 'g'), ','))) then
    new.status := 'suppressed';
  end if;
  return new;
end;
$$;

revoke all on function public.finance_zalo_filter_allowed_events() from public, anon, authenticated;

drop trigger if exists trg_finance_zalo_filter_allowed_events on public.finance_zalo_notifications;
create trigger trg_finance_zalo_filter_allowed_events
  before insert on public.finance_zalo_notifications
  for each row execute function public.finance_zalo_filter_allowed_events();

-- Tin đang chờ gửi thuộc loại không còn được gửi: chuyển sang suppressed.
update public.finance_zalo_notifications
   set status = 'suppressed', updated_at = now()
 where status = 'pending'
   and not (event_type = any (string_to_array('payment_submission_created,payment_request_paid,payment_cash_advanced,payment_cash_settled,salary_payout_created,salary_payout_advanced,salary_payout_completed', ',')));
