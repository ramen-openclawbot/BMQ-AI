-- One transaction and one source-PO lock: recovery cannot leave an empty header
-- or create a second production order after a lost response.
create or replace function public.create_q7_production_from_po(
  p_po_id uuid, p_start_date date, p_end_date date, p_notes text, p_items jsonb
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_po public.customer_po_inbox%rowtype;
  v_order public.production_orders%rowtype;
  v_item jsonb;
  v_sku public.product_skus%rowtype;
  v_date date := coalesce(p_start_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_prefix text;
  v_sequence integer;
begin
  if auth.uid() is null or not public.can_edit_production_q7() then
    raise exception 'Q7 edit permission required' using errcode = '42501';
  end if;
  select * into v_po from public.customer_po_inbox where id = p_po_id for update;
  if not found then raise exception 'Source PO not found'; end if;
  select * into v_order from public.production_orders where source_po_inbox_id = p_po_id;
  if found then
    if not exists(select 1 from public.production_order_items where production_order_id = v_order.id) then
      raise exception 'Existing production order has no items; review it before continuing';
    end if;
    return jsonb_build_object('order', to_jsonb(v_order), 'reused', true);
  end if;
  if v_po.match_status not in ('approved', 'pending_approval') or v_po.match_status is null then
    raise exception 'Source PO is not approved for production';
  end if;
  if v_po.match_status <> 'approved' and (
    lower(coalesce(v_po.from_email,'')) ~ '@([a-z0-9-]+\.)?kingfoodmart\.com$'
    or v_po.revenue_channel in ('cake_kingfoodmart','wholesale_kfm')
    or v_po.raw_payload #>> '{po_automation,rule}' = 'kingfood_po_automation'
    or exists(select 1 from public.mini_crm_customers c where c.id=v_po.matched_customer_id
      and (lower(c.customer_code)='b2b-kfm' or lower(c.customer_name) ~ 'king[[:space:]]*food|\mkfm\M'))
  ) then
    raise exception 'KFM PO must be confirmed through portal intake first';
  end if;
  if v_po.raw_payload->>'source' = 'kfm_portal' and not exists(
    select 1 from public.kfm_po_intake_attempts a
    where a.inbox_id=p_po_id and a.state='imported' and a.decision='confirm'
  ) then
    raise exception 'KFM confirmation has not been verified';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Production items are required';
  end if;
  if jsonb_array_length(p_items) > 500 or p_end_date < v_date then
    raise exception 'Invalid production plan';
  end if;
  if v_po.raw_payload->>'source' = 'kfm_portal'
    and jsonb_array_length(p_items) is distinct from jsonb_array_length(v_po.production_items) then
    raise exception 'The complete confirmed portal PO is required';
  end if;
  if exists(select 1 from jsonb_array_elements(p_items) x group by x->>'sku_id' having count(*)>1) then
    raise exception 'Duplicate production SKU';
  end if;
  -- Validate the entire plan before inserting a header. Quantities may be
  -- adjusted by staff, but must be finite/nonnegative and use enabled Q7 SKUs.
  for v_item in select value from jsonb_array_elements(p_items) loop
    select s.* into v_sku from public.product_skus s
      join public.production_location_sku_settings q on q.sku_id=s.id
      where s.id=(v_item->>'sku_id')::uuid and q.location_code='q7' and q.is_enabled;
    if not found then raise exception 'SKU is not enabled for Q7'; end if;
    if v_po.raw_payload->>'source' = 'kfm_portal' and not exists(
      select 1 from jsonb_array_elements(v_po.production_items) source_item
      where (source_item->>'sku_id'=v_sku.id::text or
        (source_item->>'sku_id' is null and upper(trim(coalesce(source_item->>'sku_code',source_item->>'sku'))) = upper(trim(v_sku.sku_code))))
        and (source_item->>'qty')::numeric = (v_item->>'original_qty')::numeric
        and (source_item->>'date')::date = (v_item->>'date')::date
    ) then
      raise exception 'Production item does not match the confirmed portal PO';
    end if;
    if coalesce(v_item->>'product_name','') = '' or coalesce(v_item->>'unit','') = ''
      or coalesce(v_item->>'planned_qty','') !~ '^([0-9]+([.][0-9]+)?|[.][0-9]+)$'
      or coalesce(v_item->>'original_qty','') !~ '^([0-9]+([.][0-9]+)?|[.][0-9]+)$'
      or (v_item->>'planned_qty')::numeric > 999999999999
      or (v_item->>'original_qty')::numeric > 999999999999 then
      raise exception 'Invalid production item';
    end if;
  end loop;
  v_prefix := 'SX-' || to_char(v_date,'YYYYMMDD') || '-';
  perform pg_advisory_xact_lock(hashtextextended('q7-production-number:'||v_prefix,0));
  select coalesce(max(substring(production_number from length(v_prefix)+1)::integer),0)+1
    into v_sequence from public.production_orders
    where production_number like v_prefix||'%' and substring(production_number from length(v_prefix)+1) ~ '^[0-9]+$';
  insert into public.production_orders(production_number, source_po_inbox_id, status, location_code,
    planned_start_date, planned_end_date, notes, created_by)
    values(v_prefix||lpad(v_sequence::text, greatest(3,length(v_sequence::text)), '0'), p_po_id, 'planned', 'q7',
      v_date, p_end_date, nullif(p_notes,''), auth.uid()) returning * into v_order;
  insert into public.production_order_items(production_order_id,sku_id,product_name,ordered_qty,planned_qty,unit,delivery_date,notes)
    select v_order.id,s.id,s.product_name,(x->>'original_qty')::numeric,
      (x->>'planned_qty')::numeric,coalesce(nullif(s.unit,''),
        case when v_po.raw_payload->>'source'='kfm_portal' then
          (select source_item->>'unit' from jsonb_array_elements(v_po.production_items) source_item
            where source_item->>'sku_id'=s.id::text or
              (source_item->>'sku_id' is null and upper(trim(coalesce(source_item->>'sku_code',source_item->>'sku')))=upper(trim(s.sku_code))) limit 1)
          else x->>'unit' end),nullif(x->>'date','')::date,
      case when (x->>'planned_qty')::numeric != (x->>'original_qty')::numeric
        then 'Đã điều chỉnh số lượng trước khi xác nhận' else null end
    from jsonb_array_elements(p_items) x join public.product_skus s on s.id=(x->>'sku_id')::uuid;
  return jsonb_build_object('order',to_jsonb(v_order),'reused',false);
end;
$$;
revoke all on function public.create_q7_production_from_po(uuid,date,date,text,jsonb) from public, anon;
grant execute on function public.create_q7_production_from_po(uuid,date,date,text,jsonb) to authenticated;
