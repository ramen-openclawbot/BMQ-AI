-- Rollback-only smoke for the supplier ordering closed loop.
--
-- Apply 20261102970000_supplier_order_loop.sql first, then run this file in the
-- same transaction. It never commits: the last statement is `rollback;`.
--
-- 1. A sent one-line Phúc Thịnh order gets exactly one confirmed goods receipt
--    and one pending/unpaid payment request through
--    supplier_order_open_receipt_queue (called twice).
-- 2. The upload evidence is written to the PO, its GR and its PR exactly once.
-- 3. PO-000865 carries one GR and one PR (13.078.000 / VAT 968.741).
-- 4. supplier_orders gates the read RPCs (view) and catalog_set (edit).

begin;

select set_config('request.jwt.claim.role', 'service_role', true);
-- Like the edge's service-role client: no user in the token.
select set_config('request.jwt.claim.sub', '', true);
set local role service_role;

do $queue$
declare
  v_actor constant uuid := '27dbc34e-75ee-4973-8f9a-d1b125c90483';
  v_phuc constant uuid := 'bc39ded3-755c-4b31-9e4c-d7729e009608';
  v_mi999 constant uuid := '1039f461-8f9f-45a1-b05c-b96cb736812e';
  v_request_id uuid := gen_random_uuid();
  v_create jsonb;
  v_mark jsonb;
  v_queue1 jsonb;
  v_queue2 jsonb;
  v_po_id uuid;
  v_receipt_id uuid;
  v_payment_id uuid;
  v_count integer;
  v_po_count integer;
  v_total numeric;
  v_vat numeric;
  v_status text;
  v_payment_status text;
  v_po_total numeric;
  v_po_vat numeric;
begin
  v_create := public.create_supplier_order_multi(
    v_request_id,
    v_phuc,
    jsonb_build_array(
      jsonb_build_object('item_id', v_mi999, 'quantity', 25)
    ),
    'Smoke khép kín đặt hàng NCC',
    v_actor
  );

  v_po_id := (v_create ->> 'purchase_order_id')::uuid;
  if v_po_id is null then
    raise exception 'multi create did not return a purchase order: %', v_create;
  end if;

  v_mark := public.mark_supplier_order_sent(
    v_request_id,
    'smoke-gmail-message-id',
    null,
    null
  );
  if v_mark ->> 'status' <> 'sent' then
    raise exception 'mark_supplier_order_sent failed: %', v_mark;
  end if;

  v_queue1 := public.supplier_order_open_receipt_queue(v_request_id, v_actor);
  v_queue2 := public.supplier_order_open_receipt_queue(v_request_id, v_actor);

  v_receipt_id := (v_queue1 ->> 'goods_receipt_id')::uuid;
  v_payment_id := (v_queue1 ->> 'payment_request_id')::uuid;
  if v_receipt_id is null or v_payment_id is null then
    raise exception 'receipt queue did not return a GR and a PR: %', v_queue1;
  end if;
  if v_queue1 ->> 'receipt_number' is null
     or v_queue1 ->> 'request_number' is null then
    raise exception 'receipt queue must return receipt/request numbers: %', v_queue1;
  end if;

  -- Idempotent: the second call returns the same queue and creates nothing.
  if (v_queue2 ->> 'goods_receipt_id')::uuid is distinct from v_receipt_id
     or (v_queue2 ->> 'payment_request_id')::uuid is distinct from v_payment_id then
    raise exception 'second queue call created a different queue: %', v_queue2;
  end if;

  select count(*) into v_count
  from public.goods_receipts
  where purchase_order_id = v_po_id;
  if v_count <> 1 then
    raise exception 'expected exactly one goods receipt for %, got %', v_po_id, v_count;
  end if;

  select status::text into v_status
  from public.goods_receipts
  where id = v_receipt_id;
  if v_status is distinct from 'confirmed' then
    raise exception 'goods receipt must be confirmed, got %', v_status;
  end if;

  select count(*) into v_po_count
  from public.purchase_order_items
  where purchase_order_id = v_po_id;

  select count(*) into v_count
  from public.goods_receipt_items
  where goods_receipt_id = v_receipt_id;
  if v_count <> v_po_count then
    raise exception 'goods receipt lines (%) must match PO lines (%)', v_count, v_po_count;
  end if;

  if exists (
    select 1
    from public.purchase_order_items poi
    where poi.purchase_order_id = v_po_id
      and not exists (
        select 1
        from public.goods_receipt_items gri
        where gri.goods_receipt_id = v_receipt_id
          and gri.product_name = poi.product_name
          and gri.ordered_quantity = poi.quantity
      )
  ) then
    raise exception 'goods receipt lines must mirror the PO lines';
  end if;

  select count(*) into v_count
  from public.payment_requests
  where purchase_order_id = v_po_id;
  if v_count <> 1 then
    raise exception 'expected exactly one payment request for %, got %', v_po_id, v_count;
  end if;

  select status::text, payment_status::text, total_amount, vat_amount
  into v_status, v_payment_status, v_total, v_vat
  from public.payment_requests
  where id = v_payment_id;

  select total_amount, vat_amount
  into v_po_total, v_po_vat
  from public.purchase_orders
  where id = v_po_id;

  if v_status is distinct from 'pending'
     or v_payment_status is distinct from 'unpaid' then
    raise exception 'payment request must be pending/unpaid, got % / %',
      v_status, v_payment_status;
  end if;
  if v_total is distinct from v_po_total
     or v_vat is distinct from v_po_vat then
    raise exception 'payment request total/VAT (%) must match the PO (%)',
      v_total, v_po_total;
  end if;

  if not exists (
    select 1
    from public.supplier_order_requests
    where request_id = v_request_id
      and goods_receipt_id = v_receipt_id
      and payment_request_id = v_payment_id
      and receipt_queue_error is null
  ) then
    raise exception 'supplier order request must store the queue ids';
  end if;

  raise notice 'supplier order queue smoke passed';
