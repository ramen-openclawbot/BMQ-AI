-- 2026-11-02: stock-alias -> canonical Material Master links for documents.
--
-- The warehouse game already records how each supplier writes an item in
-- public.stock_material_aliases (line_class='stock').  This migration turns
-- those approved labels into real Material Master links:
--   * public.stock_alias_canonical_material() resolves one raw document name to
--     the canonical material of the linked kitchen item (supplier -> global ->
--     unambiguous any-supplier, the same precedence the read-only document RPC
--     uses).  It follows merged_into_id at most five hops and returns null when
--     the labels disagree.
--   * public.link_documents_from_stock_aliases() links kitchen items that lack
--     canonical_material_id, then links untouched purchase_order_items,
--     payment_request_items, invoice_items and goods_receipt_items through the
--     existing controller functions only.
--   * an AFTER trigger on stock_material_aliases keeps new/changed stock labels
--     flowing to documents.
--   * resolve_canonical_material() gains one fallback branch at the very end:
--     when every existing lookup misses, try the stock alias.  Earlier branches
--     are untouched.
--   * get_stock_item_names_for_lines() also returns the canonical material and
--     the last purchase price/date for that material.
--
-- No document product_name / product_code / unit / quantity / price / total is
-- written here, no line is deleted, and no guard trigger is disabled.

-- ---------------------------------------------------------------------------
-- 1. Resolve one document spelling to the canonical material of its stock item
-- ---------------------------------------------------------------------------

create or replace function public.stock_alias_canonical_material(
  p_supplier_id uuid,
  p_raw_name text
)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_norm text := public.normalize_stock_item_name(p_raw_name);
  v_use_supplier boolean := false;
  v_has_global boolean := false;
  v_item_id uuid;
  v_final_item uuid;
  v_steps integer;
  v_item public.kitchen_inventory_items%rowtype;
  v_item_ids uuid[] := '{}'::uuid[];
  v_material_id uuid;
  v_distinct_items integer;
  r record;
begin
  if v_norm is null or btrim(v_norm) = '' then
    return null;
  end if;

  if p_supplier_id is not null and exists (
    select 1
    from public.stock_material_aliases a
    where a.normalized_name = v_norm
      and a.line_class = 'stock'
      and a.kitchen_inventory_item_id is not null
      and a.supplier_id = p_supplier_id
  ) then
    v_use_supplier := true;
  end if;

  v_has_global := exists (
    select 1
    from public.stock_material_aliases a
    where a.normalized_name = v_norm
      and a.line_class = 'stock'
      and a.kitchen_inventory_item_id is not null
      and a.supplier_id is null
  );

  for r in
    select distinct a.kitchen_inventory_item_id as item_id
    from public.stock_material_aliases a
    where a.normalized_name = v_norm
      and a.line_class = 'stock'
      and a.kitchen_inventory_item_id is not null
      and (
        (v_use_supplier and a.supplier_id = p_supplier_id)
        or (not v_use_supplier and v_has_global and a.supplier_id is null)
        or (not v_use_supplier and not v_has_global)
      )
    order by a.kitchen_inventory_item_id
  loop
    v_final_item := r.item_id;
    v_steps := 0;
    loop
      select * into v_item
      from public.kitchen_inventory_items k
      where k.id = v_final_item;

      if not found then
        return null;
      end if;
      if v_item.active is not true then
        return null;
      end if;
      if v_item.merged_into_id is null then
        exit;
      end if;

      v_steps := v_steps + 1;
      if v_steps > 5 then
        return null;
      end if;
      v_final_item := v_item.merged_into_id;
    end loop;

    if v_final_item is null then
      return null;
    end if;
    v_item_ids := array_append(v_item_ids, v_final_item);
  end loop;

  if cardinality(v_item_ids) = 0 then
    return null;
  end if;

  select count(distinct x) into v_distinct_items from unnest(v_item_ids) x;
  if v_distinct_items <> 1 then
    return null;
  end if;

  select k.canonical_material_id into v_material_id
  from public.kitchen_inventory_items k
  where k.id = v_item_ids[1];

  if v_material_id is null then
    return null;
  end if;

  if not exists (
    select 1
    from public.sku_cogs_materials m
    where m.id = v_material_id
      and m.active = true
  ) then
    return null;
  end if;

  return v_material_id;
end;
$$;

comment on function public.stock_alias_canonical_material(uuid, text) is
  'Resolve a raw document name to the active canonical material of its stock alias (supplier -> global -> unambiguous any-supplier). Returns null on disagreement or unusable merge chains.';

