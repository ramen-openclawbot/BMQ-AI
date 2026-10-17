-- Rollback-only smoke for migration 20261101410000_q7_bom_match_and_posting.sql.
--
-- Run after the migration is applied, as the database owner/Maestro:
--   supabase db query --linked -f scripts/smoke_q7_bom_match.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_q7_bom_match.sql).
--
-- The file opens one transaction, impersonates the real owner through
-- request.jwt.claims, then exercises:
--   (a) post_material_issue_usage on an issue dated = cutover returns
--       before_cutover and writes no rows;
--   (b) the review lists the Đường (NVL-DUONG) group as open;
--   (c) resolve remaps NVL-DUONG g → Q7-8EBB689B5977C1D6DF8A with factor 1,
--       and replaying the same request_id returns replay=true;
--   (d) resolve excludes the canonical behind Q7-259831B6C7785A330111 (NƯỚC ĐÁ)
--       when that item / canonical appears;
--   (e) post_pending_q7_material_issues(false) posts the 2026-10-17 issue with
--       a movement on Đường tinh luyện and none on NƯỚC ĐÁ;
--   (f) a second call reports already_posted and writes no new movements.
--
-- It raises notice 'SMOKE_RESULT PASS' and rolls back; nothing is committed.

begin;

do $smoke$
declare
  v_owner uuid;
  v_cutover date;
  v_issue_at_cutover public.production_material_issues%rowtype;
  v_synthetic_issue uuid;
  v_issue17 public.production_material_issues%rowtype;
  v_duong uuid;
  v_duong_unit text;
  v_target uuid;
  v_target_unit text;
  v_nuoc_da uuid;
  v_nuoc_da_canonical uuid;
  v_nuoc_da_unit text;
  v_review jsonb;
  v_row jsonb;
  v_resolve jsonb;
  v_replay jsonb;
  v_resolve_nuoc_da jsonb;
  v_post jsonb;
  v_post2 jsonb;
  v_moves_before bigint;
  v_moves_after bigint;
  v_target_moves bigint;
  v_nuoc_da_moves bigint;
  v_posted_issue uuid;
  v_posted_number text;
  v_posted_action text;
  v_posted_movements integer;
  v_second_action text;
  v_second_movements integer;
  v_revision integer;
  v_request uuid := gen_random_uuid();
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL: no owner role';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  v_cutover := public.stock_ledger_cutover_date('q7');
  if v_cutover is null then
    raise exception 'SMOKE_RESULT FAIL: q7 cutover is null';
  end if;

  -- The real 17/10 issue (or the first current issue after cutover).
  select * into v_issue17
  from public.production_material_issues pmi
  where pmi.location_code = 'q7'
    and pmi.is_current = true
    and pmi.issue_date > v_cutover
    and pmi.status not in ('cancelled', 'superseded')
  order by
    (pmi.issue_date = '2026-10-17') desc,
    pmi.issue_date,
    pmi.issue_number
  limit 1;
  if not found then
    raise exception 'SMOKE_RESULT FAIL: no current Q7 issue after cutover';
  end if;

  -- -------------------------------------------------------------------------
  -- (a) issue_date = cutover is before_cutover and writes no movement.
  -- -------------------------------------------------------------------------
  select * into v_issue_at_cutover
  from public.production_material_issues pmi
  where pmi.location_code = 'q7'
    and pmi.is_current = true
    and pmi.issue_date = v_cutover
    and pmi.status in ('pdf_ready', 'posted')
  order by pmi.issue_number
  limit 1;

  if not found then
    -- Temporarily free the 17/10 order's current slot, add a cutover-dated
    -- header, test it, then restore. Everything rolls back.
    update public.production_material_issues
    set is_current = false
    where id = v_issue17.id;

    select coalesce(max(pmi.revision), 0) + 1 into v_revision
    from public.production_material_issues pmi
    where pmi.production_order_id = v_issue17.production_order_id;

    insert into public.production_material_issues(
      issue_number, production_order_id, issue_date, status, total_amount,
      location_code, revision, source_hash, is_current
    ) values (
      'PXK-SMOKE-Q7-' || to_char(v_cutover, 'YYYYMMDD') || '-'
        || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
      v_issue17.production_order_id,
      v_cutover,
      'pdf_ready',
      0,
      'q7',
      v_revision,
      md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text),
      true
    )
    returning id into v_synthetic_issue;

    select * into v_issue_at_cutover
    from public.production_material_issues
    where id = v_synthetic_issue;
  end if;

  select count(*) into v_moves_before
  from public.q7_inventory_movements m
  where m.source = 'production_material_issue'
    and m.source_issue_id = v_issue_at_cutover.id;

  v_replay := public.post_material_issue_usage(v_issue_at_cutover.id);

  select count(*) into v_moves_after
  from public.q7_inventory_movements m
  where m.source = 'production_material_issue'
    and m.source_issue_id = v_issue_at_cutover.id;

  if v_replay ->> 'status' is distinct from 'before_cutover' then
    raise exception 'SMOKE_RESULT FAIL: (a) status=%', v_replay ->> 'status';
  end if;
  if v_moves_after <> v_moves_before then
    raise exception 'SMOKE_RESULT FAIL: (a) wrote movements (% -> %)',
      v_moves_before, v_moves_after;
  end if;

  if v_synthetic_issue is not null then
    delete from public.production_material_issues where id = v_synthetic_issue;
    update public.production_material_issues
    set is_current = true
    where id = v_issue17.id;
  end if;
  raise notice 'SMOKE: (a) cutover guard uses <= and wrote 0 rows';

  -- -------------------------------------------------------------------------
  -- (b) Đường (NVL-DUONG) is an open review group.
  -- -------------------------------------------------------------------------
  select id into v_duong
  from public.sku_cogs_materials m
  where m.material_code = 'NVL-DUONG'
    and m.active = true
  order by m.id
  limit 1;
  if v_duong is null then
    raise exception 'SMOKE_RESULT FAIL: canonical NVL-DUONG not found';
  end if;

  -- Drop any live remap for this smoke key so the line is provably open.
  update public.q7_bom_line_decisions
  set active = false
  where canonical_material_id = v_duong
    and lower(btrim(source_unit)) = 'g'
    and active = true;

  v_review := public.get_q7_bom_mismatch_review();

  select r into v_row
  from jsonb_array_elements(v_review) r
  where r ->> 'canonical_material_id' = v_duong::text
    and lower(r ->> 'source_unit') = 'g'
  limit 1;
  if v_row is null then
    raise exception 'SMOKE_RESULT FAIL: (b) NVL-DUONG/g is not in the review';
  end if;
  if (v_row ->> 'open')::boolean is not true then
    raise exception 'SMOKE_RESULT FAIL: (b) NVL-DUONG/g is not open';
  end if;
  v_duong_unit := lower(v_row ->> 'source_unit');
  raise notice 'SMOKE: (b) Đường group is open';

  -- -------------------------------------------------------------------------
  -- (c) Remap NVL-DUONG g → Đường tinh luyện, factor 1, replay-safe.
  -- -------------------------------------------------------------------------
  select id, unit into v_target, v_target_unit
  from public.kitchen_inventory_items k
  where k.item_code = 'Q7-8EBB689B5977C1D6DF8A'
    and k.active = true
  limit 1;
  if v_target is null then
    raise exception 'SMOKE_RESULT FAIL: Q7-8EBB689B5977C1D6DF8A not found';
  end if;

  v_resolve := public.resolve_q7_bom_line(
    v_duong, v_duong_unit, 'remap', v_target, 1, 'Smoke Q7 BOM remap', v_request
  );
  if v_resolve ->> 'action' is distinct from 'remap'
     or (v_resolve ->> 'new_kitchen_item_id')::uuid is distinct from v_target
     or (v_resolve ->> 'conversion_factor')::numeric is distinct from 1 then
    raise exception 'SMOKE_RESULT FAIL: (c) resolve result %', v_resolve;
  end if;
  if (v_resolve ->> 'replay')::boolean is not false then
    raise exception 'SMOKE_RESULT FAIL: (c) first resolve marked replay';
  end if;

  v_replay := public.resolve_q7_bom_line(
    v_duong, v_duong_unit, 'remap', v_target, 1, 'Smoke Q7 BOM remap', v_request
  );
  if (v_replay ->> 'replay')::boolean is not true
     or (v_replay ->> 'decision_id') is distinct from (v_resolve ->> 'decision_id') then
    raise exception 'SMOKE_RESULT FAIL: (c) replay %', v_replay;
  end if;

  if not exists (
    select 1
    from public.q7_material_issue_material_mappings m
    where m.canonical_material_id = v_duong
      and lower(btrim(m.source_unit)) = v_duong_unit
      and m.approval_status = 'approved'
      and m.kitchen_inventory_item_id = v_target
      and m.conversion_factor = 1
  ) then
    raise exception 'SMOKE_RESULT FAIL: (c) approved mapping was not re-pointed';
  end if;
  raise notice 'SMOKE: (c) remap + replay OK';

  -- -------------------------------------------------------------------------
  -- (d) Exclude NƯỚC ĐÁ when its canonical appears in the review.
  -- -------------------------------------------------------------------------
  select id, canonical_material_id, unit
    into v_nuoc_da, v_nuoc_da_canonical, v_nuoc_da_unit
  from public.kitchen_inventory_items k
  where k.item_code = 'Q7-259831B6C7785A330111'
  limit 1;

  if v_nuoc_da is not null and v_nuoc_da_canonical is not null then
    select r into v_row
    from jsonb_array_elements(public.get_q7_bom_mismatch_review()) r
    where r ->> 'canonical_material_id' = v_nuoc_da_canonical::text
    limit 1;

    if v_row is not null then
      v_nuoc_da_unit := lower(v_row ->> 'source_unit');
      v_resolve_nuoc_da := public.resolve_q7_bom_line(
        v_nuoc_da_canonical, v_nuoc_da_unit, 'not_tracked', null, null,
        'Smoke Q7 BOM: nước đá không theo dõi', gen_random_uuid()
      );
      if v_resolve_nuoc_da ->> 'action' is distinct from 'not_tracked' then
        raise exception 'SMOKE_RESULT FAIL: (d) %', v_resolve_nuoc_da;
      end if;
      raise notice 'SMOKE: (d) NƯỚC ĐÁ excluded';
    end if;
  end if;

  -- Exclude any remaining open line of this issue so the catch-up may post it.
  for v_row in
    select r
    from jsonb_array_elements(public.get_q7_bom_mismatch_review()) r
    where (r ->> 'open')::boolean = true
      and exists (
        select 1
        from public.production_material_issue_items i
        where i.material_issue_id = v_issue17.id
          and i.canonical_material_id = (r ->> 'canonical_material_id')::uuid
          and lower(btrim(i.source_unit)) = (r ->> 'source_unit')
      )
  loop
    perform public.resolve_q7_bom_line(
      (v_row ->> 'canonical_material_id')::uuid,
      v_row ->> 'source_unit',
      'bom_error',
      null,
      null,
      'Smoke Q7 BOM: exclude remaining open line',
      gen_random_uuid()
    );
  end loop;

  -- -------------------------------------------------------------------------
  -- (e) Catch-up posts the 17/10 issue exactly once.
  -- -------------------------------------------------------------------------
  update public.production_material_issues
  set status = 'pdf_ready',
      source_hash = coalesce(
        source_hash,
        md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text)
      ),
      updated_at = now()
  where id = v_issue17.id
    and status not in ('cancelled');

  -- Clear this issue's ledger rows (rollback-only) so the catch-up must write.
  -- q7_inventory_movements is append-only in production; this rollback fixture
  -- temporarily disables that guard and restores it in the same transaction.
  if exists (
    select 1
    from public.q7_inventory_movements
    where source = 'production_material_issue'
      and source_issue_id = v_issue17.id
  ) then
    alter table public.q7_inventory_movements
      disable trigger q7_inventory_movements_immutable;
    delete from public.q7_inventory_movements
    where source = 'production_material_issue'
      and source_issue_id = v_issue17.id;
    alter table public.q7_inventory_movements
      enable trigger q7_inventory_movements_immutable;
  end if;

  v_post := public.post_pending_q7_material_issues(false);

  select pmi.id, pmi.issue_number
    into v_posted_issue, v_posted_number
  from public.production_material_issues pmi
  where pmi.production_order_id = v_issue17.production_order_id
    and pmi.is_current = true
    and pmi.status not in ('cancelled', 'superseded')
  order by pmi.revision desc
  limit 1;

  if v_posted_issue is null then
    raise exception 'SMOKE_RESULT FAIL: (e) current issue disappeared';
  end if;

  select r ->> 'action', (r ->> 'movements')::integer
    into v_posted_action, v_posted_movements
  from jsonb_array_elements(v_post -> 'issues') r
  where r ->> 'issue_id' = v_posted_issue::text
  limit 1;

  if v_posted_action not in ('posted', 'regenerated') then
    raise exception 'SMOKE_RESULT FAIL: (e) action=% result=%',
      v_posted_action, v_post;
  end if;
  if coalesce(v_posted_movements, 0) <= 0 then
    raise exception 'SMOKE_RESULT FAIL: (e) no movements in result=%', v_post;
  end if;

  select count(*) into v_target_moves
  from public.q7_inventory_movements m
  where m.source = 'production_material_issue'
    and m.source_issue_id = v_posted_issue
    and m.kitchen_inventory_item_id = v_target;
  if v_target_moves <= 0 then
    raise exception 'SMOKE_RESULT FAIL: (e) no movement on Đường tinh luyện';
  end if;

  if v_nuoc_da_canonical is not null then
    select count(*) into v_nuoc_da_moves
    from public.q7_inventory_movements m
    join public.production_material_issue_items i on i.id = m.source_issue_item_id
    where m.source = 'production_material_issue'
      and m.source_issue_id = v_posted_issue
      and (
        i.kitchen_inventory_item_id = v_nuoc_da
        or i.canonical_material_id = v_nuoc_da_canonical
      );
    if v_nuoc_da_moves <> 0 then
      raise exception 'SMOKE_RESULT FAIL: (e) NƯỚC ĐÁ got % movements',
        v_nuoc_da_moves;
    end if;
  end if;
  raise notice 'SMOKE: (e) posted % with % movements', v_posted_number, v_posted_movements;

  -- -------------------------------------------------------------------------
  -- (f) A second call is already_posted and writes nothing new.
  -- -------------------------------------------------------------------------
  select count(*) into v_moves_before
  from public.q7_inventory_movements m
  where m.source = 'production_material_issue'
    and m.source_issue_id = v_posted_issue;

  v_post2 := public.post_pending_q7_material_issues(false);

  select count(*) into v_moves_after
  from public.q7_inventory_movements m
  where m.source = 'production_material_issue'
    and m.source_issue_id = v_posted_issue;

  select r ->> 'action', (r ->> 'movements')::integer
    into v_second_action, v_second_movements
  from jsonb_array_elements(v_post2 -> 'issues') r
  where r ->> 'issue_id' = v_posted_issue::text
  limit 1;

  if v_second_action is distinct from 'already_posted' then
    raise exception 'SMOKE_RESULT FAIL: (f) action=% result=%', v_second_action, v_post2;
  end if;
  if coalesce(v_second_movements, 0) <> 0 or v_moves_after <> v_moves_before then
    raise exception 'SMOKE_RESULT FAIL: (f) wrote new movements (% -> %)',
      v_moves_before, v_moves_after;
  end if;

  raise notice 'SMOKE_RESULT PASS';
end;
$smoke$;

rollback;
