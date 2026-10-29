-- Discard a supplier-order request whose email could not be sent.
--
-- The orderer can retry the same request_id: the failed request and its upload
-- rows are deleted, and the untouched draft PO is cancelled instead of being
-- left behind. A PO that is no longer a draft or already has a goods receipt,
-- payment request or incoming invoice keeps both the PO and the request.
--
-- Service-role only. The request is locked by supplier_order_requests.id (the
-- order_request_id returned by the create RPCs).

create or replace function public.discard_failed_supplier_order(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.supplier_order_requests%rowtype;
  v_po public.purchase_orders%rowtype;
  v_po_number text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select *
    into v_request
  from public.supplier_order_requests
  where id = p_request_id
  for update;

  if not found then
    return jsonb_build_object('discarded', false);
  end if;

  if v_request.status <> 'failed' then
    return jsonb_build_object('discarded', false);
  end if;

  if v_request.purchase_order_id is not null then
    select *
      into v_po
    from public.purchase_orders
    where id = v_request.purchase_order_id
    for update;

    if found then
      v_po_number := v_po.po_number;

      if v_po.status::text is distinct from 'draft' then
        return jsonb_build_object('discarded', false, 'reason', 'po_in_use');
      end if;

      if exists (
        select 1
        from public.goods_receipts gr
        where gr.purchase_order_id = v_po.id
      ) or exists (
        select 1
        from public.payment_requests pr
        where pr.purchase_order_id = v_po.id
      ) or exists (
        select 1
        from public.incoming_invoices ii
        where ii.purchase_order_id = v_po.id
      ) then
        return jsonb_build_object('discarded', false, 'reason', 'po_in_use');
      end if;

      update public.purchase_orders
      set status = 'cancelled'::public.purchase_order_status,
          notes = concat_ws(
            E'\n',
            nullif(btrim(coalesce(notes, '')), ''),
            'Huỷ tự động: email đặt hàng chưa gửi được'
          )
      where id = v_po.id;
    end if;
  end if;

  delete from public.supplier_order_uploads
  where order_request_id = v_request.id;

  delete from public.supplier_order_request_lines
  where request_id = v_request.id;

  delete from public.supplier_order_requests
  where id = v_request.id;

  return jsonb_build_object('discarded', true, 'po_number', v_po_number);
end;
$$;

revoke all on function public.discard_failed_supplier_order(uuid)
  from public, anon, authenticated;
grant execute on function public.discard_failed_supplier_order(uuid)
  to service_role;
