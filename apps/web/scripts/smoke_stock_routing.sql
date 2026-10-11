-- Smoke test for stock routing (Giai đoạn 3 data layer).
-- Runs entirely inside BEGIN ... ROLLBACK so it never keeps fixtures.
-- Prerequisites (real data only, never created by this script):
--   * the 20261017100000_stock_routing.sql migration applied
--   * at least one public.user_roles row with role 'owner'
-- Run with:  psql "$DATABASE_URL" -f scripts/smoke_stock_routing.sql
--
-- Scenarios:
--   A: raw material, 1 confirmed receipt with no warehouse, 1 line aliased to Q7
--   B: bread/pate supplier -> rule_hint 'tan_tao'
--   C: service supplier   -> rule_hint 'non_stock'

begin;

select set_config('request.jwt.claim.role', 'service_role', true);

do $smoke$
declare
  v_actor uuid;
  v_supplier_a uuid;
  v_supplier_b uuid;
  v_supplier_c uuid;
  v_item uuid;
  v_receipt_a uuid;
  v_line_a1 uuid;
  v_line_a2 uuid;
  v_receipt_b uuid;
  v_receipt_c uuid;
  v_line_c uuid;
  v_alias uuid;
  v_suggestion_a uuid;
  v_suggestion_c uuid;
  v_material uuid;
  v_cat_suggestion uuid;
  v_evidence jsonb;
  v_result jsonb;
  v_review jsonb;
  v_overview jsonb;
  v_suggest jsonb;
  v_count integer;
  v_status text;
  v_loc text;
  v_exempt boolean;
  v_suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
