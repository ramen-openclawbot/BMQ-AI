-- 2026-11-01. Procurement unit-drift fix.
--
-- Live 14/10: create_procurement_line_with_material_resolution ->
-- apply_procurement_line_material_resolution raised
-- 'procurement source unit drift' (23514) whenever the inserted line's unit had
-- been rewritten by the document-line normalising trigger
-- (purchase_order_items_normalize_unit and its siblings on payment_request_items
-- / goods_receipt_items, from 20261022100000_shared_catalog_units.sql). The
-- trigger rewrites a known unit spelling to the standard label (cai -> cái,
-- chiếc -> cái, gr -> g, từ -> tờ, lít -> l, ...), so the stored line unit no
-- longer matched the raw unit the caller passed. This migration re-creates
-- public.apply_procurement_line_material_resolution byte-for-byte from its
-- newest definition (20260817170000_task6_procurement_material_controller.sql)
-- and changes ONLY the unit drift comparison: both sides are cast through the
-- same stock_unit_code -> label mapping, with the previous lower(btrim(...))
-- fallback for unknown spellings. Nothing else in the function, its signature,
-- its security or its search_path changes.
--
-- This file is not applied by the agent. The Maestro applies it, then runs the
-- PO-000842 repair (create the lines + ensure_purchase_order_receipt_queue).

