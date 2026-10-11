-- 2026-10-23 — Kho 2D (phần dữ liệu): toàn cảnh kho một lần gọi, đổi tên và
-- đổi đơn vị mặt hàng an toàn.
--
-- Additive migration on top of 20261022100000_shared_catalog_units.sql. It adds:
--   1. public.get_warehouse_game_snapshot(p_location) — one call for the whole
--      warehouse view of one location: the shared kitchen item catalog with the
--      location ledger total, aliases, finished-goods SKUs (Tân Tạo only), the
--      alias backlog (including the Jev suggestion) and the item-class counts.
--   2. public.rename_stock_item(...) — rename one live item and write the audit
--      row, idempotent by request_id.
--   3. public.change_stock_item_unit(...) — move one item to another standard
--      unit without rewriting the append-only ledger, idempotent by request_id.
--   4. public.warehouse_game_requests — the small idempotency table for 2 and 3.
--
-- Owner rule 2026-10-11: the catalog stores weights in g and volumes in ml. A
-- unit change therefore always lands on the base unit (kg -> g, l -> ml) and the
-- existing kitchen_inventory_items_unit_guard is left untouched.
--
-- Nothing here updates or deletes purchase_orders, payment_requests, goods_receipts,
-- q7_inventory_movements, tan_tao_material_movements or tan_tao_warehouse_movements.
-- The unit change reuses public.apply_stock_item_merge, which only appends ledger
-- rows and moves live references; the merge can be undone with
-- public.revert_stock_item_merge.

-- ===========================================================================
-- 1. Idempotency table
-- ===========================================================================

create table if not exists public.warehouse_game_requests (
  request_id uuid primary key,
  action text not null,
  item_id uuid,
  result jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint warehouse_game_requests_action_check check (action in ('rename', 'change_unit'))
);

alter table public.warehouse_game_requests enable row level security;

drop policy if exists warehouse_game_requests_select on public.warehouse_game_requests;
create policy warehouse_game_requests_select on public.warehouse_game_requests
  for select to authenticated
  using (public.material_alias_can_admin((select auth.uid())));

revoke all on table public.warehouse_game_requests from public, anon, authenticated;
grant select on table public.warehouse_game_requests to authenticated, service_role;
grant insert, update, delete on table public.warehouse_game_requests to service_role;

-- ===========================================================================
-- 3. public.get_warehouse_game_snapshot(p_location)
-- ===========================================================================

