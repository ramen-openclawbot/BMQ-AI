-- Smoke test for the purchase-must-stock flow (Giai đoạn 4 data layer).
-- Runs entirely inside BEGIN ... ROLLBACK so it never keeps fixtures.
-- Prerequisites (real data only, never created by this script):
--   * 20261019100000_purchase_must_stock.sql applied
--   * at least one public.user_roles row with role 'owner'
--   * optionally one editor that is not an admin (material_alias_can_edit but
--     not material_alias_can_admin) to exercise the non_stock gate; otherwise
--     that part is skipped with a notice.
-- Run with:  psql "$DATABASE_URL" -f scripts/smoke_purchase_must_stock.sql
--
-- Shared stock_line_auto_non_stock test cases (must match the migration and
-- src/lib/material-alias.ts / supabase/functions/stock-alias-jev/jev.ts):
--   'Thuế VAT 8%'          -> vat
--   'VAT'                  -> vat
--   'Thuế GTGT'            -> vat
--   'Phí vận chuyển'       -> fee
--   'Phụ phí giao hàng'    -> fee
--   'Cước ship nội thành'  -> fee
--   'Vận chuyển hàng'      -> fee
--   'Xử lý côn trùng'      -> service
--   'Phí phân tích mẫu'    -> service
--   'Thuê máy'             -> service
--   'Tỏi phi'              -> null
--   'Bánh mì lớn 17'       -> null
--   'Phô mai Dairymont'    -> null
--   'Ship hàng'            -> fee
--   'Cước Rửa Chén TBP x 4 Miếng' -> null
--   'Cước điện thoại_0966998998' -> fee
--   'Thuê nhà Q.7 T9/26'   -> service

begin;

select set_config('request.jwt.claim.role', 'service_role', true);

do $smoke$
declare
  v_owner uuid;
  v_editor uuid;
  v_supplier uuid;
  v_item uuid;
  v_receipt uuid;
  v_line_toi uuid;
  v_line_fee uuid;
  v_line_vat uuid;
  v_line_bot uuid;
  v_post jsonb;
  v_overview jsonb;
  v_suggest jsonb;
  v_result jsonb;
  v_count integer;
  v_suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_case record;
