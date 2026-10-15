-- Rollback-only smoke for migration 20261101230000_stock_item_discontinue.sql.
--
-- Run as one file (from apps/web), by the database owner/Maestro:
--   DO_NOT_TRACK=1 supabase db query --linked -f scripts/smoke_stock_item_discontinue.sql
-- or wrapped with the migration in one rollback transaction:
--   begin; <migration>; <this file>; rollback;
--
-- The file is self-contained: it opens one transaction (a no-op if one is
-- already open), impersonates the real owner from public.user_roles through
-- request.jwt.claims, then exercises the owner "Ngưng dùng" action:
--   (a) a temp kitchen item (unit g, not pastry) is discontinued: active = false,
--       absent from get_warehouse_game_snapshot('tan_tao') and from
--       get_material_link_review('tan_tao'), present in
--       get_discontinued_stock_items();
--   (b) reactivate brings it back (active = true, present in the snapshot again);
--   (c) discontinuing an item that still has on_hand > 0 raises item_has_stock
--       (skipped with a notice when no snapshot item has stock);
--   (d) an unknown JWT subject cannot discontinue (insufficient_privilege);
--   (e) 'Bột custard sư tử' no longer gets 'Bột mì 888' / 'Bột Ngọt' candidates.
-- It raises notice 'SMOKE PASS' and rolls back. Nothing is committed.

begin;