begin
  ------------------------------------------------------------------
  -- Actor and cutover (only started when the store has not started).
  ------------------------------------------------------------------
  select u.id into v_actor
  from auth.users u
  join public.user_roles r on r.user_id = u.id and r.role = 'owner'
  order by u.created_at
  limit 1;
  if v_actor is null then
    raise exception 'smoke requires at least one owner user';
  end if;
  perform set_config('request.jwt.claim.sub', v_actor::text, true);

  update public.stock_ledger_settings
  set q7_cutover_date = coalesce(q7_cutover_date, current_date - 365),
      tan_tao_cutover_date = coalesce(tan_tao_cutover_date, current_date - 365)
  where id = 1;

  ------------------------------------------------------------------
  -- Fixtures
  ------------------------------------------------------------------
  insert into public.kitchen_inventory_items (item_code, normalized_key, item_type, name, unit)
  values ('SMOKE-ROUTE-' || v_suffix, 'smoke-route-' || v_suffix, 'ingredient', 'Bột mì smoke', 'kg')
  returning id into v_item;

  -- A: raw material, one confirmed receipt with no warehouse.
  insert into public.suppliers (name) values ('Smoke route A ' || v_suffix) returning id into v_supplier_a;
  insert into public.goods_receipts (receipt_number, receipt_date, supplier_id, status, payable_status)
  values ('SMOKE-RA-' || v_suffix, current_date - 5, v_supplier_a, 'draft', 'not_generated')
  returning id into v_receipt_a;
  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, raw_product_name, quantity, actual_quantity, unit)
  values (v_receipt_a, 'Bột mì 888', 'Bột mì 888', 10, 10, 'kg')
  returning id into v_line_a1;
  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, raw_product_name, quantity, actual_quantity, unit)
  values (v_receipt_a, 'Phí vận chuyển', 'Phí vận chuyển', 1, 1, 'lần')
  returning id into v_line_a2;
  update public.goods_receipts set status = 'confirmed' where id = v_receipt_a;

  -- A already has a Q7 alias for one line.
  insert into public.stock_material_aliases
    (supplier_id, normalized_name, location, kitchen_inventory_item_id, conversion_factor, unit,
     created_by, line_class, status, confirm_count)
  values (v_supplier_a, public.normalize_stock_item_name('Bột mì 888'), 'q7', v_item, 1, 'kg',
          v_actor, 'stock', 'auto', 3)
  returning id into v_alias;

  -- B: bread / pate supplier.
  insert into public.suppliers (name) values ('Smoke route B ' || v_suffix) returning id into v_supplier_b;
  insert into public.goods_receipts (receipt_number, receipt_date, supplier_id, status, payable_status)
  values ('SMOKE-RB-' || v_suffix, current_date - 5, v_supplier_b, 'draft', 'not_generated')
  returning id into v_receipt_b;
  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, raw_product_name, quantity, actual_quantity, unit)
  values (v_receipt_b, 'Bánh mì tươi', 'Bánh mì tươi', 100, 100, 'que'),
         (v_receipt_b, 'Pate 500g', 'Pate 500g', 10, 10, 'hộp');
  update public.goods_receipts set status = 'confirmed' where id = v_receipt_b;

  -- C: service supplier, with a warehouse that must be ignored after exempt.
  insert into public.suppliers (name) values ('Smoke route C ' || v_suffix) returning id into v_supplier_c;
  insert into public.goods_receipts (receipt_number, receipt_date, supplier_id, status, payable_status, receiving_location)
  values ('SMOKE-RC-' || v_suffix, current_date - 5, v_supplier_c, 'draft', 'not_generated', 'q7')
  returning id into v_receipt_c;
  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, raw_product_name, quantity, actual_quantity, unit)
  values (v_receipt_c, 'Phí vận chuyển', 'Phí vận chuyển', 1, 1, 'lần')
  returning id into v_line_c;
  update public.goods_receipts set status = 'confirmed' where id = v_receipt_c;

  ------------------------------------------------------------------
  -- (1) rule_hint for A / B / C
  ------------------------------------------------------------------
  v_evidence := public.supplier_routing_evidence(v_supplier_a);
  if v_evidence ->> 'rule_hint' is distinct from 'q7' then
    raise exception 'A rule_hint must be q7, got %', v_evidence ->> 'rule_hint';
  end if;
  v_evidence := public.supplier_routing_evidence(v_supplier_b);
  if v_evidence ->> 'rule_hint' is distinct from 'tan_tao' then
    raise exception 'B rule_hint must be tan_tao, got %', v_evidence ->> 'rule_hint';
  end if;
  v_evidence := public.supplier_routing_evidence(v_supplier_c);
  if v_evidence ->> 'rule_hint' is distinct from 'non_stock' then
    raise exception 'C rule_hint must be non_stock, got %', v_evidence ->> 'rule_hint';
  end if;

  ------------------------------------------------------------------
  -- (2) apply_supplier_routing(A,'q7','jev') fills the old receipt and posts the
  -- aliased line once; the unaliased line stays pending.
  ------------------------------------------------------------------
  v_evidence := public.supplier_routing_evidence(v_supplier_a);
  insert into public.supplier_routing_suggestions
    (supplier_id, proposed_location, probability, evidence, prompt_version, status)
  values (v_supplier_a, 'q7', 0.95, v_evidence, 'smoke-routing-a', 'pending')
  returning id into v_suggestion_a;

  v_result := public.apply_supplier_routing(v_supplier_a, 'q7', 'jev', v_suggestion_a);
  if (v_result ->> 'receipts_filled')::int < 1 then
    raise exception 'apply must fill at least one old receipt';
  end if;
  select gr.receiving_location into v_status from public.goods_receipts gr where gr.id = v_receipt_a;
  if v_status is distinct from 'q7' then
    raise exception 'A receipt must be routed to q7, got %', v_status;
  end if;

  select count(*) into v_count
  from public.q7_inventory_movements
  where source = 'goods_receipt' and source_ref_key = 'gr-item:' || v_line_a1::text;
  if v_count <> 1 then
    raise exception 'aliased line must post exactly once, found %', v_count;
  end if;

  v_overview := public.get_stock_ledger_overview('q7');
  if not exists (
    select 1 from jsonb_array_elements(v_overview -> 'pending_aliases') e
    where e ->> 'goods_receipt_item_id' = v_line_a2::text
  ) then
    raise exception 'unaliased line must stay pending';
  end if;

  ------------------------------------------------------------------
  -- (3) apply_supplier_routing(C,'non_stock','jev') exempts supplier C.
  ------------------------------------------------------------------
  v_evidence := public.supplier_routing_evidence(v_supplier_c);
  insert into public.supplier_routing_suggestions
    (supplier_id, proposed_location, probability, evidence, prompt_version, status)
  values (v_supplier_c, 'non_stock', 0.95, v_evidence, 'smoke-routing-c', 'pending')
  returning id into v_suggestion_c;

  v_result := public.apply_supplier_routing(v_supplier_c, 'non_stock', 'jev', v_suggestion_c);
  select s.stock_exempt, s.default_receiving_location into v_exempt, v_loc
  from public.suppliers s where s.id = v_supplier_c;
  if v_exempt is distinct from true or v_loc is not null then
    raise exception 'C must be stock_exempt with no default location';
  end if;

  v_result := public.post_goods_receipt_to_stock(v_receipt_c);
  if v_result ->> 'status' is distinct from 'supplier_exempt' then
    raise exception 'exempt supplier must post nothing, got %', v_result ->> 'status';
  end if;

  v_overview := public.get_stock_ledger_overview('q7');
  if exists (
    select 1 from jsonb_array_elements(v_overview -> 'pending_aliases') e
    where e ->> 'goods_receipt_item_id' = v_line_c::text
  ) then
    raise exception 'exempt supplier receipt must not be pending';
  end if;

  ------------------------------------------------------------------
  -- (4) confirm a non_stock alias: no post, leaves pending, suggest says non_stock
  ------------------------------------------------------------------
  v_result := public.confirm_material_alias(
    v_supplier_a, 'q7', 'Phí vận chuyển', 'lần', null, null, 'lần', 1,
    null, null, 'goods_receipt_items', v_line_a2, 'non_stock'
  );
  if v_result -> 'alias' ->> 'line_class' is distinct from 'non_stock' then
    raise exception 'confirm must store line_class non_stock';
  end if;
  if public.stock_goods_receipt_item_is_posted(v_line_a2) then
    raise exception 'a non_stock alias must never post';
  end if;

  v_overview := public.get_stock_ledger_overview('q7');
  if exists (
    select 1 from jsonb_array_elements(v_overview -> 'pending_aliases') e
    where e ->> 'goods_receipt_item_id' = v_line_a2::text
  ) then
    raise exception 'a non_stock alias must leave the pending list';
  end if;

  v_suggest := public.suggest_material_aliases(
    v_supplier_a, 'q7',
    jsonb_build_array(jsonb_build_object('line_key', 'l2', 'raw_name', 'Phí vận chuyển', 'raw_unit', 'lần'))
  );
  if v_suggest -> 0 -> 'alias' ->> 'line_class' is distinct from 'non_stock' then
    raise exception 'suggest must return alias.line_class non_stock';
  end if;

  ------------------------------------------------------------------
  -- (5) revert_supplier_routing restores the previous warehouse.
  ------------------------------------------------------------------
  v_result := public.revert_supplier_routing(v_suggestion_a);
  if v_result ->> 'status' is distinct from 'reverted' then
    raise exception 'revert must return status reverted';
  end if;
  select s.default_receiving_location, s.stock_exempt into v_loc, v_exempt
  from public.suppliers s where s.id = v_supplier_a;
  if v_loc is not null or v_exempt is distinct from false then
    raise exception 'revert must restore A to no warehouse, not exempt';
  end if;

  ------------------------------------------------------------------
  -- (6) decide_material_category approve + revert
  ------------------------------------------------------------------
  insert into public.sku_cogs_materials
    (material_code, canonical_name, normalized_name, default_unit, category)
  values ('SMOKE-MAT-' || v_suffix, 'Bột mì smoke ' || v_suffix, 'bot mi smoke ' || v_suffix, 'kg', null)
  returning id into v_material;

  insert into public.material_category_suggestions
    (material_id, proposed_category, probability, prompt_version, status)
  values (v_material, 'flour', 0.9, 'smoke-routing-mat', 'pending')
  returning id into v_cat_suggestion;

  v_result := public.decide_material_category(v_cat_suggestion, 'approve');
  if v_result ->> 'category' is distinct from 'flour' then
    raise exception 'material category must be flour';
  end if;
  select m.category into v_status from public.sku_cogs_materials m where m.id = v_material;
  if v_status is distinct from 'flour' then
    raise exception 'approve must write sku_cogs_materials.category';
  end if;

  v_result := public.revert_material_category(v_cat_suggestion);
  select m.category into v_status from public.sku_cogs_materials m where m.id = v_material;
  if v_status is not null then
    raise exception 'revert must restore the previous (null) category';
  end if;

  ------------------------------------------------------------------
  -- (7) get_stock_routing_review returns every block
  ------------------------------------------------------------------
  v_review := public.get_stock_routing_review();
  if not (v_review ? 'supplier_pending'
          and v_review ? 'supplier_recent'
          and v_review ? 'supplier_counts'
          and v_review ? 'material_pending'
          and v_review ? 'material_category_counts'
          and v_review ? 'categories'
          and v_review ? 'jev_usage') then
    raise exception 'get_stock_routing_review is missing a block';
  end if;

  raise notice 'stock routing smoke passed';
end;
$smoke$;

rollback;
