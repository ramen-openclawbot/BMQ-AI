-- 2026-11-02: phone-bill lines (Cước điện thoại bấm Không nhập kho) can be
-- named by the phone number alone. normalize_stock_item_name strips trailing
-- digits, so '0966998998' and '011532087 (Vnpt)' normalize to null and the old
-- code raised item_name_required before the non_stock branch could store the
-- alias. Non-stock lines now fall back to a stable key made of the digits and
-- letters of the raw name; stock lines keep raising item_name_required and
-- never create a warehouse item for a number-only name.
--
-- Re-creates only the 13-argument overload from
-- 20261022100000_shared_catalog_units.sql; the 12-argument wrapper still
-- delegates to it. No existing alias, receipt or ledger row is modified.

-- confirm_material_alias: for 'tan_tao' accept exactly one of a shared kitchen
-- item or a finished-goods SKU. Everything else (auto after 3 confirmations,
-- admin auto-promote, non_stock, replay over confirmed receipt lines) is kept.
create or replace function public.confirm_material_alias(
  p_supplier_id uuid,
  p_location text,
  p_raw_name text,
  p_raw_unit text,
  p_kitchen_inventory_item_id uuid,
  p_tan_tao_sku_id uuid,
  p_entered_unit_label text,
  p_conversion_factor numeric,
  p_jev_item_id uuid,
  p_jev_probability numeric,
  p_source_table text,
  p_source_id uuid,
  p_line_class text default 'stock'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_array uuid[];
  v_norm text;
  v_unit text;
  v_factor numeric;
  v_pack_label text;
  v_alias public.stock_material_aliases%rowtype;
  v_same boolean;
  v_action text;
  v_jev_disagreed boolean;
  v_new_item uuid;
  v_new_sku uuid;
  v_chosen uuid;
  v_confirmers uuid[];
  v_distinct integer;
  v_cutover date;
  v_target record;
  v_applied integer := 0;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if p_line_class not in ('stock', 'non_stock') then
    raise exception 'line_class_invalid' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_line_class = 'non_stock'
     and public.stock_line_auto_non_stock(p_raw_name) is null
     and coalesce(auth.role(), '') <> 'service_role'
     and not public.material_alias_can_admin(v_actor) then
    raise exception 'non_stock_requires_admin' using errcode = '42501';
  end if;

  v_actor_array := case when v_actor is null then '{}'::uuid[] else array[v_actor] end;
  v_norm := public.normalize_stock_item_name(p_raw_name);
  -- A phone-bill non-stock line may be named by the phone number alone
  -- ('0966998998') or by a number plus a carrier note ('011532087 (Vnpt)').
  -- normalize_stock_item_name strips the trailing digits (and the trailing
  -- parenthetical), so v_norm is null for both. Non-stock has no warehouse item
  -- to route, so build a stable alias key from the digits and letters of the
  -- raw name instead of rejecting it. Stock keeps the strict rule below: a
  -- number-only stock name must still raise and never create an item.
  if v_norm is null and p_line_class = 'non_stock' then
    v_norm := nullif(
      regexp_replace(lower(btrim(coalesce(p_raw_name, ''))), '[^a-z0-9]', '', 'g'),
      ''
    );
  end if;
  if v_norm is null then raise exception 'item_name_required' using errcode = '22023'; end if;

  if p_line_class = 'non_stock' then
    v_new_item := null;
    v_new_sku := null;
    v_factor := 1;
    v_unit := coalesce(nullif(btrim(p_raw_unit), ''), '-');
  else
    if p_conversion_factor is null or p_conversion_factor <= 0
       or p_conversion_factor::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'invalid_conversion_factor' using errcode = '22023';
    end if;
    v_factor := p_conversion_factor;

    if p_location = 'q7' then
      if p_kitchen_inventory_item_id is null or p_tan_tao_sku_id is not null then
        raise exception 'kitchen_inventory_item_required' using errcode = '22023';
      end if;
      select kii.unit into v_unit
      from public.kitchen_inventory_items kii
      where kii.id = p_kitchen_inventory_item_id
        and kii.active = true
        and kii.merged_into_id is null;
      if v_unit is null then raise exception 'q7_item_not_found' using errcode = 'P0002'; end if;
      v_new_item := p_kitchen_inventory_item_id;
      v_new_sku := null;
    else
      -- Tân Tạo: exactly one target, a shared NVL item or a finished-goods SKU.
      if (p_kitchen_inventory_item_id is null) = (p_tan_tao_sku_id is null) then
        raise exception 'tan_tao_target_required' using errcode = '22023';
      end if;
      if p_kitchen_inventory_item_id is not null then
        select kii.unit into v_unit
        from public.kitchen_inventory_items kii
        where kii.id = p_kitchen_inventory_item_id
          and kii.active = true
          and kii.merged_into_id is null;
        if v_unit is null then raise exception 'tan_tao_item_not_found' using errcode = 'P0002'; end if;
        v_new_item := p_kitchen_inventory_item_id;
        v_new_sku := null;
      else
        select ps.unit into v_unit
        from public.product_skus ps
        where ps.id = p_tan_tao_sku_id
          and upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G');
        if v_unit is null then raise exception 'tan_tao_sku_not_found' using errcode = 'P0002'; end if;
        v_new_item := null;
        v_new_sku := p_tan_tao_sku_id;
      end if;
    end if;
  end if;

  v_pack_label := nullif(btrim(coalesce(p_entered_unit_label, '')), '');
  if v_pack_label is null then
    v_pack_label := public.q7_pack_from_name(p_raw_name, p_raw_unit) ->> 'pack_label';
  end if;

  v_chosen := coalesce(v_new_item, v_new_sku);
  v_jev_disagreed := p_jev_item_id is not null
    and p_jev_item_id is distinct from v_chosen
    and coalesce(p_jev_probability, 0) >= 0.9;

  select * into v_alias
  from public.stock_material_aliases a
  where a.location = p_location
    and a.normalized_name = v_norm
    and a.supplier_id is not distinct from p_supplier_id
  for update;

  if not found then
    insert into public.stock_material_aliases(
      supplier_id, normalized_name, location, kitchen_inventory_item_id,
      tan_tao_sku_id, conversion_factor, unit, created_by,
      confirm_count, confirmers, status, pack_label, last_confirmed_at,
      jev_item_id, jev_probability, jev_disagreed, line_class
    ) values (
      p_supplier_id, v_norm, p_location, v_new_item,
      v_new_sku, v_factor, v_unit, v_actor,
      1, v_actor_array, 'learning', v_pack_label, now(),
      p_jev_item_id, p_jev_probability, v_jev_disagreed, p_line_class
    )
    returning * into v_alias;
    v_action := 'confirm';
    insert into public.material_alias_events(
      alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
      new_item_id, new_sku_id, new_factor, new_line_class, jev_item_id, jev_probability
    ) values (
      v_alias.id, 'confirm', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
      v_new_item, v_new_sku, v_factor, p_line_class, p_jev_item_id, p_jev_probability
    );
  else
    v_same := (v_alias.line_class is not distinct from p_line_class)
      and (v_alias.kitchen_inventory_item_id is not distinct from v_new_item)
      and (v_alias.tan_tao_sku_id is not distinct from v_new_sku)
      and (v_alias.conversion_factor = v_factor);

    if v_same then
      v_confirmers := coalesce(v_alias.confirmers, '{}'::uuid[]);
      if v_actor is not null and not (v_actor = any (v_confirmers)) then
        v_confirmers := v_confirmers || v_actor;
      end if;
      update public.stock_material_aliases
        set confirm_count = v_alias.confirm_count + 1,
            confirmers = v_confirmers,
            last_confirmed_at = now(),
            pack_label = coalesce(v_pack_label, pack_label),
            jev_item_id = p_jev_item_id,
            jev_probability = p_jev_probability,
            jev_disagreed = v_jev_disagreed,
            updated_at = now()
        where id = v_alias.id
        returning * into v_alias;
      v_action := 'confirm';
      insert into public.material_alias_events(
        alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
        new_item_id, new_sku_id, new_factor, new_line_class, jev_item_id, jev_probability
      ) values (
        v_alias.id, 'confirm', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
        v_new_item, v_new_sku, v_factor, p_line_class, p_jev_item_id, p_jev_probability
      );
    else
      v_action := 'correct';
      insert into public.material_alias_events(
        alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
        previous_item_id, previous_sku_id, previous_factor, previous_line_class,
        new_item_id, new_sku_id, new_factor, new_line_class, jev_item_id, jev_probability
      ) values (
        v_alias.id, 'correct', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
        v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor,
        v_alias.line_class,
        v_new_item, v_new_sku, v_factor, p_line_class, p_jev_item_id, p_jev_probability
      );
      update public.stock_material_aliases
        set kitchen_inventory_item_id = v_new_item,
            tan_tao_sku_id = v_new_sku,
            conversion_factor = v_factor,
            unit = v_unit,
            line_class = p_line_class,
            pack_label = v_pack_label,
            confirm_count = 1,
            confirmers = v_actor_array,
            status = 'learning',
            last_confirmed_at = now(),
            jev_item_id = p_jev_item_id,
            jev_probability = p_jev_probability,
            jev_disagreed = v_jev_disagreed,
            updated_at = now()
        where id = v_alias.id
        returning * into v_alias;
    end if;
  end if;

  select count(distinct c) into v_distinct
  from unnest(coalesce(v_alias.confirmers, '{}'::uuid[])) c;
  if (v_alias.confirm_count >= 3 or v_distinct >= 2) and v_alias.status <> 'auto' then
    update public.stock_material_aliases
      set status = 'auto', updated_at = now()
      where id = v_alias.id
      returning * into v_alias;
    insert into public.material_alias_events(
      alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
      new_item_id, new_sku_id, new_factor, new_line_class
    ) values (
      v_alias.id, 'auto_promoted', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
      v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor,
      v_alias.line_class
    );
  end if;

  if v_alias.status <> 'auto' and public.material_alias_can_admin(v_actor) then
    update public.stock_material_aliases
      set status = 'auto', updated_at = now()
      where id = v_alias.id
      returning * into v_alias;
    insert into public.material_alias_events(
      alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
      new_item_id, new_sku_id, new_factor, new_line_class
    ) values (
      v_alias.id, 'auto_promoted', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
      v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor,
      v_alias.line_class
    );
  end if;

  if p_line_class = 'stock' then
    v_cutover := public.stock_ledger_cutover_date(p_location);
    for v_target in
      select gri.id
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      where gr.supplier_id is not distinct from p_supplier_id
        and gr.receiving_location = p_location
        and gr.status in ('confirmed', 'received')
        and (v_cutover is null or gr.receipt_date >= v_cutover)
        and public.normalize_stock_item_name(
              coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
            ) = v_norm
      order by gr.receipt_date asc, gri.created_at asc, gri.id asc
    loop
      if not public.stock_goods_receipt_item_is_posted(v_target.id) then
        if public.post_stock_goods_receipt_item(v_target.id, v_alias) then
          v_applied := v_applied + 1;
        end if;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'status', v_action,
    'alias', to_jsonb(v_alias),
    'applied_lines', v_applied,
    'promoted', v_alias.status = 'auto'
  );
