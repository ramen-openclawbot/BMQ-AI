-- 2026-10-21 — Kho 2 việc: danh sách hàng + lưu tên/đơn vị/bật tắt + đếm từng món.
--
-- The UI is built next; this migration is the data layer only.  It reuses the
-- live primitives instead of copying their logic:
--   B1. kho_item_can_edit() is the exact discontinue_stock_item() gate.
--       rename_stock_item() and change_stock_item_unit() keep their old bodies
--       and only swap that one permission check.
--   B2. kho_get_items() returns one payload for the whole list: two ledger calls,
--       one aggregate for the open-count pending values and one aggregate for
--       the linked document-line counts.  No per-item function call.
--   B3. kho_save_item() validates name / unit / active and merges or edits only
--       through rename_stock_item, change_stock_item_unit, apply_stock_item_merge,
--       discontinue_stock_item and reactivate_stock_item.  Replay is stored in
--       warehouse_game_requests under action 'kho_save_item'.
--   B4. kho_count_item() posts through record_q7_stock_count() /
--       record_tan_tao_material_count(), the same per-line functions
--       submit_stock_count() uses.  It never opens or submits a count session.
--
-- No DELETE, no direct document-line write, no stock_material_aliases write.
-- The Maestro applies this migration; Harness does not.

-- ===========================================================================
-- B1. The shared garden gate
-- ===========================================================================

