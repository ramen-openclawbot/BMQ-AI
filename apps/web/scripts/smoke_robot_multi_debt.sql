-- Rollback-only production smoke for migration
-- 20261101280000_robot_multi_debt_learning.sql.
--
-- Run as one file (the Maestro applies the migration first, as the DB owner):
--   supabase db query --linked -f apps/web/scripts/smoke_robot_multi_debt.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_robot_multi_debt.sql).
--
-- The file opens one transaction, impersonates a real owner through
-- request.jwt.claims, seeds one supplier with three old purchase orders (oldest
-- 40 days, middle 20 days, newest 5 days), then drives
-- create_robot_order_package with an ARRAY picking the oldest and the newest:
--   * it must create one draft PO with the two lines;
--   * for both chosen 'po' debts it must create two pending old_order payment
--     requests with the PO items copied and submit them through ONE
--     create_payment_submission call (one submission, two items, one Zalo);
--   * it must write exactly one supplier_debt_pick_history row with
--     picked_count = 2, candidate_count = 3 and skipped_older_count = 1;
--   * the learned cutover is the oldest pick, so nothing older gets marked;
--   * a replay with the same key must return idempotent = true and add nothing;
--   * a duplicate id must raise debt_duplicate.
-- The final ROLLBACK removes every row this smoke wrote.

begin;

