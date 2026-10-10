-- Bắt buộc ảnh phiếu giao hàng trước khi duyệt phiếu chi theo PO.
--
-- Bối cảnh: phiếu chi gắn phiếu nhập (goods_receipts) của một PO chỉ được duyệt
-- khi có ảnh phiếu giao hàng, lấy từ gr.image_url hoặc (nếu phiếu nhập trống) từ
-- po.image_url. Công tắc finance_settings.require_delivery_image_before_approval
-- bật mặc định; khi tắt, việc duyệt được phép như trước.
--
-- Điều kiện đã kiểm trên database thật trước khi viết migration (CHỈ SELECT):
--   * public.approve_payment_request_with_material_controller(uuid, text, uuid)
--     đặt public.payment_requests.status = 'approved' trực tiếp, nên trigger
--     BEFORE UPDATE OF status dưới đây bắt được mọi đường duyệt.
--   * public.approve_payment_requests_with_unc(uuid[], jsonb, text) gọi lại
--     public.approve_payment_request_with_material_controller cho từng phiếu
--     'pending', nên cũng đi qua trigger này.
--   * Trigger BEFORE UPDATE trên public.payment_requests được PostgreSQL bắn theo
--     thứ tự tên: trg_guard_payment_request_delivery_image (migration này) chạy
--     trước trg_guard_payment_request_material_approval và
--     trg_guard_payment_request_po_total, nên lỗi thiếu ảnh nổi lên trước.
--   * public.guard_payment_request_material_approval chỉ chặn UPDATE trực tiếp
--     sang 'approved' khi thiếu GUC; trigger này độc lập và không cần GUC.
--   * Hàm duyệt chỉ đổi status khi phiếu còn 'pending'/'approved'; điều kiện
--     old.status is distinct from 'approved' bảo đảm không chặn phiếu đã duyệt,
--     rejected hoặc paid.
--   * 53 phiếu chi 'pending' có phiếu nhập PO thiếu ảnh và 49 phiếu có ảnh.
--
-- Migration này KHÔNG sửa public.approve_payment_request_with_material_controller,
-- public.approve_payment_requests_with_unc, public.finalize_goods_receipt hay
-- public.auto_receive_goods_receipt; chỉ thêm một trigger và một công tắc.

-- ---------------------------------------------------------------------------
-- 1. Công tắc hệ thống (mặc định bật), giữ nguyên khi đã có.
-- ---------------------------------------------------------------------------
insert into public.finance_settings (key, value)
values ('require_delivery_image_before_approval', 'true'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Hàm trigger: chặn pending -> approved khi phiếu nhập PO thiếu ảnh.
-- ---------------------------------------------------------------------------
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

    if v_enabled then
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

comment on function public.guard_payment_request_delivery_image() is
  'BEFORE UPDATE OF status: từ chối pending -> approved khi phiếu chi gắn phiếu nhập thuộc PO mà thiếu ảnh phiếu giao hàng (gr.image_url và po.image_url đều trống) và công tắc require_delivery_image_before_approval bật. Lỗi pr_requires_delivery_image: <receipt_number>, errcode P0001.';

-- ---------------------------------------------------------------------------
-- 3. Trigger BEFORE UPDATE OF status.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_guard_payment_request_delivery_image on public.payment_requests;
create trigger trg_guard_payment_request_delivery_image
before update of status on public.payment_requests
for each row
execute function public.guard_payment_request_delivery_image();

-- ---------------------------------------------------------------------------
-- 4. Không cho client gọi trực tiếp hàm trigger.
-- ---------------------------------------------------------------------------
revoke all on function public.guard_payment_request_delivery_image() from public, anon, authenticated;