create or replace function public.get_warehouse_game_snapshot(p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_as_of date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_cutover date;
  v_items jsonb := '[]'::jsonb;
  v_skus jsonb := '[]'::jsonb;
  v_pending jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;

  -- Same reader gate as public.get_stock_ledger_overview(p_location).
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if p_location = 'q7' then
      if not public.q7_material_inventory_can_view(v_actor) then
        raise exception 'insufficient_privilege' using errcode = '42501';
      end if;
    else
      if not public.can_view_tan_tao_warehouse() then
        raise exception 'insufficient_privilege' using errcode = '42501';
      end if;
    end if;
  end if;

  v_cutover := public.stock_ledger_cutover_date(p_location);

  -- The shared catalog: every live item, for both warehouses.
  if p_location = 'q7' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', x.id,
             'code', x.item_code,
             'name', x.name,
             'unit', x.unit,
             'item_class', x.item_class,
             'on_hand', x.on_hand,
             'last_count_date', x.last_count_date,
             'aliases', x.aliases
           ) order by x.name), '[]'::jsonb)
    into v_items
    from (
      select kii.id,
             kii.item_code,
             kii.name,
             kii.unit,
             coalesce(kii.item_class, 'unclassified') as item_class,
             (
               coalesce(o.opening_qty, 0)
               + coalesce(mt.receipt_qty, 0)
               - coalesce(mt.usage_qty, 0)
               + coalesce(mt.adjustment_qty, 0)
             ) as on_hand,
             (
               select max(m.movement_date)
               from public.q7_inventory_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.source = 'manual_adjustment'
                 and m.source_ref_key like 'q7-stock-count:%'
                 and m.movement_date <= v_as_of
             ) as last_count_date,
             coalesce((
               select jsonb_agg(jsonb_build_object(
                        'normalized_name', a.normalized_name,
                        'status', a.status,
                        'line_class', a.line_class,
                        'supplier_name', sup.name
                      ) order by a.normalized_name)
               from public.stock_material_aliases a
               left join public.suppliers sup on sup.id = a.supplier_id
               where a.kitchen_inventory_item_id = kii.id
                 and a.location = p_location
             ), '[]'::jsonb) as aliases
      from public.kitchen_inventory_items kii
      left join lateral (
        select o2.opening_qty, o2.effective_date
        from public.q7_inventory_openings o2
        where o2.kitchen_inventory_item_id = kii.id
          and o2.effective_date <= v_as_of
        order by o2.effective_date desc, o2.updated_at desc, o2.id desc
        limit 1
      ) o on true
      left join lateral (
        select coalesce(sum(m.quantity) filter (where m.movement_type = 'receipt'), 0) as receipt_qty,
               coalesce(sum(m.quantity) filter (where m.movement_type = 'production_usage'), 0) as usage_qty,
               coalesce(sum(m.quantity) filter (where m.movement_type = 'adjustment'), 0) as adjustment_qty
        from public.q7_inventory_movements m
        where m.kitchen_inventory_item_id = kii.id
          and m.movement_date <= v_as_of
          and m.movement_date >= coalesce(o.effective_date, '0001-01-01'::date)
      ) mt on true
      where kii.active = true
        and kii.merged_into_id is null
    ) x;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', x.id,
             'code', x.item_code,
             'name', x.name,
             'unit', x.unit,
             'item_class', x.item_class,
             'on_hand', x.on_hand,
             'last_count_date', x.last_count_date,
             'aliases', x.aliases
           ) order by x.name), '[]'::jsonb)
    into v_items
    from (
      select kii.id,
             kii.item_code,
             kii.name,
             kii.unit,
             coalesce(kii.item_class, 'unclassified') as item_class,
             coalesce((
               select sum(case m.movement_type
                            when 'receipt' then m.quantity
                            when 'opening' then m.quantity
                            when 'production_usage' then -m.quantity
                            when 'adjustment' then m.quantity
                            else 0 end)
               from public.tan_tao_material_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.movement_date <= v_as_of
             ), 0) as on_hand,
             (
               select max(m.movement_date)
               from public.tan_tao_material_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.source = 'manual_adjustment'
                 and m.source_ref_key like 'tt-material-count:%'
                 and m.movement_date <= v_as_of
             ) as last_count_date,
             coalesce((
               select jsonb_agg(jsonb_build_object(
                        'normalized_name', a.normalized_name,
                        'status', a.status,
                        'line_class', a.line_class,
                        'supplier_name', sup.name
                      ) order by a.normalized_name)
               from public.stock_material_aliases a
               left join public.suppliers sup on sup.id = a.supplier_id
               where a.kitchen_inventory_item_id = kii.id
                 and a.location = p_location
             ), '[]'::jsonb) as aliases
      from public.kitchen_inventory_items kii
      where kii.active = true
        and kii.merged_into_id is null
    ) x;

    -- Finished-goods SKUs only exist at Tân Tạo.
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', ps.id,
             'sku_code', ps.sku_code,
             'product_name', ps.product_name,
             'unit', ps.unit,
             'on_hand', coalesce((
               select sum(m.quantity)
               from public.tan_tao_warehouse_movements m
               where m.sku_id = ps.id
                 and m.location_code = 'warehouse_tan_tao'
             ), 0)
           ) order by ps.sku_code), '[]'::jsonb)
    into v_skus
    from public.product_skus ps
    where ps.sku_type::text = 'finished_good';
  end if;

  -- The backlog review is owner / Q7-admin only. A plain warehouse viewer still
  -- gets the whole snapshot, just with an empty pending list.
  begin
    select coalesce(jsonb_agg(to_jsonb(p) order by p.line_count desc, p.normalized_name, p.supplier_id), '[]'::jsonb)
    into v_pending
    from public.get_material_alias_backlog_review(p_location, 200) p;
  exception when insufficient_privilege then
    v_pending := '[]'::jsonb;
  end;

  select coalesce(jsonb_object_agg(g.cls, g.n), '{}'::jsonb)
  into v_counts
  from (
    select coalesce(kii.item_class, 'unclassified') as cls, count(*)::numeric as n
    from public.kitchen_inventory_items kii
    where kii.active = true
      and kii.merged_into_id is null
    group by 1
  ) g;

  return jsonb_build_object(
    'location', p_location,
    'cutover_date', v_cutover,
    'items', v_items,
    'skus', v_skus,
    'pending', v_pending,
    'counts', v_counts,
    'can_edit', public.q7_material_inventory_can_edit(v_actor)
  );