end;
$queue$;

do $evidence$
declare
  v_actor constant uuid := '27dbc34e-75ee-4973-8f9a-d1b125c90483';
  v_phuc constant uuid := 'bc39ded3-755c-4b31-9e4c-d7729e009608';
  v_mi999 constant uuid := '1039f461-8f9f-45a1-b05c-b96cb736812e';
  v_request_id uuid := gen_random_uuid();
  v_create jsonb;
  v_attach jsonb;
  v_po_id uuid;
  v_receipt_id uuid;
  v_payment_id uuid;
  v_first constant text := 'PO-SMOKE-supplier-evidence.jpg';
  v_second constant text := 'PO-SMOKE-supplier-evidence-2.jpg';
  v_po_image text;
  v_gr_image text;
  v_pr_image text;
begin
  v_create := public.create_supplier_order_multi(
    v_request_id,
    v_phuc,
    jsonb_build_array(
      jsonb_build_object('item_id', v_mi999, 'quantity', 25)
    ),
    'Smoke evidence',
    v_actor
  );
  v_po_id := (v_create ->> 'purchase_order_id')::uuid;
  perform public.mark_supplier_order_sent(v_request_id, 'smoke-evidence', null, null);

  v_receipt_id := (
    public.supplier_order_open_receipt_queue(v_request_id, v_actor) ->> 'goods_receipt_id'
  )::uuid;
  v_payment_id := (
    public.supplier_order_open_receipt_queue(v_request_id, v_actor) ->> 'payment_request_id'
  )::uuid;

  v_attach := public.supplier_order_attach_evidence(v_request_id, v_first);
  if (v_attach ->> 'purchase_order_image_set')::boolean is not true
     or (v_attach ->> 'goods_receipt_image_set')::boolean is not true
     or (v_attach ->> 'payment_request_image_set')::boolean is not true then
    raise exception 'first evidence attach must set all three images: %', v_attach;
  end if;

  select image_url into v_po_image from public.purchase_orders where id = v_po_id;
  select image_url into v_gr_image from public.goods_receipts where id = v_receipt_id;
  select image_url into v_pr_image from public.payment_requests where id = v_payment_id;
  if v_po_image is distinct from v_first
     or v_gr_image is distinct from v_first
     or v_pr_image is distinct from v_first then
    raise exception 'evidence path was not written: %, %, %', v_po_image, v_gr_image, v_pr_image;
  end if;

  v_attach := public.supplier_order_attach_evidence(v_request_id, v_second);
  if (v_attach ->> 'purchase_order_image_set')::boolean is not false
     or (v_attach ->> 'goods_receipt_image_set')::boolean is not false
     or (v_attach ->> 'payment_request_image_set')::boolean is not false then
    raise exception 'second evidence attach must not overwrite: %', v_attach;
  end if;

  select image_url into v_po_image from public.purchase_orders where id = v_po_id;
  select image_url into v_gr_image from public.goods_receipts where id = v_receipt_id;
  select image_url into v_pr_image from public.payment_requests where id = v_payment_id;
  if v_po_image is distinct from v_first
     or v_gr_image is distinct from v_first
     or v_pr_image is distinct from v_first then
    raise exception 'evidence path was overwritten: %, %, %', v_po_image, v_gr_image, v_pr_image;
  end if;

  raise notice 'supplier order evidence smoke passed';
end;
$evidence$;

do $backfill$
declare
  v_po_id uuid;
  v_request_id uuid;
  v_receipt_id uuid;
  v_payment_id uuid;
  v_count integer;
  v_total numeric;
  v_vat numeric;