do $smoke$
declare
  v_owner uuid;
  v_supplier uuid;
  v_old uuid;
  v_mid uuid;
  v_new uuid;
  v_old_total numeric := 1000000;
  v_mid_total numeric := 800000;
  v_new_total numeric := 500000;
  v_old_items integer;
  v_new_items integer;
  v_suffix text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');
  v_key text := 'smoke-robot-multi-' || v_suffix;
  v_note text := 'smoke robot multi ' || v_suffix;
  v_lines jsonb;
  v_picks jsonb;
  v_res jsonb;
  v_res2 jsonb;
  v_draft uuid;
  v_draft_count integer;
  v_draft_items integer;
  v_new_pr_old uuid;
  v_new_pr_new uuid;
  v_new_pr_old_items integer;
  v_new_pr_new_items integer;
  v_pr_count integer;
  v_submission uuid;
  v_submission_rows integer;
  v_zalo integer;
  v_cutover public.supplier_debt_cutovers%rowtype;
  v_hist public.supplier_debt_pick_history%rowtype;
  v_mark integer;
  v_sub_before integer;
  v_hist_before integer;
  v_sub_after integer;
  v_hist_after integer;
  v_probe integer;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE FAIL no_owner';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  insert into public.suppliers (name)
  values ('SMOKE robot multi ' || v_suffix)
  returning id into v_supplier;

  -- Oldest PO, 40 days back: the learned cutover.
  insert into public.purchase_orders (
    po_number, supplier_id, status, order_date, expected_date, total_amount,
    vat_amount, notes, created_by
  ) values (
    'SMOKE-MULTI-OLD-' || v_suffix, v_supplier, 'sent',
    current_date - 40, current_date - 40, v_old_total, 0, 'smoke multi old', v_owner
  ) returning id into v_old;
  insert into public.purchase_order_items (
    purchase_order_id, product_name, quantity, unit, unit_price, line_total
  ) values
    (v_old, 'Bột mì multi cũ', 10, 'kg', 20000, 200000),
    (v_old, 'Đường multi cũ', 5, 'kg', 30000, 150000);
  select count(*) into v_old_items
  from public.purchase_order_items where purchase_order_id = v_old;

  -- Middle PO, 20 days back: NOT picked, sits older than the newest pick.
  insert into public.purchase_orders (
    po_number, supplier_id, status, order_date, expected_date, total_amount,
    vat_amount, notes, created_by
  ) values (
    'SMOKE-MULTI-MID-' || v_suffix, v_supplier, 'sent',
    current_date - 20, current_date - 20, v_mid_total, 0, 'smoke multi mid', v_owner
  ) returning id into v_mid;
  insert into public.purchase_order_items (
    purchase_order_id, product_name, quantity, unit, unit_price, line_total
  ) values (v_mid, 'Bột mì multi giữa', 8, 'kg', 20000, 160000);

  -- Newest PO, 5 days back: picked together with the oldest.
  insert into public.purchase_orders (
    po_number, supplier_id, status, order_date, expected_date, total_amount,
    vat_amount, notes, created_by
  ) values (
    'SMOKE-MULTI-NEW-' || v_suffix, v_supplier, 'sent',
    current_date - 5, current_date - 5, v_new_total, 0, 'smoke multi new', v_owner
  ) returning id into v_new;
  insert into public.purchase_order_items (
    purchase_order_id, product_name, quantity, unit, unit_price, line_total
  ) values (v_new, 'Bột mì multi mới', 5, 'kg', 20000, 100000);
  select count(*) into v_new_items
  from public.purchase_order_items where purchase_order_id = v_new;

  select count(*) into v_sub_before from public.payment_submissions;
  select count(*) into v_hist_before
  from public.supplier_debt_pick_history where supplier_id = v_supplier;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'supplier_id', v_supplier, 'product_name', 'Bột mì multi robot',
      'quantity', 10, 'unit', 'kg', 'unit_price', 20000
    ),
    jsonb_build_object(
      'supplier_id', v_supplier, 'product_name', 'Đường multi robot',
      'quantity', 5, 'unit', 'kg', 'unit_price', 30000
    )
  );

  v_picks := jsonb_build_array(
    jsonb_build_object('kind', 'po', 'id', v_old),
    jsonb_build_object('kind', 'po', 'id', v_new)
  );

  v_res := public.create_robot_order_package(v_lines, v_picks, v_note, v_key);

  ----------------------------------------------------------------
  -- (1) one new draft PO with exactly the two lines
  ----------------------------------------------------------------
  select count(*) into v_draft_count
  from public.purchase_orders
  where supplier_id = v_supplier and status = 'draft';
  if v_draft_count <> 1 then
    raise exception 'SMOKE FAIL draft_count %', v_draft_count;
  end if;

  select po.id into v_draft
  from public.purchase_orders po
  where po.supplier_id = v_supplier and po.status = 'draft'
  order by po.created_at desc, po.po_number desc
  limit 1;
  select count(*) into v_draft_items
  from public.purchase_order_items where purchase_order_id = v_draft;
  if v_draft_items <> 2 then
    raise exception 'SMOKE FAIL draft_items %', v_draft_items;
  end if;

  ----------------------------------------------------------------
  -- (2) two pending old_order PRs, one per picked PO, items copied
  ----------------------------------------------------------------
  select pr.id into v_new_pr_old
  from public.payment_requests pr
  where pr.supplier_id = v_supplier
    and pr.purchase_order_id = v_old
    and pr.status = 'pending'
    and pr.payment_type = 'old_order'
  order by pr.created_at desc
  limit 1;
  select pr.id into v_new_pr_new
  from public.payment_requests pr
  where pr.supplier_id = v_supplier
    and pr.purchase_order_id = v_new
    and pr.status = 'pending'
    and pr.payment_type = 'old_order'
  order by pr.created_at desc
  limit 1;
  if v_new_pr_old is null or v_new_pr_new is null then
    raise exception 'SMOKE FAIL new_pr_missing';
  end if;

  select count(*) into v_new_pr_old_items
  from public.payment_request_items where payment_request_id = v_new_pr_old;
  if v_new_pr_old_items <> v_old_items then
    raise exception 'SMOKE FAIL new_pr_old_items % / %', v_new_pr_old_items, v_old_items;
  end if;
  select count(*) into v_new_pr_new_items
  from public.payment_request_items where payment_request_id = v_new_pr_new;
  if v_new_pr_new_items <> v_new_items then
    raise exception 'SMOKE FAIL new_pr_new_items % / %', v_new_pr_new_items, v_new_items;
  end if;

  ----------------------------------------------------------------
  -- (3) ONE submission with both items and one Zalo notice
  ----------------------------------------------------------------
  v_submission := nullif(v_res -> 'debt' ->> 'submission_id', '')::uuid;
  if v_submission is null then
    raise exception 'SMOKE FAIL submission_missing';
  end if;

  select count(*) into v_submission_rows
  from public.payment_submission_items
  where submission_id = v_submission;
  if v_submission_rows <> 2 then
    raise exception 'SMOKE FAIL submission_items %', v_submission_rows;
  end if;

  select count(*) into v_zalo
  from public.finance_zalo_notifications
  where event_type = 'payment_submission_created' and entity_id = v_submission;
  if v_zalo <> 1 then
    raise exception 'SMOKE FAIL zalo_notice %', v_zalo;
  end if;

  ----------------------------------------------------------------
  -- (4) one learning-history row with picked_count = 2
  ----------------------------------------------------------------
  select * into v_hist
  from public.supplier_debt_pick_history
  where package_id = (v_res ->> 'package_id')::uuid;
  if not found then
    raise exception 'SMOKE FAIL history_missing';
  end if;
  if v_hist.picked_count <> 2 then
    raise exception 'SMOKE FAIL picked_count %', v_hist.picked_count;
  end if;
  if v_hist.candidate_count <> 3 then
    raise exception 'SMOKE FAIL candidate_count %', v_hist.candidate_count;
  end if;
  if v_hist.skipped_older_count <> 1 then
    raise exception 'SMOKE FAIL skipped_older_count %', v_hist.skipped_older_count;
  end if;
  if jsonb_array_length(v_hist.picked) <> 2 then
    raise exception 'SMOKE FAIL picked_rows %', jsonb_array_length(v_hist.picked);
  end if;
  if v_hist.picked_total <> v_old_total + v_new_total then
    raise exception 'SMOKE FAIL picked_total %', v_hist.picked_total;
  end if;

  ----------------------------------------------------------------
  -- (5) the cutover is the OLDEST pick and nothing older is marked
  ----------------------------------------------------------------
  select * into v_cutover
  from public.supplier_debt_cutovers where supplier_id = v_supplier;
  if not found then
    raise exception 'SMOKE FAIL cutover_missing';
  end if;
  if v_cutover.purchase_order_id is distinct from v_old then
    raise exception 'SMOKE FAIL cutover_po %', v_cutover.purchase_order_id;
  end if;
  if v_cutover.start_date is distinct from (current_date - 40) then
    raise exception 'SMOKE FAIL cutover_date %', v_cutover.start_date;
  end if;

  select count(*) into v_mark
  from public.supplier_debt_marks where supplier_id = v_supplier;
  if v_mark <> 0 then
    raise exception 'SMOKE FAIL mark_total %', v_mark;
  end if;

  ----------------------------------------------------------------
  -- (6) the same key replays with idempotent = true and adds nothing
  ----------------------------------------------------------------
  v_res2 := public.create_robot_order_package(v_lines, v_picks, v_note, v_key);
  if coalesce((v_res2 ->> 'idempotent')::boolean, false) is not true then
    raise exception 'SMOKE FAIL replay_not_idempotent';
  end if;
  if (v_res2 ->> 'package_id') is distinct from (v_res ->> 'package_id') then
    raise exception 'SMOKE FAIL replay_package_changed';
  end if;

  select count(*) into v_sub_after from public.payment_submissions;
  select count(*) into v_hist_after
  from public.supplier_debt_pick_history where supplier_id = v_supplier;
  if v_sub_after <> v_sub_before + 1 or v_hist_after <> v_hist_before + 1 then
    raise exception 'SMOKE FAIL replay_created % %', v_sub_after, v_hist_after;
  end if;

  ----------------------------------------------------------------
  -- (7) a duplicate id raises debt_duplicate
  ----------------------------------------------------------------
  v_probe := 0;
  begin
    perform public.create_robot_order_package(
      v_lines,
      jsonb_build_array(
        jsonb_build_object('kind', 'po', 'id', v_old),
        jsonb_build_object('kind', 'po', 'id', v_old)
      ),
      v_note,
      'smoke-robot-multi-dup-' || v_suffix
    );
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%debt_duplicate%' then
      raise;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE FAIL debt_duplicate_accepted';
  end if;

  raise notice 'SMOKE PASS';
end;
$smoke$;

rollback;