create or replace function public.kho_item_can_edit(p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.has_role(p_actor, 'owner')
    or public.q7_material_inventory_can_edit(p_actor)
    or public.can_edit_material_master()
    or public.has_module_permission(p_actor, 'inventory', 'edit');
$$;

revoke all on function public.kho_item_can_edit(uuid) from public, anon;
grant execute on function public.kho_item_can_edit(uuid) to authenticated, service_role;

-- ===========================================================================
-- B1a. rename_stock_item — body unchanged, only the gate now uses
--      kho_item_can_edit() so the warehouse game's inventory editor can rename.
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
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
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
-- B1b. change_stock_item_unit — body unchanged, same gate swap.
-- ===========================================================================

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

-- ===========================================================================
-- B2. kho_get_items — the whole list in one call
-- ===========================================================================

create or replace function public.kho_get_items()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_tt jsonb;
  v_q7 jsonb;
  v_items jsonb;
begin
  if v_actor is null then
    raise exception 'actor_required' using errcode = '42501';
  end if;
  if not (
    public.q7_material_inventory_can_view(v_actor)
    or public.stock_count_can_view('tan_tao')
    or public.stock_count_can_view('q7')
    or public.kho_item_can_edit(v_actor)
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Exactly two ledger calls, once for the whole list.
  v_tt := public.get_stock_ledger_overview('tan_tao', current_date);
  v_q7 := public.get_stock_ledger_overview('q7', current_date);

  with tt as (
    select coalesce(jsonb_object_agg(e ->> 'item_id', e), '{}'::jsonb) as map
    from jsonb_array_elements(coalesce(v_tt -> 'materials', '[]'::jsonb)) e
    where nullif(e ->> 'item_id', '') is not null
  ),
  q7 as (
    select coalesce(jsonb_object_agg(e ->> 'item_id', e), '{}'::jsonb) as map
    from jsonb_array_elements(coalesce(v_q7 -> 'items', '[]'::jsonb)) e
    where nullif(e ->> 'item_id', '') is not null
  ),
  pending as (
    select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) as map
    from (
      select distinct on (s.location, l.target_id)
        s.location || ':' || l.target_id::text as k,
        l.counted_qty as v
      from public.stock_count_lines l
      join public.stock_count_sessions s on s.id = l.session_id
      where s.status = 'open'
        and l.target_kind = 'item'
        and s.location in ('tan_tao', 'q7')
      order by s.location, l.target_id, s.opened_at desc, l.id desc
    ) x
  ),
  docs as (
    select coalesce(jsonb_object_agg(item_id, n), '{}'::jsonb) as map
    from (
      select a.kitchen_inventory_item_id as item_id,
             count(distinct gri.id)::integer as n
      from public.stock_material_aliases a
      join public.goods_receipts gr
        on gr.supplier_id is not distinct from a.supplier_id
      left join public.suppliers s on s.id = gr.supplier_id
      join public.goods_receipt_items gri on gri.goods_receipt_id = gr.id
      where a.kitchen_inventory_item_id is not null
        and a.location in ('tan_tao', 'q7')
        and a.location = coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao')
        and gr.status in ('confirmed', 'received')
        and coalesce(s.stock_exempt, false) = false
        and public.stock_line_auto_non_stock(
              coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
            ) is null
        and a.normalized_name = public.normalize_stock_item_name(
              coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
            )
      group by a.kitchen_inventory_item_id
    ) x
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', kii.id,
           'item_code', kii.item_code,
           'name', kii.name,
           'unit', kii.unit,
           'active', coalesce(kii.active, false),
           'item_class', kii.item_class,
           'in_q7', coalesce(kii.pastry_q7, false),
           'qty', jsonb_build_object(
             'tan_tao', case
               when tt.map ? kii.id::text
                 then (tt.map -> kii.id::text ->> 'current_qty')::numeric
               else null
             end,
             'q7', case
               when q7.map ? kii.id::text
                 then (q7.map -> kii.id::text ->> 'current_qty')::numeric
               else null
             end
           ),
           'last_count_date', jsonb_build_object(
             'tan_tao', tt.map -> kii.id::text ->> 'last_count_date',
             'q7', q7.map -> kii.id::text ->> 'last_count_date'
           ),
           'pending_count', jsonb_build_object(
             'tan_tao', pending.map -> ('tan_tao:' || kii.id::text),
             'q7', pending.map -> ('q7:' || kii.id::text)
           ),
           'doc_lines', coalesce((docs.map ->> kii.id::text)::integer, 0)
         ) order by kii.name, kii.id), '[]'::jsonb)
  into v_items
  from public.kitchen_inventory_items kii
  cross join tt
  cross join q7
  cross join pending
  cross join docs
  where kii.active = true
     or exists (
       select 1
       from public.stock_item_discontinuations d
       where d.item_id = kii.id
     );

  return jsonb_build_object(
    'can_edit', public.kho_item_can_edit(v_actor),
    'can_count', jsonb_build_object(
      'tan_tao', public.stock_count_can_edit('tan_tao'),
      'q7', public.stock_count_can_edit('q7')
    ),
    'items', v_items
  );
end;
$$;

revoke all on function public.kho_get_items() from public, anon;
grant execute on function public.kho_get_items() to authenticated, service_role;

-- ===========================================================================
-- B3. kho_save_item — one transaction for name / unit / active (+ merge)
-- ===========================================================================

