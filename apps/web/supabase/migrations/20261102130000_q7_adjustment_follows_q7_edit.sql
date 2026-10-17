-- 2026-10-17 — Q7 stock adjustments follow the Kho Q7 edit permission.
--
-- Owner 17/10 (IMG_5833): Xuan Mai has "Kho Q7 – sửa" but every Q7 answer in the
-- mission "Quy đổi tồn 16/10" failed with insufficient_privilege, because
-- record_q7_stock_count -> record_q7_inventory_adjustment only accepted the owner
-- or accounting:edit (no user holds accounting). Owner: "Quyền sửa thì theo phân
-- quyền. A đã phân quyền cho Mai được sửa thì tương đương kế toán rồi."
--
-- Only the permission check changes; the body is copied from the live definition
-- (pg_get_functiondef, 17/10). Grants unchanged (authenticated).

CREATE OR REPLACE FUNCTION public.record_q7_inventory_adjustment(p_movement_date date, p_kitchen_inventory_item_id uuid, p_quantity numeric, p_unit text, p_reason text, p_source_ref_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_id uuid := auth.uid();
  v_resolved record;
  v_movement_id uuid;
  v_existing public.q7_inventory_movements%rowtype;
  v_source_ref_key text := nullif(btrim(p_source_ref_key), '');
begin
  if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
  -- Owner 17/10: Q7 stock edits follow the permission matrix — whoever may edit
  -- Kho Q7 (q7_material_inventory_can_edit) may record a Q7 adjustment, like accounting.
  if not (
    public.has_role(v_actor_id, 'owner')
    or public.has_module_permission(v_actor_id, 'accounting', 'edit')
    or public.q7_material_inventory_can_edit(v_actor_id)
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_movement_date is null then raise exception 'movement_date_required' using errcode = '22023'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason_required' using errcode = '22023'; end if;
  if p_quantity is null or p_quantity = 0 or p_quantity::text in ('NaN', 'Infinity', '-Infinity') then raise exception 'invalid_quantity' using errcode = '22023'; end if;
  if p_source_ref_key is not null and (btrim(p_source_ref_key) = '' or length(btrim(p_source_ref_key)) > 120) then raise exception 'source_ref_key_invalid' using errcode = '22023'; end if;

  select * into v_resolved
  from public.resolve_q7_canonical_inventory_item(p_kitchen_inventory_item_id, p_unit);

  insert into public.q7_inventory_movements(
    kitchen_inventory_item_id, movement_date, movement_type, quantity, unit, source,
    source_ref_key, note, created_by, q7_mapping_id, canonical_material_id
  ) values (
    v_resolved.kitchen_inventory_item_id, p_movement_date, 'adjustment', p_quantity,
    v_resolved.unit, 'manual_adjustment', v_source_ref_key, p_reason, v_actor_id,
    v_resolved.q7_mapping_id, v_resolved.canonical_material_id
  )
  on conflict (source, source_ref_key) where source_ref_key is not null do nothing
  returning id into v_movement_id;

  if v_movement_id is not null then
    return jsonb_build_object('status', 'adjustment_recorded', 'movement_id', v_movement_id);
  end if;

  if v_source_ref_key is not null then
    select * into v_existing
    from public.q7_inventory_movements
    where source = 'manual_adjustment' and source_ref_key = v_source_ref_key
    for update;
    if found and v_existing.kitchen_inventory_item_id is not distinct from v_resolved.kitchen_inventory_item_id
       and v_existing.movement_date is not distinct from p_movement_date
       and v_existing.movement_type is not distinct from 'adjustment'
       and v_existing.quantity is not distinct from p_quantity
       and lower(btrim(v_existing.unit)) is not distinct from lower(btrim(v_resolved.unit))
       and v_existing.note is not distinct from p_reason
       and v_existing.q7_mapping_id is not distinct from v_resolved.q7_mapping_id
       and v_existing.canonical_material_id is not distinct from v_resolved.canonical_material_id then
      return jsonb_build_object('status', 'adjustment_unchanged', 'movement_id', v_existing.id);
    end if;
    raise exception 'source_ref_conflict' using errcode = '23505';
  end if;

  raise exception 'q7_adjustment_insert_failed' using errcode = '40001';
end;
$function$;

revoke all on function public.record_q7_inventory_adjustment(date, uuid, numeric, text, text, text) from public, anon;
grant execute on function public.record_q7_inventory_adjustment(date, uuid, numeric, text, text, text) to authenticated;
