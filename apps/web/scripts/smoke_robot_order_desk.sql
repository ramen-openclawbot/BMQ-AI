-- Rollback-only production smoke for migration
-- 20261101170000_robot_order_desk.sql.
--
-- Run as one file (the Maestro applies the migration first, as the DB owner):
--   supabase db query --linked -f apps/web/scripts/smoke_robot_order_desk.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_robot_order_desk.sql).
--
-- The file opens one transaction, impersonates a real owner through
-- request.jwt.claims, seeds one supplier with three old purchase orders (one
-- older, one the chosen middle, one with a newer pending payment request), then
-- drives create_robot_order_package:
--   * it must create one draft PO with the two lines;
--   * for the chosen 'po' debt it must create one pending old_order payment
--     request with the PO items copied, submit it and enqueue the Zalo notice;
--   * it must write the supplier debt cutover at the middle PO doc_date and mark
--     only the strictly older unpaid rows as settled_outside / learned;
--   * a replay with the same key must return idempotent = true and add nothing;
--   * a paid payment request as debt must raise debt_not_payable;
--   * a random non-privileged subject must raise forbidden.
-- The final ROLLBACK removes every row this smoke wrote.

begin;

do $smoke$
declare
  v_owner uuid;
  v_supplier uuid;
  v_old uuid;
  v_mid uuid;
  v_third uuid;
  v_pr uuid;
  v_paid_pr uuid;
  v_suffix text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');
  v_key text := 'smoke-robot-' || v_suffix;
  v_note text := 'smoke robot ' || v_suffix;
  v_lines jsonb;
  v_res jsonb;
  v_res2 jsonb;
  v_draft uuid;
  v_draft_count integer;
  v_draft_items integer;
  v_new_pr uuid;
  v_new_pr_items integer;
  v_mid_items integer;
  v_submission uuid;
  v_submission_rows integer;
  v_zalo integer;
  v_cutover public.supplier_debt_cutovers%rowtype;
  v_mark integer;
  v_old_mark integer;
  v_newer_pr_mark integer;
  v_po_before integer;
  v_pr_before integer;
  v_sub_before integer;
  v_po_after integer;
  v_pr_after integer;
  v_sub_after integer;
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
  values ('SMOKE robot ' || v_suffix)
  returning id into v_supplier;

  -- Oldest PO, 40 days back: must be marked settled_outside / learned.
  insert into public.purchase_orders (
    po_number, supplier_id, status, order_date, expected_date, total_amount,
    vat_amount, notes, created_by
  ) values (
    'SMOKE-ROB-OLD-' || v_suffix, v_supplier, 'sent',
    current_date - 40, current_date - 40, 1000000, 0, 'smoke robot old', v_owner
  ) returning id into v_old;
  insert into public.purchase_order_items (
    purchase_order_id, product_name, quantity, unit, unit_price, line_total
  ) values
    (v_old, 'Bột mì smoke cũ', 10, 'kg', 20000, 200000),
    (v_old, 'Đường smoke cũ', 5, 'kg', 30000, 150000);

  -- Chosen middle PO, 20 days back: the cutover document.
  insert into public.purchase_orders (
    po_number, supplier_id, status, order_date, expected_date, total_amount,
    vat_amount, notes, created_by
  ) values (
    'SMOKE-ROB-MID-' || v_suffix, v_supplier, 'sent',
    current_date - 20, current_date - 20, 800000, 0, 'smoke robot mid', v_owner
  ) returning id into v_mid;
  insert into public.purchase_order_items (
    purchase_order_id, product_name, quantity, unit, unit_price, line_total
  ) values
    (v_mid, 'Bột mì smoke giữa', 8, 'kg', 20000, 160000),
    (v_mid, 'Đường smoke giữa', 4, 'kg', 30000, 120000);
  select count(*) into v_mid_items
  from public.purchase_order_items where purchase_order_id = v_mid;

  -- Third PO, 5 days back, carrying a newer pending unpaid payment request:
  -- it must stay unpaid and never get a settled_outside mark.
  insert into public.purchase_orders (
    po_number, supplier_id, status, order_date, expected_date, total_amount,
    vat_amount, notes, created_by
  ) values (
    'SMOKE-ROB-NEW-' || v_suffix, v_supplier, 'sent',
    current_date - 5, current_date - 5, 500000, 0, 'smoke robot new', v_owner
  ) returning id into v_third;
  insert into public.purchase_order_items (
    purchase_order_id, product_name, quantity, unit, unit_price, line_total
  ) values (v_third, 'Bột mì smoke mới', 5, 'kg', 20000, 100000);

  insert into public.payment_requests (
    request_number, supplier_id, purchase_order_id, title, description,
    total_amount, vat_amount, status, payment_status, payment_type,
    payment_method, created_by
  ) values (
    'PR-SMOKE-' || substr(v_suffix, 1, 10), v_supplier, v_third,
    'Đề nghị chi - SMOKE-ROB-NEW-' || v_suffix,
    'smoke robot newer pending request',
    500000, 0, 'pending', 'unpaid', 'new_order', 'bank_transfer', v_owner
  ) returning id into v_pr;

  select count(*) into v_po_before from public.purchase_orders where supplier_id = v_supplier;
  select count(*) into v_pr_before from public.payment_requests where supplier_id = v_supplier;
  select count(*) into v_sub_before from public.payment_submissions;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'supplier_id', v_supplier, 'product_name', 'Bột mì smoke robot',
      'quantity', 10, 'unit', 'kg', 'unit_price', 20000
    ),
    jsonb_build_object(
      'supplier_id', v_supplier, 'product_name', 'Đường smoke robot',
      'quantity', 5, 'unit', 'kg', 'unit_price', 30000
    )
  );

  v_res := public.create_robot_order_package(
    v_lines,
    jsonb_build_object('kind', 'po', 'id', v_mid),
    v_note,
    v_key
  );

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
  -- (2) one new pending old_order PR linked to the chosen PO, items copied
  ----------------------------------------------------------------
  select pr.id into v_new_pr
  from public.payment_requests pr
  where pr.supplier_id = v_supplier
    and pr.purchase_order_id = v_mid
    and pr.status = 'pending'
    and pr.payment_type = 'old_order'
  order by pr.created_at desc
  limit 1;
  if v_new_pr is null then
    raise exception 'SMOKE FAIL new_pr_missing';
  end if;

  select count(*) into v_new_pr_items
  from public.payment_request_items where payment_request_id = v_new_pr;
  if v_new_pr_items <> v_mid_items then
    raise exception 'SMOKE FAIL new_pr_items % / %', v_new_pr_items, v_mid_items;
  end if;

  ----------------------------------------------------------------
  -- (3) one new submission + the finance Zalo notice for it
  ----------------------------------------------------------------
  v_submission := nullif(v_res -> 'debt' ->> 'submission_id', '')::uuid;
  if v_submission is null then
    raise exception 'SMOKE FAIL submission_missing';
  end if;

  select count(*) into v_submission_rows
  from public.payment_submission_items
  where submission_id = v_submission and payment_request_id = v_new_pr;
  if v_submission_rows <> 1 then
    raise exception 'SMOKE FAIL submission_item %', v_submission_rows;
  end if;

  select count(*) into v_zalo
  from public.finance_zalo_notifications
  where event_type = 'payment_submission_created' and entity_id = v_submission;
  if v_zalo <> 1 then
    raise exception 'SMOKE FAIL zalo_notice %', v_zalo;
  end if;

  ----------------------------------------------------------------
  -- (4) the cutover is the middle PO at its doc_date
  ----------------------------------------------------------------
  select * into v_cutover
  from public.supplier_debt_cutovers where supplier_id = v_supplier;
  if not found then
    raise exception 'SMOKE FAIL cutover_missing';
  end if;
  if v_cutover.purchase_order_id is distinct from v_mid then
    raise exception 'SMOKE FAIL cutover_po %', v_cutover.purchase_order_id;
  end if;
  if v_cutover.start_date is distinct from (current_date - 20) then
    raise exception 'SMOKE FAIL cutover_date %', v_cutover.start_date;
  end if;

  ----------------------------------------------------------------
  -- (5) only the strictly older PO is marked settled_outside / learned
  ----------------------------------------------------------------
  select count(*) into v_old_mark
  from public.supplier_debt_marks
  where purchase_order_id = v_old
    and mark = 'settled_outside'
    and source = 'learned';
  if v_old_mark <> 1 then
    raise exception 'SMOKE FAIL old_mark %', v_old_mark;
  end if;

  select count(*) into v_newer_pr_mark
  from public.supplier_debt_marks
  where payment_request_id = v_pr;
  if v_newer_pr_mark <> 0 then
    raise exception 'SMOKE FAIL newer_pr_marked %', v_newer_pr_mark;
  end if;

  select count(*) into v_mark
  from public.supplier_debt_marks where supplier_id = v_supplier;
  if v_mark <> 1 then
    raise exception 'SMOKE FAIL mark_total %', v_mark;
  end if;

  ----------------------------------------------------------------
  -- (6) the same key replays with idempotent = true and adds nothing
  ----------------------------------------------------------------
  v_res2 := public.create_robot_order_package(
    v_lines,
    jsonb_build_object('kind', 'po', 'id', v_mid),
    v_note,
    v_key
  );
  if coalesce((v_res2 ->> 'idempotent')::boolean, false) is not true then
    raise exception 'SMOKE FAIL replay_not_idempotent';
  end if;
  if (v_res2 ->> 'package_id') is distinct from (v_res ->> 'package_id') then
    raise exception 'SMOKE FAIL replay_package_changed';
  end if;

  select count(*) into v_po_after from public.purchase_orders where supplier_id = v_supplier;
  select count(*) into v_pr_after from public.payment_requests where supplier_id = v_supplier;
  select count(*) into v_sub_after from public.payment_submissions;
  if v_po_after <> v_po_before + 1
     or v_pr_after <> v_pr_before + 1
     or v_sub_after <> v_sub_before + 1 then
    raise exception 'SMOKE FAIL replay_created % % %',
      v_po_after, v_pr_after, v_sub_after;
  end if;

  ----------------------------------------------------------------
  -- (7) a paid payment request as debt raises debt_not_payable
  ----------------------------------------------------------------
  insert into public.payment_requests (
    request_number, supplier_id, title, description, total_amount, vat_amount,
    status, payment_status, payment_type, payment_method, created_by
  ) values (
    'PR-SMOKE-PAID-' || substr(v_suffix, 1, 10), v_supplier,
    'Đề nghị chi - smoke paid', 'smoke robot paid request',
    100000, 0, 'approved', 'paid', 'old_order', 'bank_transfer', v_owner
  ) returning id into v_paid_pr;

  v_probe := 0;
  begin
    perform public.create_robot_order_package(
      v_lines,
      jsonb_build_object('kind', 'pr', 'id', v_paid_pr),
      v_note,
      'smoke-robot-paid-' || v_suffix
    );
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%debt_not_payable%' then
      raise;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE FAIL debt_not_payable_accepted';
  end if;

  ----------------------------------------------------------------
  -- (8) a random non-privileged subject raises forbidden
  ----------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text,
    true
  );
  v_probe := 0;
  begin
    perform public.create_robot_order_package(
      v_lines, null, v_note, 'smoke-robot-forbidden-' || v_suffix
    );
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%forbidden%' then
      raise;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE FAIL forbidden_accepted';
  end if;

  raise notice 'SMOKE PASS';
end;
$smoke$;

rollback;