begin
  select po.id into v_po_id
  from public.purchase_orders po
  where po.po_number = 'PO-000865';
  if v_po_id is null then
    raise exception 'PO-000865 is missing';
  end if;

  select r.id, r.goods_receipt_id, r.payment_request_id
  into v_request_id, v_receipt_id, v_payment_id
  from public.supplier_order_requests r
  where r.purchase_order_id = v_po_id
    and r.status = 'sent'
  order by r.created_at desc
  limit 1;

  if v_request_id is null then
    raise exception 'PO-000865 has no sent supplier order request';
  end if;
  if v_receipt_id is null or v_payment_id is null then
    raise exception 'PO-000865 backfill did not store the queue ids';
  end if;

  select count(*) into v_count
  from public.goods_receipts
  where purchase_order_id = v_po_id;
  if v_count <> 1 then
    raise exception 'PO-000865 must have exactly one goods receipt, got %', v_count;
  end if;

  if not exists (
    select 1
    from public.goods_receipts gr
    where gr.id = v_receipt_id
      and gr.status = 'confirmed'
  ) then
    raise exception 'PO-000865 goods receipt must be confirmed';
  end if;

  select count(*) into v_count
  from public.goods_receipt_items
  where goods_receipt_id = v_receipt_id;
  if v_count <> 3 then
    raise exception 'PO-000865 goods receipt must have three lines, got %', v_count;
  end if;

  if not exists (
    select 1 from public.goods_receipt_items
    where goods_receipt_id = v_receipt_id
      and product_name ilike '%Bột mì 999%'
      and ordered_quantity = 200
  ) or not exists (
    select 1 from public.goods_receipt_items
    where goods_receipt_id = v_receipt_id
      and product_name ilike '%Bột mì 888%'
      and ordered_quantity = 250
  ) or not exists (
    select 1 from public.goods_receipt_items
    where goods_receipt_id = v_receipt_id
      and product_name ilike '%Sữa bột%'
      and ordered_quantity = 25
  ) then
    raise exception 'PO-000865 goods receipt lines do not match the order';
  end if;

  select count(*) into v_count
  from public.payment_requests
  where purchase_order_id = v_po_id;
  if v_count <> 1 then
    raise exception 'PO-000865 must have exactly one payment request, got %', v_count;
  end if;

  select total_amount, vat_amount
  into v_total, v_vat
  from public.payment_requests
  where id = v_payment_id;

  if v_total is distinct from 13078000 or v_vat is distinct from 968741 then
    raise exception 'PO-000865 payment request must be 13078000 / VAT 968741, got % / %',
      v_total, v_vat;
  end if;
  if not exists (
    select 1 from public.payment_requests
    where id = v_payment_id
      and status = 'pending'
      and payment_status = 'unpaid'
  ) then
    raise exception 'PO-000865 payment request must be pending/unpaid';
  end if;

  raise notice 'supplier order PO-000865 backfill smoke passed';
end;
$backfill$;

do $permissions$
declare
  v_actor uuid;
  v_phuc constant uuid := 'bc39ded3-755c-4b31-9e4c-d7729e009608';
  v_mi999 constant uuid := '1039f461-8f9f-45a1-b05c-b96cb736812e';
begin
  -- Pick a non-owner user and give it only supplier_orders view inside this
  -- transaction; everything rolls back.
  select ump.user_id into v_actor
  from public.user_module_permissions ump
  where ump.module_key = 'purchase_orders'
    and ump.can_edit = true
    and not public.has_role(ump.user_id, 'owner')
  order by ump.user_id
  limit 1;

  if v_actor is null then
    select ur.user_id into v_actor
    from public.user_roles ur
    where not public.has_role(ur.user_id, 'owner')
    order by ur.user_id
    limit 1;
  end if;

  if v_actor is null then
    raise exception 'no non-owner user exists for the permission smoke';
  end if;

  delete from public.user_module_permissions
  where user_id = v_actor
    and module_key = 'supplier_orders';
  insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
  values (v_actor, 'supplier_orders', true, false);

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_actor::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_actor::text, 'role', 'authenticated')::text,
    true
  );

  -- View permission can read the catalog and the history.
  perform public.supplier_order_catalog(v_phuc);
  perform public.supplier_order_history(v_mi999);

  -- View permission cannot edit the catalog.
  begin
    perform public.supplier_order_catalog_set(v_phuc, v_mi999, true, 'kg', 25, null);
    raise exception 'catalog_set was allowed with only view permission';
  exception when others then
    if sqlerrm not like '%insufficient_privilege%' then
      raise;
    end if;
  end;

  -- Neither supplier_orders nor owner can read the catalog.
  delete from public.user_module_permissions
  where user_id = v_actor
    and module_key = 'supplier_orders';

  begin
    perform public.supplier_order_catalog(v_phuc);
    raise exception 'catalog was allowed without supplier_orders permission';
  exception when others then
    if sqlerrm not like '%insufficient_privilege%' then
      raise;
    end if;
  end;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);

  raise notice 'supplier order permission smoke passed';
end;
$permissions$;

rollback;
