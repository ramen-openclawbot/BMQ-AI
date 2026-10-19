-- Rollback-only smoke for migration 20261102280000_q7_cancel_order_reverses_usage.sql.
--
-- Run after the migration is applied, as the database owner/Maestro:
--   supabase db query --linked -f scripts/smoke_q7_cancel_reversal.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_q7_cancel_reversal.sql).
--
-- The file opens one transaction, impersonates the real owner through
-- request.jwt.claims, then exercises:
--   (a) picks a Q7 order that has a current, pdf_ready issue after the cutover
--       with posted production_usage, or builds a temporary posted fixture;
--       records each kitchen item's balance and the issue's usage rows;
--   (b) sets the order to 'cancelled' and checks the issue became
--       status='cancelled', is_current=false, one reversal per usage row with
--       the cancellation note, and item balances returned to pre-issue values;
--   (c) cancelling the order again and re-running
--       cancel_production_order_material_issues writes nothing;
--   (d) post_material_issue_usage on the cancelled order's issue returns
--       order_cancelled and writes nothing;
--   (e) post_pending_q7_material_issues(true) does not list that issue;
--   (f) a superseded issue is still reversed with the old note.
--
-- It raises notice 'SMOKE_RESULT PASS' and rolls back; nothing is committed.

begin;

-- Ensures the session temp schema exists before the pg_temp fixture helper.
create temp table smoke_q7_cancel_scratch (id integer) on commit drop;

-- Builds an isolated order + issue + one approved BOM item, posts it, and
-- returns the issue id. Used when no real issue qualifies and by case (f).
create function pg_temp.smoke_q7_cancel_create_issue(
  p_owner uuid,
  p_issue_date date
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mapping public.q7_material_issue_material_mappings%rowtype;
  v_order_id uuid;
  v_order_item_id uuid;
  v_issue_id uuid;
  v_suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
begin
  select m.* into v_mapping
  from public.q7_material_issue_material_mappings m
  join public.kitchen_inventory_items k on k.id = m.kitchen_inventory_item_id
  where m.approval_status = 'approved'
    and k.active = true
    and coalesce(k.item_class, '') <> 'non_stock'
    and not exists (
      select 1
      from public.q7_bom_line_decisions d
      where d.active = true
        and d.action in ('not_tracked', 'bom_error')
        and d.canonical_material_id = m.canonical_material_id
        and lower(btrim(d.source_unit)) = lower(btrim(m.source_unit))
    )
  order by m.created_at, m.id
  limit 1;

  if v_mapping.id is null then
    raise exception 'SMOKE_RESULT FAIL: no approved Q7 mapping for the smoke fixture';
  end if;

  insert into public.production_orders(
    production_number, status, location_code, notes, created_by
  ) values (
    'SX-SMOKE-Q7-' || to_char(p_issue_date, 'YYYYMMDD') || '-' || v_suffix,
    'planned',
    'q7',
    'SMOKE cancel-reversal fixture',
    p_owner
  )
  returning id into v_order_id;

  insert into public.production_order_items(
    production_order_id, product_name, ordered_qty, planned_qty, unit
  ) values (
    v_order_id, 'SMOKE fixture finished good', 1, 1, 'kg'
  )
  returning id into v_order_item_id;

  insert into public.production_material_issues(
    issue_number, production_order_id, issue_date, status, total_amount,
    location_code, revision, source_hash, is_current, created_by
  ) values (
    'PXK-SMOKE-Q7-' || to_char(p_issue_date, 'YYYYMMDD') || '-' || v_suffix,
    v_order_id,
    p_issue_date,
    'pdf_ready',
    0,
    'q7',
    1,
    md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text),
    true,
    p_owner
  )
  returning id into v_issue_id;

  insert into public.production_material_issue_items(
    material_issue_id, production_order_item_id, kitchen_inventory_item_id,
    ingredient_name, required_qty, unit, source_ref_key,
    canonical_material_id, q7_mapping_id, source_unit,
    source_required_qty, conversion_factor
  ) values (
    v_issue_id,
    v_order_item_id,
    v_mapping.kitchen_inventory_item_id,
    'SMOKE ' || coalesce(v_mapping.source_unit, 'NVL'),
    1,
    v_mapping.kitchen_unit,
    'smoke-' || v_suffix,
    v_mapping.canonical_material_id,
    v_mapping.id,
    v_mapping.source_unit,
    1,
    v_mapping.conversion_factor
  );

  if public.post_material_issue_usage(v_issue_id) ->> 'status' is distinct from 'posted' then
    raise exception 'SMOKE_RESULT FAIL: fixture issue was not posted';
  end if;
  if not exists (
    select 1
    from public.q7_inventory_movements
    where source = 'production_material_issue'
      and source_issue_id = v_issue_id
  ) then
    raise exception 'SMOKE_RESULT FAIL: fixture issue wrote no production_usage';
  end if;

  return v_issue_id;
