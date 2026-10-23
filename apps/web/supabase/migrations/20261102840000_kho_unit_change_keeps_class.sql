-- 2026-10-23 — Đổi đơn vị món giữ nhóm hàng, chỗ ở kho và ghi chú.
--
-- change_stock_item_unit creates a same-name sibling in the new unit and merges
-- the old item into it.  The sibling was inserted without item_class / places /
-- note, so the merge (now compared by item_class) refused "packaging_supply vs
-- ingredient".  Only this function is redefined (live body), copying those
-- fields and letting the item-code trigger assign the next code of the class.
-- Grants are untouched (create or replace keeps them).

CREATE OR REPLACE FUNCTION public.change_stock_item_unit(p_item_id uuid, p_new_unit text, p_factor numeric, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_old_unit text;
  v_new_unit text;
  v_old_kind text;
  v_new_kind text;
  v_old_to_base numeric;
  v_new_to_base numeric;
  v_factor numeric;
  v_has_history boolean;
  v_new_item_id uuid;
  v_merge_id uuid;
  v_merge jsonb;
  v_code text;
  v_key text;
  v_cached jsonb;
  v_result jsonb;
begin
  -- Owner or Q7 stock editor only.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
      raise exception 'unit_forbidden' using errcode = '42501';
    end if;
  end if;

  -- The requested spelling must be a known unit. The catalog keeps base units
  -- only (owner rule: g / ml, never kg / l), so kg collapses to g here.
  v_new_unit := public.normalize_stock_unit(p_new_unit);
  if v_new_unit is null
     or not exists (select 1 from public.stock_units u where u.code = v_new_unit) then
    raise exception 'unit_not_allowed' using errcode = '23514';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text));
    select r.result into v_cached
    from public.warehouse_game_requests r
    where r.request_id = p_request_id
      and r.action = 'change_unit';
    if found then
      return v_cached;
    end if;
  end if;

  select * into v_item
  from public.kitchen_inventory_items
  where id = p_item_id
    and active = true
    and merged_into_id is null
  for update;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  v_old_unit := v_item.unit;
  if v_old_unit = v_new_unit then
    raise exception 'unit_unchanged' using errcode = '22023';
  end if;

  select u.kind, u.to_base into v_old_kind, v_old_to_base
  from public.stock_units u
  where u.code = public.normalize_stock_unit(v_old_unit);
  select u.kind, u.to_base into v_new_kind, v_new_to_base
  from public.stock_units u
  where u.code = v_new_unit;

  if v_old_kind is not null
     and v_old_kind = v_new_kind
     and v_old_kind in ('weight', 'volume') then
    v_factor := v_old_to_base / v_new_to_base;
  else
    if p_factor is null
       or p_factor <= 0
       or p_factor::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'invalid_factor' using errcode = '22023';
    end if;
    v_factor := p_factor;
  end if;

  v_has_history := public.stock_unit_item_has_history(p_item_id);

  if not v_has_history then
    update public.kitchen_inventory_items
      set unit = v_new_unit,
          standard_unit_cost = round(standard_unit_cost / v_factor, 8),
          updated_at = now()
      where id = p_item_id;

    update public.stock_material_aliases
      set unit = v_new_unit,
          conversion_factor = conversion_factor * v_factor,
          updated_at = now()
      where kitchen_inventory_item_id = p_item_id;

    insert into public.stock_unit_conversions (
      old_item_id, new_item_id, old_unit, new_unit, factor, merge_id, note
    ) values (
      p_item_id, p_item_id, v_old_unit, v_new_unit, v_factor, null,
      'warehouse_game_unit_change'
    );

    v_result := jsonb_build_object(
      'item_id', p_item_id,
      'old_unit', v_old_unit,
      'new_unit', v_new_unit,
      'factor', v_factor,
      'merge_id', null
    );
  else
    -- New sibling in the new unit, same name. The unit-migration flag lets the
    -- guard accept the temporary duplicate name while both rows are live.
    v_code := public.stock_unit_next_item_code();
    v_key := v_item.normalized_key || ':unit:' || v_new_unit;
    while exists (
      select 1 from public.kitchen_inventory_items k where k.normalized_key = v_key
    ) loop
      v_key := v_key || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);
    end loop;

    perform set_config('stock_catalog.unit_migration', 'on', true);
    -- The sibling keeps the item's catalog class, kho places and note (owner
    -- 23/10: a unit change on a Bao bì item failed the merge class check), and
    -- takes the next code of its class from the item-code trigger.
    insert into public.kitchen_inventory_items (
      item_code, normalized_key, item_type, item_class, pastry_q7, in_tan_tao, note,
      name, unit, standard_unit_cost, active
    ) values (
      null, v_key, v_item.item_type, v_item.item_class, v_item.pastry_q7, v_item.in_tan_tao, v_item.note,
      v_item.name, v_new_unit,
      round(v_item.standard_unit_cost / v_factor, 8), true
    )
    returning id into v_new_item_id;
    perform set_config('stock_catalog.unit_migration', 'off', true);

    v_merge := public.apply_stock_item_merge(p_item_id, v_new_item_id, v_factor, null);
    v_merge_id := nullif(v_merge ->> 'merge_id', '')::uuid;

    -- The item keeps its code across a unit change: the merged-away row gets a
    -- parked code and the new sibling takes the original one back.
    if v_item.item_code is not null then
      update public.kitchen_inventory_items
        set item_code = 'UNIT-' || p_item_id::text
        where id = p_item_id;
      update public.kitchen_inventory_items
        set item_code = v_item.item_code
        where id = v_new_item_id;
      delete from public.kitchen_item_code_history
        where item_id = v_new_item_id and reason = 'auto_assign';
    end if;

    insert into public.stock_unit_conversions (
      old_item_id, new_item_id, old_unit, new_unit, factor, merge_id, note
    ) values (
      p_item_id, v_new_item_id, v_old_unit, v_new_unit, v_factor, v_merge_id,
      'warehouse_game_unit_change_merge'
    );

    v_result := jsonb_build_object(
      'item_id', v_new_item_id,
      'old_unit', v_old_unit,
      'new_unit', v_new_unit,
      'factor', v_factor,
      'merge_id', v_merge_id
    );
  end if;

  if p_request_id is not null then
    insert into public.warehouse_game_requests (request_id, action, item_id, result, created_by)
    values (p_request_id, 'change_unit', (v_result ->> 'item_id')::uuid, v_result, v_actor)
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$function$;
