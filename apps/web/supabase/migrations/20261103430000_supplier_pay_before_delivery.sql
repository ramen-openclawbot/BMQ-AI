-- Nhà cung cấp thanh toán trước khi giao (anh Tâm 29/10: Cholimex).
--
-- guard_payment_request_delivery_image chặn duyệt phiếu chi khi phiếu nhập
-- chưa có ảnh phiếu giao hàng. Với NCC phải trả tiền trước rồi mới giao, ảnh
-- giao hàng chỉ có sau khi đã chi, nên bỏ qua kiểm tra này cho NCC đó.
-- Phiếu nhập vẫn cần ảnh giao hàng khi hàng về như bình thường.

alter table public.suppliers
  add column if not exists pay_before_delivery boolean not null default false;

comment on column public.suppliers.pay_before_delivery is
  'NCC yêu cầu thanh toán trước khi giao: duyệt chi không cần ảnh phiếu giao hàng.';

create or replace function public.guard_payment_request_delivery_image()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_enabled boolean;
  v_receipt_number text;
  v_po_id uuid;
  v_image_url text;
  v_pay_before_delivery boolean;
begin
  if new.status::text = 'approved'
     and old.status::text is distinct from 'approved'
     and new.goods_receipt_id is not null then
    v_enabled := coalesce(
      (
        select (fs.value #>> '{}')::boolean
          from public.finance_settings fs
         where fs.key = 'require_delivery_image_before_approval'
      ),
      true
    );

    select coalesce(s.pay_before_delivery, false)
      into v_pay_before_delivery
      from public.suppliers s
     where s.id = new.supplier_id;

    if v_enabled and not coalesce(v_pay_before_delivery, false) then
      select gr.receipt_number,
             gr.purchase_order_id,
             coalesce(nullif(gr.image_url, ''), nullif(po.image_url, ''))
        into v_receipt_number, v_po_id, v_image_url
        from public.goods_receipts gr
        left join public.purchase_orders po on po.id = gr.purchase_order_id
       where gr.id = new.goods_receipt_id;

      if v_po_id is not null and v_image_url is null then
        raise exception 'pr_requires_delivery_image: %', v_receipt_number
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  return new;
end;
$$;

update public.suppliers
   set pay_before_delivery = true
 where id = 'ecd49e72-96fe-465d-b8a5-2c474aa7d6ae'; -- Cholimex