create or replace function public.kho_save_item(
  p_item_id uuid,
  p_name text,
  p_unit text,
  p_active boolean,
  p_unit_factor numeric,
  p_merge boolean,
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
  v_other public.kitchen_inventory_items%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_unit text := btrim(coalesce(p_unit, ''));
  v_norm text;
  v_factor numeric;
  v_unit_factor numeric;
  v_unit_request uuid;
  v_unit_result jsonb;
  v_item_id uuid;
  v_target_active boolean;
  v_is_merge boolean := false;
  v_unit_changed boolean := false;
  v_cached jsonb;
  v_result jsonb;
begin
  if not public.kho_item_can_edit(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  -- Replay is checked before any write; all validation stays below it.
  select r.result into v_cached
  from public.warehouse_game_requests r
  where r.request_id = p_request_id
    and r.action = 'kho_save_item';
  if found then
    return v_cached;
  end if;

  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  -- The shared catalog keeps one unit per kind (kg -> g, lít -> ml), exactly as
  -- change_stock_item_unit stores it; typing "kg" on a g item is no change.
  if v_unit <> '' then
    v_unit := coalesce(public.normalize_stock_unit(v_unit), v_unit);
  end if;

  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = p_item_id;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  v_norm := public.normalize_stock_item_name(v_name);
  if v_norm is null then v_norm := lower(v_name); end if;

  -- The same normalized name rename_stock_item protects against.  An inactive
  -- duplicate is found too: that is exactly when p_merge is useful.
  -- Same name test as rename_stock_item (normalize_stock_item_name of the name;
  -- normalized_key also carries the unit, so it is not the name key).  An item
  -- that is switched off still owns its name: one name, one item.
  select * into v_other
  from public.kitchen_inventory_items k
  where k.id <> p_item_id
    and k.merged_into_id is null
    and public.normalize_stock_item_name(k.name) = v_norm
  order by coalesce(k.active, false) desc, k.created_at, k.id
  limit 1;

  v_is_merge := found;

  -- Validate both save paths before the first write.  A name collision uses the
  -- merge factor; no collision uses the item's unit change factor.
  if v_is_merge then
    if not coalesce(p_merge, false) then
      return jsonb_build_object(
        'status', 'name_taken',
        'other', jsonb_build_object(
          'id', v_other.id,
          'name', v_other.name,
          'unit', v_other.unit,
          'active', coalesce(v_other.active, false)
        )
      );
    end if;

    v_factor := public.q7_unit_factor(v_item.unit, v_other.unit);
    if v_factor is null or v_factor <= 0 then
      if lower(regexp_replace(coalesce(v_item.unit, ''), '\s+', '', 'g'))
         = lower(regexp_replace(coalesce(v_other.unit, ''), '\s+', '', 'g')) then
        v_factor := 1;
      else
        v_factor := p_unit_factor;
      end if;
    end if;

    if v_factor is null
       or v_factor <= 0
       or v_factor::text in ('NaN', 'Infinity', '-Infinity') then
      return jsonb_build_object(
        'status', 'unit_factor_needed',
        'from', v_item.unit,
        'to', v_other.unit
      );
    end if;
  else
    v_unit_changed :=
      lower(regexp_replace(v_unit, '\s+', '', 'g'))
      is distinct from lower(regexp_replace(coalesce(v_item.unit, ''), '\s+', '', 'g'));

    if v_unit_changed then
      v_unit_factor := public.q7_unit_factor(v_item.unit, v_unit);
      if v_unit_factor is null or v_unit_factor <= 0 then
        v_unit_factor := p_unit_factor;
      end if;
      if v_unit_factor is null
         or v_unit_factor <= 0
         or v_unit_factor::text in ('NaN', 'Infinity', '-Infinity') then
        return jsonb_build_object(
          'status', 'unit_factor_needed',
          'from', v_item.unit,
          'to', v_unit
        );
      end if;
    end if;
  end if;

  -- Every validation passed; writes start here.
  if v_is_merge then
    if coalesce(v_other.active, false) = false and coalesce(p_active, false) = true then
      perform public.reactivate_stock_item(v_other.id);
    end if;

    perform public.apply_stock_item_merge(p_item_id, v_other.id, round(v_factor, 6), null);

    v_result := jsonb_build_object(
      'status', 'merged',
      'into', jsonb_build_object(
        'id', v_other.id,
        'name', v_other.name,
        'unit', v_other.unit
      )
    );

    insert into public.warehouse_game_requests (request_id, action, item_id, result, created_by)
    values (p_request_id, 'kho_save_item', v_other.id, v_result, v_actor)
    on conflict (request_id) do nothing;

    return v_result;
  end if;

  v_item_id := p_item_id;
  v_target_active := coalesce(p_active, v_item.active);

  -- warehouse_game_requests is keyed by request_id alone, so every inner call
  -- gets its own derived id; the outer id stays free for the kho_save_item row.
  if v_name <> v_item.name then
    perform public.rename_stock_item(p_item_id, v_name, md5(p_request_id::text || ':rename')::uuid);
  end if;

  if v_unit_changed then
    -- A derived request id keeps the inner idempotency key separate from the
    -- outer save request.
    v_unit_request := md5(p_request_id::text || ':unit')::uuid;
    v_unit_result := public.change_stock_item_unit(
      p_item_id, v_unit, v_unit_factor, v_unit_request
    );
    v_item_id := coalesce(
      nullif(v_unit_result ->> 'item_id', '')::uuid,
      p_item_id
    );
  end if;

  if v_target_active is distinct from coalesce(v_item.active, false) then
    if v_target_active then
      perform public.reactivate_stock_item(v_item_id);
    else
      perform public.discontinue_stock_item(v_item_id, 'Tắt trong game kho', md5(p_request_id::text || ':power')::uuid);
    end if;
  end if;

  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = v_item_id;

  v_result := jsonb_build_object(
    'status', 'saved',
    'item', jsonb_build_object(
      'id', v_item.id,
      'name', v_item.name,
      'unit', v_item.unit,
      'active', coalesce(v_item.active, false)
    )
  );

  insert into public.warehouse_game_requests (request_id, action, item_id, result, created_by)
  values (p_request_id, 'kho_save_item', v_item_id, v_result, v_actor)
  on conflict (request_id) do nothing;

  return v_result;
end;
$$;

revoke all on function public.kho_save_item(uuid, text, text, boolean, numeric, boolean, uuid) from public, anon;
grant execute on function public.kho_save_item(uuid, text, text, boolean, numeric, boolean, uuid) to authenticated, service_role;

-- The old constraint only knew the two game actions.
alter table public.warehouse_game_requests
  drop constraint if exists warehouse_game_requests_action_check;
alter table public.warehouse_game_requests
  add constraint warehouse_game_requests_action_check
  check (action in ('rename', 'change_unit', 'set_item_pastry_q7', 'kho_save_item'));

-- ===========================================================================
-- B4. kho_count_item — count one item through the existing per-line RPCs
-- ===========================================================================

create or replace function public.kho_count_item(
  p_location text,
  p_item_id uuid,
  p_counted_qty numeric,
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
  v_count_date date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_result jsonb;
begin
  if p_location not in ('tan_tao', 'q7') then
    raise exception 'invalid_location' using errcode = '22023';
  end if;
  if v_actor is null then
    raise exception 'actor_required' using errcode = '42501';
  end if;
  if not public.stock_count_can_edit(p_location) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_counted_qty is null
     or p_counted_qty < 0
     or p_counted_qty::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'invalid_quantity' using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = p_item_id;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  if coalesce(v_item.active, false) = false then
    raise exception 'item_inactive' using errcode = '22023';
  end if;
  if p_location = 'q7' and coalesce(v_item.pastry_q7, false) = false then
    raise exception 'item_not_in_location' using errcode = '22023';
  end if;

  if p_location = 'q7' then
    v_result := public.record_q7_stock_count(
      p_item_id,
      p_counted_qty,
      v_count_date,
      'Đếm trong game kho',
      'kho-count:' || p_request_id::text
    );
  else
    v_result := public.record_tan_tao_material_count(
      p_item_id,
      p_counted_qty,
      v_count_date,
      'Đếm trong game kho',
      'kho-count:' || p_request_id::text
    );
  end if;

  return jsonb_build_object(
    'status', 'counted',
    'location', p_location,
    'item_id', p_item_id,
    'counted_qty', p_counted_qty,
    'result', v_result
  );
end;
$$;

revoke all on function public.kho_count_item(text, uuid, numeric, uuid) from public, anon;
grant execute on function public.kho_count_item(text, uuid, numeric, uuid) to authenticated, service_role;
