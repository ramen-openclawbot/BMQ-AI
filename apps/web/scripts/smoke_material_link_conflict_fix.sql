-- Rollback-only smoke for migration 20261101210000_material_link_conflict_fix.sql.
--
-- Run as one file (from apps/web), by the database owner/Maestro:
--   DO_NOT_TRACK=1 supabase db query --linked -f scripts/smoke_material_link_conflict_fix.sql
-- or wrapped with the migration in one rollback transaction:
--   begin; <migration>; <this file>; rollback;
--
-- The file is self-contained: it opens one transaction (a no-op if one is
-- already open), impersonates the real owner from public.user_roles through
-- request.jwt.claims, then exercises the conflict fix:
--   (a) the owner's live pair "Dầu Hướng Dương Simply 2L x 6 Chai / Thùng"
--       (id 8a73abc2…) links to material ed1b15d9… with alias_skipped = true;
--   (b) kitchen item "Nước uống Vĩnh Hảo" (bình) links to material_code
--       NVL-NUOC-VIHAWA-20L-BINH-VOI;
--   (c) link_exact_materials('q7'|'tan_tao') does not raise and returns linked;
--   (d) the "Phô mai 84 lát trắng Dairymont …" item no longer gets "Bánh mì
--       tươi" / "Bao xốp" candidates;
--   (e) the material_links_done missions evaluate under 300 ms;
--   (f) every item × candidate link, forced to roll back, raises no
--       material_name_conflict / material_alias_conflict.
-- It raises notice 'SMOKE PASS' and rolls back. Nothing is committed.

begin;