begin
  ------------------------------------------------------------------
  -- (0) Shared stock_line_auto_non_stock case table
  ------------------------------------------------------------------
  for v_case in
    select * from (values
      ('Thuế VAT 8%', 'vat'),
      ('VAT', 'vat'),
      ('Thuế GTGT', 'vat'),
      ('Phí vận chuyển', 'fee'),
      ('Phụ phí giao hàng', 'fee'),
      ('Cước ship nội thành', 'fee'),
      ('Vận chuyển hàng', 'fee'),
      ('Xử lý côn trùng', 'service'),
      ('Phí phân tích mẫu', 'service'),
      ('Thuê máy', 'service'),
      ('Tỏi phi', null),
      ('Bánh mì lớn 17', null),
      ('Phô mai Dairymont', null),
      ('Ship hàng', 'fee'),
      ('Cước Rửa Chén TBP x 4 Miếng', null),
      ('Cước điện thoại_0966998998', 'fee'),
      ('Thuê nhà Q.7 T9/26', 'service')
    ) as t(raw_name, expected)
  loop
    if public.stock_line_auto_non_stock(v_case.raw_name) is distinct from v_case.expected then
      raise exception 'stock_line_auto_non_stock(%) must be %, got %',
        v_case.raw_name, v_case.expected, public.stock_line_auto_non_stock(v_case.raw_name);
    end if;
  end loop;

  ------------------------------------------------------------------
  -- Actors: real owner first; a non-admin editor only when one exists.
  ------------------------------------------------------------------
  select u.id into v_owner
  from auth.users u
  join public.user_roles r on r.user_id = u.id and r.role = 'owner'
  order by u.created_at
  limit 1;
  if v_owner is null then
    raise exception 'smoke requires at least one owner user';
  end if;
  perform set_config('request.jwt.claim.sub', v_owner::text, true);

  ------------------------------------------------------------------
  -- Fixtures: supplier, kitchen item, auto alias, confirmed receipt
  -- with a real line plus a fee line and a VAT line.
  ------------------------------------------------------------------
  insert into public.suppliers (name, default_receiving_location)
  values ('Smoke must-stock NCC ' || v_suffix, 'q7')
  returning id into v_supplier;

  insert into public.kitchen_inventory_items (item_code, normalized_key, item_type, name, unit)
  values ('SMOKE-MUST-' || v_suffix, 'smoke-must-' || v_suffix, 'ingredient', 'Tỏi bóc vỏ', 'kg')
  returning id into v_item;

  -- Cutover: only set when the store has not started, so the fixture posts.
  update public.stock_ledger_settings
  set q7_cutover_date = current_date - 365
  where id = 1 and q7_cutover_date is null;

  insert into public.stock_material_aliases
    (supplier_id, normalized_name, location, kitchen_inventory_item_id,
     conversion_factor, unit, created_by, status, confirm_count, line_class)
  values (v_supplier, 'toi', 'q7', v_item, 1, 'kg', v_owner, 'auto', 3, 'stock');

  insert into public.goods_receipts
    (receipt_number, receipt_date, supplier_id, status, receiving_location, payable_status)
  values ('SMOKE-MUST-GR-' || v_suffix, current_date - 5, v_supplier, 'draft', 'q7', 'not_generated')
  returning id into v_receipt;

  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, raw_product_name, quantity, actual_quantity, unit)
  values (v_receipt, 'Tỏi ngày 10', 'Tỏi ngày 10', 7, 7, 'kg')
  returning id into v_line_toi;

  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, raw_product_name, quantity, actual_quantity, unit)
  values (v_receipt, 'Phí vận chuyển', 'Phí vận chuyển', 1, 1, 'chuyến')
  returning id into v_line_fee;

  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, raw_product_name, quantity, actual_quantity, unit)
  values (v_receipt, 'Thuế VAT 8%', 'Thuế VAT 8%', 1, 1, '%')
  returning id into v_line_vat;

  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, raw_product_name, quantity, actual_quantity, unit)
  values (v_receipt, 'Bột mì', 'Bột mì', 5, 5, 'kg')
  returning id into v_line_bot;

  update public.goods_receipts set status = 'confirmed' where id = v_receipt;

  ------------------------------------------------------------------
  -- (1) post only writes the real line; fee and VAT are skipped and
  --     are not counted as pending.
  ------------------------------------------------------------------
  v_post := public.post_goods_receipt_to_stock(v_receipt);
  if (v_post ->> 'status') <> 'posted' then
    raise exception 'post must report posted, got %', v_post ->> 'status';
  end if;
  -- The goods_receipts trigger already posted the real line when the receipt was
  -- confirmed, so this explicit (idempotent) call writes 0 or 1 row; the ledger
  -- count below is the real check.
  if (v_post ->> 'posted_count')::int > 1 then
    raise exception 'post must write at most one line, got %', v_post ->> 'posted_count';
  end if;
  -- Only the real 'Bột mì' line (no alias yet) is pending; fee and VAT are not.
  if (v_post ->> 'pending_alias_count')::int <> 1 then
    raise exception 'only the Bột mì line may be pending, got %', v_post ->> 'pending_alias_count';
  end if;

  select count(*) into v_count from public.q7_inventory_movements
  where source = 'goods_receipt' and source_ref_key = 'gr-item:' || v_line_toi::text;
  if v_count <> 1 then
    raise exception 'the real line must post exactly once, found %', v_count;
  end if;
  for v_case in
    select * from (values (v_line_fee), (v_line_vat)) as t(item_id)
  loop
    select count(*) into v_count from public.q7_inventory_movements
    where source = 'goods_receipt' and source_ref_key = 'gr-item:' || v_case.item_id::text;
    if v_count <> 0 then
      raise exception 'a fee / VAT line must never post, found % rows', v_count;
    end if;
  end loop;

  ------------------------------------------------------------------
  -- (2) overview pending has neither the fee nor the VAT line
  ------------------------------------------------------------------
  v_overview := public.get_stock_ledger_overview('q7');
  if exists (
    select 1
    from jsonb_array_elements(v_overview -> 'pending_aliases') p
    where p ->> 'product_name' in ('Phí vận chuyển', 'Thuế VAT 8%')
  ) then
    raise exception 'fee / VAT lines must not appear in pending_aliases';
  end if;

  ------------------------------------------------------------------
  -- (3) suggest returns auto_non_stock for fee / VAT and still asks
  --     for a real line without an alias
  ------------------------------------------------------------------
  v_suggest := public.suggest_material_aliases(
    v_supplier, 'q7',
    jsonb_build_array(
      jsonb_build_object('line_key', 'fee', 'raw_name', 'Phí vận chuyển', 'raw_unit', null),
      jsonb_build_object('line_key', 'vat', 'raw_name', 'Thuế VAT 8%', 'raw_unit', null),
      jsonb_build_object('line_key', 'bot', 'raw_name', 'Bột mì smoke ' || v_suffix, 'raw_unit', 'kg')
    )
  );
  if (v_suggest -> 0 ->> 'needs_prompt')::boolean is not false then
    raise exception 'a fee line must not need a prompt';
  end if;
  if (v_suggest -> 0 -> 'auto_non_stock' ->> 'reason') <> 'fee'
     or (v_suggest -> 0 -> 'auto_non_stock' ->> 'source') <> 'rule' then
    raise exception 'a fee line must come back as a rule auto_non_stock, got %', v_suggest -> 0 -> 'auto_non_stock';
  end if;
  if jsonb_array_length(v_suggest -> 0 -> 'candidates') <> 0 then
    raise exception 'a rule line must have no candidates';
  end if;
  if (v_suggest -> 1 ->> 'needs_prompt')::boolean is not false then
    raise exception 'a VAT line must not need a prompt';
  end if;
  if (v_suggest -> 1 -> 'auto_non_stock' ->> 'reason') <> 'vat' then
    raise exception 'a VAT line must come back as vat, got %', v_suggest -> 1 -> 'auto_non_stock';
  end if;
  if (v_suggest -> 2 ->> 'needs_prompt')::boolean is not true then
    raise exception 'a real line without an alias must still need a prompt';
  end if;
  -- JSON null is not SQL NULL: compare its type.
  if coalesce(jsonb_typeof(v_suggest -> 2 -> 'auto_non_stock'), 'null') <> 'null' then
    raise exception 'a real line must have auto_non_stock null';
  end if;

  ------------------------------------------------------------------
  -- (4) confirming non_stock by hand needs an admin for a name the
  --     fixed rule does not classify; a rule name needs no admin.
  ------------------------------------------------------------------
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  select u.id into v_editor
  from auth.users u
  where public.material_alias_can_edit(u.id)
    and not public.material_alias_can_admin(u.id)
  order by u.created_at
  limit 1;

  if v_editor is not null then
    perform set_config('request.jwt.claim.sub', v_editor::text, true);
    begin
      perform public.confirm_material_alias(
        v_supplier, 'q7', 'Bột mì', 'kg', null, null, null, 1, null, null,
        'goods_receipt_items', v_line_bot, 'non_stock'
      );
      raise exception 'non_stock for Bột mì by a non-admin must be refused';
    exception
      when others then
        if sqlerrm <> 'non_stock_requires_admin' then
          raise exception 'expected non_stock_requires_admin, got %', sqlerrm;
        end if;
    end;

    -- A rule name (fee) needs no admin.
    perform set_config('request.jwt.claim.sub', v_editor::text, true);
    v_result := public.confirm_material_alias(
      v_supplier, 'q7', 'Phí giao hàng', 'chuyến', null, null, null, 1, null, null,
      'goods_receipt_items', v_line_fee, 'non_stock'
    );
    if (v_result -> 'alias' ->> 'line_class') <> 'non_stock' then
      raise exception 'a fee line must be confirmable as non_stock by a normal editor';
    end if;
  else
    raise notice 'no non-admin editor found: skip the non_stock admin gate check';
  end if;

  -- The owner may mark a non-rule name as non_stock.
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  v_result := public.confirm_material_alias(
    v_supplier, 'q7', 'Bột mì', 'kg', null, null, null, 1, null, null,
    'goods_receipt_items', v_line_bot, 'non_stock'
  );
  if (v_result -> 'alias' ->> 'line_class') <> 'non_stock' then
    raise exception 'the owner must be allowed to mark Bột mì as non_stock';
  end if;

  raise notice 'purchase must stock smoke passed';
end;
$smoke$;

rollback;