do $smoke$
declare
  v_owner uuid;
  v_other uuid := gen_random_uuid();
  v_item_id uuid;
  v_res jsonb;
  v_snap jsonb;
  v_review jsonb;
  v_item_json jsonb;
  v_stock_item uuid;
  v_found boolean := false;
  v_custard uuid := '245d214c-5f8d-4490-91aa-4d58192bf899'::uuid;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE FAIL: no owner role';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  -- -------------------------------------------------------------------------
  -- (a) Temp item -> discontinue -> leaves shelves / deck, joins the list.
  -- -------------------------------------------------------------------------
  insert into public.kitchen_inventory_items(
    item_code, normalized_key, item_type, name, unit, active, pastry_q7
  ) values (
    'SMOKE-DISC-' || replace(gen_random_uuid()::text, '-', ''),
    'smoke-discontinue-' || gen_random_uuid()::text,
    'ingredient',
    'SMOKE Ngưng dùng ' || gen_random_uuid()::text,
    'g',
    true,
    false
  )
  returning id into v_item_id;

  v_res := public.discontinue_stock_item(v_item_id, 'smoke test', gen_random_uuid());
  if (v_res ->> 'active') is distinct from 'false' then
    raise exception 'SMOKE FAIL: (a) active not false: %', v_res;
  end if;
  if not exists (
    select 1 from public.kitchen_inventory_items k
    where k.id = v_item_id and k.active = false
  ) then
    raise exception 'SMOKE FAIL: (a) kitchen row still active';
  end if;

  v_snap := public.get_warehouse_game_snapshot('tan_tao');
  if exists (
    select 1 from jsonb_array_elements(coalesce(v_snap -> 'items', '[]'::jsonb)) e
    where e ->> 'id' = v_item_id::text
  ) then
    raise exception 'SMOKE FAIL: (a) item still in tan_tao snapshot';
  end if;

  v_review := public.get_material_link_review('tan_tao');
  if exists (
    select 1 from jsonb_array_elements(coalesce(v_review -> 'items', '[]'::jsonb)) e
    where e ->> 'item_id' = v_item_id::text
  ) then
    raise exception 'SMOKE FAIL: (a) item still in tan_tao link review';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(public.get_discontinued_stock_items()) e
    where e ->> 'item_id' = v_item_id::text
  ) then
    raise exception 'SMOKE FAIL: (a) item missing from get_discontinued_stock_items';
  end if;
  raise notice 'SMOKE: (a) ok';

  -- -------------------------------------------------------------------------
  -- (b) Reactivate -> back on the shelf.
  -- -------------------------------------------------------------------------
  v_res := public.reactivate_stock_item(v_item_id);
  if (v_res ->> 'active') is distinct from 'true' then
    raise exception 'SMOKE FAIL: (b) active not true: %', v_res;
  end if;
  if exists (
    select 1 from public.stock_item_discontinuations d where d.item_id = v_item_id
  ) then
    raise exception 'SMOKE FAIL: (b) discontinuation row not cleared';
  end if;

  v_snap := public.get_warehouse_game_snapshot('tan_tao');
  if not exists (
    select 1 from jsonb_array_elements(coalesce(v_snap -> 'items', '[]'::jsonb)) e
    where e ->> 'id' = v_item_id::text
  ) then
    raise exception 'SMOKE FAIL: (b) item not back in tan_tao snapshot';
  end if;
  raise notice 'SMOKE: (b) ok';

  -- -------------------------------------------------------------------------
  -- (c) An item with on_hand > 0 must raise item_has_stock.
  -- -------------------------------------------------------------------------
  select (e ->> 'id')::uuid into v_stock_item
  from jsonb_array_elements(public.get_warehouse_game_snapshot('tan_tao') -> 'items') e
  where coalesce((e ->> 'on_hand')::numeric, 0) > 0
  order by e ->> 'name'
  limit 1;

  if v_stock_item is null then
    select (e ->> 'id')::uuid into v_stock_item
    from jsonb_array_elements(public.get_warehouse_game_snapshot('q7') -> 'items') e
    where coalesce((e ->> 'on_hand')::numeric, 0) > 0
    order by e ->> 'name'
    limit 1;
  end if;

  if v_stock_item is null then
    raise notice 'SMOKE: (c) no snapshot item with stock, skipping';
  else
    begin
      v_res := public.discontinue_stock_item(v_stock_item, null, gen_random_uuid());
      raise exception 'SMOKE FAIL: (c) item_has_stock not raised (got %)', v_res;
    exception
      when others then
        if sqlerrm <> 'item_has_stock' then
          raise exception 'SMOKE FAIL: (c) unexpected error: %', sqlerrm;
        end if;
    end;
    raise notice 'SMOKE: (c) ok';
  end if;

  -- -------------------------------------------------------------------------
  -- (d) An unknown JWT subject cannot discontinue.
  -- -------------------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_other, 'role', 'authenticated')::text,
    true
  );
  begin
    v_res := public.discontinue_stock_item(v_item_id, null, gen_random_uuid());
    raise exception 'SMOKE FAIL: (d) insufficient_privilege not raised (got %)', v_res;
  exception
    when others then
      if sqlerrm <> 'insufficient_privilege' then
        raise exception 'SMOKE FAIL: (d) unexpected error: %', sqlerrm;
      end if;
  end;
  raise notice 'SMOKE: (d) ok';

  -- Restore the owner claims for the remaining read checks.
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  -- -------------------------------------------------------------------------
  -- (e) 'Bột custard sư tử': no junk candidates from the shared word 'bột'.
  -- -------------------------------------------------------------------------
  select true into v_found
  from public.kitchen_inventory_items k
  where k.id = v_custard
    and k.active = true
    and k.merged_into_id is null
    and k.canonical_material_id is null;

  if not coalesce(v_found, false) then
    raise notice 'SMOKE: (e) custard item not active/unlinked, skipping';
  else
    select x into v_item_json
    from jsonb_array_elements(public.get_material_link_review('tan_tao') -> 'items') x
    where x ->> 'item_id' = v_custard::text;

    if v_item_json is null then
      raise notice 'SMOKE: (e) custard item not in tan_tao review, skipping';
    else
      if exists (
        select 1
        from jsonb_array_elements(coalesce(v_item_json -> 'candidates', '[]'::jsonb)) c
        where lower(btrim(c ->> 'canonical_name')) in (lower('Bột mì 888'), lower('Bột Ngọt'))
      ) then
        raise exception 'SMOKE FAIL: (e) stopword candidates still present: %',
          v_item_json -> 'candidates';
      end if;
      raise notice 'SMOKE: (e) ok candidates=%',
        jsonb_array_length(coalesce(v_item_json -> 'candidates', '[]'::jsonb));
    end if;
  end if;

  raise notice 'SMOKE PASS';
end;
$smoke$;

rollback;
