-- Smoke test for 20261102620000_kho_item_two_locations.sql.
--
-- Run with:  DO_NOT_TRACK=1 supabase db query --linked -f scripts/smoke_kho_two_locations.sql
-- (from apps/web).  The whole file is one transaction and ends with ROLLBACK.
-- Apply the migration first; this file never changes live rows.
--
-- It acts as a real owner through request.jwt.claims so auth.uid() is non-null
-- and auth.role() is authenticated.  It returns the single-Tân-Tạo / single-Q7 /
-- both counts for the migration header, then asserts the two-place contract.

begin;

do $$
declare
  v_actor uuid;
begin
  select ur.user_id
  into v_actor
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.user_id::text
  limit 1;

  if v_actor is null then
    raise exception 'smoke: no owner in public.user_roles';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_actor::text)::text,
    true
  );
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_actor::text, true);
end;
$$;

-- Counts to paste into the migration header after the rollback-only smoke.
select
  count(*) filter (
    where in_tan_tao and not coalesce(pastry_q7, false)
  ) as single_tan_tao,
  count(*) filter (
    where coalesce(pastry_q7, false) and not in_tan_tao
  ) as single_q7,
  count(*) filter (
    where in_tan_tao and coalesce(pastry_q7, false)
  ) as both_kho,
  count(*) filter (
    where not (in_tan_tao or coalesce(pastry_q7, false))
  ) as invalid_rows
from public.kitchen_inventory_items;

do $$
declare
  v_actor uuid := auth.uid();
  v_req_replay uuid := gen_random_uuid();
  v_req_other uuid := gen_random_uuid();
  v_item_id uuid;
  v_row jsonb;
  v_result jsonb;
  v_first jsonb;
  v_failed boolean;
  v_error text;
  v_sqlstate text;
  v_bad_check integer;
  v_bad_both integer;
  v_tt_qty numeric;
  v_q7_qty numeric;
  v_q7_before numeric;
  v_tt_before numeric;
  v_q7_after numeric;
  v_tt_after numeric;
