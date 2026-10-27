-- 2026-10-27 — Kho: tạo món mới / sao chép món (phần máy chủ).
--
-- public.kho_create_item() creates one kitchen_inventory_items row, either from
-- scratch or by copying the catalog settings of an existing item.  The copy
-- carries only the item definition: unit conversions and the ATTP profile.
-- It never copies stock, lots, ledger movements, supplier aliases, the
-- canonical/material-resolution link, Q7 mappings, photos or documents.
--
-- The item code is left to the existing BEFORE INSERT trigger
-- (kho_assign_item_code -> kho_next_item_code), so the NVL/CCDC series stays
-- the single allocator.  Replays are keyed by p_request_id through
-- warehouse_game_requests with action 'kho_create_item'.

-- The idempotency table action list keeps every previous action.
alter table public.warehouse_game_requests
  drop constraint if exists warehouse_game_requests_action_check;
alter table public.warehouse_game_requests
  add constraint warehouse_game_requests_action_check
  check (action in (
    'rename', 'change_unit', 'set_item_pastry_q7', 'kho_save_item',
    'kho_add_unit', 'kho_set_conversion', 'set_item_kho_locations',
    'kho_review_link_line', 'kho_review_create_item',
    'kho_review_jev_feedback', 'kho_create_item'
  ));

create or replace function public.kho_create_item(
  p_name text,
  p_unit text,
  p_class text,
  p_tan_tao boolean,
  p_q7 boolean,
  p_note text,
  p_copy_from uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_unit_input text;
  v_unit text;
  v_class text;
  v_note text;
  v_tan_tao boolean;
  v_q7 boolean;
  v_name_key text;
  v_normalized_key text;
  v_source public.kitchen_inventory_items%rowtype;
  v_has_source boolean := false;
  v_item_id uuid;
  v_item_code text;
  v_item_name text;
  v_item_unit text;
  v_cached jsonb;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  -- Replay is checked before validation: the original call already passed it
  -- and its result must be returned unchanged on a repeated click/retry.
  perform pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text));
  select r.result into v_cached
  from public.warehouse_game_requests r
  where r.request_id = p_request_id
    and r.action = 'kho_create_item';
  if found then
    return v_cached;
  end if;

  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  -- The source, when given, must still be part of the live catalog.  Its
  -- settings fill only the parameters the caller left null.
  if p_copy_from is not null then
    select * into v_source
    from public.kitchen_inventory_items k
    where k.id = p_copy_from
      and k.merged_into_id is null;
    if not found then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;
    v_has_source := true;
  end if;

  -- One normalized name, one live item: the same key kho_save_item and the
  -- item unit guard use.  Inactive / merged rows do not own the name.
  v_name_key := public.kho_item_name_key(v_name);
  if v_name_key is null then v_name_key := lower(v_name); end if;
  if exists (
    select 1
    from public.kitchen_inventory_items k
    where k.active = true
      and k.merged_into_id is null
      and public.kho_item_name_key(k.name) = v_name_key
  ) then
    raise exception 'item_name_duplicate' using errcode = '23505';
  end if;

  v_unit_input := nullif(btrim(coalesce(p_unit, '')), '');
  if v_unit_input is null and v_has_source then
    v_unit_input := v_source.unit;
  end if;
  v_unit := public.normalize_stock_unit(v_unit_input);
  if v_unit is null then
    raise exception 'unit_not_allowed' using errcode = '23514';
  end if;

  v_class := nullif(btrim(coalesce(p_class, '')), '');
  if v_class is null and v_has_source then
    v_class := v_source.item_class;
  end if;
  if v_class is null or v_class not in ('raw_material', 'packaging_supply') then
    raise exception 'invalid_class' using errcode = '22023';
  end if;

  v_tan_tao := p_tan_tao;
  v_q7 := p_q7;
  if v_has_source then
    if v_tan_tao is null then v_tan_tao := v_source.in_tan_tao; end if;
    if v_q7 is null then v_q7 := coalesce(v_source.pastry_q7, false); end if;
  end if;
  v_tan_tao := coalesce(v_tan_tao, false);
  v_q7 := coalesce(v_q7, false);
  if not v_tan_tao and not v_q7 then
    raise exception 'kho_location_required' using errcode = '22023';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if p_note is null and v_has_source then
    v_note := v_source.note;
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'invalid_note' using errcode = '22023';
  end if;

  -- Every validation passed; writes start here.
  v_normalized_key := 'manual:' || v_name_key;
  if exists (
    select 1
    from public.kitchen_inventory_items k
    where k.normalized_key = v_normalized_key
  ) then
    -- A retired row may still hold the plain key; keep the new row distinct.
    v_normalized_key := v_normalized_key || ':' || substr(md5(p_request_id::text), 1, 12);
  end if;

  insert into public.kitchen_inventory_items (
    normalized_key,
    item_type,
    name,
    unit,
    standard_unit_cost,
    active,
    item_class,
    note,
    in_tan_tao,
    pastry_q7,
    pastry_q7_source,
    pastry_q7_set_at,
    pastry_q7_set_by
  ) values (
    v_normalized_key,
    'ingredient',
    v_name,
    v_unit,
    0,
    true,
    v_class,
    v_note,
    v_tan_tao,
    v_q7,
    'owner',
    now(),
    v_actor
  )
  returning id, item_code, name, unit
    into v_item_id, v_item_code, v_item_name, v_item_unit;

  -- A copy carries the item's count/pack conversions and ATTP profile only.
  if v_has_source then
    insert into public.stock_item_unit_factors (
      kitchen_inventory_item_id, unit, factor, updated_by, updated_at
    )
    select v_item_id, f.unit, f.factor, v_actor, now()
    from public.stock_item_unit_factors f
    where f.kitchen_inventory_item_id = p_copy_from
    on conflict (kitchen_inventory_item_id, unit) do nothing;

    update public.kitchen_inventory_items
       set attp_profile = v_source.attp_profile
     where id = v_item_id;
  end if;

  v_result := jsonb_build_object(
    'status', 'created',
    'item_id', v_item_id,
    'item_code', v_item_code,
    'name', v_item_name,
    'unit', v_item_unit,
    'in_tan_tao', v_tan_tao,
    'in_q7', v_q7,
    'copied_from', p_copy_from
  );

  insert into public.warehouse_game_requests (request_id, action, item_id, result, created_by)
  values (p_request_id, 'kho_create_item', v_item_id, v_result, v_actor)
  on conflict (request_id) do nothing;

  return v_result;
end;
$$;

revoke all on function public.kho_create_item(text, text, text, boolean, boolean, text, uuid, uuid)
  from public, anon;
grant execute on function public.kho_create_item(text, text, text, boolean, boolean, text, uuid, uuid)
  to authenticated;