end;
$$;

do $smoke$
declare
  v_owner uuid;
  v_cutover date;
  v_issue_id uuid;
  v_issue public.production_material_issues%rowtype;
  v_cancelled_issue public.production_material_issues%rowtype;
  v_superseded_issue uuid;
  v_usage_rows integer;
  v_rev_before integer;
  v_rev_after integer;
  v_moves_before bigint;
  v_moves_after bigint;
  v_cancel jsonb;
  v_post jsonb;
  v_pending jsonb;
  v_superseded_usage integer;
  v_superseded_reversals integer;
  v_note_cancelled constant text :=
    'Hoàn bút toán phiếu xuất NVL — lệnh sản xuất đã hủy';
  v_note_superseded constant text :=
    'Đảo bút toán phiếu xuất NVL bị thay thế';
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

  -- -------------------------------------------------------------------------
  -- (a) A current, pdf_ready Q7 issue after the cutover with posted usage.
  -- -------------------------------------------------------------------------
  select pmi.id into v_issue_id
  from public.production_material_issues pmi
  join public.production_orders po on po.id = pmi.production_order_id
  where pmi.location_code = 'q7'
    and pmi.is_current = true
    and pmi.status = 'pdf_ready'
    and pmi.issue_date > v_cutover
    and po.status::text <> 'cancelled'
    -- The cancellation trigger handles every current issue of the order, so the
    -- balance assertions need an order whose only current issue is this one.
    and not exists (
      select 1
      from public.production_material_issues pmi_other
      where pmi_other.production_order_id = pmi.production_order_id
        and pmi_other.id <> pmi.id
        and pmi_other.is_current = true
        and pmi_other.status <> 'cancelled'
    )
    and exists (
      select 1
      from public.q7_inventory_movements m
      where m.source = 'production_material_issue'
        and m.source_issue_id = pmi.id
    )
    and not exists (
      select 1
      from public.q7_inventory_movements r
      where r.source = 'production_material_issue_reversal'
        and r.source_issue_id = pmi.id
    )
  order by pmi.issue_date desc, pmi.issue_number
  limit 1;

  if v_issue_id is null then
    v_issue_id := pg_temp.smoke_q7_cancel_create_issue(v_owner, v_cutover + 1);
    raise notice 'SMOKE: (a) no real issue qualified, built a posted fixture';
  end if;

  select * into v_issue
  from public.production_material_issues
  where id = v_issue_id;

  create temp table smoke_q7_cancel_before (
    item_id uuid primary key,
    qty numeric
  ) on commit drop;

  -- Balances are compared per merge group (coalesce(merged_into_id, id)) with
  -- the ledger formula on-hand = receipts - production_usage + adjustments,
  -- because stock_item_merge_forward moves any row written for a merged item
  -- onto its target (net zero inside the group). item_id = group id.
  insert into smoke_q7_cancel_before(item_id, qty)
  select coalesce(k.merged_into_id, k.id),
         sum(case m.movement_type
               when 'receipt' then m.quantity
               when 'production_usage' then -m.quantity
               when 'adjustment' then m.quantity
               else 0 end)
  from public.q7_inventory_movements m
  join public.kitchen_inventory_items k on k.id = m.kitchen_inventory_item_id
  where coalesce(k.merged_into_id, k.id) in (
    select distinct coalesce(ku.merged_into_id, ku.id)
    from public.q7_inventory_movements u
    join public.kitchen_inventory_items ku on ku.id = u.kitchen_inventory_item_id
    where u.source = 'production_material_issue'
      and u.source_issue_id = v_issue.id
  )
  group by coalesce(k.merged_into_id, k.id);

  create temp table smoke_q7_cancel_usage (
    item_id uuid primary key,
    qty numeric
  ) on commit drop;

  insert into smoke_q7_cancel_usage(item_id, qty)
  select coalesce(k.merged_into_id, k.id), sum(m.quantity)
  from public.q7_inventory_movements m
  join public.kitchen_inventory_items k on k.id = m.kitchen_inventory_item_id
  where m.source = 'production_material_issue'
    and m.source_issue_id = v_issue.id
  group by coalesce(k.merged_into_id, k.id);

  select count(*) into v_usage_rows
  from public.q7_inventory_movements
  where source = 'production_material_issue'
    and source_issue_id = v_issue.id;

  if v_usage_rows <= 0 then
    raise exception 'SMOKE_RESULT FAIL: (a) issue % has no production_usage', v_issue.issue_number;
  end if;

  select count(*) into v_rev_before
  from public.q7_inventory_movements
  where source = 'production_material_issue_reversal'
    and source_issue_id = v_issue.id;
  if v_rev_before <> 0 then
    raise exception 'SMOKE_RESULT FAIL: (a) issue % already has % reversal rows',
      v_issue.issue_number, v_rev_before;
  end if;

  raise notice 'SMOKE: (a) issue % has % usage rows', v_issue.issue_number, v_usage_rows;

  -- -------------------------------------------------------------------------
  -- (b) Cancelling the order cancels the issue and reverses every usage row.
  -- -------------------------------------------------------------------------
  update public.production_orders
  set status = 'cancelled'
  where id = v_issue.production_order_id;

  select * into v_cancelled_issue
  from public.production_material_issues
  where id = v_issue.id;

  if v_cancelled_issue.status is distinct from 'cancelled'
     or v_cancelled_issue.is_current is distinct from false then
    raise exception 'SMOKE_RESULT FAIL: (b) issue status=% is_current=%',
      v_cancelled_issue.status, v_cancelled_issue.is_current;
  end if;

  select count(*) into v_rev_after
  from public.q7_inventory_movements
  where source = 'production_material_issue_reversal'
    and source_issue_id = v_issue.id;

  if v_rev_after - v_rev_before <> v_usage_rows then
    raise exception 'SMOKE_RESULT FAIL: (b) reversed % rows, expected %',
      v_rev_after - v_rev_before, v_usage_rows;
  end if;

  if exists (
    select 1
    from public.q7_inventory_movements
    where source = 'production_material_issue_reversal'
      and source_issue_id = v_issue.id
      and note is distinct from v_note_cancelled
  ) then
    raise exception 'SMOKE_RESULT FAIL: (b) reversal note is not the cancellation note';
  end if;

  if exists (
    select 1
    from smoke_q7_cancel_before b
    join smoke_q7_cancel_usage u on u.item_id = b.item_id
    left join (
      select coalesce(k.merged_into_id, k.id) as item_id,
             sum(case m.movement_type
                   when 'receipt' then m.quantity
                   when 'production_usage' then -m.quantity
                   when 'adjustment' then m.quantity
                   else 0 end) as qty
      from public.q7_inventory_movements m
      join public.kitchen_inventory_items k on k.id = m.kitchen_inventory_item_id
      where coalesce(k.merged_into_id, k.id) in (select item_id from smoke_q7_cancel_before)
      group by coalesce(k.merged_into_id, k.id)
    ) a on a.item_id = b.item_id
    -- The usage row deducted u.qty from on-hand; the positive reversal
    -- adjustment puts it back, so on-hand returns to the pre-issue value.
    where coalesce(a.qty, 0) <> b.qty + u.qty
  ) then
    raise exception 'SMOKE_RESULT FAIL: (b) item balances did not return to pre-issue values';
  end if;

  raise notice 'SMOKE: (b) issue cancelled, % reversal rows written, balances restored',
    v_rev_after - v_rev_before;

  -- -------------------------------------------------------------------------
  -- (c) Repeating the cancellation / function call writes nothing.
  -- -------------------------------------------------------------------------
  select count(*) into v_moves_before
  from public.q7_inventory_movements
  where source_issue_id = v_issue.id;

  update public.production_orders
  set status = 'cancelled'
  where id = v_issue.production_order_id;

  v_cancel := public.cancel_production_order_material_issues(v_issue.production_order_id);
  if coalesce((v_cancel ->> 'issues_cancelled')::integer, -1) <> 0
     or coalesce((v_cancel ->> 'reversal_rows')::integer, -1) <> 0 then
    raise exception 'SMOKE_RESULT FAIL: (c) second call returned %', v_cancel;
  end if;

  select count(*) into v_moves_after
  from public.q7_inventory_movements
  where source_issue_id = v_issue.id;
  if v_moves_after <> v_moves_before then
    raise exception 'SMOKE_RESULT FAIL: (c) wrote rows on the second call (% -> %)',
      v_moves_before, v_moves_after;
  end if;

  raise notice 'SMOKE: (c) repeated cancellation is a no-op';

  -- -------------------------------------------------------------------------
  -- (d) post_material_issue_usage refuses a cancelled order and writes nothing.
  -- The order guard sits after not_current/not_postable, so temporarily make the
  -- cancelled issue look postable (the order itself stays cancelled) to reach it.
  -- -------------------------------------------------------------------------
  update public.production_material_issues
  set status = 'pdf_ready',
      is_current = true
  where id = v_issue.id;

  select count(*) into v_moves_before
  from public.q7_inventory_movements
  where source_issue_id = v_issue.id;

  v_post := public.post_material_issue_usage(v_issue.id);
  if v_post ->> 'status' is distinct from 'order_cancelled' then
    raise exception 'SMOKE_RESULT FAIL: (d) status=%', v_post ->> 'status';
  end if;
  if coalesce((v_post ->> 'movement_count')::integer, -1) <> 0
     or coalesce((v_post ->> 'skipped_count')::integer, -1) <> 0 then
    raise exception 'SMOKE_RESULT FAIL: (d) result=%', v_post;
  end if;

  select count(*) into v_moves_after
  from public.q7_inventory_movements
  where source_issue_id = v_issue.id;
  if v_moves_after <> v_moves_before then
    raise exception 'SMOKE_RESULT FAIL: (d) wrote rows (% -> %)',
      v_moves_before, v_moves_after;
  end if;

  update public.production_material_issues
  set status = 'cancelled',
      is_current = false
  where id = v_issue.id;

  raise notice 'SMOKE: (d) cancelled order refused posting';

  -- -------------------------------------------------------------------------
  -- (e) The catch-up job does not list the cancelled issue.
  -- -------------------------------------------------------------------------
  v_pending := public.post_pending_q7_material_issues(true);
  if exists (
    select 1
    from jsonb_array_elements(coalesce(v_pending -> 'issues', '[]'::jsonb)) r
    where r ->> 'issue_id' = v_issue.id::text
  ) then
    raise exception 'SMOKE_RESULT FAIL: (e) pending list still contains %', v_issue.id;
  end if;

  raise notice 'SMOKE: (e) cancelled issue is not in the pending list';

  -- -------------------------------------------------------------------------
  -- (f) A superseded issue is still reversed with the old note.
  -- -------------------------------------------------------------------------
  v_superseded_issue := pg_temp.smoke_q7_cancel_create_issue(v_owner, v_cutover + 1);

  select count(*) into v_superseded_usage
  from public.q7_inventory_movements
  where source = 'production_material_issue'
    and source_issue_id = v_superseded_issue;
  if v_superseded_usage <= 0 then
    raise exception 'SMOKE_RESULT FAIL: (f) fixture has no production_usage';
  end if;

  update public.production_material_issues
  set status = 'superseded',
      is_current = false,
      superseded_by_issue_id = v_issue.id
  where id = v_superseded_issue;

  select count(*) into v_superseded_reversals
  from public.q7_inventory_movements
  where source = 'production_material_issue_reversal'
    and source_issue_id = v_superseded_issue;
  if v_superseded_reversals <> v_superseded_usage then
    raise exception 'SMOKE_RESULT FAIL: (f) reversed % rows, expected %',
      v_superseded_reversals, v_superseded_usage;
  end if;
  if exists (
    select 1
    from public.q7_inventory_movements
    where source = 'production_material_issue_reversal'
      and source_issue_id = v_superseded_issue
      and note is distinct from v_note_superseded
  ) then
    raise exception 'SMOKE_RESULT FAIL: (f) superseded note changed';
  end if;

  raise notice 'SMOKE: (f) superseded issue reversed with the old note';

  raise notice 'SMOKE_RESULT PASS';
end;
$smoke$;

rollback;