create or replace function public.apply_procurement_line_material_resolution(
  p_source_table text,
  p_source_line_id uuid,
  p_raw_name text,
  p_raw_code text default null,
  p_raw_unit text default null,
  p_supplier_id uuid default null,
  p_source_type text default null,
  p_reason text default 'procurement material resolution exact link',
  p_expected_material_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_table text := lower(btrim(coalesce(p_source_table, '')));
  v_source_type text := lower(btrim(coalesce(p_source_type, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_raw_name text := nullif(btrim(coalesce(p_raw_name, '')), '');
  v_raw_unit text := nullif(btrim(coalesce(p_raw_unit, '')), '');
  v_line record;
  v_parent_id uuid;
  v_supplier_id uuid;
  v_kind text;
  v_required_caps text[] := array['unit'];
  v_resolved jsonb;
  v_request jsonb;
  v_request_id uuid;
  v_request_status text;
  v_request_resolution_status text;
  v_request_resolved_material_id uuid;
  v_material_id uuid;
  v_status text;
  v_ready jsonb;
begin
  if not (
    coalesce(public.material_master_jwt_role(), '') = 'service_role'
    or public.has_role((select auth.uid()), 'owner')
    or (v_table = 'purchase_order_items' and public.has_module_permission((select auth.uid()), 'purchase_orders', 'edit'))
    or (v_table = 'payment_request_items' and public.has_module_permission((select auth.uid()), 'payment_requests', 'edit'))
    or (v_table = 'invoice_items' and public.has_module_permission((select auth.uid()), 'finance_cost', 'edit'))
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_table not in ('purchase_order_items','payment_request_items','invoice_items') then
    raise exception 'unsupported procurement source table' using errcode = '22023';
  end if;
  if v_source_type = '' then
    v_source_type := case v_table when 'purchase_order_items' then 'purchase_order' when 'payment_request_items' then 'payment_request' else 'invoice' end;
  end if;
  if v_source_type not in ('purchase_order','payment_request','invoice','create_invoice_from_pr') then
    raise exception 'unsupported procurement source_type' using errcode = '22023';
  end if;
  if p_source_line_id is null or v_raw_name is null or v_reason is null then
    raise exception 'source line, raw_name, and reason required' using errcode = '22023';
  end if;

  if v_table = 'purchase_order_items' then
    select poi.id, poi.purchase_order_id as parent_id, po.supplier_id, poi.product_name, poi.unit, poi.sku_id, null::text as standard_cost_code_type,
           poi.canonical_material_id, poi.material_resolution_status, poi.material_resolution_request_id, poi.raw_product_name
      into v_line
    from public.purchase_order_items poi join public.purchase_orders po on po.id = poi.purchase_order_id
    where poi.id = p_source_line_id for update;
  elsif v_table = 'payment_request_items' then
    select pri.id, pri.payment_request_id as parent_id, pr.supplier_id, pri.product_name, pri.unit, pri.sku_id, pri.standard_cost_code_type,
           pri.canonical_material_id, pri.material_resolution_status, pri.material_resolution_request_id, pri.raw_product_name
      into v_line
    from public.payment_request_items pri join public.payment_requests pr on pr.id = pri.payment_request_id
    where pri.id = p_source_line_id for update;
  else
    select ii.id, ii.invoice_id as parent_id, inv.supplier_id, ii.product_name, ii.unit, null::uuid as sku_id, ii.standard_cost_code_type,
           ii.canonical_material_id, ii.material_resolution_status, ii.material_resolution_request_id, ii.raw_product_name
      into v_line
    from public.invoice_items ii join public.invoices inv on inv.id = ii.invoice_id
    where ii.id = p_source_line_id for update;
  end if;
  if not found then raise exception 'procurement source line not found' using errcode = 'P0002'; end if;
  v_parent_id := v_line.parent_id;
  v_supplier_id := coalesce(p_supplier_id, v_line.supplier_id);
  if p_supplier_id is not null and v_line.supplier_id is distinct from p_supplier_id then
    raise exception 'procurement supplier identity mismatch' using errcode = '23514';
  end if;
  if v_line.raw_product_name is not null and public.material_master_normalize(v_line.raw_product_name) <> public.material_master_normalize(v_raw_name) then
    raise exception 'procurement source raw identity drift' using errcode = '23514';
  elsif v_line.raw_product_name is null and public.material_master_normalize(v_line.product_name) <> public.material_master_normalize(v_raw_name) then
    raise exception 'procurement source raw identity drift' using errcode = '23514';
  end if;
  if coalesce(
       (select u.label from public.stock_units u where u.code = public.stock_unit_code(v_line.unit)),
       lower(btrim(coalesce(v_line.unit, '')))
     ) is distinct from coalesce(
       (select u.label from public.stock_units u where u.code = public.stock_unit_code(coalesce(v_raw_unit, v_line.unit))),
       lower(btrim(coalesce(v_raw_unit, v_line.unit, '')))
     ) then
    -- Both spellings are cast through the same stock_unit_code -> label mapping
    -- the document-line trigger (purchase_order_items_normalize_unit and its
    -- siblings) applies, so cai / Cái / chiếc / gr / từ / lít all resolve to the
    -- same standard label as the stored line unit. Unknown spellings
    -- (stock_unit_code returns null) fall back to the historical lower(btrim(...)).
    raise exception 'procurement source unit drift' using errcode = '23514';
  end if;

  v_kind := public.procurement_material_line_kind(v_table, p_source_line_id, v_line.standard_cost_code_type, v_line.sku_id, v_line.canonical_material_id);
  if v_kind in ('finished_good','service_or_non_material') then
    perform set_config('material_master.procurement_line_resolution', p_source_line_id::text, true);
    if v_table = 'purchase_order_items' then
      update public.purchase_order_items set raw_product_name = coalesce(raw_product_name, v_raw_name), material_resolution_status = coalesce(material_resolution_status, v_kind) where id = p_source_line_id;
    elsif v_table = 'payment_request_items' then
      update public.payment_request_items set raw_product_name = coalesce(raw_product_name, v_raw_name), material_resolution_status = coalesce(material_resolution_status, v_kind) where id = p_source_line_id;
    else
      update public.invoice_items set raw_product_name = coalesce(raw_product_name, v_raw_name), material_resolution_status = coalesce(material_resolution_status, v_kind) where id = p_source_line_id;
    end if;
    perform set_config('material_master.procurement_line_resolution', '', true);
    return jsonb_build_object('status',v_kind,'line_kind',v_kind,'source_table',v_table,'source_id',p_source_line_id,'material_id',null,'request_id',null,'resolved_exact',false);
  end if;

  if v_supplier_id is not null then v_required_caps := array['unit','supplier_product']; end if;
  v_resolved := public.resolve_canonical_material(v_raw_name, p_raw_code, coalesce(v_raw_unit, v_line.unit), v_supplier_id, v_source_type, current_date, v_required_caps);
  v_status := coalesce(v_resolved->>'status', 'controller_error');
  v_material_id := nullif(v_resolved->>'material_id', '')::uuid;
  if p_expected_material_id is not null and v_material_id is distinct from p_expected_material_id then
    raise exception 'procurement material resolver did not return expected material' using errcode = '23514';
  end if;

  v_request := public.request_material_resolution(
    v_source_type, v_table, v_parent_id, p_source_line_id, v_raw_name, p_raw_code, coalesce(v_raw_unit, v_line.unit), v_supplier_id,
    jsonb_build_object('candidate_source', coalesce(v_resolved->>'match_source', v_status), 'confidence', case when coalesce((v_resolved->>'resolved_exact')::boolean, false) then 'exact' else 'pending' end, 'field_name', v_table || '.canonical_material_id')
  );
  v_request_id := nullif(v_request->>'request_id', '')::uuid;
  v_request_status := v_request->>'status';
  v_request_resolution_status := v_request->>'resolution_status';
  v_request_resolved_material_id := nullif(v_request->>'resolved_material_id', '')::uuid;
  if v_request_id is null or v_request_status not in ('already_resolved','request_existing','request_created') then
    raise exception 'stable material resolution request required' using errcode = '23514';
  end if;

  if coalesce((v_resolved->>'resolved_exact')::boolean, false) is not true then
    perform set_config('material_master.procurement_line_resolution', p_source_line_id::text, true);
    if v_table = 'purchase_order_items' then
      update public.purchase_order_items set raw_product_name = coalesce(raw_product_name, v_raw_name), material_resolution_status = case when v_kind = 'unknown' then 'unknown' else v_status end, material_resolution_request_id = v_request_id where id = p_source_line_id;
    elsif v_table = 'payment_request_items' then
      update public.payment_request_items set raw_product_name = coalesce(raw_product_name, v_raw_name), material_resolution_status = case when v_kind = 'unknown' then 'unknown' else v_status end, material_resolution_request_id = v_request_id where id = p_source_line_id;
    else
      update public.invoice_items set raw_product_name = coalesce(raw_product_name, v_raw_name), material_resolution_status = case when v_kind = 'unknown' then 'unknown' else v_status end, material_resolution_request_id = v_request_id where id = p_source_line_id;
    end if;
    perform set_config('material_master.procurement_line_resolution', '', true);
    return jsonb_build_object('status',case when v_kind = 'unknown' then 'unknown' else v_status end,'line_kind',v_kind,'source_table',v_table,'source_id',p_source_line_id,'material_id',null,'request_id',v_request_id,'resolved_exact',false);
  end if;

  if v_request_resolution_status not in ('resolved_existing','created_new')
    or v_request_resolved_material_id is distinct from v_material_id then
    raise exception 'terminal exact request evidence required' using errcode = '23514';
  end if;

  v_ready := public.assert_material_ready(v_material_id, v_required_caps, v_supplier_id, coalesce(v_raw_unit, v_line.unit), current_date);
  if coalesce((v_ready->>'ready')::boolean, false) is not true then
    raise exception 'procurement canonical material not ready: %', v_ready using errcode = '23514';
  end if;

  if v_line.canonical_material_id is not null and v_line.canonical_material_id <> v_material_id then
    raise exception 'procurement line already linked to different canonical material' using errcode = '23514';
  end if;
  if v_line.canonical_material_id = v_material_id and v_line.material_resolution_request_id = v_request_id and v_line.material_resolution_status = 'resolved_exact' then
    return jsonb_build_object('status','linked_unchanged','line_kind',v_kind,'source_table',v_table,'source_id',p_source_line_id,'material_id',v_material_id,'request_id',v_request_id,'resolved_exact',true);
  end if;

  perform set_config('material_master.procurement_line_resolution', p_source_line_id::text, true);
  if v_table = 'purchase_order_items' then
    update public.purchase_order_items set canonical_material_id = v_material_id, material_resolution_status = 'resolved_exact', material_resolution_request_id = v_request_id, raw_product_name = coalesce(raw_product_name, v_raw_name) where id = p_source_line_id;
  elsif v_table = 'payment_request_items' then
    update public.payment_request_items set canonical_material_id = v_material_id, material_resolution_status = 'resolved_exact', material_resolution_request_id = v_request_id, raw_product_name = coalesce(raw_product_name, v_raw_name) where id = p_source_line_id;
  else
    update public.invoice_items set canonical_material_id = v_material_id, material_resolution_status = 'resolved_exact', material_resolution_request_id = v_request_id, raw_product_name = coalesce(raw_product_name, v_raw_name) where id = p_source_line_id;
  end if;
  perform set_config('material_master.procurement_line_resolution', '', true);

  perform public.material_master_audit_append(
    'apply_procurement_line_material_resolution', v_material_id, v_request_id, v_reason,
    jsonb_build_object('source_table',v_table,'source_id',p_source_line_id,'canonical_material_id',v_line.canonical_material_id,'material_resolution_status',v_line.material_resolution_status,'material_resolution_request_id',v_line.material_resolution_request_id),
    jsonb_build_object('source_table',v_table,'source_id',p_source_line_id,'canonical_material_id',v_material_id,'material_resolution_status','resolved_exact','material_resolution_request_id',v_request_id,'raw_product_name',coalesce(v_line.raw_product_name, v_raw_name)),
    jsonb_build_object('source_type',v_source_type,'source_table',v_table,'source_id',p_source_line_id)
  );
  return jsonb_build_object('status','linked','line_kind',v_kind,'source_table',v_table,'source_id',p_source_line_id,'material_id',v_material_id,'request_id',v_request_id,'resolved_exact',true);
end;
$$;

revoke execute on function public.apply_procurement_line_material_resolution(text, uuid, text, text, text, uuid, text, text, uuid) from public, anon;
grant execute on function public.apply_procurement_line_material_resolution(text, uuid, text, text, text, uuid, text, text, uuid) to authenticated, service_role;
comment on function public.apply_procurement_line_material_resolution(text, uuid, text, text, text, uuid, text, text, uuid) is 'Task6 narrow RPC: only path allowed to write protected canonical_material_id/raw_product_name/material_resolution_status/material_resolution_request_id on PO/PR/invoice lines.';
