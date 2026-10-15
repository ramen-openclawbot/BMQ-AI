-- Kho văn phòng / Đặt hàng tự động: the PR / PO detail now returns its photo paths so the room can show them
-- (owner 16/10 IMG_5762: "Ko xem ảnh được"). Same SECURITY INVOKER function, same caller RLS; storage access
-- still goes through the client's signed URLs (resolveImageUrl), so a user who cannot read the bucket sees nothing.
--   * PR: image_path (payment_requests.image_url) + attachments (payment_request_attachments).
--   * PO: image_path (purchase_orders.image_url).
--   * GR (both): image_path (goods_receipts.image_url) + photos (goods_receipts.product_photos).

create or replace function public.get_payment_doc_detail(p_kind text, p_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_pr public.payment_requests%rowtype;
  v_po public.purchase_orders%rowtype;
  v_supplier jsonb;
  v_po_json jsonb;
  v_gr jsonb;
  v_prs jsonb;
  v_lines jsonb;
begin
  if p_kind = 'pr' then
    select *
      into v_pr
    from public.payment_requests pr
    where pr.id = p_id;

    if not found then
      return null;
    end if;

    v_supplier := null;
    if v_pr.supplier_id is not null then
      select jsonb_build_object('id', s.id, 'name', s.name)
        into v_supplier
      from public.suppliers s
      where s.id = v_pr.supplier_id;
    end if;

    v_po_json := null;
    if v_pr.purchase_order_id is not null then
      select jsonb_build_object(
        'id', po.id,
        'number', po.po_number,
        'date', po.order_date,
        'status', po.status,
        'amount', po.total_amount
      )
      into v_po_json
      from public.purchase_orders po
      where po.id = v_pr.purchase_order_id;
    end if;

    v_gr := null;
    select jsonb_build_object(
      'id', gr.id,
      'number', gr.receipt_number,
      'date', gr.receipt_date,
      'status', gr.status,
      'has_image', gr.image_url is not null,
      'image_path', gr.image_url,
      'photos', coalesce(to_jsonb(gr.product_photos), '[]'::jsonb)
    )
    into v_gr
    from public.goods_receipts gr
    where (
        v_pr.goods_receipt_id is not null
        and gr.id = v_pr.goods_receipt_id
      )
      or (
        v_pr.goods_receipt_id is null
        and gr.payment_request_id = v_pr.id
      )
    order by gr.receipt_date desc nulls last, gr.created_at desc
    limit 1;

    v_lines := coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', pri.product_name,
          'qty', pri.quantity,
          'unit', pri.unit,
          'price', pri.unit_price,
          'total', pri.line_total,
          'change', pri.price_change_percent
        )
        order by pri.created_at, pri.product_name
      )
      from public.payment_request_items pri
      where pri.payment_request_id = v_pr.id
    ), '[]'::jsonb);

    return jsonb_build_object(
      'kind', 'pr',
      'id', v_pr.id,
      'number', v_pr.request_number,
      'title', v_pr.title,
      'description', v_pr.description,
      'notes', v_pr.notes,
      'status', v_pr.status,
      'payment_status', v_pr.payment_status,
      'delivery_status', v_pr.delivery_status,
      'payment_type', v_pr.payment_type,
      'payment_method', v_pr.payment_method,
      'amount', v_pr.total_amount,
      'vat', v_pr.vat_amount,
      'created_at', v_pr.created_at::date,
      'invoice_created', v_pr.invoice_created,
      'has_image', v_pr.image_url is not null,
      'image_path', v_pr.image_url,
      'attachments', coalesce((
        select jsonb_agg(jsonb_build_object('path', att.storage_path, 'name', att.file_name, 'mime', att.mime_type) order by att.created_at)
        from public.payment_request_attachments att
        where att.payment_request_id = v_pr.id
      ), '[]'::jsonb),
      'supplier', v_supplier,
      'po', v_po_json,
      'gr', v_gr,
      'lines', v_lines
    );
  elsif p_kind = 'po' then
    select *
      into v_po
    from public.purchase_orders po
    where po.id = p_id;

    if not found then
      return null;
    end if;

    v_supplier := null;
    if v_po.supplier_id is not null then
      select jsonb_build_object('id', s.id, 'name', s.name)
        into v_supplier
      from public.suppliers s
      where s.id = v_po.supplier_id;
    end if;

    select jsonb_build_object(
      'id', gr.id,
      'number', gr.receipt_number,
      'date', gr.receipt_date,
      'status', gr.status,
      'has_image', gr.image_url is not null,
      'image_path', gr.image_url,
      'photos', coalesce(to_jsonb(gr.product_photos), '[]'::jsonb)
    )
    into v_gr
    from public.goods_receipts gr
    where gr.purchase_order_id = v_po.id
    order by gr.receipt_date desc nulls last, gr.created_at desc
    limit 1;

    v_prs := coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', pr.id,
          'number', pr.request_number,
          'status', pr.status,
          'payment_status', pr.payment_status,
          'amount', pr.total_amount
        )
        order by pr.created_at
      )
      from public.payment_requests pr
      where pr.purchase_order_id = v_po.id
    ), '[]'::jsonb);

    v_lines := coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', poi.product_name,
          'qty', poi.quantity,
          'unit', poi.unit,
          'price', poi.unit_price,
          'total', poi.line_total,
          'change', null
        )
        order by poi.created_at, poi.product_name
      )
      from public.purchase_order_items poi
      where poi.purchase_order_id = v_po.id
    ), '[]'::jsonb);

    return jsonb_build_object(
      'kind', 'po',
      'id', v_po.id,
      'number', v_po.po_number,
      'date', v_po.order_date,
      'expected', v_po.expected_date,
      'status', v_po.status,
      'amount', v_po.total_amount,
      'vat', v_po.vat_amount,
      'notes', v_po.notes,
      'has_image', v_po.image_url is not null,
      'image_path', v_po.image_url,
      'supplier', v_supplier,
      'gr', v_gr,
      'prs', v_prs,
      'lines', v_lines
    );
  else
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.get_payment_doc_detail(text, uuid) from public, anon;
grant execute on function public.get_payment_doc_detail(text, uuid) to authenticated, service_role;