do $smoke$
declare
  v_owner uuid;
  v_item public.kitchen_inventory_items%rowtype;
  v_link jsonb;
  v_res jsonb;
  v_item_json jsonb;
  v_review jsonb;
  v_loc text;
  v_cand jsonb;
  v_material_id uuid;
  v_conflicts integer := 0;
  v_defer boolean;
  v_t0 timestamptz;
  v_ms numeric;
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
  -- (a) Owner's live name-conflict pair: link the picked material anyway.
  -- -------------------------------------------------------------------------
  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = '8a73abc2-db11-4961-b31f-dbd72cd443bd'::uuid;
  if not found then
    raise notice 'SMOKE: (a) item not found, skipping';
  elsif v_item.canonical_material_id is not null then
    raise notice 'SMOKE: (a) item already linked, skipping';
  else
    v_link := public.link_item_material(
      '8a73abc2-db11-4961-b31f-dbd72cd443bd'::uuid,
      'ed1b15d9-51ef-44da-91d9-8fe57d261e51'::uuid,
      false, gen_random_uuid(), null, false
    );
    if coalesce((v_link ->> 'alias_skipped')::boolean, false) is not true then
      raise exception 'SMOKE FAIL: (a) alias_skipped not true: %', v_link;
    end if;
    if (v_link ->> 'material_id')::uuid
       is distinct from 'ed1b15d9-51ef-44da-91d9-8fe57d261e51'::uuid then
      raise exception 'SMOKE FAIL: (a) linked wrong material: %', v_link;
    end if;
    if not exists (
      select 1 from public.kitchen_inventory_items k
      where k.id = '8a73abc2-db11-4961-b31f-dbd72cd443bd'::uuid
        and k.canonical_material_id = 'ed1b15d9-51ef-44da-91d9-8fe57d261e51'::uuid
    ) then
      raise exception 'SMOKE FAIL: (a) canonical_material_id not set';
    end if;
    raise notice 'SMOKE: (a) ok alias_owner=%', v_link ->> 'alias_owner_material_code';
  end if;

  -- -------------------------------------------------------------------------
  -- (b) Kitchen item "Nước uống Vĩnh Hảo" (bình) → NVL-NUOC-VIHAWA-20L-BINH-VOI.
  -- -------------------------------------------------------------------------
  select * into v_item
  from public.kitchen_inventory_items k
  where lower(btrim(k.name)) = lower('Nước uống Vĩnh Hảo')
    and lower(btrim(k.unit)) = 'bình'
  order by k.active desc, k.id
  limit 1;
  if not found then
    raise notice 'SMOKE: (b) item not found, skipping';
  elsif v_item.canonical_material_id is not null then
    raise notice 'SMOKE: (b) item already linked, skipping';
  else
    select m.id into v_material_id
    from public.sku_cogs_materials m
    where m.material_code = 'NVL-NUOC-VIHAWA-20L-BINH-VOI'
      and m.active = true
    limit 1;
    if v_material_id is null then
      raise notice 'SMOKE: (b) material not found, skipping';
    else
      v_link := public.link_item_material(
        v_item.id, v_material_id, false, gen_random_uuid(), null, false
      );
      if (v_link ->> 'material_id')::uuid is distinct from v_material_id then
        raise exception 'SMOKE FAIL: (b) linked wrong material: %', v_link;
      end if;
      if not exists (
        select 1 from public.kitchen_inventory_items k
        where k.id = v_item.id and k.canonical_material_id = v_material_id
      ) then
        raise exception 'SMOKE FAIL: (b) canonical_material_id not set';
      end if;
      raise notice 'SMOKE: (b) ok alias_skipped=%', v_link ->> 'alias_skipped';
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- (c) link_exact_materials must not raise and must return a linked key.
  -- -------------------------------------------------------------------------
  foreach v_loc in array array['q7', 'tan_tao'] loop
    v_res := public.link_exact_materials(v_loc, gen_random_uuid());
    if v_res is null or (v_res -> 'linked') is null then
      raise exception 'SMOKE FAIL: (c) % missing linked key: %', v_loc, v_res;
    end if;
    raise notice 'SMOKE: (c) % linked=% needs_factor=% failed=%',
      v_loc, v_res ->> 'linked',
      jsonb_array_length(coalesce(v_res -> 'needs_factor', '[]'::jsonb)),
      jsonb_array_length(coalesce(v_res -> 'failed', '[]'::jsonb));
  end loop;

  -- -------------------------------------------------------------------------
  -- (d) No junk candidates on the Dairymont item.
  -- -------------------------------------------------------------------------
  select x into v_item_json
  from jsonb_array_elements(public.get_material_link_review('q7') -> 'items') x
  where lower(btrim(x ->> 'name')) =
        lower('Phô mai 84 lát trắng Dairymont (1kg/khối 12 khối/thùng)')
  limit 1;
  if v_item_json is null then
    raise notice 'SMOKE: (d) Dairymont item not in review (linked/skipped/moved), skipping';
  else
    if exists (
      select 1
      from jsonb_array_elements(coalesce(v_item_json -> 'candidates', '[]'::jsonb)) c
      where lower(btrim(c ->> 'canonical_name')) in (lower('Bánh mì tươi'), lower('Bao xốp'))
    ) then
      raise exception 'SMOKE FAIL: (d) junk candidate still present: %',
        v_item_json -> 'candidates';
    end if;
    raise notice 'SMOKE: (d) ok candidates=%',
      jsonb_array_length(coalesce(v_item_json -> 'candidates', '[]'::jsonb));
  end if;

  -- -------------------------------------------------------------------------
  -- (e) the two link missions evaluate fast (counts only; get_my_missions calls these). The pre-existing
  -- wh-unknown-units mission (~2 s, unit scan) is outside this fix.
  v_t0 := clock_timestamp();
  perform public.mission_evaluate(m.id) from public.missions m where m.check_rule = 'material_links_done' and m.status = 'open';
  v_ms := extract(epoch from clock_timestamp() - v_t0) * 1000;
  if v_ms > 300 then
    raise exception 'SMOKE FAIL: (e) link missions slow % ms', round(v_ms);
  end if;
  raise notice 'SMOKE: (e) link missions % ms', round(v_ms);

  -- -------------------------------------------------------------------------
  -- (f) Every item × candidate link, rolled back, must not raise
  --     material_name_conflict / material_alias_conflict.
  -- -------------------------------------------------------------------------
  foreach v_loc in array array['q7', 'tan_tao'] loop
    v_review := public.get_material_link_review(v_loc);
    for v_item_json in
      select x from jsonb_array_elements(coalesce(v_review -> 'items', '[]'::jsonb)) x
    loop
      for v_cand in
        select c
        from jsonb_array_elements(coalesce(v_item_json -> 'candidates', '[]'::jsonb)) c
      loop
        v_defer := coalesce(v_cand ->> 'unit_status', '') = 'needs_factor';
        begin
          perform public.link_item_material(
            (v_item_json ->> 'item_id')::uuid,
            (v_cand ->> 'id')::uuid,
            false,
            gen_random_uuid(),
            null,
            v_defer
          );
          raise exception 'SMOKE_ROLLBACK' using errcode = 'P0001';
        exception
          when others then
            if sqlerrm in ('material_name_conflict', 'material_alias_conflict') then
              v_conflicts := v_conflicts + 1;
              raise notice 'SMOKE CONFLICT % % -> %',
                v_loc, v_item_json ->> 'name', sqlerrm;
            end if;
        end;
      end loop;
    end loop;
  end loop;

  if v_conflicts <> 0 then
    raise exception 'SMOKE FAIL: (f) % conflict errors', v_conflicts;
  end if;

  raise notice 'SMOKE PASS';
end;
$smoke$;

rollback;
