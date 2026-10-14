-- Rollback-only smoke for migration 20261101190000_material_link_defer_factor.sql.
--
-- Run as one file (from apps/web), by the database owner:
--   DO_NOT_TRACK=1 supabase db query --linked -f scripts/smoke_material_link_defer.sql
--
-- The file opens one transaction, impersonates the real owner from
-- public.user_roles through request.jwt.claims, exercises the defer-factor link,
-- the manual factor setter and the review suggestion order, then raises notice
-- 'SMOKE PASS' and rolls back. Nothing is committed.

begin;

do $smoke$
declare
  v_owner uuid;
  v_review jsonb;
  v_doc record;
  v_item_json jsonb;
  v_loc text;
  v_found boolean := false;
  v_first_unit text;
  v_suffix text;
  v_name text;
  v_item_id uuid;
  v_item2_id uuid;
  v_material_id uuid;
  v_request uuid;
  v_link jsonb;
  v_pending integer;
  v_conv record;
  v_active integer;
  v_set jsonb;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role = 'owner'
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
  -- (a) The real item "Nước uống Vĩnh Hảo", when present and unlinked, must
  --     suggest the bình material first. Otherwise skip with a notice.
  -- -------------------------------------------------------------------------
  for v_doc in
    select 'tan_tao'::text as loc, public.get_material_link_review('tan_tao') as review
    union all
    select 'q7'::text, public.get_material_link_review('q7')
  loop
    select x into v_item_json
    from jsonb_array_elements(v_doc.review -> 'items') x
    where lower(btrim(x ->> 'name')) = lower('Nước uống Vĩnh Hảo')
    limit 1;
    if v_item_json is not null then
      v_loc := v_doc.loc;
      v_found := true;
      exit;
    end if;
  end loop;

  if v_found then
    if jsonb_array_length(coalesce(v_item_json -> 'candidates', '[]'::jsonb)) > 0 then
      v_first_unit := v_item_json -> 'candidates' -> 0 ->> 'default_unit';
    elsif v_item_json -> 'exact_material' is not null
          and v_item_json -> 'exact_material' <> 'null'::jsonb then
      v_first_unit := v_item_json -> 'exact_material' ->> 'default_unit';
    end if;
    if v_first_unit is distinct from 'bình' then
      raise exception 'SMOKE FAIL: Vĩnh Hảo first suggestion unit % (loc %)', v_first_unit, v_loc;
    end if;
  else
    raise notice 'SMOKE: "Nước uống Vĩnh Hảo" not present or already linked, skipping first-suggestion check';
  end if;

  -- -------------------------------------------------------------------------
  -- (b) A temp item (bình) + temp material (g): link with p_defer_factor true
  --     succeeds, factor_pending is true and a pending row exists.
  -- -------------------------------------------------------------------------
  v_suffix := left(replace(gen_random_uuid()::text, '-', ''), 8);
  v_name := 'SMOKE defer ' || v_suffix;

  insert into public.sku_cogs_materials (
    material_code, canonical_name, normalized_name, default_unit, active
  ) values (
    'SMOKE-DEFER-' || v_suffix,
    v_name,
    public.material_master_normalize(v_name),
    'g',
    true
  )
  returning id into v_material_id;

  v_item_id := gen_random_uuid();
  insert into public.kitchen_inventory_items (
    id, item_code, normalized_key, item_type, name, unit, active
  ) values (
    v_item_id,
    'SMOKE-DF-' || left(v_item_id::text, 8),
    'smoke-df-' || left(v_item_id::text, 8),
    'ingredient',
    v_name,
    'bình',
    true
  );

  v_request := gen_random_uuid();
  v_link := public.link_item_material(
    v_item_id, v_material_id, false, v_request, null, true
  );
  if v_link is null or coalesce((v_link ->> 'factor_pending')::boolean, false) is not true then
    raise exception 'SMOKE FAIL: defer link did not report factor_pending %', v_link;
  end if;
  if not exists (
    select 1 from public.kitchen_inventory_items k
    where k.id = v_item_id and k.canonical_material_id = v_material_id
  ) then
    raise exception 'SMOKE FAIL: defer link did not set canonical_material_id';
  end if;
  select count(*) into v_pending
  from public.material_link_pending_factors pf
  where pf.item_id = v_item_id and pf.material_id = v_material_id;
  if v_pending <> 1 then
    raise exception 'SMOKE FAIL: pending row missing after defer link';
  end if;

  -- -------------------------------------------------------------------------
  -- (c) set_item_material_factor: set 20000, clear, then reject 0.
  -- -------------------------------------------------------------------------
  v_set := public.set_item_material_factor(v_item_id, 20000);
  if coalesce((v_set ->> 'pending')::boolean, true) is not false then
    raise exception 'SMOKE FAIL: set factor still pending %', v_set;
  end if;
  select count(*) into v_pending
  from public.material_link_pending_factors pf where pf.item_id = v_item_id;
  if v_pending <> 0 then
    raise exception 'SMOKE FAIL: pending row survived set factor';
  end if;
  select * into v_conv
  from public.material_unit_conversions c
  where c.material_id = v_material_id
    and c.active = true
    and c.approved = true
    and lower(btrim(c.from_unit)) = 'bình'
    and lower(btrim(c.to_unit)) = 'g';
  if not found then
    raise exception 'SMOKE FAIL: no active conversion after set factor';
  end if;
  if v_conv.factor <> 20000 then
    raise exception 'SMOKE FAIL: stored factor % <> 20000', v_conv.factor;
  end if;

  v_set := public.set_item_material_factor(v_item_id, null);
  if coalesce((v_set ->> 'pending')::boolean, false) is not true then
    raise exception 'SMOKE FAIL: clearing factor did not go back to pending %', v_set;
  end if;
  select count(*) into v_pending
  from public.material_link_pending_factors pf where pf.item_id = v_item_id;
  if v_pending <> 1 then
    raise exception 'SMOKE FAIL: pending row missing after clear';
  end if;
  select count(*) into v_active
  from public.material_unit_conversions c
  where c.material_id = v_material_id
    and c.active = true
    and c.approved = true
    and lower(btrim(c.from_unit)) = 'bình';
  if v_active <> 0 then
    raise exception 'SMOKE FAIL: active conversion survived clear';
  end if;

  begin
    perform public.set_item_material_factor(v_item_id, 0);
    raise exception 'SMOKE FAIL: invalid factor 0 was accepted';
  exception when others then
    if sqlstate <> '22023' or sqlerrm not like '%invalid_factor%' then
      raise exception 'SMOKE FAIL: wrong error for factor 0: % %', sqlstate, sqlerrm;
    end if;
  end;

  -- -------------------------------------------------------------------------
  -- (d) The 5-arg link_q7_item_material without a factor must keep raising
  --     unit_factor_required for the same needs_factor situation.
  -- -------------------------------------------------------------------------
  v_item2_id := gen_random_uuid();
  insert into public.kitchen_inventory_items (
    id, item_code, normalized_key, item_type, name, unit, active
  ) values (
    v_item2_id,
    'SMOKE-DF-' || left(v_item2_id::text, 8),
    'smoke-df-' || left(v_item2_id::text, 8),
    'ingredient',
    'SMOKE defer second ' || left(v_item2_id::text, 8),
    'bình',
    true
  );

  begin
    perform public.link_q7_item_material(
      v_item2_id, v_material_id, false, gen_random_uuid()
    );
    raise exception 'SMOKE FAIL: 5-arg link without factor was accepted';
  exception when others then
    if sqlstate <> '22023' or sqlerrm not like '%unit_factor_required%' then
      raise exception 'SMOKE FAIL: wrong error for 5-arg link: % %', sqlstate, sqlerrm;
    end if;
  end;

  raise notice 'SMOKE PASS';
end;
$smoke$;

rollback;
