-- 2026-10-23 — Kho merge compares the catalog class, not the legacy item_type.
--
-- Owner could not merge "Hộp cua, croissant mini, danish" (tool_supply) into
-- "Hộp đựng bánh vuông nâu Kraft (Hàng nhập)" (ingredient): both are
-- packaging_supply in the app.  Only apply_stock_item_merge is redefined (body
-- from 20261102820000_kho_merge_chain.sql), with the type check switched to
-- item_class (item_type as fallback).  Signature, security and grants unchanged.

create or replace function public.apply_stock_item_merge(
  p_source uuid,
  p_target uuid,
  p_factor numeric,
  p_suggestion uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_source public.kitchen_inventory_items%rowtype;
  v_target public.kitchen_inventory_items%rowtype;
  v_target_unit text;
  v_merge_id uuid;
  v_rows integer := 0;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_source_balance numeric;
  v_tt_balance numeric;
  v_old jsonb;
  v_new jsonb;
  v_existing_setting public.q7_purchase_item_settings%rowtype;
  v_child public.kitchen_inventory_items%rowtype;
  v_child_factor numeric;
  c record;
  r record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_edit(v_actor_id) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_source is null or p_target is null then
    raise exception 'merge_source_and_target_required' using errcode = '22023';
  end if;
  if p_source = p_target then
    raise exception 'merge_source_equals_target' using errcode = '22023';
  end if;
  if p_factor is null or p_factor <= 0 or p_factor::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'merge_factor_invalid' using errcode = '22023';
  end if;

  select * into v_source from public.kitchen_inventory_items where id = p_source for update;
  if not found then raise exception 'merge_source_not_found' using errcode = 'P0002'; end if;
  select * into v_target from public.kitchen_inventory_items where id = p_target for update;
  if not found then raise exception 'merge_target_not_found' using errcode = 'P0002'; end if;

  if v_source.active is not true then
    raise exception 'merge_source_inactive: item % is already inactive or merged', p_source using errcode = '23514';
  end if;
  if v_target.active is not true then
    raise exception 'merge_target_inactive: target item % is inactive', p_target using errcode = '23514';
  end if;
  -- Compare the catalog class (Nguyên liệu vs Bao bì & vật tư) that the app
  -- shows; the legacy item_type is mixed inside packaging_supply (31 ingredient
  -- vs 35 tool_supply on 23/10) and blocked same-class merges.  item_type is
  -- only the fallback when a class is missing.
  if coalesce(v_source.item_class, v_source.item_type) is distinct from coalesce(v_target.item_class, v_target.item_type) then
    raise exception 'merge_item_type_mismatch: % vs %', coalesce(v_source.item_class, v_source.item_type), coalesce(v_target.item_class, v_target.item_type) using errcode = '23514';
  end if;
  if v_target.merged_into_id is not null then
    raise exception 'merge_target_already_merged: target % is already merged into another item', p_target using errcode = '23514';
  end if;
  -- A source that was the target of applied merges is allowed (merge chains);
  -- its children are re-pointed after the source -> target merge below.

  v_target_unit := v_target.unit;

  insert into public.stock_item_merges(source_id, target_id, factor, status, applied_by, applied_at, suggestion_id)
  values (p_source, p_target, p_factor, 'applied', v_actor_id, now(), p_suggestion)
  returning id into v_merge_id;

  select s.balance_qty
    into v_source_balance
  from public.get_q7_inventory_snapshot(v_today) s
  where s.kitchen_inventory_item_id = p_source;
  v_source_balance := coalesce(v_source_balance, 0);

  if v_source_balance <> 0 then
    insert into public.q7_inventory_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      p_source, v_today, 'adjustment', -v_source_balance, v_source.unit,
      'item_merge', 'item-merge:' || v_merge_id::text || ':out',
      'Bút toán chuyển tồn khi gộp mặt hàng ' || v_source.name || ' vào ' || v_target.name,
      v_actor_id
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

    insert into public.q7_inventory_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      p_target, v_today, 'adjustment', v_source_balance * p_factor, v_target_unit,
      'item_merge', 'item-merge:' || v_merge_id::text || ':in',
      'Bút toán nhận tồn khi gộp mặt hàng ' || v_source.name || ' vào ' || v_target.name,
      v_actor_id
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
  end if;

  -- Tân Tạo NVL ledger: the same append-only transfer pair for shared raw items.
  select coalesce(sum(case m.movement_type
                        when 'receipt' then m.quantity
                        when 'opening' then m.quantity
                        when 'production_usage' then -m.quantity
                        when 'adjustment' then m.quantity
                        when 'transfer_out' then -m.quantity
                        else 0 end), 0)
    into v_tt_balance
  from public.tan_tao_material_movements m
  where m.kitchen_inventory_item_id = p_source;

  if v_tt_balance <> 0 then
    insert into public.tan_tao_material_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      p_source, v_today, 'adjustment', -v_tt_balance, v_source.unit,
      'item_merge', 'item-merge:' || v_merge_id::text || ':tt:out',
      'Bút toán chuyển tồn sổ NVL Tân Tạo khi gộp ' || v_source.name || ' vào ' || v_target.name,
      v_actor_id
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

    insert into public.tan_tao_material_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      p_target, v_today, 'adjustment', v_tt_balance * p_factor, v_target_unit,
      'item_merge', 'item-merge:' || v_merge_id::text || ':tt:in',
      'Bút toán nhận tồn sổ NVL Tân Tạo khi gộp ' || v_source.name || ' vào ' || v_target.name,
      v_actor_id
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
  end if;

  for r in select * from public.production_material_issue_items where kitchen_inventory_item_id = p_source for update loop
    v_old := to_jsonb(r);
    update public.production_material_issue_items as t
      set kitchen_inventory_item_id = p_target,
          required_qty = r.required_qty * p_factor,
          unit = v_target_unit,
          conversion_factor = case
            when r.conversion_factor is null then null
            else r.conversion_factor * p_factor
          end,
          updated_at = now()
      where t.id = r.id
      returning to_jsonb(t.*) into v_new;
    insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
    values (v_merge_id, 'production_material_issue_items', r.id, v_old, v_new);
    v_rows := v_rows + 1;
  end loop;

  for r in select * from public.q7_material_issue_material_mappings where kitchen_inventory_item_id = p_source for update loop
    v_old := to_jsonb(r);
    update public.q7_material_issue_material_mappings as t
      set kitchen_inventory_item_id = p_target,
          conversion_factor = r.conversion_factor * p_factor,
          kitchen_unit = v_target_unit,
          updated_at = now()
      where t.id = r.id
      returning to_jsonb(t.*) into v_new;
    insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
    values (v_merge_id, 'q7_material_issue_material_mappings', r.id, v_old, v_new);
    v_rows := v_rows + 1;
  end loop;

  for r in select * from public.stock_material_aliases where kitchen_inventory_item_id = p_source for update loop
    v_old := to_jsonb(r);
    update public.stock_material_aliases as t
      set kitchen_inventory_item_id = p_target,
          conversion_factor = r.conversion_factor * p_factor,
          unit = v_target_unit,
          updated_at = now()
      where t.id = r.id
      returning to_jsonb(t.*) into v_new;
    insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
    values (v_merge_id, 'stock_material_aliases', r.id, v_old, v_new);
    v_rows := v_rows + 1;
  end loop;

  for r in select * from public.q7_purchase_item_settings where kitchen_inventory_item_id = p_source for update loop
    v_old := to_jsonb(r);
    select * into v_existing_setting
    from public.q7_purchase_item_settings
    where kitchen_inventory_item_id = p_target
    for update;
    if found then
      delete from public.q7_purchase_item_settings where id = r.id;
      insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
      values (v_merge_id, 'q7_purchase_item_settings', r.id, v_old, null);
    else
      update public.q7_purchase_item_settings as t
        set kitchen_inventory_item_id = p_target,
            updated_at = now()
        where t.id = r.id
        returning to_jsonb(t.*) into v_new;
      insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
      values (v_merge_id, 'q7_purchase_item_settings', r.id, v_old, v_new);
    end if;
    v_rows := v_rows + 1;
  end loop;

  update public.kitchen_inventory_items
    set active = false,
        merged_into_id = p_target,
        merged_factor = p_factor,
        merged_at = now()
    where id = p_source;

  -- Merge chains: this source may already be the target of applied merges.
  -- The body above forwarded the children's rows (aliases, mappings, settings)
  -- from the source to the target, so re-point the child items and their applied
  -- merge rows at the new target with the composed factor.  The old child values
  -- are logged in stock_item_merge_rows so revert_stock_item_merge can restore
  -- the chain in reverse order.
  for c in
    select sm.*
    from public.stock_item_merges sm
    where sm.target_id = p_source
      and sm.status = 'applied'
    order by sm.applied_at, sm.id
    for update
  loop
    v_child_factor := round(c.factor * p_factor, 8);
    if v_child_factor is null
       or v_child_factor <= 0
       or v_child_factor::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'merge_factor_invalid' using errcode = '22023';
    end if;

    select * into v_child
    from public.kitchen_inventory_items
    where id = c.source_id
    for update;
    if not found then
      raise exception 'merge_source_not_found' using errcode = 'P0002';
    end if;

    v_old := to_jsonb(v_child);
    update public.kitchen_inventory_items as t
      set merged_into_id = p_target,
          merged_factor = v_child_factor
      where t.id = c.source_id
      returning to_jsonb(t.*) into v_new;
    insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
    values (v_merge_id, 'kitchen_inventory_items', c.source_id, v_old, v_new);
    v_rows := v_rows + 1;

    v_old := to_jsonb(c);
    update public.stock_item_merges as t
      set target_id = p_target,
          factor = v_child_factor
      where t.id = c.id
      returning to_jsonb(t.*) into v_new;
    insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
    values (v_merge_id, 'stock_item_merges', c.id, v_old, v_new);
    v_rows := v_rows + 1;
  end loop;

  if p_suggestion is not null then
    update public.stock_catalog_suggestions
      set status = 'applied',
          decided_by = coalesce(decided_by, v_actor_id),
          decided_at = coalesce(decided_at, now())
      where id = p_suggestion and status in ('pending', 'approved');
  end if;

  return jsonb_build_object(
    'status', 'applied',
    'merge_id', v_merge_id,
    'source_id', p_source,
    'target_id', p_target,
    'factor', p_factor,
    'rows_logged', v_rows
  );
end;
$$;

revoke all on function public.apply_stock_item_merge(uuid, uuid, numeric, uuid) from public, anon;
grant execute on function public.apply_stock_item_merge(uuid, uuid, numeric, uuid) to authenticated, service_role;