begin
  if v_actor is null then
    raise exception 'smoke: auth.uid() is null';
  end if;

  -- 1. The check constraint holds for every row.
  select count(*)
  into v_bad_check
  from public.kitchen_inventory_items kii
  where not (kii.in_tan_tao or coalesce(kii.pastry_q7, false));
  if v_bad_check <> 0 then
    raise exception 'smoke: % row(s) break kitchen_inventory_items_in_tan_tao_check', v_bad_check;
  end if;

  -- 2. Every item with a non-zero balance at both kho is a two-kho item.
  --    kho_get_items uses the same balance expressions as the migration.
  select count(*)
  into v_bad_both
  from jsonb_array_elements(public.kho_get_items() -> 'items') e
  where coalesce((e #>> '{qty,tan_tao}')::numeric, 0) <> 0
    and coalesce((e #>> '{qty,q7}')::numeric, 0) <> 0
    and not (
      coalesce((e ->> 'in_tan_tao')::boolean, false)
      and coalesce((e ->> 'in_q7')::boolean, false)
    );
  if v_bad_both <> 0 then
    raise exception 'smoke: % item(s) have stock at both kho but are not both', v_bad_both;
  end if;

  select coalesce(sum(m.quantity), 0)
  into v_q7_before
  from public.q7_inventory_movements m;
  select coalesce(sum(m.quantity), 0)
  into v_tt_before
  from public.tan_tao_material_movements m;

  -- 3. Pick a real single-Tân-Tạo item for the write path.
  select kii.id
  into v_item_id
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.merged_into_id is null
    and kii.in_tan_tao = true
    and coalesce(kii.pastry_q7, false) = false
  order by kii.id
  limit 1;
  if v_item_id is null then
    raise exception 'smoke: no active single-Tân-Tạo item to exercise';
  end if;

  -- 4. Set both places.  The list must expose both flags.
  v_result := public.set_item_kho_locations(v_item_id, true, true, gen_random_uuid());
  if not coalesce((v_result ->> 'in_tan_tao')::boolean, false)
     or not coalesce((v_result ->> 'in_q7')::boolean, false) then
    raise exception 'smoke: set_item_kho_locations did not return both true: %', v_result;
  end if;

  select e
  into v_row
  from jsonb_array_elements(public.kho_get_items() -> 'items') e
  where e ->> 'id' = v_item_id::text;
  if v_row is null
     or not coalesce((v_row ->> 'in_tan_tao')::boolean, false)
     or not coalesce((v_row ->> 'in_q7')::boolean, false) then
    raise exception 'smoke: kho_get_items did not return in_tan_tao + in_q7 for %', v_item_id;
  end if;

  -- Count at both places with the current book quantities, so this smoke
  -- writes no adjustment movement.
  v_tt_qty := coalesce((v_row #>> '{qty,tan_tao}')::numeric, 0);
  v_q7_qty := coalesce((v_row #>> '{qty,q7}')::numeric, 0);
  perform public.kho_count_item('tan_tao', v_item_id, v_tt_qty, gen_random_uuid());
  perform public.kho_count_item('q7', v_item_id, v_q7_qty, gen_random_uuid());

  -- 5. Q7-only item: Tân Tạo count must refuse it.
  v_result := public.set_item_kho_locations(v_item_id, false, true, gen_random_uuid());
  if coalesce((v_result ->> 'in_tan_tao')::boolean, true)
     or not coalesce((v_result ->> 'in_q7')::boolean, false) then
    raise exception 'smoke: Q7-only set returned the wrong state: %', v_result;
  end if;

  v_failed := false;
  begin
    perform public.kho_count_item('tan_tao', v_item_id, 0, gen_random_uuid());
  exception when others then
    v_failed := true;
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
  end;
  if not v_failed then
    raise exception 'smoke: kho_count_item(tan_tao) accepted a Q7-only item';
  end if;
  if v_sqlstate <> '22023' or v_error not like '%item_not_in_location%' then
    raise exception 'smoke: wrong Tan Tao refusal %, %', v_sqlstate, v_error;
  end if;

  -- 6. Neither place is rejected before any write.
  v_failed := false;
  begin
    perform public.set_item_kho_locations(v_item_id, false, false, gen_random_uuid());
  exception when others then
    v_failed := true;
    get stacked diagnostics v_error = message_text, v_sqlstate = returned_sqlstate;
  end;
  if not v_failed then
    raise exception 'smoke: set_item_kho_locations accepted neither kho';
  end if;
  if v_sqlstate <> '22023' or v_error not like '%kho_location_required%' then
    raise exception 'smoke: wrong both-false refusal %, %', v_sqlstate, v_error;
  end if;

  -- 7. Old single-kho RPC still collapses a two-kho item to Q7 only.
  perform public.set_item_kho_locations(v_item_id, true, true, gen_random_uuid());
  perform public.set_item_pastry_q7(v_item_id, true, gen_random_uuid());
  select to_jsonb(kii)
  into v_row
  from public.kitchen_inventory_items kii
  where kii.id = v_item_id;
  if coalesce((v_row ->> 'pastry_q7')::boolean, false) is not true
     or coalesce((v_row ->> 'in_tan_tao')::boolean, true) is not false then
    raise exception 'smoke: set_item_pastry_q7(true) must leave in_tan_tao false: %', v_row;
  end if;

  -- 8. Replay returns the first result and does not re-apply the update.
  v_first := public.set_item_kho_locations(v_item_id, true, true, v_req_replay);
  perform public.set_item_kho_locations(v_item_id, false, true, v_req_other);
  v_result := public.set_item_kho_locations(v_item_id, true, true, v_req_replay);
  if v_result is distinct from v_first then
    raise exception 'smoke: replay result % != first result %', v_result, v_first;
  end if;
  select to_jsonb(kii)
  into v_row
  from public.kitchen_inventory_items kii
  where kii.id = v_item_id;
  if coalesce((v_row ->> 'in_tan_tao')::boolean, true) is not false
     or coalesce((v_row ->> 'pastry_q7')::boolean, false) is not true then
    raise exception 'smoke: replay re-applied the first update: %', v_row;
  end if;

  -- 9. No stock movement was added anywhere in this path.
  select coalesce(sum(m.quantity), 0)
  into v_q7_after
  from public.q7_inventory_movements m;
  select coalesce(sum(m.quantity), 0)
  into v_tt_after
  from public.tan_tao_material_movements m;
  if v_q7_after is distinct from v_q7_before then
    raise exception 'smoke: q7_inventory_movements sum changed % -> %', v_q7_before, v_q7_after;
  end if;
  if v_tt_after is distinct from v_tt_before then
    raise exception 'smoke: tan_tao_material_movements sum changed % -> %', v_tt_before, v_tt_after;
  end if;

  -- 10. anon cannot execute the new RPC.
  if has_function_privilege(
       'anon',
       'public.set_item_kho_locations(uuid, boolean, boolean, uuid)',
       'EXECUTE'
     ) then
    raise exception 'smoke: anon has EXECUTE on set_item_kho_locations';
  end if;
end;
$$;

rollback;
