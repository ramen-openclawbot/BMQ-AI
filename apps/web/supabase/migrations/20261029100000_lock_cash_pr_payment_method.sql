-- Chặn đổi hình thức chi của phiếu Chi tiền mặt thuộc luồng mới.
--
-- Bối cảnh: phiếu chi đã đi qua luồng "Chi tiền mặt" mới (có dòng trong
-- public.cash_pr_idempotency hoặc đã có cash_settlement_status) là phiếu tiền
-- mặt đã khoá hình thức. Không được đổi payment_method từ 'cash' sang giá trị
-- khác (ví dụ 'bank_transfer') qua bất kỳ đường duyệt nào.
--
-- Điều kiện đã kiểm trên database thật trước khi viết migration (CHỈ SELECT):
--   * public.approve_payment_request_with_material_controller(uuid, text, uuid)
--     cập nhật public.payment_requests set status = 'approved', payment_method =
--     ... trong một câu UPDATE, nên trigger BEFORE UPDATE OF payment_method bắt
--     được mọi đường duyệt.
--   * public.approve_payment_requests_with_unc(uuid[], jsonb, text) gọi lại
--     public.approve_payment_request_with_material_controller(v_pr.id, v_method,
--     v_actor) cho từng phiếu 'pending' trước khi insert public.payments, nên
--     lỗi trong trigger huỷ cả lần duyệt (rollback toàn bộ RPC).
--   * Trigger BEFORE UPDATE chạy theo thứ tự tên:
--     trg_guard_cash_pr_payment_method đứng trước
--     trg_guard_payment_request_material_approval nên lỗi khoá hình thức nổi
--     lên trước.
--   * public.cash_pr_idempotency(payment_request_id uuid not null, ...) là dấu
--     hiệu phiếu thuộc luồng Chi tiền mặt mới; cột
--     public.payment_requests.cash_settlement_status (text, nullable) là dấu
--     hiệu bổ sung.
--   * Phiếu cash form cũ (không có dòng idempotency, cash_settlement_status
--     null) vẫn được đổi hình thức; chiều bank_transfer -> cash và giữ nguyên
--     cash không bị ảnh hưởng.
--
-- Migration này KHÔNG sửa public.approve_payment_request_with_material_controller,
-- public.approve_payment_requests_with_unc hay bất kỳ hàm duyệt nào; chỉ thêm một
-- trigger và một hàm trigger.

-- ---------------------------------------------------------------------------
-- 1. Hàm trigger: khoá hình thức chi tiền mặt của phiếu thuộc luồng mới.
-- ---------------------------------------------------------------------------
create or replace function public.guard_cash_pr_payment_method()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.payment_method::text = 'cash'
     and new.payment_method::text is distinct from 'cash'
     and (
       exists (
         select 1
           from public.cash_pr_idempotency cpi
          where cpi.payment_request_id = old.id
       )
       or old.cash_settlement_status is not null
     ) then
    raise exception 'cash_pr_method_locked: %', old.request_number
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.guard_cash_pr_payment_method() is
  'BEFORE UPDATE OF payment_method: từ chối đổi payment_method từ ''cash'' sang giá trị khác khi phiếu chi thuộc luồng Chi tiền mặt mới (có dòng public.cash_pr_idempotency hoặc cash_settlement_status is not null). Lỗi cash_pr_method_locked: <request_number>, errcode P0001.';

-- ---------------------------------------------------------------------------
-- 2. Trigger BEFORE UPDATE OF payment_method.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_guard_cash_pr_payment_method on public.payment_requests;
create trigger trg_guard_cash_pr_payment_method
before update of payment_method on public.payment_requests
for each row
execute function public.guard_cash_pr_payment_method();

-- ---------------------------------------------------------------------------
-- 3. Không cho client gọi trực tiếp hàm trigger.
-- ---------------------------------------------------------------------------
revoke all on function public.guard_cash_pr_payment_method() from public, anon, authenticated;
