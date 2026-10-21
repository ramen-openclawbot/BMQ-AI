-- Rollback-only smoke for migration 20261102460000_stock_item_in_use_toggle.sql.
--
-- Run as one file (from apps/web), by the database owner/Maestro:
--   DO_NOT_TRACK=1 supabase db query --linked -f scripts/smoke_stock_item_discontinue.sql
-- or wrapped with the migration in one rollback transaction:
--   begin; <migration>; <this file>; rollback;
--
-- The file is self-contained: it opens one transaction (a no-op if one is
-- already open), impersonates the real owner from public.user_roles through
-- request.jwt.claims, then exercises the owner 21/10 ON/OFF switch:
--   (a) a temp kitchen item WITH Tân Tạo stock (opening 7.5 g) is stopped:
--       active = false, the discontinuation row stores tan_tao_qty_at_stop =
--       7.5, and get_discontinued_stock_items returns the on-hand + item_class;
--   (b) reactivate brings it back (active = true, row cleared, back in the
--       Tân Tạo snapshot);
--   (c) a user without any edit right cannot stop or reactivate
--       (insufficient_privilege).
-- It raises notice 'SMOKE PASS' and rolls back. Nothing is committed.

begin;

do $smoke$
declare
  v_owner uuid;
  v_other uuid := gen_random_uuid();
  v_item_id uuid;
  v_res jsonb;
  v_snap jsonb;
  v_item_json jsonb;
  v_running numeric;
  v_stopped numeric;
  v_q7_stopped numeric;
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
  -- (a) Temp item WITH stock -> stop succeeds and stores the qty at stop.
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

  insert into public.tan_tao_material_movements(
    kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
    source, source_ref_key, note, created_by
  ) values (
    v_item_id,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date,
    'opening',
    7.500,
    'g',
    'manual_adjustment',
    'smoke-stock-toggle:' || gen_random_uuid()::text,
    'SMOKE: tồn trước khi ngưng',
    v_owner
  );

  v_snap := public.get_warehouse_game_snapshot('tan_tao');
  select coalesce((e ->> 'on_hand')::numeric, 0) into v_running
  from jsonb_array_elements(coalesce(v_snap -> 'items', '[]'::jsonb)) e
  where e ->> 'id' = v_item_id::text;
  if coalesce(v_running, 0) <> 7.5 then
    raise exception 'SMOKE FAIL: (a) expected 7.5 on hand before stop, got %', v_running;
  end if;

  v_res := public.discontinue_stock_item(v_item_id, 'smoke test', gen_random_uuid());
  if (v_res ->> 'active') is distinct from 'false' then
    raise exception 'SMOKE FAIL: (a) stopping with stock did not return active=false: %', v_res;
  end if;
  if not exists (
    select 1 from public.kitchen_inventory_items k
    where k.id = v_item_id and k.active = false
  ) then
    raise exception 'SMOKE FAIL: (a) kitchen row still active';
  end if;

  select d.tan_tao_qty_at_stop, d.q7_qty_at_stop
  into v_stopped, v_q7_stopped
  from public.stock_item_discontinuations d
  where d.item_id = v_item_id;
  if v_stopped is distinct from 7.5 or v_q7_stopped is distinct from 0 then
    raise exception 'SMOKE FAIL: (a) qty at stop not recorded: tan_tao=%, q7=%',
      v_stopped, v_q7_stopped;
  end if;

  v_snap := public.get_warehouse_game_snapshot('tan_tao');
  if exists (
    select 1 from jsonb_array_elements(coalesce(v_snap -> 'items', '[]'::jsonb)) e
    where e ->> 'id' = v_item_id::text
  ) then
    raise exception 'SMOKE FAIL: (a) item still in tan_tao snapshot';
  end if;

  select e into v_item_json
  from jsonb_array_elements(public.get_discontinued_stock_items()) e
  where e ->> 'item_id' = v_item_id::text;
  if v_item_json is null then
    raise exception 'SMOKE FAIL: (a) item missing from get_discontinued_stock_items';
  end if;
  if (v_item_json ->> 'tan_tao_qty_at_stop')::numeric is distinct from 7.5
     or (v_item_json ->> 'q7_qty_at_stop')::numeric is distinct from 0 then
    raise exception 'SMOKE FAIL: (a) list qty at stop wrong: %', v_item_json;
  end if;
  if (v_item_json ->> 'tan_tao_qty')::numeric is distinct from 7.5 then
    raise exception 'SMOKE FAIL: (a) list current tan_tao_qty wrong: %', v_item_json;
  end if;
  if (v_item_json ->> 'in_q7') is distinct from 'false' then
    raise exception 'SMOKE FAIL: (a) in_q7 must be false: %', v_item_json;
  end if;
  if (v_item_json -> 'item_class') is distinct from 'null'::jsonb then
    raise exception 'SMOKE FAIL: (a) item_class must be null for a bare item: %', v_item_json;
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
  -- (c) A user without any edit right cannot stop or reactivate.
  -- -------------------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_other, 'role', 'authenticated')::text,
    true
  );
  begin
    v_res := public.discontinue_stock_item(v_item_id, null, gen_random_uuid());
    raise exception 'SMOKE FAIL: (c) discontinue insufficient_privilege not raised (got %)', v_res;
  exception
    when others then
      if sqlerrm <> 'insufficient_privilege' then
        raise exception 'SMOKE FAIL: (c) discontinue unexpected error: %', sqlerrm;
      end if;
  end;
  begin
    v_res := public.reactivate_stock_item(v_item_id);
    raise exception 'SMOKE FAIL: (c) reactivate insufficient_privilege not raised (got %)', v_res;
  exception
    when others then
      if sqlerrm <> 'insufficient_privilege' then
        raise exception 'SMOKE FAIL: (c) reactivate unexpected error: %', sqlerrm;
      end if;
  end;
  raise notice 'SMOKE: (c) ok';

  raise notice 'SMOKE PASS';
end;
$smoke$;

rollback;
