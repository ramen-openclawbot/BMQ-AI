-- Rollback-only smoke for migration 20261101390000_relink_material_and_q7_supplies.sql.
--
-- Run as one file (from apps/web), by the database owner/Maestro:
--   DO_NOT_TRACK=1 supabase db query --linked -f scripts/smoke_relink_q7_supplies.sql
-- or wrapped with the migration in one rollback transaction:
--   begin; <migration>; <this file>; rollback;
--
-- The file opens one transaction, impersonates the real owner from
-- public.user_roles through request.jwt.claims, then exercises:
--   (a) NVL-025 (Hạt hướng dương, currently bound to the 'Đường' material) is
--       relinked through public.relink_item_material; replay returns replay=true
--       and a second material_relinks row is not written;
--   (b) a real non-owner user is denied with 42501;
--   (c) an item that already has q7_inventory_movements is refused with
--       item_has_q7_movements;
--   (d) a skipped 'not_material' supply is accepted by record_q7_stock_count;
--   (e) an unlinked raw material is still refused with
--       q7_canonical_link_required.
-- It raises notice 'SMOKE_RESULT PASS' and rolls back. Nothing is committed.

begin;

do $smoke$
declare
  v_owner uuid;
  v_nonowner uuid;
  v_item public.kitchen_inventory_items%rowtype;
  v_old_material_id uuid;
  v_new_material_id uuid;
  v_res jsonb;
  v_replay jsonb;
  v_request_id uuid;
  v_temp jsonb;
  v_temp_item uuid;
  v_temp_raw uuid;
  v_count jsonb;
  v_resolved record;
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
  -- (a) Owner relinks the wrongly-bound Hạt hướng dương item.
  -- -------------------------------------------------------------------------
  select * into v_item
  from public.kitchen_inventory_items k
  where k.item_code = 'NVL-025'
  order by k.active desc, k.id
  limit 1;

  if not found then
    raise notice 'SMOKE: (a) NVL-025 not found, skipping';
  elsif v_item.active is not true
     or v_item.merged_into_id is not null
     or v_item.canonical_material_id is null
     or v_item.material_resolution_status is distinct from 'linked' then
    raise notice 'SMOKE: (a) NVL-025 is not currently linked, skipping';
  else
    v_old_material_id := v_item.canonical_material_id;
    v_request_id := gen_random_uuid();

    v_res := public.relink_item_material(
      v_item.id, null, true, 'SMOKE relink Hạt hướng dương', v_request_id
    );
    if (v_res ->> 'old_material_id')::uuid is distinct from v_old_material_id then
      raise exception 'SMOKE FAIL: (a) old_material_id mismatch: %', v_res;
    end if;
    if (v_res ->> 'new_material_id')::uuid is not distinct from v_old_material_id then
      raise exception 'SMOKE FAIL: (a) new material is still the old material: %', v_res;
    end if;
    if coalesce((v_res ->> 'replay')::boolean, true) is not false then
      raise exception 'SMOKE FAIL: (a) first call must not be a replay: %', v_res;
    end if;
    v_new_material_id := (v_res ->> 'new_material_id')::uuid;

    if not exists (
      select 1
      from public.kitchen_inventory_items k
      where k.id = v_item.id
        and k.canonical_material_id = v_new_material_id
        and k.material_resolution_status = 'linked'
    ) then
      raise exception 'SMOKE FAIL: (a) item did not move to the new material';
    end if;

    if (
      select count(*)
      from public.material_relinks r
      where r.request_id = v_request_id
    ) <> 1 then
      raise exception 'SMOKE FAIL: (a) expected exactly one material_relinks row';
    end if;

    v_replay := public.relink_item_material(
      v_item.id, null, true, 'SMOKE relink Hạt hướng dương', v_request_id
    );
    if coalesce((v_replay ->> 'replay')::boolean, false) is not true then
      raise exception 'SMOKE FAIL: (a) replay was not detected: %', v_replay;
    end if;
    if (v_replay ->> 'new_material_id')::uuid is distinct from v_new_material_id then
      raise exception 'SMOKE FAIL: (a) replay changed the material: %', v_replay;
    end if;
    if (
      select count(*)
      from public.material_relinks r
      where r.request_id = v_request_id
    ) <> 1 then
      raise exception 'SMOKE FAIL: (a) replay wrote a second material_relinks row';
    end if;

    raise notice 'SMOKE: (a) ok new_material=%', v_res ->> 'new_material_code';
  end if;

  -- -------------------------------------------------------------------------
  -- (b) A real non-owner is denied before touching any item.
  -- -------------------------------------------------------------------------
  select ur.user_id into v_nonowner
  from public.user_roles ur
  where ur.role::text <> 'owner'
    and not exists (
      select 1
      from public.user_roles o
      where o.user_id = ur.user_id
        and o.role::text = 'owner'
    )
  order by ur.created_at, ur.user_id
  limit 1;

  if v_nonowner is null then
    raise notice 'SMOKE: (b) no non-owner user, skipping';
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', v_nonowner, 'role', 'authenticated')::text,
      true
    );
    begin
      perform public.relink_item_material(
        coalesce(v_item.id, gen_random_uuid()), null, true,
        'SMOKE non-owner relink', gen_random_uuid()
      );
      raise exception 'SMOKE FAIL: (b) non-owner relink was allowed';
    exception when insufficient_privilege then
      raise notice 'SMOKE: (b) ok non-owner denied (insufficient_privilege/42501)';
    end;
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', v_owner, 'role', 'authenticated')::text,
      true
    );
  end if;

  -- -------------------------------------------------------------------------
  -- (c) An item with Q7 movements is refused (the named item when present).
  -- -------------------------------------------------------------------------
  select * into v_item
  from public.kitchen_inventory_items k
  where k.item_code = 'Q7-B9503866F1BEE04EC5F8'
    and k.active = true
    and k.merged_into_id is null
    and k.canonical_material_id is not null
    and k.material_resolution_status = 'linked'
    and exists (
      select 1
      from public.q7_inventory_movements m
      where m.kitchen_inventory_item_id = k.id
    )
  order by k.id
  limit 1;

  if not found then
    select * into v_item
    from public.kitchen_inventory_items k
    where k.active = true
      and k.merged_into_id is null
      and k.canonical_material_id is not null
      and k.material_resolution_status = 'linked'
      and exists (
        select 1
        from public.q7_inventory_movements m
        where m.kitchen_inventory_item_id = k.id
      )
    order by k.item_code, k.id
    limit 1;
  end if;

  if not found then
    raise notice 'SMOKE: (c) no linked item with Q7 movements, skipping';
  else
    begin
      perform public.relink_item_material(
        v_item.id, null, true, 'SMOKE movement guard', gen_random_uuid()
      );
      raise exception 'SMOKE FAIL: (c) item with Q7 movements was relinked';
    exception when sqlstate '23514' then
      if sqlerrm <> 'item_has_q7_movements' then
        raise;
      end if;
      raise notice 'SMOKE: (c) ok item_has_q7_movements';
    end;
  end if;

  -- -------------------------------------------------------------------------
  -- (d) A skipped 'not_material' supply can take a Q7 stock count.
  -- -------------------------------------------------------------------------
  v_temp := public.create_stock_material_item(
    'SMOKE vật tư ' || now()::text,
    'cái',
    'q7',
    gen_random_uuid()
  );
  v_temp_item := (v_temp ->> 'item_id')::uuid;
  if v_temp_item is null then
    raise exception 'SMOKE FAIL: (d) create_stock_material_item returned no item: %', v_temp;
  end if;

  perform public.skip_item_material_link(v_temp_item, 'not_material', null);

  select * into v_resolved
  from public.resolve_q7_canonical_inventory_item(v_temp_item, 'cái');
  if v_resolved.canonical_material_id is not null
     or v_resolved.q7_mapping_id is not null
     or v_resolved.conversion_factor is distinct from 1 then
    raise exception 'SMOKE FAIL: (d) resolver did not return null mapping/canonical with factor 1: %',
      row_to_json(v_resolved);
  end if;

  v_count := public.record_q7_stock_count(
    v_temp_item, 3, date '2026-10-16', 'SMOKE supplies count',
    'smoke-supplies-' || v_temp_item::text
  );
  if coalesce(v_count ->> 'status', '') <> 'recorded' then
    raise exception 'SMOKE FAIL: (d) stock count was not recorded: %', v_count;
  end if;
  raise notice 'SMOKE: (d) ok skipped supply counted';

  -- -------------------------------------------------------------------------
  -- (e) An unlinked raw material still fails closed.
  -- -------------------------------------------------------------------------
  v_temp := public.create_stock_material_item(
    'SMOKE nguyên liệu ' || now()::text,
    'kg',
    'q7',
    gen_random_uuid()
  );
  v_temp_raw := (v_temp ->> 'item_id')::uuid;
  if v_temp_raw is null then
    raise exception 'SMOKE FAIL: (e) create_stock_material_item returned no item: %', v_temp;
  end if;

  begin
    perform public.record_q7_stock_count(
      v_temp_raw, 3, date '2026-10-16', 'SMOKE unlinked raw material',
      'smoke-canonical-' || v_temp_raw::text
    );
    raise exception 'SMOKE FAIL: (e) unlinked raw material was accepted';
  exception when sqlstate '22023' then
    if sqlerrm <> 'q7_canonical_link_required' then
      raise;
    end if;
    raise notice 'SMOKE: (e) ok q7_canonical_link_required';
  end;

  raise notice 'SMOKE_RESULT PASS';
end;
$smoke$;

rollback;
