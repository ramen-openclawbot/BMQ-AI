-- Rollback-only smoke for migration 20261101180000_material_link_quest.sql.
--
-- Run as one file (from apps/web), by the database owner:
--   DO_NOT_TRACK=1 supabase db query --linked -f scripts/smoke_material_link_quest.sql
--
-- The file opens one transaction, impersonates the real owner from
-- public.user_roles through request.jwt.claims, exercises the new review / skip /
-- link / mission RPCs, then raises notice 'SMOKE PASS' and rolls back. Nothing is
-- committed and the live database is untouched.

begin;

do $smoke$
declare
  v_owner uuid;
  v_q7 jsonb;
  v_tt jsonb;
  v_first jsonb;
  v_skipped_before integer;
  v_item_id uuid;
  v_item2_id uuid;
  v_request uuid;
  v_link jsonb;
  v_replay jsonb;
  v_canon uuid;
  v_mission uuid;
  v_eval jsonb;
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
  -- (a) both reviews return items and a material with a skus array.
  -- -------------------------------------------------------------------------
  v_q7 := public.get_material_link_review('q7');
  if v_q7 is null or jsonb_typeof(v_q7 -> 'items') is distinct from 'array' then
    raise exception 'SMOKE FAIL: get_material_link_review(q7) shape %', v_q7;
  end if;
  if coalesce((v_q7 -> 'counts' ->> 'total')::int, 0) <= 0 then
    raise exception 'SMOKE FAIL: q7 review has no items';
  end if;

  v_tt := public.get_material_link_review('tan_tao');
  if v_tt is null or jsonb_typeof(v_tt -> 'items') is distinct from 'array' then
    raise exception 'SMOKE FAIL: get_material_link_review(tan_tao) shape %', v_tt;
  end if;
  if coalesce((v_tt -> 'counts' ->> 'total')::int, 0) <= 0 then
    raise exception 'SMOKE FAIL: tan_tao review has no items';
  end if;

  select x into v_first
  from jsonb_array_elements(v_q7 -> 'items') x
  where (x -> 'exact_material' is not null and x -> 'exact_material' <> 'null'::jsonb)
     or jsonb_array_length(coalesce(x -> 'candidates', '[]'::jsonb)) > 0
  limit 1;

  if v_first is null then
    select x into v_first
    from jsonb_array_elements(v_tt -> 'items') x
    where (x -> 'exact_material' is not null and x -> 'exact_material' <> 'null'::jsonb)
       or jsonb_array_length(coalesce(x -> 'candidates', '[]'::jsonb)) > 0
    limit 1;
  end if;

  if v_first is null then
    raise exception 'SMOKE FAIL: no item with a material suggestion';
  end if;
  if v_first -> 'exact_material' is not null and v_first -> 'exact_material' <> 'null'::jsonb then
    if jsonb_typeof(v_first -> 'exact_material' -> 'skus') is distinct from 'array' then
      raise exception 'SMOKE FAIL: exact_material.skus is not an array';
    end if;
  else
    if jsonb_typeof(v_first -> 'candidates' -> 0 -> 'skus') is distinct from 'array' then
      raise exception 'SMOKE FAIL: candidate.skus is not an array';
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- (b) a new Tân Tạo item: appears in tan_tao, not in q7; skip removes it;
  --     unskip brings it back.
  -- -------------------------------------------------------------------------
  v_item_id := gen_random_uuid();
  insert into public.kitchen_inventory_items (
    id, item_code, normalized_key, item_type, name, unit, active
  ) values (
    v_item_id,
    'SMOKE-QL-' || left(v_item_id::text, 8),
    'smoke-ql-' || left(v_item_id::text, 8),
    'ingredient',
    'SMOKE quest mới ' || left(v_item_id::text, 8),
    'g',
    true
  );

  v_tt := public.get_material_link_review('tan_tao');
  if not exists (
    select 1 from jsonb_array_elements(v_tt -> 'items') x
    where (x ->> 'item_id')::uuid = v_item_id
  ) then
    raise exception 'SMOKE FAIL: new tan_tao item missing from review';
  end if;

  v_q7 := public.get_material_link_review('q7');
  if exists (
    select 1 from jsonb_array_elements(v_q7 -> 'items') x
    where (x ->> 'item_id')::uuid = v_item_id
  ) then
    raise exception 'SMOKE FAIL: new tan_tao item leaked into q7 review';
  end if;

  v_skipped_before := coalesce((v_tt -> 'counts' ->> 'skipped')::int, 0);
  perform public.skip_item_material_link(v_item_id, 'not_material');

  v_tt := public.get_material_link_review('tan_tao');
  if exists (
    select 1 from jsonb_array_elements(v_tt -> 'items') x
    where (x ->> 'item_id')::uuid = v_item_id
  ) then
    raise exception 'SMOKE FAIL: skipped item still in review';
  end if;
  if coalesce((v_tt -> 'counts' ->> 'skipped')::int, 0) <> v_skipped_before + 1 then
    raise exception 'SMOKE FAIL: skipped count did not grow % -> %',
      v_skipped_before, (v_tt -> 'counts' ->> 'skipped');
  end if;

  perform public.unskip_item_material_link(v_item_id);
  v_tt := public.get_material_link_review('tan_tao');
  if not exists (
    select 1 from jsonb_array_elements(v_tt -> 'items') x
    where (x ->> 'item_id')::uuid = v_item_id
  ) then
    raise exception 'SMOKE FAIL: unskipped item did not come back';
  end if;

  -- -------------------------------------------------------------------------
  -- (c) link_item_material creates a new material and is idempotent per request.
  -- -------------------------------------------------------------------------
  v_request := gen_random_uuid();
  v_link := public.link_item_material(v_item_id, null, true, v_request);
  if v_link is null or (v_link ->> 'material_id') is null then
    raise exception 'SMOKE FAIL: link result %', v_link;
  end if;
  if coalesce((v_link ->> 'created_material')::boolean, false) is not true then
    raise exception 'SMOKE FAIL: link did not create a new material %', v_link;
  end if;

  select k.canonical_material_id into v_canon
  from public.kitchen_inventory_items k
  where k.id = v_item_id;
  if v_canon is null or v_canon::text <> (v_link ->> 'material_id') then
    raise exception 'SMOKE FAIL: item canonical material % <> %',
      v_canon, (v_link ->> 'material_id');
  end if;

  v_replay := public.link_item_material(v_item_id, null, true, v_request);
  if v_replay is distinct from v_link then
    raise exception 'SMOKE FAIL: link replay differs % vs %', v_replay, v_link;
  end if;

  -- -------------------------------------------------------------------------
  -- (d) mission_evaluate reads the new rule.
  -- -------------------------------------------------------------------------
  select m.id into v_mission from public.missions m where m.code = 'wh-link-q7';
  if v_mission is null then
    raise exception 'SMOKE FAIL: mission wh-link-q7 missing';
  end if;
  v_eval := public.mission_evaluate(v_mission);
  if coalesce((v_eval ->> 'total')::int, 0) <= 0 then
    raise exception 'SMOKE FAIL: mission total % ', v_eval ->> 'total';
  end if;
  if coalesce((v_eval ->> 'left')::int, -1) < 0 then
    raise exception 'SMOKE FAIL: mission left negative %', v_eval ->> 'left';
  end if;
  if v_eval -> 'detail' -> 0 ->> 'location' is distinct from 'q7' then
    raise exception 'SMOKE FAIL: mission detail location %', v_eval -> 'detail';
  end if;

  -- -------------------------------------------------------------------------
  -- (e) a skipped item cannot be linked.
  -- -------------------------------------------------------------------------
  v_item2_id := gen_random_uuid();
  insert into public.kitchen_inventory_items (
    id, item_code, normalized_key, item_type, name, unit, active
  ) values (
    v_item2_id,
    'SMOKE-QL-' || left(v_item2_id::text, 8),
    'smoke-ql-' || left(v_item2_id::text, 8),
    'ingredient',
    'SMOKE quest skip ' || left(v_item2_id::text, 8),
    'g',
    true
  );
  perform public.skip_item_material_link(v_item2_id, 'not_material');

  begin
    perform public.link_item_material(v_item2_id, null, true, gen_random_uuid());
    raise exception 'SMOKE FAIL: skipped item was linked';
  exception when others then
    if sqlstate <> '22023' or sqlerrm not like '%item_not_eligible%' then
      raise exception 'SMOKE FAIL: wrong error % %', sqlstate, sqlerrm;
    end if;
  end;

  raise notice 'SMOKE PASS';
end;
$smoke$;

rollback;