revoke all on function public.stock_alias_canonical_material(uuid, text) from public, anon;
grant execute on function public.stock_alias_canonical_material(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Backfill / replay controller
-- ---------------------------------------------------------------------------

create or replace function public.link_documents_from_stock_aliases(
  p_supplier_id uuid default null,
  p_normalized_name text default null,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dry boolean := coalesce(p_dry_run, true);
  v_filter_supplier uuid := p_supplier_id;
  v_filter_norm text := nullif(btrim(coalesce(p_normalized_name, '')), '');
  v_errors jsonb;
  v_candidates integer;
  v_linked integer;
  v_already integer;
  v_conflict integer;
  v_no_material integer;
  v_error_count integer;
  v_created_aliases integer;
  v_created_materials integer;
  v_total_candidates integer := 0;
  v_total_linked integer := 0;
  v_total_already integer := 0;
  v_total_conflict integer := 0;
  v_total_no_material integer := 0;
  v_total_errors integer := 0;
  v_total_created_aliases integer := 0;
  v_total_created_materials integer := 0;
  v_k_items jsonb;
  v_po_items jsonb;
  v_pr_items jsonb;
  v_inv_items jsonb;
  v_gr_items jsonb;
  v_item_ids uuid[] := '{}'::uuid[];
  v_item_ids_all uuid[] := '{}'::uuid[];
  v_linkable jsonb := '{}'::jsonb;
  v_item public.kitchen_inventory_items%rowtype;
  v_next_item public.kitchen_inventory_items%rowtype;
  v_final_item uuid;
  v_item_id uuid;
  v_steps integer;
  v_material_id uuid;
  v_material_unit text;
  v_created jsonb;
  v_factor numeric;
  v_unit_diff boolean;
  v_linkable_material uuid;
  v_raw text;
  v_material uuid;
  v_master_norm text;
  v_source_type text;
  v_alias_count integer;
  v_alias_same integer;
  v_alias_exists boolean;
  v_alias_payload jsonb;
  v_candidate_source text;
  v_version integer;
  v_req jsonb;
  v_confirm jsonb;
  v_apply jsonb;
  v_req_id uuid;
  v_req_resolved uuid;
  v_req_status text;
  v_fallback_setting text;
  v_gr_controller regprocedure;
  r record;
begin
  if not (
    public.has_role(auth.uid(), 'owner')
    or coalesce(public.material_master_jwt_role(), '') = 'service_role'
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- -----------------------------------------------------------------------
  -- Step 1: kitchen items referenced by a confirmed stock label
  -- -----------------------------------------------------------------------
  for r in
    select a.kitchen_inventory_item_id as item_id
    from public.stock_material_aliases a
    where a.line_class = 'stock'
      and a.kitchen_inventory_item_id is not null
      and (v_filter_supplier is null or a.supplier_id = v_filter_supplier)
      and (v_filter_norm is null or a.normalized_name = v_filter_norm)
    order by a.kitchen_inventory_item_id, a.id
  loop
    v_final_item := r.item_id;
    v_steps := 0;
    loop
      select * into v_item
      from public.kitchen_inventory_items k
      where k.id = v_final_item;

      if not found then
        v_final_item := null;
        exit;
      end if;
      if v_item.active is not true then
        v_final_item := null;
        exit;
      end if;
      if v_item.merged_into_id is null then
        exit;
      end if;

      v_steps := v_steps + 1;
      if v_steps > 5 then
        v_final_item := null;
        exit;
      end if;
      v_final_item := v_item.merged_into_id;
    end loop;

    if v_final_item is not null and not (v_final_item = any (v_item_ids)) then
      v_item_ids := array_append(v_item_ids, v_final_item);
    end if;
  end loop;

  begin
    v_linkable := public.link_kitchen_items_to_canonical_materials();
  exception when others then
    v_linkable := '{}'::jsonb;
  end;

  v_candidates := 0;
  v_linked := 0;
  v_already := 0;
  v_conflict := 0;
  v_no_material := 0;
  v_error_count := 0;
  v_errors := '[]'::jsonb;
  v_created_materials := 0;

  foreach v_item_id in array v_item_ids
  loop
    select * into v_item
    from public.kitchen_inventory_items k
    where k.id = v_item_id;

    if not found
       or v_item.active is not true
       or v_item.merged_into_id is not null then
      continue;
    end if;

    if v_item.canonical_material_id is not null then
      v_already := v_already + 1;
      continue;
    end if;

    v_candidates := v_candidates + 1;

    -- Items the owner already marked as not-material keep their skip record;
    -- creating a canonical material for them would be wrong and would burn a
    -- material code on every replay.
    if exists (
      select 1
      from public.material_link_skips s
      where s.item_id = v_item.id
    ) then
      v_no_material := v_no_material + 1;
      if jsonb_array_length(v_errors) < 20 then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'item_id', v_item.id,
          'message', 'material_link_skips'
        ));
      end if;
      continue;
    end if;

    if v_dry then
      v_linked := v_linked + 1;
      continue;
    end if;

    begin
      v_material_id := null;

      select nullif(e ->> 'material_id', '')::uuid
      into v_linkable_material
      from jsonb_array_elements(coalesce(v_linkable -> 'linkable_items', '[]'::jsonb)) e
      where e ->> 'item_id' = v_item.id::text
      limit 1;

      if v_linkable_material is not null then
        v_material_id := v_linkable_material;
      end if;

      if v_material_id is null then
        begin
          v_created := public.create_canonical_material(
            null,
            v_item.name,
            v_item.unit,
            null,
            null,
            null,
            'game kho: tạo mã cho món đã chốt nhãn',
            null
          );
          v_material_id := (v_created ->> 'material_id')::uuid;
          v_created_materials := v_created_materials + 1;
        exception when unique_violation then
          select m.id into v_material_id
          from public.sku_cogs_materials m
          where m.normalized_name = public.material_master_normalize(v_item.name)
            and m.active = true
          order by m.created_at, m.id
          limit 1;
        end;
      end if;

      if v_material_id is null then
        raise exception 'no active canonical material for kitchen item %', v_item.id using errcode = 'P0002';
      end if;

      select m.default_unit into v_material_unit
      from public.sku_cogs_materials m
      where m.id = v_material_id;

      v_unit_diff := lower(btrim(coalesce(v_item.unit, ''))) <> lower(btrim(coalesce(v_material_unit, '')));
      v_factor := case
        when v_unit_diff then public.q7_unit_factor(v_item.unit, v_material_unit)
        else null
      end;

      perform public.q7_link_item_material_internal(
        v_item.id,
        v_material_id,
        false,
        null,
        v_factor,
        v_unit_diff and v_factor is null
      );

      v_linked := v_linked + 1;
    exception when others then
      v_error_count := v_error_count + 1;
      if jsonb_array_length(v_errors) < 20 then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'item_id', v_item.id,
          'message', sqlerrm
        ));
      end if;
    end;
  end loop;

  v_k_items := jsonb_build_object(
    'candidates', v_candidates,
    'linked', v_linked,
    'already_linked', v_already,
    'conflict', v_conflict,
    'no_material', v_no_material,
    'errors', v_errors,
    'error_count', v_error_count,
    'created_materials', v_created_materials
  );
  v_total_candidates := v_total_candidates + v_candidates;
  v_total_linked := v_total_linked + v_linked;
  v_total_already := v_total_already + v_already;
  v_total_conflict := v_total_conflict + v_conflict;
  v_total_no_material := v_total_no_material + v_no_material;
  v_total_errors := v_total_errors + v_error_count;
  v_total_created_materials := v_total_created_materials + v_created_materials;

  -- -----------------------------------------------------------------------
  -- Step 2a: purchase_order_items
  -- -----------------------------------------------------------------------
  v_candidates := 0;
  v_linked := 0;
  v_already := 0;
  v_conflict := 0;
  v_no_material := 0;
  v_error_count := 0;
  v_errors := '[]'::jsonb;
  v_created_aliases := 0;

  select count(*) into v_already
  from public.purchase_order_items poi
  join public.purchase_orders po on po.id = poi.purchase_order_id
  where poi.canonical_material_id is not null
    and (v_filter_supplier is null or po.supplier_id = v_filter_supplier)
    and (
      v_filter_norm is null
      or public.normalize_stock_item_name(coalesce(nullif(btrim(poi.raw_product_name), ''), poi.product_name)) = v_filter_norm
    );

  for r in
    select
      poi.id as line_id,
      poi.purchase_order_id as parent_id,
      po.supplier_id,
      coalesce(nullif(btrim(poi.raw_product_name), ''), poi.product_name) as raw_name,
      null::text as product_code,
      poi.unit
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
    where poi.canonical_material_id is null
      and (v_filter_supplier is null or po.supplier_id = v_filter_supplier)
      and (
        v_filter_norm is null
        or public.normalize_stock_item_name(coalesce(nullif(btrim(poi.raw_product_name), ''), poi.product_name)) = v_filter_norm
      )
    order by poi.id
  loop
    v_candidates := v_candidates + 1;
    v_raw := r.raw_name;
    if v_raw is null or btrim(v_raw) = '' then
      v_no_material := v_no_material + 1;
      continue;
    end if;

    v_material := public.stock_alias_canonical_material(r.supplier_id, v_raw);
    if v_material is null then
      v_no_material := v_no_material + 1;
      continue;
    end if;

    v_master_norm := public.material_master_normalize(v_raw);
    v_source_type := 'purchase_order';
    v_candidate_source := case when r.supplier_id is null then 'approved_source_alias' else 'approved_supplier_alias' end;
    v_alias_payload := jsonb_build_object(
      'alias_name', v_raw,
      'candidate_source', v_candidate_source,
      'confidence', 'exact',
      'field_name', 'purchase_order_items.canonical_material_id'
    );

    if r.supplier_id is not null then
      select count(*) filter (where a.material_id = v_material), count(*)
      into v_alias_same, v_alias_count
      from public.material_scoped_aliases a
      where a.supplier_id = r.supplier_id
        and a.normalized_alias = v_master_norm
        and a.active = true
        and a.approved = true;
    else
      select count(*) filter (where a.material_id = v_material), count(*)
      into v_alias_same, v_alias_count
      from public.material_scoped_aliases a
      where a.supplier_id is null
        and a.source_type = v_source_type
        and a.normalized_alias = v_master_norm
        and a.active = true
        and a.approved = true;
    end if;

    if v_alias_count > 0 and v_alias_same < v_alias_count then
      v_conflict := v_conflict + 1;
      continue;
    end if;

    v_alias_exists := v_alias_count > 0;

    if v_dry then
      v_linked := v_linked + 1;
      continue;
    end if;

    begin
      if r.supplier_id is not null and not exists (
        select 1
        from public.material_supplier_products sp
        where sp.material_id = v_material
          and sp.supplier_id = r.supplier_id
          and sp.active = true
          and sp.approved = true
      ) then
        select coalesce(m.version, 1) into v_version
        from public.sku_cogs_materials m
        where m.id = v_material;
        perform public.link_material_supplier(
          v_material,
          v_version,
          r.supplier_id,
          'game kho: nhãn đã chốt'
        );
      end if;

      -- A previous controller pass may have left a pending request for this
      -- exact line. Confirm it to the stock-alias material instead of letting
      -- the apply controller reject stale request evidence.
      v_req_id := null;
      select req.id into v_req_id
      from public.material_resolution_requests req
      where req.source_table = 'purchase_order_items'
        and req.source_id = r.parent_id
        and req.source_line_id = r.line_id
        and req.status = 'pending'
        and req.supplier_id is not distinct from r.supplier_id
        and public.material_master_normalize(req.raw_name) = public.material_master_normalize(v_raw)
      order by req.created_at desc, req.id desc
      limit 1;

      if v_req_id is not null then
        v_confirm := public.confirm_material_resolution(
          v_req_id,
          'resolve_existing',
          v_material,
          null,
          v_alias_payload,
          '{}'::jsonb,
          'game kho: nhãn đã chốt'
        );

        if not v_alias_exists and nullif(v_confirm ->> 'alias_id', '') is not null then
          v_created_aliases := v_created_aliases + 1;
        end if;
        v_alias_exists := true;
      elsif not v_alias_exists and v_master_norm <> '' then
        v_fallback_setting := current_setting('material_master.stock_alias_fallback', true);
        begin
          perform set_config('material_master.stock_alias_fallback', 'off', true);
          v_req := public.request_material_resolution(
            v_source_type,
            'purchase_order_items',
            r.parent_id,
            r.line_id,
            v_raw,
            r.product_code,
            r.unit,
            r.supplier_id,
            v_alias_payload
          );
        exception when others then
          perform set_config('material_master.stock_alias_fallback', coalesce(v_fallback_setting, ''), true);
          raise;
        end;
        perform set_config('material_master.stock_alias_fallback', coalesce(v_fallback_setting, ''), true);

        v_req_resolved := nullif(v_req ->> 'resolved_material_id', '')::uuid;
        v_req_status := coalesce(v_req ->> 'resolution_status', '');

        if v_req_resolved is not null and v_req_resolved <> v_material then
          v_conflict := v_conflict + 1;
          continue;
        end if;

        if v_req_status not in ('resolved_existing', 'created_new') then
          v_req_id := nullif(v_req ->> 'request_id', '')::uuid;
          if v_req_id is null then
            raise exception 'material resolution request id missing' using errcode = 'P0002';
          end if;

          v_confirm := public.confirm_material_resolution(
            v_req_id,
            'resolve_existing',
            v_material,
            null,
            v_alias_payload,
            '{}'::jsonb,
            'game kho: nhãn đã chốt'
          );

          if nullif(v_confirm ->> 'alias_id', '') is not null then
            v_created_aliases := v_created_aliases + 1;
          end if;
        end if;
      end if;
    exception when others then
      v_error_count := v_error_count + 1;
      if jsonb_array_length(v_errors) < 20 then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'line_id', r.line_id,
          'message', sqlerrm
        ));
      end if;
      continue;
    end;

    begin
      v_apply := public.apply_procurement_line_material_resolution(
        'purchase_order_items',
        r.line_id,
        v_raw,
        r.product_code,
        r.unit,
        r.supplier_id,
        null,
        'game kho: nhãn đã chốt',
        v_material
      );

      if coalesce((v_apply ->> 'resolved_exact')::boolean, false)
         and nullif(v_apply ->> 'material_id', '')::uuid = v_material then
        v_linked := v_linked + 1;
      else
        v_no_material := v_no_material + 1;
        if jsonb_array_length(v_errors) < 20 then
          v_errors := v_errors || jsonb_build_array(jsonb_build_object(
            'line_id', r.line_id,
            'message', coalesce(v_apply ->> 'status', 'not_linked')
          ));
        end if;
      end if;
    exception when others then
      v_error_count := v_error_count + 1;
      if jsonb_array_length(v_errors) < 20 then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'line_id', r.line_id,
          'message', sqlerrm
        ));
      end if;
    end;
  end loop;

  v_po_items := jsonb_build_object(
    'candidates', v_candidates,
    'linked', v_linked,
    'already_linked', v_already,
    'conflict', v_conflict,
    'no_material', v_no_material,
    'errors', v_errors,
    'error_count', v_error_count,
    'created_aliases', v_created_aliases
  );
  v_total_candidates := v_total_candidates + v_candidates;
  v_total_linked := v_total_linked + v_linked;
  v_total_already := v_total_already + v_already;
  v_total_conflict := v_total_conflict + v_conflict;
  v_total_no_material := v_total_no_material + v_no_material;
  v_total_errors := v_total_errors + v_error_count;
  v_total_created_aliases := v_total_created_aliases + v_created_aliases;

  -- -----------------------------------------------------------------------
  -- Step 2b: payment_request_items
  -- -----------------------------------------------------------------------
  v_candidates := 0;
  v_linked := 0;
  v_already := 0;
  v_conflict := 0;
  v_no_material := 0;
  v_error_count := 0;
  v_errors := '[]'::jsonb;
  v_created_aliases := 0;

  select count(*) into v_already
  from public.payment_request_items pri
  join public.payment_requests pr on pr.id = pri.payment_request_id
  where pri.canonical_material_id is not null
    and (v_filter_supplier is null or pr.supplier_id = v_filter_supplier)
    and (
      v_filter_norm is null
      or public.normalize_stock_item_name(coalesce(nullif(btrim(pri.raw_product_name), ''), pri.product_name)) = v_filter_norm
    );

  for r in
    select
      pri.id as line_id,
      pri.payment_request_id as parent_id,
      pr.supplier_id,
      coalesce(nullif(btrim(pri.raw_product_name), ''), pri.product_name) as raw_name,
      pri.product_code,
      pri.unit
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    where pri.canonical_material_id is null
      and (v_filter_supplier is null or pr.supplier_id = v_filter_supplier)
      and (
        v_filter_norm is null
        or public.normalize_stock_item_name(coalesce(nullif(btrim(pri.raw_product_name), ''), pri.product_name)) = v_filter_norm
      )
    order by pri.id
  loop
    v_candidates := v_candidates + 1;
    v_raw := r.raw_name;
    if v_raw is null or btrim(v_raw) = '' then
      v_no_material := v_no_material + 1;
      continue;
    end if;

    v_material := public.stock_alias_canonical_material(r.supplier_id, v_raw);
    if v_material is null then
      v_no_material := v_no_material + 1;
      continue;
    end if;

    v_master_norm := public.material_master_normalize(v_raw);
    v_source_type := 'payment_request';
    v_candidate_source := case when r.supplier_id is null then 'approved_source_alias' else 'approved_supplier_alias' end;
    v_alias_payload := jsonb_build_object(
      'alias_name', v_raw,
      'candidate_source', v_candidate_source,
      'confidence', 'exact',
      'field_name', 'payment_request_items.canonical_material_id'
    );

    if r.supplier_id is not null then
      select count(*) filter (where a.material_id = v_material), count(*)
      into v_alias_same, v_alias_count
      from public.material_scoped_aliases a
      where a.supplier_id = r.supplier_id
        and a.normalized_alias = v_master_norm
        and a.active = true
        and a.approved = true;
    else
      select count(*) filter (where a.material_id = v_material), count(*)
      into v_alias_same, v_alias_count
      from public.material_scoped_aliases a
      where a.supplier_id is null
        and a.source_type = v_source_type
        and a.normalized_alias = v_master_norm
        and a.active = true
        and a.approved = true;
    end if;

    if v_alias_count > 0 and v_alias_same < v_alias_count then
      v_conflict := v_conflict + 1;
      continue;
    end if;

    v_alias_exists := v_alias_count > 0;

    if v_dry then
      v_linked := v_linked + 1;
      continue;
    end if;

    begin
      if r.supplier_id is not null and not exists (
        select 1
        from public.material_supplier_products sp
        where sp.material_id = v_material
          and sp.supplier_id = r.supplier_id
          and sp.active = true
          and sp.approved = true
      ) then
        select coalesce(m.version, 1) into v_version
        from public.sku_cogs_materials m
        where m.id = v_material;
        perform public.link_material_supplier(
          v_material,
          v_version,
          r.supplier_id,
          'game kho: nhãn đã chốt'
        );
      end if;

      v_req_id := null;
      select req.id into v_req_id
      from public.material_resolution_requests req
      where req.source_table = 'payment_request_items'
        and req.source_id = r.parent_id
        and req.source_line_id = r.line_id
        and req.status = 'pending'
        and req.supplier_id is not distinct from r.supplier_id
        and public.material_master_normalize(req.raw_name) = public.material_master_normalize(v_raw)
      order by req.created_at desc, req.id desc
      limit 1;

      if v_req_id is not null then
        v_confirm := public.confirm_material_resolution(
          v_req_id,
          'resolve_existing',
          v_material,
          null,
          v_alias_payload,
          '{}'::jsonb,
          'game kho: nhãn đã chốt'
        );

        if not v_alias_exists and nullif(v_confirm ->> 'alias_id', '') is not null then
          v_created_aliases := v_created_aliases + 1;
        end if;
        v_alias_exists := true;
      elsif not v_alias_exists and v_master_norm <> '' then
        v_fallback_setting := current_setting('material_master.stock_alias_fallback', true);
        begin
          perform set_config('material_master.stock_alias_fallback', 'off', true);
          v_req := public.request_material_resolution(
            v_source_type,
            'payment_request_items',
            r.parent_id,
            r.line_id,
            v_raw,
            r.product_code,
            r.unit,
            r.supplier_id,
            v_alias_payload
          );
        exception when others then
          perform set_config('material_master.stock_alias_fallback', coalesce(v_fallback_setting, ''), true);
          raise;
        end;
        perform set_config('material_master.stock_alias_fallback', coalesce(v_fallback_setting, ''), true);

        v_req_resolved := nullif(v_req ->> 'resolved_material_id', '')::uuid;
        v_req_status := coalesce(v_req ->> 'resolution_status', '');

        if v_req_resolved is not null and v_req_resolved <> v_material then
          v_conflict := v_conflict + 1;
          continue;
        end if;

        if v_req_status not in ('resolved_existing', 'created_new') then
          v_req_id := nullif(v_req ->> 'request_id', '')::uuid;
          if v_req_id is null then
            raise exception 'material resolution request id missing' using errcode = 'P0002';
          end if;

          v_confirm := public.confirm_material_resolution(
            v_req_id,
            'resolve_existing',
            v_material,
            null,
            v_alias_payload,
            '{}'::jsonb,
            'game kho: nhãn đã chốt'
          );

          if nullif(v_confirm ->> 'alias_id', '') is not null then
            v_created_aliases := v_created_aliases + 1;
          end if;
        end if;
      end if;
    exception when others then
      v_error_count := v_error_count + 1;
      if jsonb_array_length(v_errors) < 20 then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'line_id', r.line_id,
          'message', sqlerrm
        ));
      end if;
      continue;
    end;

    begin
      v_apply := public.apply_procurement_line_material_resolution(
        'payment_request_items',
        r.line_id,
        v_raw,
        r.product_code,
        r.unit,
        r.supplier_id,
        null,
        'game kho: nhãn đã chốt',
        v_material
      );

      if coalesce((v_apply ->> 'resolved_exact')::boolean, false)
         and nullif(v_apply ->> 'material_id', '')::uuid = v_material then
        v_linked := v_linked + 1;
      else
        v_no_material := v_no_material + 1;
        if jsonb_array_length(v_errors) < 20 then
          v_errors := v_errors || jsonb_build_array(jsonb_build_object(
            'line_id', r.line_id,
            'message', coalesce(v_apply ->> 'status', 'not_linked')
          ));
        end if;
      end if;
    exception when others then
      v_error_count := v_error_count + 1;
      if jsonb_array_length(v_errors) < 20 then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'line_id', r.line_id,
          'message', sqlerrm
        ));
      end if;
    end;
  end loop;

  v_pr_items := jsonb_build_object(
    'candidates', v_candidates,
    'linked', v_linked,
    'already_linked', v_already,
    'conflict', v_conflict,
    'no_material', v_no_material,
    'errors', v_errors,
    'error_count', v_error_count,
    'created_aliases', v_created_aliases
  );
  v_total_candidates := v_total_candidates + v_candidates;
  v_total_linked := v_total_linked + v_linked;
  v_total_already := v_total_already + v_already;
  v_total_conflict := v_total_conflict + v_conflict;
  v_total_no_material := v_total_no_material + v_no_material;
  v_total_errors := v_total_errors + v_error_count;
  v_total_created_aliases := v_total_created_aliases + v_created_aliases;

  -- -----------------------------------------------------------------------
  -- Step 2c: invoice_items
  -- -----------------------------------------------------------------------
  v_candidates := 0;
  v_linked := 0;
  v_already := 0;
  v_conflict := 0;
  v_no_material := 0;
  v_error_count := 0;
  v_errors := '[]'::jsonb;
  v_created_aliases := 0;

  select count(*) into v_already
  from public.invoice_items ii
  join public.invoices inv on inv.id = ii.invoice_id
  where ii.canonical_material_id is not null
    and (v_filter_supplier is null or inv.supplier_id = v_filter_supplier)
    and (
      v_filter_norm is null
      or public.normalize_stock_item_name(coalesce(nullif(btrim(ii.raw_product_name), ''), ii.product_name)) = v_filter_norm
    );

  for r in
    select
      ii.id as line_id,
      ii.invoice_id as parent_id,
      inv.supplier_id,
      coalesce(nullif(btrim(ii.raw_product_name), ''), ii.product_name) as raw_name,
      ii.product_code,
      ii.unit
    from public.invoice_items ii
    join public.invoices inv on inv.id = ii.invoice_id
    where ii.canonical_material_id is null
      and (v_filter_supplier is null or inv.supplier_id = v_filter_supplier)
      and (
        v_filter_norm is null
        or public.normalize_stock_item_name(coalesce(nullif(btrim(ii.raw_product_name), ''), ii.product_name)) = v_filter_norm
      )
    order by ii.id
  loop
    v_candidates := v_candidates + 1;
    v_raw := r.raw_name;
    if v_raw is null or btrim(v_raw) = '' then
      v_no_material := v_no_material + 1;
      continue;
    end if;

    v_material := public.stock_alias_canonical_material(r.supplier_id, v_raw);
    if v_material is null then
      v_no_material := v_no_material + 1;
      continue;
    end if;

    v_master_norm := public.material_master_normalize(v_raw);
    v_source_type := 'invoice';
    v_candidate_source := case when r.supplier_id is null then 'approved_source_alias' else 'approved_supplier_alias' end;
    v_alias_payload := jsonb_build_object(
      'alias_name', v_raw,
      'candidate_source', v_candidate_source,
      'confidence', 'exact',
      'field_name', 'invoice_items.canonical_material_id'
    );

    if r.supplier_id is not null then
      select count(*) filter (where a.material_id = v_material), count(*)
      into v_alias_same, v_alias_count
      from public.material_scoped_aliases a
      where a.supplier_id = r.supplier_id
        and a.normalized_alias = v_master_norm
        and a.active = true
        and a.approved = true;
    else
      select count(*) filter (where a.material_id = v_material), count(*)
      into v_alias_same, v_alias_count
      from public.material_scoped_aliases a
      where a.supplier_id is null
        and a.source_type = v_source_type
        and a.normalized_alias = v_master_norm
        and a.active = true
        and a.approved = true;
    end if;

    if v_alias_count > 0 and v_alias_same < v_alias_count then
      v_conflict := v_conflict + 1;
      continue;
    end if;

    v_alias_exists := v_alias_count > 0;

    if v_dry then
      v_linked := v_linked + 1;
      continue;
    end if;

    begin
      if r.supplier_id is not null and not exists (
        select 1
        from public.material_supplier_products sp
        where sp.material_id = v_material
          and sp.supplier_id = r.supplier_id
          and sp.active = true
          and sp.approved = true
      ) then
        select coalesce(m.version, 1) into v_version
        from public.sku_cogs_materials m
        where m.id = v_material;
        perform public.link_material_supplier(
          v_material,
          v_version,
          r.supplier_id,
          'game kho: nhãn đã chốt'
        );
      end if;

      v_req_id := null;
      select req.id into v_req_id
      from public.material_resolution_requests req
      where req.source_table = 'invoice_items'
        and req.source_id = r.parent_id
        and req.source_line_id = r.line_id
        and req.status = 'pending'
        and req.supplier_id is not distinct from r.supplier_id
        and public.material_master_normalize(req.raw_name) = public.material_master_normalize(v_raw)
      order by req.created_at desc, req.id desc
      limit 1;

      if v_req_id is not null then
        v_confirm := public.confirm_material_resolution(
          v_req_id,
          'resolve_existing',
          v_material,
          null,
          v_alias_payload,
          '{}'::jsonb,
          'game kho: nhãn đã chốt'
        );

        if not v_alias_exists and nullif(v_confirm ->> 'alias_id', '') is not null then
          v_created_aliases := v_created_aliases + 1;
        end if;
        v_alias_exists := true;
      elsif not v_alias_exists and v_master_norm <> '' then
        v_fallback_setting := current_setting('material_master.stock_alias_fallback', true);
        begin
          perform set_config('material_master.stock_alias_fallback', 'off', true);
          v_req := public.request_material_resolution(
            v_source_type,
            'invoice_items',
            r.parent_id,
            r.line_id,
            v_raw,
            r.product_code,
            r.unit,
            r.supplier_id,
            v_alias_payload
          );
        exception when others then
          perform set_config('material_master.stock_alias_fallback', coalesce(v_fallback_setting, ''), true);
          raise;
        end;
        perform set_config('material_master.stock_alias_fallback', coalesce(v_fallback_setting, ''), true);

        v_req_resolved := nullif(v_req ->> 'resolved_material_id', '')::uuid;
        v_req_status := coalesce(v_req ->> 'resolution_status', '');

        if v_req_resolved is not null and v_req_resolved <> v_material then
          v_conflict := v_conflict + 1;
          continue;
        end if;

        if v_req_status not in ('resolved_existing', 'created_new') then
          v_req_id := nullif(v_req ->> 'request_id', '')::uuid;
          if v_req_id is null then
            raise exception 'material resolution request id missing' using errcode = 'P0002';
          end if;

          v_confirm := public.confirm_material_resolution(
            v_req_id,
            'resolve_existing',
            v_material,
            null,
            v_alias_payload,
            '{}'::jsonb,
            'game kho: nhãn đã chốt'
          );

          if nullif(v_confirm ->> 'alias_id', '') is not null then
            v_created_aliases := v_created_aliases + 1;
          end if;
        end if;
      end if;
    exception when others then
      v_error_count := v_error_count + 1;
      if jsonb_array_length(v_errors) < 20 then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'line_id', r.line_id,
          'message', sqlerrm
        ));
      end if;
      continue;
    end;

    begin
      v_apply := public.apply_procurement_line_material_resolution(
        'invoice_items',
        r.line_id,
        v_raw,
        r.product_code,
        r.unit,
        r.supplier_id,
        null,
        'game kho: nhãn đã chốt',
        v_material
      );

      if coalesce((v_apply ->> 'resolved_exact')::boolean, false)
         and nullif(v_apply ->> 'material_id', '')::uuid = v_material then
        v_linked := v_linked + 1;
      else
        v_no_material := v_no_material + 1;
        if jsonb_array_length(v_errors) < 20 then
          v_errors := v_errors || jsonb_build_array(jsonb_build_object(
            'line_id', r.line_id,
            'message', coalesce(v_apply ->> 'status', 'not_linked')
          ));
        end if;
      end if;
    exception when others then
      v_error_count := v_error_count + 1;
      if jsonb_array_length(v_errors) < 20 then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'line_id', r.line_id,
          'message', sqlerrm
        ));
      end if;
    end;
  end loop;

  v_inv_items := jsonb_build_object(
    'candidates', v_candidates,
    'linked', v_linked,
    'already_linked', v_already,
    'conflict', v_conflict,
    'no_material', v_no_material,
    'errors', v_errors,
    'error_count', v_error_count,
    'created_aliases', v_created_aliases
  );
  v_total_candidates := v_total_candidates + v_candidates;
  v_total_linked := v_total_linked + v_linked;
  v_total_already := v_total_already + v_already;
  v_total_conflict := v_total_conflict + v_conflict;
  v_total_no_material := v_total_no_material + v_no_material;
  v_total_errors := v_total_errors + v_error_count;
  v_total_created_aliases := v_total_created_aliases + v_created_aliases;

  -- -----------------------------------------------------------------------
  -- Step 3: goods_receipt_items through the existing Task-5 controller
  -- -----------------------------------------------------------------------
  v_candidates := 0;
  v_linked := 0;
  v_already := 0;
  v_conflict := 0;
  v_no_material := 0;
  v_error_count := 0;
  v_errors := '[]'::jsonb;
  v_created_aliases := 0;

  v_gr_controller := to_regprocedure('public.apply_goods_receipt_item_material_resolution(uuid, uuid, text, text, text, uuid, text, text)');

  if v_gr_controller is null then
    v_gr_items := jsonb_build_object(
      'skipped', true,
      'reason', 'apply_goods_receipt_item_material_resolution not found',
      'candidates', 0,
      'linked', 0,
      'already_linked', 0,
      'conflict', 0,
      'no_material', 0,
      'errors', '[]'::jsonb,
      'error_count', 0,
      'created_aliases', 0
    );
  else
    select count(*) into v_already
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    where gri.canonical_material_id is not null
      and (v_filter_supplier is null or gr.supplier_id = v_filter_supplier)
      and (
        v_filter_norm is null
        or public.normalize_stock_item_name(coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)) = v_filter_norm
      );

    for r in
      select
        gri.id as line_id,
        gri.goods_receipt_id as parent_id,
        gr.supplier_id,
        coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as raw_name,
        gri.unit
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      where gri.canonical_material_id is null
        and (v_filter_supplier is null or gr.supplier_id = v_filter_supplier)
        and (
          v_filter_norm is null
          or public.normalize_stock_item_name(coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)) = v_filter_norm
        )
      order by gri.id
    loop
      v_candidates := v_candidates + 1;
      v_raw := r.raw_name;
      if v_raw is null or btrim(v_raw) = '' then
        v_no_material := v_no_material + 1;
        continue;
      end if;

      v_material := public.stock_alias_canonical_material(r.supplier_id, v_raw);
      if v_material is null then
        v_no_material := v_no_material + 1;
        continue;
      end if;

      v_master_norm := public.material_master_normalize(v_raw);
      v_source_type := 'goods_receipt';
      v_candidate_source := case when r.supplier_id is null then 'approved_source_alias' else 'approved_supplier_alias' end;
      v_alias_payload := jsonb_build_object(
        'alias_name', v_raw,
        'candidate_source', v_candidate_source,
        'confidence', 'exact',
        'field_name', 'goods_receipt_items.canonical_material_id'
      );

      if r.supplier_id is not null then
        select count(*) filter (where a.material_id = v_material), count(*)
        into v_alias_same, v_alias_count
        from public.material_scoped_aliases a
        where a.supplier_id = r.supplier_id
          and a.normalized_alias = v_master_norm
          and a.active = true
          and a.approved = true;
      else
        select count(*) filter (where a.material_id = v_material), count(*)
        into v_alias_same, v_alias_count
        from public.material_scoped_aliases a
        where a.supplier_id is null
          and a.source_type = v_source_type
          and a.normalized_alias = v_master_norm
          and a.active = true
          and a.approved = true;
      end if;

      if v_alias_count > 0 and v_alias_same < v_alias_count then
        v_conflict := v_conflict + 1;
        continue;
      end if;

      v_alias_exists := v_alias_count > 0;

      if v_dry then
        v_linked := v_linked + 1;
        continue;
      end if;

      begin
        if r.supplier_id is not null and not exists (
          select 1
          from public.material_supplier_products sp
          where sp.material_id = v_material
            and sp.supplier_id = r.supplier_id
            and sp.active = true
            and sp.approved = true
        ) then
          select coalesce(m.version, 1) into v_version
          from public.sku_cogs_materials m
          where m.id = v_material;
          perform public.link_material_supplier(
            v_material,
            v_version,
            r.supplier_id,
            'game kho: nhãn đã chốt'
          );
        end if;
      exception when others then
        v_error_count := v_error_count + 1;
        if jsonb_array_length(v_errors) < 20 then
          v_errors := v_errors || jsonb_build_array(jsonb_build_object(
            'line_id', r.line_id,
            'message', sqlerrm
          ));
        end if;
        continue;
      end;

      begin
        v_req_id := null;
        select req.id into v_req_id
        from public.material_resolution_requests req
        where req.source_table = 'goods_receipt_items'
          and req.source_id = r.parent_id
          and req.source_line_id = r.line_id
          and req.status = 'pending'
          and req.supplier_id is not distinct from r.supplier_id
          and public.material_master_normalize(req.raw_name) = public.material_master_normalize(v_raw)
        order by req.created_at desc, req.id desc
        limit 1;

        if v_req_id is not null then
          v_confirm := public.confirm_material_resolution(
            v_req_id,
            'resolve_existing',
            v_material,
            null,
            v_alias_payload,
            '{}'::jsonb,
            'game kho: nhãn đã chốt'
          );

          if not v_alias_exists and nullif(v_confirm ->> 'alias_id', '') is not null then
            v_created_aliases := v_created_aliases + 1;
          end if;
        end if;
      exception when others then
        v_error_count := v_error_count + 1;
        if jsonb_array_length(v_errors) < 20 then
          v_errors := v_errors || jsonb_build_array(jsonb_build_object(
            'line_id', r.line_id,
            'message', sqlerrm
          ));
        end if;
        continue;
      end;

      begin
        v_apply := public.apply_goods_receipt_item_material_resolution(
          r.line_id,
          v_material,
          v_raw,
          null,
          r.unit,
          r.supplier_id,
          'goods_receipt',
          'game kho: nhãn đã chốt'
        );

        if coalesce(v_apply ->> 'status', '') in ('linked', 'linked_unchanged')
           and nullif(v_apply ->> 'material_id', '')::uuid = v_material then
          v_linked := v_linked + 1;
        else
          v_no_material := v_no_material + 1;
          if jsonb_array_length(v_errors) < 20 then
            v_errors := v_errors || jsonb_build_array(jsonb_build_object(
              'line_id', r.line_id,
              'message', coalesce(v_apply ->> 'status', 'not_linked')
            ));
          end if;
        end if;
      exception when others then
        v_error_count := v_error_count + 1;
        if jsonb_array_length(v_errors) < 20 then
          v_errors := v_errors || jsonb_build_array(jsonb_build_object(
            'line_id', r.line_id,
            'message', sqlerrm
          ));
        end if;
      end;
    end loop;

    v_gr_items := jsonb_build_object(
      'skipped', false,
      'candidates', v_candidates,
      'linked', v_linked,
      'already_linked', v_already,
      'conflict', v_conflict,
      'no_material', v_no_material,
      'errors', v_errors,
      'error_count', v_error_count,
      'created_aliases', v_created_aliases
    );
  end if;

  v_total_candidates := v_total_candidates + v_candidates;
  v_total_linked := v_total_linked + v_linked;
  v_total_already := v_total_already + v_already;
  v_total_conflict := v_total_conflict + v_conflict;
  v_total_no_material := v_total_no_material + v_no_material;
  v_total_errors := v_total_errors + v_error_count;
  v_total_created_aliases := v_total_created_aliases + v_created_aliases;

  return jsonb_build_object(
    'dry_run', v_dry,
    'filters', jsonb_build_object(
      'supplier_id', v_filter_supplier,
      'normalized_name', v_filter_norm
    ),
    'kitchen_items', v_k_items,
    'purchase_order_items', v_po_items,
    'payment_request_items', v_pr_items,
    'invoice_items', v_inv_items,
    'goods_receipt_items', v_gr_items,
    'created_materials', v_total_created_materials,
    'created_aliases', v_total_created_aliases,
    'totals', jsonb_build_object(
      'candidates', v_total_candidates,
      'linked', v_total_linked,
      'already_linked', v_total_already,
      'conflict', v_total_conflict,
      'no_material', v_total_no_material,
      'errors', v_total_errors
    )
  );
