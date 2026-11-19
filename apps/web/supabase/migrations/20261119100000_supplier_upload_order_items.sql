-- Trang NCC tải hoá đơn (ai.banhmique.vn/ncc/hoa-don/<token>) hiện đủ các dòng của PO.
-- Trước đây chỉ trả dòng đầu và quantity của supplier_order_requests (null với đơn
-- nhiều dòng), nên trang hiện "Nước lau nhà Power · 0" cho PO-000916 (7 dòng).
-- Giữ nguyên các khoá cũ; thêm 'items' và 'total_amount'.

create or replace function public.resolve_supplier_order_upload_token(p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_request public.supplier_order_requests%rowtype;
  v_po_number text;
  v_supplier_name text;
  v_product_name text;
  v_upload_count integer := 0;
  v_items jsonb;
begin
  if nullif(btrim(coalesce(p_token_hash, '')), '') is null then
    return null;
  end if;

  select * into v_request
  from public.supplier_order_requests
  where id = public.supplier_order_request_id_for_upload_token(p_token_hash);

  if not found then
    return null;
  end if;

  select po.po_number into v_po_number
  from public.purchase_orders po
  where po.id = v_request.purchase_order_id;

  select s.name into v_supplier_name
  from public.suppliers s
  where s.id = v_request.supplier_id;

  select poi.product_name into v_product_name
  from public.purchase_order_items poi
  where poi.purchase_order_id = v_request.purchase_order_id
  order by poi.created_at asc
  limit 1;

  -- Every line of the PO (owner 19/11: a 7-line Kamereo order showed only its first item, quantity 0).
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_name', poi.product_name,
           'quantity', poi.quantity,
           'unit', poi.unit
         ) order by poi.created_at asc, poi.id asc), '[]'::jsonb)
    into v_items
  from public.purchase_order_items poi
  where poi.purchase_order_id = v_request.purchase_order_id;

  select count(*) into v_upload_count
  from public.supplier_order_uploads u
  where u.order_request_id = v_request.id;

  return jsonb_build_object(
    'order_request_id', v_request.id,
    'po_number', v_po_number,
    'supplier_name', v_supplier_name,
    'product_name', coalesce(v_product_name, ''),
    'quantity', v_request.quantity,
    'unit', v_request.unit,
    'sent_at', v_request.sent_at,
    'upload_count', v_upload_count,
    'items', v_items,
    'total_amount', v_request.total_amount
  );
end;
$function$;
