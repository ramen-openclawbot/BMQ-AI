-- Rollback-only smoke for migration
-- 20261101450000_mission_assignee_access.sql.
--
-- Run after the migration is applied, as the database owner/Maestro:
--   supabase db query --linked -f scripts/smoke_mission_assignee_access.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_mission_assignee_access.sql).
--
-- The file opens one transaction, picks the real owner and one real non-owner
-- user from public.user_roles, impersonates both through request.jwt.claims,
-- then checks:
--   (a) the non-owner cannot read the Q7 BOM review before being assigned;
--   (b) the owner assigns the real "wh-q7-bom-match-20261017" root mission;
--   (c) the assignee can now read the review and resolve one open line;
--   (d) the owner withdraws the copy and the assignee loses access again;
--   (e) the assignee still cannot call assign_mission;
--   (f) the owner records 60 BMQ-001 through record_mission_sku_count, the
--       warehouse on-hand becomes 60 and mission_evaluate reports done.
--
-- It raises notice 'SMOKE_RESULT PASS' and rolls back; nothing is committed.

begin;

do $smoke_mission_assignee_access$
declare
  v_owner uuid;
  v_user uuid;
  v_root uuid;
  v_copy uuid;
  v_mission uuid;
  v_review jsonb;
  v_row jsonb;
  v_assign jsonb;
  v_unassign jsonb;
  v_resolve jsonb;
  v_count jsonb;
  v_eval jsonb;
  v_on_hand numeric;
  v_probe integer;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL no_owner';
  end if;

  select id into v_root
  from public.missions
  where code = 'wh-q7-bom-match-20261017';
  if v_root is null then
    raise exception 'SMOKE_RESULT FAIL missing_q7_mission';
  end if;

  -- A real non-owner who can be assigned, cannot already view Q7 materials and
  -- has no copy of this mission yet. Keep the smoke honest on a live database.
  select ur.user_id into v_user
  from public.user_roles ur
  where not public.has_role(ur.user_id, 'owner')
    and public.material_alias_can_admin(ur.user_id) is true
    and not public.q7_material_inventory_can_view(ur.user_id)
    and not exists (
      select 1
      from public.missions m
      where m.assignee_user_id = ur.user_id
        and m.status = 'open'
        and m.check_rule = 'q7_bom_mismatch_resolved'
    )
    and not exists (
      select 1
      from public.missions m
      where m.parent_mission_id = v_root
        and m.assignee_user_id = ur.user_id
    )
  order by ur.created_at, ur.user_id
  limit 1;

  if v_user is null then
    raise notice 'SMOKE_RESULT SKIP: no eligible non-owner user';
    return;
  end if;

  -- (a) Before the assignment the non-owner has no Q7 BOM access.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  v_probe := 0;
  begin
    perform public.get_q7_bom_mismatch_review();
    v_probe := 1;
  exception when others then
    if sqlstate <> '42501' then
      raise exception 'SMOKE_RESULT FAIL review_before_state %', sqlstate;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL review_before_allowed';
  end if;

  -- (b) The owner assigns the real root mission and gets an open copy.
  update public.missions
  set status = 'open', completed_at = null, completed_by = null
  where id = v_root;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_assign := public.assign_mission(v_root, v_user);
  v_copy := (v_assign ->> 'mission_id')::uuid;
  if v_copy is null or (v_assign ->> 'status') <> 'open' then
    raise exception 'SMOKE_RESULT FAIL assign_created %', v_assign;
  end if;

  -- (c) The assignee can read the review and resolve one open group.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  v_review := public.get_q7_bom_mismatch_review();
  if jsonb_typeof(v_review) <> 'array' then
    raise exception 'SMOKE_RESULT FAIL review_after_shape %', v_review;
  end if;

  select r into v_row
  from jsonb_array_elements(v_review) r
  where coalesce((r ->> 'open')::boolean, false) = true
    and nullif(r ->> 'canonical_material_id', '') is not null
    and nullif(r ->> 'source_unit', '') is not null
  limit 1;
  if v_row is null then
    raise exception 'SMOKE_RESULT FAIL no_open_bom_group';
  end if;

  v_resolve := public.resolve_q7_bom_line(
    (v_row ->> 'canonical_material_id')::uuid,
    v_row ->> 'source_unit',
    'not_tracked',
    null,
    null,
    'smoke mission assignee access',
    gen_random_uuid()
  );
  if (v_resolve ->> 'status') <> 'resolved'
     or coalesce((v_resolve ->> 'replay')::boolean, true) is not false then
    raise exception 'SMOKE_RESULT FAIL resolve_as_assignee %', v_resolve;
  end if;

  -- (d) Withdrawing the copy removes the assignee's Q7 BOM access again.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_unassign := public.unassign_mission(v_copy);
  if (v_unassign ->> 'status') <> 'cancelled' then
    raise exception 'SMOKE_RESULT FAIL unassign_status %', v_unassign;
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  v_probe := 0;
  begin
    perform public.get_q7_bom_mismatch_review();
    v_probe := 1;
  exception when others then
    if sqlstate <> '42501' then
      raise exception 'SMOKE_RESULT FAIL review_after_unassign_state %', sqlstate;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL review_after_unassign_allowed';
  end if;

  -- (e) assign_mission stays owner-only.
  v_probe := 0;
  begin
    perform public.assign_mission(v_root, v_user);
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%forbidden%' then
      raise exception 'SMOKE_RESULT FAIL forbidden_assign: %', sqlerrm;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_RESULT FAIL forbidden_assign accepted';
  end if;

  -- (f) The owner records the BMQ-001 count through the mission RPC.
  select id into v_mission
  from public.missions
  where code = 'wh-count-bmq001-20261017';
  if v_mission is null then
    raise exception 'SMOKE_RESULT FAIL missing_sku_count_mission';
  end if;
  update public.missions
  set status = 'open', completed_at = null, completed_by = null
  where id = v_mission;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_count := public.record_mission_sku_count(
    v_mission,
    60,
    'Smoke đếm BMQ-001',
    gen_random_uuid()
  );
  if (v_count ->> 'sku_code') <> 'BMQ-001'
     or (v_count ->> 'counted_qty')::numeric <> 60 then
    raise exception 'SMOKE_RESULT FAIL sku_count_result %', v_count;
  end if;

  select coalesce(sum(m.quantity), 0) into v_on_hand
  from public.tan_tao_warehouse_movements m
  join public.product_skus s on s.id = m.sku_id
  where m.location_code = 'warehouse_tan_tao'
    and s.sku_code = 'BMQ-001';
  if v_on_hand <> 60 then
    raise exception 'SMOKE_RESULT FAIL bmq001_on_hand %', v_on_hand;
  end if;

  v_eval := public.mission_evaluate(v_mission);
  if coalesce((v_eval ->> 'done')::boolean, false) is not true then
    raise exception 'SMOKE_RESULT FAIL sku_count_mission_not_done %', v_eval;
  end if;

  raise notice 'SMOKE_RESULT PASS';
end;
$smoke_mission_assignee_access$;

rollback;