end;
$$;

revoke all on function public.get_warehouse_game_snapshot(text) from public, anon;
grant execute on function public.get_warehouse_game_snapshot(text) to authenticated, service_role;

-- ===========================================================================
-- 4. public.rename_stock_item(p_item_id, p_new_name, p_request_id)
-- ===========================================================================

create or replace function public.rename_stock_item(
  p_item_id uuid,
  p_new_name text,
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
  v_name text := btrim(coalesce(p_new_name, ''));
  v_old_name text;
  v_norm text;
  v_cached jsonb;
  v_result jsonb;
begin
  -- Owner or Q7 stock editor only.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.q7_material_inventory_can_edit(v_actor) then
      raise exception 'rename_forbidden' using errcode = '42501';
    end if;
  end if;

  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text));
    select r.result into v_cached
    from public.warehouse_game_requests r
    where r.request_id = p_request_id
      and r.action = 'rename';
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

  v_old_name := v_item.name;
  v_norm := public.normalize_stock_item_name(v_name);
  if v_norm is null then v_norm := lower(v_name); end if;

  if exists (
    select 1
    from public.kitchen_inventory_items k
    where k.id <> p_item_id
      and k.active = true
      and k.merged_into_id is null
      and public.normalize_stock_item_name(k.name) = v_norm
  ) then
    raise exception 'item_name_duplicate' using errcode = '23505';
  end if;

  -- The item unit/name trigger also refuses a duplicate; surface its clear code.
  begin
    update public.kitchen_inventory_items
      set name = v_name,
          updated_at = now()
      where id = p_item_id;
  exception when unique_violation then
    raise exception 'item_name_duplicate' using errcode = '23505';
  end;

  insert into public.kitchen_inventory_item_audit_logs (
    item_id, action, old_values, new_values, changed_by
  ) values (
    p_item_id,
    'manually_edited',
    jsonb_build_object('name', v_old_name, 'reason', 'warehouse_game_rename'),
    jsonb_build_object('name', v_name, 'reason', 'warehouse_game_rename'),
    v_actor
  );

  v_result := jsonb_build_object(
    'item_id', p_item_id,
    'old_name', v_old_name,
    'new_name', v_name
  );

  if p_request_id is not null then
    insert into public.warehouse_game_requests (request_id, action, item_id, result, created_by)
    values (p_request_id, 'rename', p_item_id, v_result, v_actor)
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.rename_stock_item(uuid, text, uuid) from public, anon;
grant execute on function public.rename_stock_item(uuid, text, uuid) to authenticated, service_role;

-- ===========================================================================
-- 5. public.change_stock_item_unit(p_item_id, p_new_unit, p_factor, p_request_id)
-- ===========================================================================
--
-- 1 old unit = p_factor new units. A weight / volume pair ignores p_factor and
-- uses the ratio in public.stock_units. An item with no ledger history is updated
-- in place; an item that already moved gets a new sibling in the new unit and is
-- merged into it, exactly like public.standardize_stock_item_units does, so the
-- old ledger rows are never rewritten.

create or replace function public.change_stock_item_unit(
  p_item_id uuid,
  p_new_unit text,
  p_factor numeric,
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
    if v_actor is null or not public.q7_material_inventory_can_edit(v_actor) then
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
    insert into public.kitchen_inventory_items (
      item_code, normalized_key, item_type, name, unit, standard_unit_cost, active
    ) values (
      v_code, v_key, v_item.item_type, v_item.name, v_new_unit,
      round(v_item.standard_unit_cost / v_factor, 8), true
    )
    returning id into v_new_item_id;
    perform set_config('stock_catalog.unit_migration', 'off', true);

    v_merge := public.apply_stock_item_merge(p_item_id, v_new_item_id, v_factor, null);
    v_merge_id := nullif(v_merge ->> 'merge_id', '')::uuid;

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
$$;

revoke all on function public.change_stock_item_unit(uuid, text, numeric, uuid) from public, anon;
grant execute on function public.change_stock_item_unit(uuid, text, numeric, uuid) to authenticated, service_role;
