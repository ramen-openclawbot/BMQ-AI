-- Rollback-only production smoke for migration
-- 20261023100000_warehouse_game.sql.
--
-- Run as one file:
--   supabase db query --linked -f apps/web/scripts/smoke_warehouse_game.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_warehouse_game.sql).
--
-- The file opens one transaction, applies the migration SQL inline, exercises the
-- snapshot, rename and unit-change RPCs as the real owner (from public.user_roles)
-- and a real employee without stock permission, then raises SMOKE_RESULT PASS.
-- The final RAISE aborts the transaction, so every change rolls back.
begin;

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

do $smoke$
declare
  v_owner uuid;
  v_emp uuid;
  v_snap jsonb;
  v_snap_tt jsonb;
  v_pending_expected jsonb;
  v_mismatch integer;
  v_groups integer;
  v_item_a uuid;
  v_name_a text;
  v_item_b uuid;
  v_name_b text;
  v_new_name text;
  v_req uuid;
  v_res jsonb;
  v_audit_count integer;
  v_audit_after integer;
  v_fresh uuid;
  v_alias_factor numeric;
  v_alias_unit text;
  v_cost numeric;
  v_unit text;
  v_hist uuid;
  v_merge_id uuid;
  v_new_item uuid;
  v_probe integer;
begin
  -- Real owner and a real employee with no stock permission.
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL no_owner';
  end if;

  select ur.user_id into v_emp
  from public.user_roles ur
  where ur.role::text = 'viewer'
    and not public.q7_material_inventory_can_edit(ur.user_id)
    and not public.material_alias_can_admin(ur.user_id)
  order by ur.created_at, ur.user_id
  limit 1;
  if v_emp is null then
    raise exception 'SMOKE_RESULT FAIL no_employee';
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  -- (1) counts match the direct per-class count.
  v_snap := public.get_warehouse_game_snapshot('q7');

  select count(*) into v_mismatch
  from jsonb_each_text(v_snap -> 'counts') c
  where c.value::numeric <> (
    select count(*)
    from public.kitchen_inventory_items k
    where k.active = true and k.merged_into_id is null
      and coalesce(k.item_class, 'unclassified') = c.key
  );
  select count(distinct coalesce(k.item_class, 'unclassified')) into v_groups
  from public.kitchen_inventory_items k
  where k.active = true and k.merged_into_id is null;
  if v_mismatch <> 0
     or (select count(*) from jsonb_object_keys(v_snap -> 'counts')) <> v_groups then
    raise exception 'SMOKE_RESULT FAIL counts_match';
  end if;

  -- (2) q7 on_hand equals the ledger total of get_stock_ledger_overview.
  with snap as (
    select (i ->> 'id')::uuid as id, (i ->> 'on_hand')::numeric as on_hand
    from jsonb_array_elements(v_snap -> 'items') i
  ), calc as (
    select kii.id,
           coalesce(o.opening_qty, 0) + coalesce(mt.receipt_qty, 0)
             - coalesce(mt.usage_qty, 0) + coalesce(mt.adjustment_qty, 0) as on_hand
    from public.kitchen_inventory_items kii
    left join lateral (
      select o2.opening_qty, o2.effective_date
      from public.q7_inventory_openings o2
      where o2.kitchen_inventory_item_id = kii.id
        and o2.effective_date <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
      order by o2.effective_date desc, o2.updated_at desc, o2.id desc
      limit 1
    ) o on true
    left join lateral (
      select coalesce(sum(m.quantity) filter (where m.movement_type = 'receipt'), 0) as receipt_qty,
             coalesce(sum(m.quantity) filter (where m.movement_type = 'production_usage'), 0) as usage_qty,
             coalesce(sum(m.quantity) filter (where m.movement_type = 'adjustment'), 0) as adjustment_qty
      from public.q7_inventory_movements m
      where m.kitchen_inventory_item_id = kii.id
        and m.movement_date <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
        and m.movement_date >= coalesce(o.effective_date, '0001-01-01'::date)
    ) mt on true
    where kii.active = true and kii.merged_into_id is null
  )
  select count(*) into v_mismatch
  from snap s join calc c using (id)
  where s.on_hand is distinct from c.on_hand;
  if v_mismatch <> 0
     or (select count(*) from jsonb_array_elements(v_snap -> 'items'))
        <> (select count(*) from public.kitchen_inventory_items k
            where k.active = true and k.merged_into_id is null) then
    raise exception 'SMOKE_RESULT FAIL on_hand_match';
  end if;

  -- (3) pending equals the backlog review (with the Jev suggestion).
  select coalesce(jsonb_agg(to_jsonb(p) order by p.line_count desc, p.normalized_name, p.supplier_id), '[]'::jsonb)
  into v_pending_expected
  from public.get_material_alias_backlog_review('q7', 200) p;
  if (v_snap -> 'pending') is distinct from v_pending_expected then
    raise exception 'SMOKE_RESULT FAIL pending_match';
  end if;

  -- (4) Tân Tạo has skus, Q7 does not.
  v_snap_tt := public.get_warehouse_game_snapshot('tan_tao');
  if jsonb_array_length(v_snap -> 'skus') <> 0 then
    raise exception 'SMOKE_RESULT FAIL skus_location q7_has_skus';
  end if;
  if jsonb_array_length(v_snap_tt -> 'skus') = 0 then
    raise exception 'SMOKE_RESULT FAIL skus_location tan_tao_has_no_skus';
  end if;
  if (v_snap_tt ->> 'location') <> 'tan_tao' then
    raise exception 'SMOKE_RESULT FAIL skus_location location=%', v_snap_tt ->> 'location';
  end if;

  with snap as (
    select (i ->> 'id')::uuid as id, (i ->> 'on_hand')::numeric as on_hand
    from jsonb_array_elements(v_snap_tt -> 'items') i
  ), calc as (
    select kii.id,
           coalesce((
             select sum(case m.movement_type
                          when 'receipt' then m.quantity
                          when 'opening' then m.quantity
                          when 'production_usage' then -m.quantity
                          when 'adjustment' then m.quantity
                          else 0 end)
             from public.tan_tao_material_movements m
             where m.kitchen_inventory_item_id = kii.id
               and m.movement_date <= (now() at time zone 'Asia/Ho_Chi_Minh')::date
           ), 0) as on_hand
    from public.kitchen_inventory_items kii
    where kii.active = true and kii.merged_into_id is null
  )
  select count(*) into v_mismatch
  from snap s join calc c using (id)
  where s.on_hand is distinct from c.on_hand;
  if v_mismatch <> 0 then
    raise exception 'SMOKE_RESULT FAIL on_hand_match tan_tao';
  end if;

  -- (5) renaming to a live item's name is refused.
  select k.id, k.name into v_item_a, v_name_a
  from public.kitchen_inventory_items k
  where k.active = true and k.merged_into_id is null
  order by k.created_at, k.id
  limit 1;
  select k.id, k.name into v_item_b, v_name_b
  from public.kitchen_inventory_items k
  where k.active = true and k.merged_into_id is null and k.id <> v_item_a
  order by k.created_at, k.id
  limit 1;
  if v_item_b is null then
    raise exception 'SMOKE_RESULT FAIL rename_duplicate no_second_item';
  end if;

  v_probe := 0;
  begin
    perform public.rename_stock_item(v_item_a, v_name_b, gen_random_uuid());
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%item_name_duplicate%' then
      raise exception 'SMOKE_RESULT FAIL rename_duplicate: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL rename_duplicate accepted';
  end if;

  -- (6) a valid rename writes the audit row, (7) replaying the request writes nothing.
  v_new_name := 'SMOKE ' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_req := gen_random_uuid();
  v_res := public.rename_stock_item(v_item_a, v_new_name, v_req);
  if (v_res ->> 'old_name') is distinct from v_name_a
     or (v_res ->> 'new_name') is distinct from v_new_name
     or (v_res ->> 'item_id')::uuid <> v_item_a then
    raise exception 'SMOKE_RESULT FAIL rename_audit result=%', v_res;
  end if;

  select count(*) into v_audit_count
  from public.kitchen_inventory_item_audit_logs l
  where l.item_id = v_item_a
    and l.new_values ->> 'reason' = 'warehouse_game_rename'
    and l.old_values ->> 'name' = v_name_a
    and l.new_values ->> 'name' = v_new_name
    and l.changed_by = v_owner;
  if v_audit_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL rename_audit count=%', v_audit_count;
  end if;

  perform public.rename_stock_item(v_item_a, 'SMOKE DIFFERENT NAME', v_req);
  select count(*) into v_audit_after
  from public.kitchen_inventory_item_audit_logs l
  where l.item_id = v_item_a
    and l.new_values ->> 'reason' = 'warehouse_game_rename';
  if v_audit_after <> v_audit_count then
    raise exception 'SMOKE_RESULT FAIL rename_idempotent audit=%', v_audit_after;
  end if;
  if (select k.name from public.kitchen_inventory_items k where k.id = v_item_a) <> v_new_name then
    raise exception 'SMOKE_RESULT FAIL rename_idempotent name';
  end if;

  -- (8) g -> kg with no history: aliases /1000, cost *1000.
  insert into public.kitchen_inventory_items (
    item_code, normalized_key, item_type, name, unit, standard_unit_cost, active
  ) values (
    public.stock_unit_next_item_code(),
    'smoke:unit:' || replace(gen_random_uuid()::text, '-', ''),
    'ingredient',
    'SMOKE UNIT ' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
    'cái', 2, true
  )
  returning id into v_fresh;

  insert into public.stock_material_aliases (
    supplier_id, normalized_name, location, kitchen_inventory_item_id,
    conversion_factor, unit, status, line_class
  ) values (
    null,
    'smoke unit ' || replace(gen_random_uuid()::text, '-', ''),
    'q7', v_fresh, 24, 'cái', 'learning', 'stock'
  );

  v_req := gen_random_uuid();
  -- 1 cái = 0.1 hộp (a box of 10).
  v_res := public.change_stock_item_unit(v_fresh, 'Hộp', 0.1, v_req);
  if (v_res ->> 'factor')::numeric <> 0.1
     or (v_res ->> 'new_unit') <> 'hộp'
     or (v_res ->> 'merge_id') is not null then
    raise exception 'SMOKE_RESULT FAIL unit_no_history result=%', v_res;
  end if;
  select a.conversion_factor, a.unit into v_alias_factor, v_alias_unit
  from public.stock_material_aliases a
  where a.kitchen_inventory_item_id = v_fresh;
  select k.standard_unit_cost, k.unit into v_cost, v_unit
  from public.kitchen_inventory_items k
  where k.id = v_fresh;
  if v_alias_factor <> 2.4 or v_alias_unit <> 'hộp' then
    raise exception 'SMOKE_RESULT FAIL unit_no_history alias factor=% unit=%', v_alias_factor, v_alias_unit;
  end if;
  if v_cost <> 20 or v_unit <> 'hộp' then
    raise exception 'SMOKE_RESULT FAIL unit_no_history cost=% unit=%', v_cost, v_unit;
  end if;
  if not exists (
    select 1 from public.stock_unit_conversions c
    where c.old_item_id = v_fresh and c.new_item_id = v_fresh
      and c.old_unit = 'cái' and c.new_unit = 'hộp' and c.factor = 0.1
  ) then
    raise exception 'SMOKE_RESULT FAIL unit_no_history conversion row';
  end if;

  -- (9) g -> kg with ledger history creates a merge, (10) the merge reverts.
  insert into public.kitchen_inventory_items (
    item_code, normalized_key, item_type, name, unit, standard_unit_cost, active
  ) values (
    public.stock_unit_next_item_code(),
    'smoke:hist:' || replace(gen_random_uuid()::text, '-', ''),
    'ingredient',
    'SMOKE HIST ' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
    'g', 3, true
  )
  returning id into v_hist;

  -- Owner rule: the catalog keeps g / ml, so asking for kg on a g item is no change.
  v_probe := 0;
  begin
    perform public.change_stock_item_unit(v_hist, 'kg', null, gen_random_uuid());
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%unit_unchanged%' then
      raise exception 'SMOKE_RESULT FAIL unit_base_only: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL unit_base_only accepted kg';
  end if;

  insert into public.q7_inventory_movements (
    kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
    source, source_ref_key, created_by
  ) values (
    v_hist, (now() at time zone 'Asia/Ho_Chi_Minh')::date, 'receipt', 100, 'g',
    'manual_receipt', 'smoke-game-hist:' || replace(gen_random_uuid()::text, '-', ''), v_owner
  );

  if not public.stock_unit_item_has_history(v_hist) then
    raise exception 'SMOKE_RESULT FAIL unit_with_history no_history';
  end if;

  v_req := gen_random_uuid();
  -- A sack is a count unit, so the factor is given: 1 g = 0.00004 bao (bao 25 kg).
  v_res := public.change_stock_item_unit(v_hist, 'bao', 0.00004, v_req);
  v_new_item := (v_res ->> 'item_id')::uuid;
  v_merge_id := nullif(v_res ->> 'merge_id', '')::uuid;
  if v_merge_id is null then
    raise exception 'SMOKE_RESULT FAIL unit_with_history no_merge result=%', v_res;
  end if;
  if v_new_item = v_hist then
    raise exception 'SMOKE_RESULT FAIL unit_with_history same_item';
  end if;
  if (select k.unit from public.kitchen_inventory_items k where k.id = v_new_item) <> 'bao' then
    raise exception 'SMOKE_RESULT FAIL unit_with_history new_unit';
  end if;
  if (select k.merged_into_id from public.kitchen_inventory_items k where k.id = v_hist) <> v_new_item then
    raise exception 'SMOKE_RESULT FAIL unit_with_history not_merged';
  end if;
  if not exists (
    select 1 from public.stock_unit_conversions c
    where c.merge_id = v_merge_id and c.old_item_id = v_hist and c.new_item_id = v_new_item
  ) then
    raise exception 'SMOKE_RESULT FAIL unit_with_history conversion row';
  end if;

  v_res := public.revert_stock_item_merge(v_merge_id);
  if (v_res ->> 'status') <> 'reverted' then
    raise exception 'SMOKE_RESULT FAIL unit_revert result=%', v_res;
  end if;
  if (select k.merged_into_id from public.kitchen_inventory_items k where k.id = v_hist) is not null then
    raise exception 'SMOKE_RESULT FAIL unit_revert still_merged';
  end if;

  -- (11) + (12) an employee with no stock permission is refused both RPCs.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_emp, 'role', 'authenticated')::text, true);

  v_probe := 0;
  begin
    perform public.rename_stock_item(v_item_b,
      'SMOKE DENIED ' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6),
      gen_random_uuid());
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%rename_forbidden%' then
      raise exception 'SMOKE_RESULT FAIL forbidden_rename: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL forbidden_rename accepted';
  end if;

  v_probe := 0;
  begin
    perform public.change_stock_item_unit(v_item_b, 'kg', null, gen_random_uuid());
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%unit_forbidden%' then
      raise exception 'SMOKE_RESULT FAIL forbidden_unit: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL forbidden_unit accepted';
  end if;

  raise exception 'SMOKE_RESULT PASS: warehouse game snapshot + rename + unit change';
end;
$smoke$;
