-- Công tắc "Thanh toán trước rồi mới giao hàng" (suppliers.pay_before_delivery).
--
-- Bật cờ này thì duyệt chi không cần ảnh phiếu giao hàng
-- (guard_payment_request_delivery_image), nên chỉ owner được đổi. Staff vẫn
-- sửa được các trường khác của nhà cung cấp như trước. service_role và
-- postgres (migration, automation) không bị chặn.

create or replace function public.guard_supplier_pay_before_delivery()
returns trigger
language plpgsql
-- security invoker on purpose: current_user must be the caller, not the owner.
set search_path = public, pg_temp
as $$
begin
  if new.pay_before_delivery is distinct from old.pay_before_delivery
     and coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin')
     and not public.has_role(auth.uid(), 'owner') then
    raise exception 'pay_before_delivery_owner_only' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_supplier_pay_before_delivery() from public, anon, authenticated;

drop trigger if exists guard_supplier_pay_before_delivery on public.suppliers;
create trigger guard_supplier_pay_before_delivery
  before update of pay_before_delivery on public.suppliers
  for each row execute function public.guard_supplier_pay_before_delivery();
