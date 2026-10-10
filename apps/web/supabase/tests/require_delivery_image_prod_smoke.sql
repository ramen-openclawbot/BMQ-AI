-- Rollback-only production smoke for migration
-- 20261012170000_require_delivery_image_before_approval.sql.
--
-- Run as one file:
--   supabase db query --linked -f supabase/tests/require_delivery_image_prod_smoke.sql
-- The file opens one transaction, applies the migration SQL inline, then
-- exercises: (a) a direct pending -> approved on a PO receipt without an image
-- must raise pr_requires_delivery_image with the real receipt number; (b) the
-- same transition on a receipt that already has an image must succeed; (c) the
-- canonical approve_payment_request_with_material_controller RPC must raise the
-- same guard (any earlier error is recorded, not failed); (d) with the switch
-- off the pending request can be approved; (e) an already approved request can
-- still update other columns. The final RAISE ends the transaction, so every
-- change is rolled back. No existing business row is persisted.
begin;
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

-- ---------------------------------------------------------------------------
-- Behavioural checks. Every step catches the expected exception / state; a
-- wrong result raises SMOKE_RESULT FAIL <step> and aborts the transaction.
-- ---------------------------------------------------------------------------
do $$
declare
  v_owner uuid;
  v_missing_id uuid;
  v_missing_receipt text;
  v_expected text;
  v_errored boolean;
  v_sqlstate text;
  v_message text;
  v_has_id uuid;
  v_has_receipt text;
  v_status text;
  v_c_note text := 'none';
  v_pending_missing integer;
begin
  -- (a) Direct pending -> approved on a PO receipt without a delivery image
  -- must fail with the new guard's P0001 message and the real receipt number.
  select pr.id, gr.receipt_number
    into v_missing_id, v_missing_receipt
    from public.payment_requests pr
    join public.goods_receipts gr on gr.id = pr.goods_receipt_id
    left join public.purchase_orders po on po.id = gr.purchase_order_id
   where pr.status::text = 'pending'
     and gr.purchase_order_id is not null
     and gr.receipt_number is not null
     and coalesce(nullif(gr.image_url, ''), nullif(po.image_url, '')) is null
   order by pr.request_number, gr.receipt_number
   limit 1;

  if v_missing_id is null then
    raise exception 'SMOKE_RESULT FAIL a_no_missing_image_candidate';
  end if;

  v_expected := 'pr_requires_delivery_image: ' || v_missing_receipt;
  v_errored := false;
  v_sqlstate := null;
  v_message := null;
  begin
    update public.payment_requests
       set status = 'approved'::public.payment_request_status
     where id = v_missing_id;
  exception when others then
    v_errored := true;
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_message = message_text;
  end;

  if not v_errored then
    raise exception 'SMOKE_RESULT FAIL a_missing_image_allowed: %', v_missing_receipt;
  end if;
  if v_sqlstate is distinct from 'P0001' then
    raise exception 'SMOKE_RESULT FAIL a_sqlstate: state=% message=%', v_sqlstate, v_message;
  end if;
  if v_message is distinct from v_expected then
    raise exception 'SMOKE_RESULT FAIL a_message: got=% expected=%', v_message, v_expected;
  end if;

  -- (b) Direct pending -> approved on a PO receipt that already has an image
  -- must succeed. Set the material-approval GUC so the independent material
  -- guard lets the direct update through (the smoke runs as the function owner).
  select pr.id, gr.receipt_number
    into v_has_id, v_has_receipt
    from public.payment_requests pr
    join public.goods_receipts gr on gr.id = pr.goods_receipt_id
    left join public.purchase_orders po on po.id = gr.purchase_order_id
   where pr.status::text = 'pending'
     and gr.purchase_order_id is not null
     and gr.receipt_number is not null
     and coalesce(nullif(gr.image_url, ''), nullif(po.image_url, '')) is not null
   order by pr.request_number, gr.receipt_number
   limit 1;

  if v_has_id is null then
    raise exception 'SMOKE_RESULT FAIL b_no_has_image_candidate';
  end if;

  perform set_config('material_master.payment_request_approval', v_has_id::text, true);
  update public.payment_requests
     set status = 'approved'::public.payment_request_status
   where id = v_has_id;
  perform set_config('material_master.payment_request_approval', '', true);

  select pr.status::text into v_status from public.payment_requests pr where pr.id = v_has_id;
  if v_status is distinct from 'approved' then
    raise exception 'SMOKE_RESULT FAIL b_not_approved: receipt=% status=%', v_has_receipt, v_status;
  end if;

  -- (c) The canonical approval RPC must hit the same guard. Any other early
  -- error (e.g. material readiness) is recorded in the PASS string, not failed.
  select ur.user_id into v_owner from public.user_roles ur where ur.role = 'owner' limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL c_owner_missing';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  v_message := null;
  begin
    perform public.approve_payment_request_with_material_controller(v_missing_id, 'bank_transfer', v_owner);
  exception when others then
    get stacked diagnostics v_message = message_text;
  end;

  if v_message = v_expected then
    v_c_note := 'approved_path_blocked';
  elsif v_message is null then
    raise exception 'SMOKE_RESULT FAIL c_rpc_did_not_raise: %', v_missing_receipt;
  else
    v_c_note := 'c_other_error: ' || left(v_message, 200);
  end if;

  -- (d) Switch off: the same pending request can now be approved.
  update public.finance_settings
     set value = 'false'::jsonb, updated_at = now()
   where key = 'require_delivery_image_before_approval';

  perform set_config('material_master.payment_request_approval', v_missing_id::text, true);
  update public.payment_requests
     set status = 'approved'::public.payment_request_status
   where id = v_missing_id;
  perform set_config('material_master.payment_request_approval', '', true);

  select pr.status::text into v_status from public.payment_requests pr where pr.id = v_missing_id;
  if v_status is distinct from 'approved' then
    raise exception 'SMOKE_RESULT FAIL d_switch_off_not_approved: receipt=% status=%', v_missing_receipt, v_status;
  end if;

  -- (e) An already approved request can still update other columns.
  begin
    update public.payment_requests
       set updated_at = now()
     where id = v_missing_id;
  exception when others then
    raise exception 'SMOKE_RESULT FAIL e_approved_update_blocked: %', sqlerrm;
  end;

  -- Pending phiếu chi whose PO receipt still has no delivery image.
  select count(*)
    into v_pending_missing
    from public.payment_requests pr
    join public.goods_receipts gr on gr.id = pr.goods_receipt_id
    left join public.purchase_orders po on po.id = gr.purchase_order_id
   where pr.status::text = 'pending'
     and gr.purchase_order_id is not null
     and coalesce(nullif(gr.image_url, ''), nullif(po.image_url, '')) is null;

  raise exception 'SMOKE_RESULT PASS: require delivery image before approval (pending_missing_image=%, a_receipt=%, b_receipt=%, c_rpc=%, d_switch_off=approved, e_non_status_update=ok)',
    v_pending_missing, v_missing_receipt, v_has_receipt, v_c_note;
end;
$$;
