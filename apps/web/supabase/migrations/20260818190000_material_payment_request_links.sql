-- Link canonical NVL to existing Duyet chi lines without changing financial state.
-- No historical backfill: every write is one-row, exact-evidence or explicit legacy-SKU confirmation.

create or replace function public.get_material_payment_request_links(p_material_id uuid)
returns table (
  payment_request_item_id uuid,
  payment_request_id uuid,
  request_number text,
  request_status text,
  request_created_at timestamptz,
  supplier_id uuid,
  vendor_display_name text,
  product_name text,
  product_code text,
  quantity numeric,
  unit text,
  unit_price numeric,
  line_total numeric,
  link_state text,
  candidate_source text,
  canonical_material_id uuid
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_view_material_master()
    or not (
      coalesce(public.material_master_jwt_role(), '') = 'service_role'
      or public.has_role((select auth.uid()), 'owner')
      or public.has_module_permission((select auth.uid()), 'payment_requests', 'view')
    ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_material_id is null then
    raise exception 'material_id required' using errcode = '22023';
  end if;

  return query
  select
    pri.id as payment_request_item_id,
    pr.id as payment_request_id,
    pr.request_number,
    pr.status::text as request_status,
    pr.created_at as request_created_at,
    pr.supplier_id,
    s.name as vendor_display_name,
    pri.product_name,
    pri.product_code,
    pri.quantity,
    pri.unit,
    pri.unit_price,
    pri.line_total,
    case when pri.canonical_material_id = m.id then 'linked' else 'candidate' end as link_state,
    case
      when pri.canonical_material_id = m.id then 'linked'
      when exists (
        select 1
        from public.material_supplier_products msp
        where msp.material_id = m.id
          and msp.supplier_id = pr.supplier_id
          and msp.active = true
          and msp.approved = true
          and public.material_master_normalize(pri.product_name) = public.material_master_normalize(msp.supplier_product_name)
          and lower(btrim(coalesce(pri.unit, ''))) = lower(btrim(msp.purchase_unit))
      ) then 'approved_supplier_product'
      when pr.supplier_id is not null
        and pri.sku_id = m.ingredient_sku_id
        and m.ingredient_sku_id is not null
        and 1 = (select count(*) from public.sku_cogs_materials m_unique where m_unique.active = true and m_unique.ingredient_sku_id = m.ingredient_sku_id)
        then 'legacy_raw_sku_exact'
      else null
    end as candidate_source,
    pri.canonical_material_id
  from public.sku_cogs_materials m
  join public.payment_request_items pri
    on pri.canonical_material_id = m.id
    or (
      pri.canonical_material_id is null
      and (
        exists (
          select 1
          from public.payment_requests pr_match
          join public.material_supplier_products msp
            on msp.supplier_id = pr_match.supplier_id
           and msp.material_id = m.id
           and msp.active = true
           and msp.approved = true
           and public.material_master_normalize(pri.product_name) = public.material_master_normalize(msp.supplier_product_name)
           and lower(btrim(coalesce(pri.unit, ''))) = lower(btrim(msp.purchase_unit))
          where pr_match.id = pri.payment_request_id
        )
        or (
          pri.sku_id = m.ingredient_sku_id
          and m.ingredient_sku_id is not null
          and 1 = (select count(*) from public.sku_cogs_materials m_unique where m_unique.active = true and m_unique.ingredient_sku_id = m.ingredient_sku_id)
        )
      )
    )
  join public.payment_requests pr on pr.id = pri.payment_request_id
  left join public.suppliers s on s.id = pr.supplier_id
  where m.id = p_material_id
    and m.active = true
    and (
      pri.canonical_material_id = m.id
      or pr.supplier_id is not null
    )
  order by pr.created_at desc, pri.id;
end;
$$;

revoke all on function public.get_material_payment_request_links(uuid) from public, anon;
grant execute on function public.get_material_payment_request_links(uuid) to authenticated, service_role;

create or replace function public.link_material_payment_request_item(
  p_material_id uuid,
  p_expected_material_version integer,
  p_payment_request_item_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_material public.sku_cogs_materials%rowtype;
  v_line record;
  v_supplier_product public.material_supplier_products%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_candidate_source text;
  v_request jsonb;
  v_confirm jsonb;
  v_request_id uuid;
  v_confirm_material_id uuid;
  v_old jsonb;
  v_new_version integer;
begin
  if not public.can_edit_material_master()
    or not (
      coalesce(public.material_master_jwt_role(), '') = 'service_role'
      or public.has_role((select auth.uid()), 'owner')
      or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
    ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_material_id is null or p_payment_request_item_id is null then
    raise exception 'material and payment request item required' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'reason required' using errcode = '22023';
  end if;

  -- Keep legacy ingredient-SKU uniqueness stable until the one-row link commits.
  lock table public.sku_cogs_materials in share mode;

  select * into v_material
  from public.sku_cogs_materials
  where id = p_material_id and active = true
  for update;
  if not found then
    raise exception 'active canonical material not found' using errcode = 'P0002';
  end if;

  select
    pri.id,
    pri.payment_request_id,
    pri.product_name,
    pri.product_code,
    pri.quantity,
    pri.unit,
    pri.unit_price,
    pri.line_total,
    pri.sku_id,
    pri.raw_product_name,
    pri.canonical_material_id,
    pri.material_resolution_status,
    pri.material_resolution_request_id,
    pr.supplier_id,
    pr.request_number,
    pr.status::text as request_status
  into v_line
  from public.payment_request_items pri
  join public.payment_requests pr on pr.id = pri.payment_request_id
  where pri.id = p_payment_request_item_id
  for update of pri;
  if not found then
    raise exception 'payment request item not found' using errcode = 'P0002';
  end if;

  if v_line.canonical_material_id = p_material_id
    and v_line.material_resolution_status = 'resolved_exact'
    and v_line.material_resolution_request_id is not null then
    return jsonb_build_object(
      'status', 'payment_request_link_unchanged',
      'material_id', p_material_id,
      'payment_request_item_id', v_line.id,
      'request_id', v_line.material_resolution_request_id,
      'material_version', v_material.version
    );
  end if;
  if v_line.canonical_material_id is not null then
    raise exception 'payment request item already linked to different canonical material' using errcode = '23514';
  end if;
  if v_material.version is distinct from p_expected_material_version then
    raise exception 'material version conflict' using errcode = '40001';
  end if;
  if v_line.supplier_id is null then
    raise exception 'payment request supplier required for manual canonical confirmation' using errcode = '23514';
  end if;

  select * into v_supplier_product
  from public.material_supplier_products
  where material_id = p_material_id
    and supplier_id = v_line.supplier_id
    and active = true
    and approved = true
    and public.material_master_normalize(v_line.product_name) = public.material_master_normalize(supplier_product_name)
    and lower(btrim(coalesce(v_line.unit, ''))) = lower(btrim(purchase_unit))
  order by created_at asc, id asc
  limit 1
  for update;

  if found then
    v_candidate_source := 'approved_supplier_product';
  elsif v_line.sku_id = v_material.ingredient_sku_id
    and v_material.ingredient_sku_id is not null
    and 1 = (
      select count(*)
      from public.sku_cogs_materials m_unique
      where m_unique.active = true
        and m_unique.ingredient_sku_id = v_material.ingredient_sku_id
    ) then
    v_candidate_source := 'legacy_raw_sku_exact';
  else
    raise exception 'payment request material candidate is not exact' using errcode = '23514';
  end if;

  v_request := public.request_material_resolution(
    'payment_request',
    'payment_request_items',
    v_line.payment_request_id,
    v_line.id,
    coalesce(v_line.raw_product_name, v_line.product_name),
    v_line.product_code,
    v_line.unit,
    v_line.supplier_id,
    jsonb_build_object(
      'candidate_source', v_candidate_source,
      'confidence', case when v_candidate_source = 'approved_supplier_product' then 'exact' else 'confirmed_exact' end,
      'field_name', 'payment_request_items.canonical_material_id'
    )
  );
  v_request_id := nullif(v_request->>'request_id', '')::uuid;
  if v_request_id is null then
    raise exception 'stable material resolution request required' using errcode = '23514';
  end if;

  v_confirm := public.confirm_material_resolution(
    v_request_id,
    'resolve_existing',
    p_material_id,
    null,
    jsonb_build_object(
      'alias_name', coalesce(v_line.raw_product_name, v_line.product_name),
      'candidate_source', v_candidate_source,
      'confidence', case when v_candidate_source = 'approved_supplier_product' then 'exact' else 'confirmed_exact' end,
      'field_name', 'payment_request_items.canonical_material_id'
    ),
    '{}'::jsonb,
    v_reason
  );
  v_confirm_material_id := nullif(v_confirm->>'material_id', '')::uuid;
  if coalesce(v_confirm->>'status', '') not in ('resolved_existing', 'resolution_unchanged')
    or v_confirm_material_id is distinct from p_material_id then
    raise exception 'payment request confirmation did not resolve expected material' using errcode = '23514';
  end if;

  v_old := jsonb_build_object(
    'payment_request_item_id', v_line.id,
    'canonical_material_id', v_line.canonical_material_id,
    'material_resolution_status', v_line.material_resolution_status,
    'material_resolution_request_id', v_line.material_resolution_request_id
  );

  perform set_config('material_master.procurement_line_resolution', v_line.id::text, true);
  update public.payment_request_items set canonical_material_id = p_material_id,
    material_resolution_status = 'resolved_exact',
    material_resolution_request_id = v_request_id,
    raw_product_name = coalesce(raw_product_name, product_name)
  where id = v_line.id;
  perform set_config('material_master.procurement_line_resolution', '', true);

  perform set_config('material_master.rpc_update', 'on', true);
  update public.sku_cogs_materials
  set version = version + 1,
      updated_at = now(),
      updated_by = auth.uid()
  where id = p_material_id
  returning version into v_new_version;
  perform set_config('material_master.rpc_update', '', true);

  perform public.material_master_audit_append(
    'link_material_payment_request_item',
    p_material_id,
    v_request_id,
    v_reason,
    v_old,
    jsonb_build_object(
      'payment_request_item_id', v_line.id,
      'payment_request_id', v_line.payment_request_id,
      'canonical_material_id', p_material_id,
      'material_resolution_status', 'resolved_exact',
      'material_resolution_request_id', v_request_id
    ),
    jsonb_build_object(
      'source_type', 'payment_request',
      'candidate_source', v_candidate_source,
      'request_number', v_line.request_number
    )
  );

  return jsonb_build_object(
    'status', 'payment_request_linked',
    'material_id', p_material_id,
    'payment_request_item_id', v_line.id,
    'payment_request_id', v_line.payment_request_id,
    'request_id', v_request_id,
    'candidate_source', v_candidate_source,
    'material_version', v_new_version
  );
end;
$$;

revoke all on function public.link_material_payment_request_item(uuid, integer, uuid, text) from public, anon;
grant execute on function public.link_material_payment_request_item(uuid, integer, uuid, text) to authenticated, service_role;