end;
$$;

revoke all on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid, text) from public, anon;
grant execute on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid, text) to authenticated, service_role;

-- suggest_material_aliases: look a phone-bill line up by the same fallback key,
-- so a phone number answered "Không nhập kho" once is recognised on the next
-- receipt instead of prompting again. Body re-created from
-- 20261019100000_purchase_must_stock.sql with only the fallback added.
create or replace function public.suggest_material_aliases(
  p_supplier_id uuid,
  p_location text,
  p_lines jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_line jsonb;
  v_line_key text;
  v_raw_name text;
  v_raw_unit text;
  v_norm text;
  v_alias public.stock_material_aliases%rowtype;
  v_item_name text;
  v_candidates jsonb;
  v_candidate_ids text[];
  v_candidates_hash text;
  v_cache public.material_alias_jev_cache%rowtype;
  v_alias_json jsonb;
  v_jev jsonb;
  v_pack jsonb;
  v_needs_prompt boolean;
  v_rule text;
  v_auto_non_stock jsonb;
  v_jev_probability numeric;
  v_result jsonb := '[]'::jsonb;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'lines_required' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'too_many_lines' using errcode = '22023';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_line_key := nullif(btrim(coalesce(v_line ->> 'line_key', '')), '');
    v_raw_name := coalesce(nullif(btrim(v_line ->> 'raw_name'), ''), '');
    v_raw_unit := nullif(btrim(v_line ->> 'raw_unit'), '');
    if v_line_key is null or v_raw_name = '' then
      continue;
    end if;

    v_norm := public.normalize_stock_item_name(v_raw_name);
    -- Same fallback as confirm_material_alias: a number-only phone-bill name
    -- normalizes to null, so look its non-stock alias up by the digits and
    -- letters of the raw name. Only non_stock aliases can carry this key,
    -- because confirm_material_alias still rejects number-only stock names.
    if v_norm is null then
      v_norm := nullif(
        regexp_replace(lower(btrim(coalesce(v_raw_name, ''))), '[^a-z0-9]', '', 'g'),
        ''
      );
    end if;

    -- [2026-10-19] The fixed rule decides VAT / fee / service before any alias
    -- or candidate lookup: no prompt, empty candidates and no Jev call.
    v_rule := public.stock_line_auto_non_stock(v_raw_name);
    if v_rule is not null then
      v_result := v_result || jsonb_build_object(
        'line_key', v_line_key,
        'normalized_name', v_norm,
        'alias', null,
        'needs_prompt', false,
        'candidates', '[]'::jsonb,
        'candidates_hash', '',
        'jev', null,
        'pack_guess', public.q7_pack_from_name(v_raw_name, v_raw_unit),
        'auto_non_stock', jsonb_build_object('reason', v_rule, 'source', 'rule')
      );
      continue;
    end if;

    v_alias := null;

    -- Prefer the supplier-specific alias, otherwise show the generic suggestion.
    select * into v_alias
    from public.stock_material_aliases a
    where a.location = p_location
      and a.normalized_name = v_norm
      and a.supplier_id is not distinct from p_supplier_id
    order by a.created_at asc, a.id asc
    limit 1;
    if v_alias.id is null then
      select * into v_alias
      from public.stock_material_aliases a
      where a.location = p_location
        and a.normalized_name = v_norm
        and a.supplier_id is null
      order by a.created_at asc, a.id asc
      limit 1;
    end if;

    v_item_name := null;
    if v_alias.id is not null and v_alias.line_class = 'stock' then
      if p_location = 'q7' then
        select kii.name into v_item_name
        from public.kitchen_inventory_items kii
        where kii.id = v_alias.kitchen_inventory_item_id;
      else
        select ps.product_name into v_item_name
        from public.product_skus ps
        where ps.id = v_alias.tan_tao_sku_id;
      end if;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
             'id', coalesce(c.item_id, c.sku_id),
             'item_id', c.item_id,
             'sku_id', c.sku_id,
             'name', c.name,
             'unit', c.unit,
             'score', c.score,
             'reason', c.reason
           ) order by c.score desc, c.name asc, c.item_id asc nulls last, c.sku_id asc nulls last), '[]'::jsonb)
    into v_candidates
    from public.material_alias_candidates(v_raw_name, p_location, 5) c;

    select coalesce(array_agg(elem ->> 'id'), '{}'::text[])
    into v_candidate_ids
    from jsonb_array_elements(v_candidates) elem
    where elem ->> 'id' is not null;
    v_candidates_hash := public.material_alias_candidates_hash(v_candidate_ids);

    v_cache := null;
    select * into v_cache
    from public.material_alias_jev_cache z
    where z.location = p_location
      and z.normalized_name = v_norm
      and z.supplier_id is not distinct from p_supplier_id
      and z.candidates_hash = v_candidates_hash
    order by z.created_at desc, z.id desc
    limit 1;

    if v_alias.id is null then
      v_alias_json := null;
      v_needs_prompt := true;
    else
      v_alias_json := jsonb_build_object(
        'alias_id', v_alias.id,
        'status', v_alias.status,
        'line_class', v_alias.line_class,
        'item_id', v_alias.kitchen_inventory_item_id,
        'sku_id', v_alias.tan_tao_sku_id,
        'item_name', v_item_name,
        'unit', v_alias.unit,
        'conversion_factor', v_alias.conversion_factor,
        'pack_label', v_alias.pack_label,
        'confirm_count', v_alias.confirm_count,
        'confirmers_count', cardinality(coalesce(v_alias.confirmers, '{}'::uuid[])),
        'jev_disagreed', v_alias.jev_disagreed
      );
      -- [Giai đoạn 3] an auto non_stock alias needs no prompt.
      v_needs_prompt := v_alias.status <> 'auto';
    end if;

    v_pack := public.q7_pack_from_name(v_raw_name, v_raw_unit);

    -- [2026-10-19] A confident Jev "non_goods" answer marks the line
    -- non-stock without a prompt, unless an auto stock alias already exists.
    -- Rule lines already returned above.
    v_auto_non_stock := null;
    if v_cache.id is not null
       and v_cache.answer ->> 'line_type' = 'non_goods'
       and coalesce((v_cache.answer ->> 'line_type_probability')::numeric, 0) >= 0.9
       and not (v_alias.id is not null and v_alias.line_class = 'stock' and v_alias.status = 'auto') then
      v_jev_probability := (v_cache.answer ->> 'line_type_probability')::numeric;
      v_auto_non_stock := jsonb_build_object(
        'reason', 'jev',
        'source', 'jev',
        'probability', v_jev_probability
      );
      v_needs_prompt := false;
    end if;

    v_result := v_result || jsonb_build_object(
      'line_key', v_line_key,
      'normalized_name', v_norm,
      'alias', v_alias_json,
      'needs_prompt', v_needs_prompt,
      'candidates', v_candidates,
      'candidates_hash', v_candidates_hash,
      'jev', case when v_cache.id is null then null else v_cache.answer end,
      'pack_guess', v_pack,
      'auto_non_stock', v_auto_non_stock
    );
  end loop;

  return v_result;
end;
$$;