end;
$$;

comment on function public.link_documents_from_stock_aliases(uuid, text, boolean) is
  'Owner/service_role only. Links kitchen items and untouched PO/PR/invoice/goods-receipt lines from confirmed stock labels through the existing Material Master controllers. Dry-run by default; idempotent.';

revoke all on function public.link_documents_from_stock_aliases(uuid, text, boolean) from public, anon;
grant execute on function public.link_documents_from_stock_aliases(uuid, text, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. New/changed stock labels keep linking new document lines
-- ---------------------------------------------------------------------------

create or replace function public.trg_stock_material_alias_link_documents()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claims text := current_setting('request.jwt.claims', true);
  v_claim_role text := current_setting('request.jwt.claim.role', true);
  v_claims_json jsonb;
  v_actor text;
begin
  if new.line_class is distinct from 'stock' then
    return new;
  end if;

  v_claims_json := '{}'::jsonb;
  if nullif(btrim(coalesce(v_claims, '')), '') is not null then
    begin
      v_claims_json := v_claims::jsonb;
    exception when others then
      v_claims_json := '{}'::jsonb;
    end;
  end if;

  -- A service-context insert may have no auth.uid(). The Material Master
  -- controllers record approved_by from auth.uid(), so keep the real confirming
  -- user when present and otherwise fall back to the alias creator or an owner.
  if nullif(v_claims_json ->> 'sub', '') is null then
    select coalesce(
      new.created_by::text,
      (
        select ur.user_id::text
        from public.user_roles ur
        where ur.role = 'owner'
        order by ur.user_id
        limit 1
      )
    )
    into v_actor;

    if v_actor is not null then
      v_claims_json := v_claims_json || jsonb_build_object('sub', v_actor);
    end if;
  end if;

  begin
    perform set_config(
      'request.jwt.claims',
      (v_claims_json || jsonb_build_object('role', 'service_role'))::text,
      true
    );
    perform set_config('request.jwt.claim.role', 'service_role', true);
    perform public.link_documents_from_stock_aliases(new.supplier_id, new.normalized_name, false);
  exception when others then
    perform set_config('request.jwt.claims', coalesce(nullif(v_claims, ''), '{}'), true);
    perform set_config('request.jwt.claim.role', coalesce(v_claim_role, ''), true);
    raise warning 'stock alias document link failed for alias %: %', new.id, sqlerrm;
  end;

  perform set_config('request.jwt.claims', coalesce(nullif(v_claims, ''), '{}'), true);
  perform set_config('request.jwt.claim.role', coalesce(v_claim_role, ''), true);
  return new;
end;
$$;

revoke all on function public.trg_stock_material_alias_link_documents() from public, anon, authenticated, service_role;

drop trigger if exists trg_stock_material_aliases_link_documents on public.stock_material_aliases;
create trigger trg_stock_material_aliases_link_documents
after insert or update of kitchen_inventory_item_id, normalized_name, supplier_id, line_class
on public.stock_material_aliases
for each row
when (new.line_class = 'stock')
execute function public.trg_stock_material_alias_link_documents();

-- ---------------------------------------------------------------------------
-- 4. resolve_canonical_material: append-only stock-alias fallback
-- ---------------------------------------------------------------------------

create or replace function public.resolve_canonical_material(
  p_raw_name text,
  p_raw_code text default null,
  p_raw_unit text default null,
  p_supplier_id uuid default null,
  p_source_type text default null,
  p_effective_date date default current_date,
  p_required_capabilities text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_norm text := public.material_master_normalize(p_raw_name);
  v_source_type text := nullif(lower(btrim(coalesce(p_source_type, ''))), '');
  v_match public.sku_cogs_materials%rowtype;
  v_source text;
  v_ready jsonb;
  v_blockers text[];
  v_candidates uuid[];
  v_force text := nullif(current_setting('material_master.force_material_id', true), '');
  v_forced public.sku_cogs_materials%rowtype;
  v_stock_material uuid;
  v_stock_fallback text := coalesce(current_setting('material_master.stock_alias_fallback', true), 'on');
begin
  -- Forced material (transaction-local, only set by q7_link_item_material_internal
  -- when the picked material does not own the item name). This keeps the
  -- controller path: the request is created already resolved_existing so
  -- confirm_material_resolution early-returns and never writes the conflicting
  -- name/alias. When the flag is unset behaviour is untouched.
  if v_force is not null
     and v_force ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_forced
    from public.sku_cogs_materials m
    where m.id = v_force::uuid
    limit 1;
    if found and v_forced.active then
      return jsonb_build_object(
        'status', 'resolved_exact',
        'resolved_exact', true,
        'match_source', 'forced',
        'material_id', v_forced.id,
        'material_code', v_forced.material_code,
        'canonical_name', v_forced.canonical_name,
        'default_unit', v_forced.default_unit
      );
    end if;
  end if;

  -- match_source precedence markers: material_code, normalized_name, approved_supplier_alias, approved_source_alias, approved_global_alias.
  -- fuzzy / ai_candidate suggestions are intentionally candidate-only and fail-closed:
  -- they may return confirmation_needed/ambiguous/not_found but never resolved_exact.
  if nullif(btrim(coalesce(p_raw_code, '')), '') is not null then
    select * into v_match from public.sku_cogs_materials m where lower(btrim(m.material_code)) = lower(btrim(p_raw_code)) order by m.active desc limit 1;
    if found then v_source := 'material_code'; end if;
  end if;
  if v_match.id is null and v_norm <> '' then
    select * into v_match from public.sku_cogs_materials m where m.normalized_name = v_norm order by m.active desc limit 1;
    if found then v_source := 'normalized_name'; end if;
  end if;
  if v_match.id is null and p_supplier_id is not null and v_norm <> '' then
    select m.* into v_match
    from public.material_scoped_aliases a join public.sku_cogs_materials m on m.id = a.material_id
    where a.supplier_id = p_supplier_id and a.normalized_alias = v_norm and a.active = true and a.approved = true
    order by m.active desc, a.created_at desc limit 1;
    if found then v_source := 'approved_supplier_alias'; end if;
  end if;
  if v_match.id is null and p_supplier_id is null and v_source_type is not null and v_norm <> '' then
    select m.* into v_match
    from public.material_scoped_aliases a join public.sku_cogs_materials m on m.id = a.material_id
    where a.supplier_id is null and a.source_type = v_source_type and a.normalized_alias = v_norm and a.active = true and a.approved = true
    order by m.active desc, a.created_at desc limit 1;
    if found then v_source := 'approved_source_alias'; end if;
  end if;
  if v_match.id is null and v_norm <> '' then
    select m.* into v_match
    from public.sku_cogs_material_aliases a join public.sku_cogs_materials m on m.id = a.material_id
    where a.normalized_alias = v_norm and a.active = true and a.source in ('canonical_name','existing_cogs','approved_peerless_alias','approved_global_alias','approved')
    order by m.active desc, a.created_at desc limit 1;
    if found then v_source := 'approved_global_alias'; end if;
  end if;

  -- New final fallback: a confirmed warehouse label.  It runs only when every
  -- pre-existing lookup missed, so earlier results and precedence are unchanged.
  if v_match.id is null
     and v_stock_fallback <> 'off'
     and v_norm <> '' then
    v_stock_material := public.stock_alias_canonical_material(p_supplier_id, p_raw_name);
    if v_stock_material is not null then
      select * into v_match
      from public.sku_cogs_materials m
      where m.id = v_stock_material
      limit 1;
      if found then v_source := 'stock_alias'; end if;
    end if;
  end if;

  if v_match.id is not null then
    if not v_match.active then
      return jsonb_build_object('status','inactive','resolved_exact',false,'match_source',v_source,'material_id',v_match.id,'material_code',v_match.material_code);
    end if;
    v_ready := public.assert_material_ready(v_match.id, coalesce(p_required_capabilities, '{}'::text[]), p_supplier_id, p_raw_unit, p_effective_date);
    v_blockers := array(select jsonb_array_elements_text(v_ready->'blockers'));
    if 'unit_unmapped' = any(v_blockers) then
      return jsonb_build_object('status','unit_unmapped','resolved_exact',false,'match_source',v_source,'material_id',v_match.id,'blockers',v_ready->'blockers');
    end if;
    if 'supplier_unmapped' = any(v_blockers) then
      return jsonb_build_object('status','supplier_unmapped','resolved_exact',false,'match_source',v_source,'material_id',v_match.id,'blockers',v_ready->'blockers');
    end if;
    if (v_ready->>'ready')::boolean is false then
      return jsonb_build_object('status','confirmation_needed','resolved_exact',false,'match_source',v_source,'material_id',v_match.id,'blockers',v_ready->'blockers');
    end if;
    return jsonb_build_object('status','resolved_exact','resolved_exact',true,'match_source',v_source,'material_id',v_match.id,'material_code',v_match.material_code,'canonical_name',v_match.canonical_name,'default_unit',v_match.default_unit);
  end if;

  select coalesce(array_agg(id order by canonical_name), '{}'::uuid[]) into v_candidates
  from public.sku_cogs_materials
  where v_norm <> '' and active = true and normalized_name like v_norm || '%';
  if cardinality(v_candidates) > 1 then
    return jsonb_build_object('status','ambiguous','resolved_exact',false,'candidates',v_candidates,'fail_closed',true);
  elsif cardinality(v_candidates) = 1 then
    return jsonb_build_object('status','confirmation_needed','resolved_exact',false,'candidates',v_candidates,'fail_closed',true);
  end if;
  return jsonb_build_object('status','not_found','resolved_exact',false,'candidates','[]'::jsonb,'fail_closed',true);
end;
$$;

revoke execute on function public.resolve_canonical_material(text, text, text, uuid, text, date, text[]) from public, anon;
grant execute on function public.resolve_canonical_material(text, text, text, uuid, text, date, text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Document read RPC: canonical material + last purchase for the material
-- ---------------------------------------------------------------------------

create or replace function public.get_stock_item_names_for_lines(p_lines jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_line jsonb;
  v_key text;
  v_name text;
  v_location text;
  v_supplier_id uuid;
  v_norm text;
  v_distinct integer;
  v_item_id uuid;
  v_alias_location text;
  v_match text;
  v_item public.kitchen_inventory_items%rowtype;
  v_next_item public.kitchen_inventory_items%rowtype;
  v_merged_steps integer;
  v_exclude_id uuid;
  v_last_unit_price numeric;
  v_last_date date;
  v_result jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'invalid_lines' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 500 then
    raise exception 'invalid_lines' using errcode = '22023';
  end if;

  for v_line in
    select e.value
    from jsonb_array_elements(p_lines) with ordinality as e(value, ordinality)
    order by e.ordinality
  loop
    v_key := v_line ->> 'key';
    v_name := v_line ->> 'name';
    v_location := nullif(btrim(coalesce(v_line ->> 'location', '')), '');
    v_supplier_id := nullif(btrim(coalesce(v_line ->> 'supplier_id', '')), '')::uuid;
    v_norm := public.normalize_stock_item_name(v_name);

    if v_key is null or v_norm is null then
      continue;
    end if;

    v_match := null;
    v_item_id := null;
    v_alias_location := null;

    -- (1) same supplier and, when supplied, the same location.
    if v_supplier_id is not null then
      select
        count(distinct a.kitchen_inventory_item_id),
        min(a.kitchen_inventory_item_id::text)::uuid,
        min(a.location)
      into v_distinct, v_item_id, v_alias_location
      from public.stock_material_aliases a
      where a.normalized_name = v_norm
        and a.line_class = 'stock'
        and a.kitchen_inventory_item_id is not null
        and a.supplier_id = v_supplier_id
        and (v_location is null or a.location = v_location);

      if v_distinct = 1 then
        v_match := 'supplier';
      end if;
    end if;

    -- (2) same supplier, any location.
    if v_match is null and v_supplier_id is not null then
      select
        count(distinct a.kitchen_inventory_item_id),
        min(a.kitchen_inventory_item_id::text)::uuid,
        min(a.location)
      into v_distinct, v_item_id, v_alias_location
      from public.stock_material_aliases a
      where a.normalized_name = v_norm
        and a.line_class = 'stock'
        and a.kitchen_inventory_item_id is not null
        and a.supplier_id = v_supplier_id;

      if v_distinct = 1 then
        v_match := 'supplier';
      end if;
    end if;

    -- (3) the global, supplier-less alias.
    if v_match is null then
      select
        count(distinct a.kitchen_inventory_item_id),
        min(a.kitchen_inventory_item_id::text)::uuid,
        min(a.location)
      into v_distinct, v_item_id, v_alias_location
      from public.stock_material_aliases a
      where a.normalized_name = v_norm
        and a.line_class = 'stock'
        and a.kitchen_inventory_item_id is not null
        and a.supplier_id is null;

      if v_distinct = 1 then
        v_match := 'global';
      end if;
    end if;

    -- (4) any supplier, only when every alias points to the same item.
    if v_match is null then
      select
        count(distinct a.kitchen_inventory_item_id),
        min(a.kitchen_inventory_item_id::text)::uuid,
        min(a.location)
      into v_distinct, v_item_id, v_alias_location
      from public.stock_material_aliases a
      where a.normalized_name = v_norm
        and a.line_class = 'stock'
        and a.kitchen_inventory_item_id is not null;

      if v_distinct = 1 then
        v_match := 'any';
      end if;
    end if;

    if v_match is null then
      continue;
    end if;

    select *
    into v_item
    from public.kitchen_inventory_items k
    where k.id = v_item_id;

    -- A row variable keeps the previous line's value when no row is found.
    if not found then
      continue;
    end if;

    -- Follow at most five merge hops. A longer chain or a missing target is
    -- treated like an unusable item and omitted from the result.
    v_merged_steps := 0;
    while v_item.merged_into_id is not null and v_merged_steps < 5 loop
      select *
      into v_next_item
      from public.kitchen_inventory_items k
      where k.id = v_item.merged_into_id;

      if not found then
        v_item_id := null;
        exit;
      end if;

      v_merged_steps := v_merged_steps + 1;
      v_item := v_next_item;
    end loop;

    if v_item_id is null
       or v_item.merged_into_id is not null
       or v_item.active is not true then
      continue;
    end if;

    v_exclude_id := case
      when v_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then v_key::uuid
      else null
    end;

    v_last_unit_price := null;
    v_last_date := null;

    -- Historical lines of one material carry mixed units (Thùng / g / gói), so a
    -- last price is only returned for the caller's unit, from POs created before
    -- the caller's 'before' timestamp (order_date is OCR'd and unreliable).
    if v_item.canonical_material_id is not null
       and nullif(btrim(coalesce(v_line ->> 'unit', '')), '') is not null then
      select poi.unit_price, po.created_at::date
      into v_last_unit_price, v_last_date
      from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      where poi.canonical_material_id = v_item.canonical_material_id
        and (v_exclude_id is null or poi.id <> v_exclude_id)
        and lower(btrim(coalesce(poi.unit, ''))) = lower(btrim(v_line ->> 'unit'))
        and (nullif(v_line ->> 'before', '') is null or po.created_at < (v_line ->> 'before')::timestamptz)
      order by po.created_at desc, poi.id desc
      limit 1;
    end if;

    v_result := v_result || jsonb_build_array(
      jsonb_build_object(
        'key', v_key,
        'item_id', v_item.id,
        'item_name', v_item.name,
        'item_code', v_item.item_code,
        'unit', v_item.unit,
        'location', v_alias_location,
        'match', v_match,
        'canonical_material_id', v_item.canonical_material_id,
        'last_unit_price', v_last_unit_price,
        'last_date', v_last_date
      )
    );
  end loop;

  return v_result;
end;
$$;

comment on function public.get_stock_item_names_for_lines(jsonb) is
  'Read-only: current stock item names/canonical material plus last purchase price/date for document lines, resolved through stock_material_aliases and merged_into_id chains. Writes no data.';

revoke all on function public.get_stock_item_names_for_lines(jsonb) from public, anon;
grant execute on function public.get_stock_item_names_for_lines(jsonb) to authenticated, service_role;
