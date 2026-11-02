-- 2026-11-02 — Kho: a kg / lít item also orders in kg / lít.
--
-- Owner IMG_6680: after turning on "Hiện theo kg", Đặt hàng still showed
-- "92 đ/g" and a g quantity box, because those supplier order lines were saved
-- with po_unit 'g'. kho_set_item_display_unit (copied from
-- 20261103600000_kho_item_display_unit.sql) now also moves the item's g / ml
-- order lines to kg / lít; existing kg items are backfilled here.
-- Sent orders keep their own quantity and unit; only future lines change.

create or replace function public.kho_order_lines_to_display_unit(
  p_item_id uuid,
  p_display_unit text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_small text := case p_display_unit when 'kg' then 'g' when 'lít' then 'ml' else null end;
  v_n integer;
begin
  if v_small is null then
    return 0;
  end if;
  update public.supplier_order_catalog_items c
    set po_unit = p_display_unit,
        po_unit_factor = c.po_unit_factor * 1000,
        pack_size_po = case when c.pack_size_po is null then null else c.pack_size_po / 1000 end,
        list_price = case when c.list_price is null then null else c.list_price * 1000 end
  where c.kitchen_inventory_item_id = p_item_id
    and lower(btrim(c.po_unit)) = v_small;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.kho_order_lines_to_display_unit(uuid, text) from public, anon, authenticated;
grant execute on function public.kho_order_lines_to_display_unit(uuid, text) to service_role;

create or replace function public.kho_set_item_display_unit(
  p_item_id uuid,
  p_display_unit text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_display_unit text;
  v_from text;
  v_cached jsonb;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
      raise exception 'unit_forbidden' using errcode = '42501';
    end if;
  end if;

  -- Replay before current catalog state is read: a retry returns the first
  -- call's result even when the item unit changed in the meantime.
  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text));
    select r.result into v_cached
    from public.warehouse_game_requests r
    where r.request_id = p_request_id
      and r.action = 'kho_set_display_unit';
    if found then
      return v_cached;
    end if;
  end if;

  v_display_unit := nullif(btrim(coalesce(p_display_unit, '')), '');
  if v_display_unit is not null then
    v_display_unit := lower(v_display_unit);
  end if;

  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = p_item_id
  for update;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  v_from := v_item.display_unit;

  -- kg is only for an item whose stored unit normalises to g; lít only for ml.
  if v_display_unit is not null
     and not (
       (v_display_unit = 'kg' and public.normalize_stock_unit(v_item.unit) = 'g')
       or (v_display_unit = 'lít' and public.normalize_stock_unit(v_item.unit) = 'ml')
     ) then
    raise exception 'display_unit_invalid' using errcode = '22023';
  end if;

  update public.kitchen_inventory_items
    set display_unit = v_display_unit
    where id = p_item_id;

  -- Turning kg / lít on also moves this item's supplier order lines that are
  -- still ordered in g / ml to kg / lít (owner 02/11: "trang đặt hàng vẫn hiển
  -- thị g"). Factor, pack size and a typed list price follow the unit, so the
  -- order amount is unchanged. Turning it off leaves the kg lines as they are.
  if v_display_unit is not null then
    perform public.kho_order_lines_to_display_unit(p_item_id, v_display_unit);
  end if;

  v_result := jsonb_build_object(
    'status', 'saved',
    'item_id', p_item_id,
    'display_unit', v_display_unit
  );

  insert into public.stock_unit_events (action, unit, item_id, details, actor)
  values (
    'set_display_unit',
    v_display_unit,
    p_item_id,
    jsonb_build_object('from', v_from, 'to', v_display_unit),
    v_actor
  );

  if p_request_id is not null then
    insert into public.warehouse_game_requests (request_id, action, item_id, result, created_by)
    values (p_request_id, 'kho_set_display_unit', p_item_id, v_result, v_actor)
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.kho_set_item_display_unit(uuid, text, uuid) from public, anon;
grant execute on function public.kho_set_item_display_unit(uuid, text, uuid) to authenticated, service_role;

-- Backfill: items already shown in kg / lít.
select public.kho_order_lines_to_display_unit(k.id, k.display_unit)
from public.kitchen_inventory_items k
where k.display_unit is not null;
