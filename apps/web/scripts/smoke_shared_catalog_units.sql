-- Smoke test for migration 20261022100000_shared_catalog_units.sql.
-- Runs entirely inside BEGIN ... ROLLBACK so it never keeps fixtures.
--
-- Prerequisites (real data only):
--   * migration 20261022100000 applied (or prepended in the same transaction)
--   * at least one public.user_roles row with role 'owner' (not needed as service)
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/smoke_shared_catalog_units.sql
-- or (migration in the same transaction, rolled back):
--   { echo begin; cat migration; cat this file without begin/rollback; echo rollback; } | supabase db query --linked
--
-- It reports:
--   * items outside the standard unit table (must be 0)
--   * Tân Tạo pending names with an NVL candidate before (SKU-only) and after
--   * the 60-day document `unit` backfill updated / blocked counts
--   * the sum of the three document line totals before and after the unit trigger
--   * a real Tân Tạo NVL ledger write, appends only, on a temporary cutover date

begin;

select set_config('request.jwt.claim.role', 'service_role', true);

create temp table _smoke_shared_catalog (
  metric text primary key,
  value text not null
) on commit drop;

do $smoke$
declare
  v_outside integer;
  v_bf record;
  v_po_before numeric; v_pr_before numeric; v_gr_before numeric;
  v_po_after numeric; v_pr_after numeric; v_gr_after numeric;
  v_tt_before integer;
  v_tt_after integer;
  v_tt_total integer;
  v_item uuid;
  v_name text := 'NVL smoke ' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_supplier uuid;
  v_receipt uuid;
  v_receipt_item uuid;
  v_alias jsonb;
  v_moves integer;
  v_cutover_saved date;
  v_probe integer;
  v_entry jsonb;
begin
  -- (1) no live item may keep a unit outside the standard table.
  select count(*) into v_outside
  from public.kitchen_inventory_items k
  where k.active = true and k.merged_into_id is null and public.normalize_stock_unit(k.unit) is null;
  insert into _smoke_shared_catalog(metric, value)
  values ('items_outside_standard', v_outside::text);
  if v_outside <> 0 then
    raise exception 'SMOKE_FAIL items_outside_standard=%', v_outside;
  end if;

  -- (2) sum of the three document line totals before the unit trigger runs.
  select coalesce(sum(coalesce(line_total, coalesce(quantity, 0) * coalesce(unit_price, 0))), 0)
    into v_po_before from public.purchase_order_items;
  select coalesce(sum(coalesce(line_total, coalesce(quantity, 0) * coalesce(unit_price, 0))), 0)
    into v_pr_before from public.payment_request_items;
  select coalesce(sum(coalesce(quantity, 0) * coalesce(unit_price, 0)), 0)
    into v_gr_before from public.goods_receipt_items;

  -- Drive the unit trigger on real, evidence-free lines and prove the totals do
  -- not move; the trigger only ever writes `unit`.
  update public.purchase_order_items i
    set unit = 'KG', line_total = i.line_total
    where i.id in (
      select x.id
      from public.purchase_order_items x
      where x.unit is not null
        and public.normalize_stock_unit(x.unit) is not null
        and public.normalize_stock_unit(x.unit) <> x.unit
        and not public.procurement_line_has_material_evidence(to_jsonb(x))
      limit 3
    );

  select coalesce(sum(coalesce(line_total, coalesce(quantity, 0) * coalesce(unit_price, 0))), 0)
    into v_po_after from public.purchase_order_items;
  select coalesce(sum(coalesce(line_total, coalesce(quantity, 0) * coalesce(unit_price, 0))), 0)
    into v_pr_after from public.payment_request_items;
  select coalesce(sum(coalesce(quantity, 0) * coalesce(unit_price, 0)), 0)
    into v_gr_after from public.goods_receipt_items;

  insert into _smoke_shared_catalog(metric, value)
  values ('line_total_po_before', v_po_before::text),
         ('line_total_pr_before', v_pr_before::text),
         ('line_total_gr_before', v_gr_before::text),
         ('line_total_po_after', v_po_after::text),
         ('line_total_pr_after', v_pr_after::text),
         ('line_total_gr_after', v_gr_after::text);
  if v_po_before <> v_po_after or v_pr_before <> v_pr_after or v_gr_before <> v_gr_after then
    raise exception 'SMOKE_FAIL line totals changed: po % -> %, pr % -> %, gr % -> %',
      v_po_before, v_po_after, v_pr_before, v_pr_after, v_gr_before, v_gr_after;
  end if;

  -- (3) 60-day `unit` backfill counts recorded by the migration.
  select * into v_bf from public.stock_unit_backfill_runs order by created_at desc limit 1;
  insert into _smoke_shared_catalog(metric, value)
  values ('backfill_days', coalesce(v_bf.days, 0)::text),
         ('backfill_updated', coalesce(v_bf.updated, 0)::text),
         ('backfill_blocked', coalesce(v_bf.blocked, 0)::text);

  -- (4) Tân Tạo pending names: the old catalog could only offer a SKU (before),
  -- the shared catalog also offers a kitchen_inventory_items NVL item (after).
  select count(*) into v_tt_total
  from public.get_material_alias_backlog_review('tan_tao', 500);
  select count(*) into v_tt_before
  from public.get_material_alias_backlog_review('tan_tao', 500) r
  where r.top_candidate ->> 'sku_id' is not null;
  select count(*) into v_tt_after
  from public.get_material_alias_backlog_review('tan_tao', 500) r
  where r.top_candidate ->> 'item_id' is not null;

  insert into _smoke_shared_catalog(metric, value)
  values ('tan_tao_pending_names', v_tt_total::text),
         ('tan_tao_pending_sku_only_before', v_tt_before::text),
         ('tan_tao_pending_nvl_after', v_tt_after::text);

  -- (5) Tân Tạo NVL ledger: create a shared item, a Tân Tạo receipt line and a
  -- confirmed alias, then prove the append-only movement was written.
  v_entry := public.create_stock_material_item(v_name, 'Kg', 'tan_tao', gen_random_uuid());
  v_item := nullif(v_entry ->> 'item_id', '')::uuid;
  if v_item is null then
    raise exception 'SMOKE_FAIL create_stock_material_item returned no item';
  end if;
  if (select unit from public.kitchen_inventory_items where id = v_item) <> 'g' then
    raise exception 'SMOKE_FAIL create_stock_material_item did not normalize Kg -> g';
  end if;

  select s.tan_tao_cutover_date into v_cutover_saved
  from public.stock_ledger_settings s where s.id = 1;
  update public.stock_ledger_settings
    set tan_tao_cutover_date = current_date - 30
    where id = 1;

  insert into public.goods_receipts (receipt_number, receipt_date, status, receiving_location)
  values ('SMOKE-TT-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
          current_date, 'received', 'tan_tao')
  returning id into v_receipt;

  insert into public.goods_receipt_items (goods_receipt_id, product_name, raw_product_name, quantity, unit)
  values (v_receipt, v_name, v_name, 3, 'Kg')
  returning id into v_receipt_item;

  -- The document trigger fixes the spelling only: 'Kg' stays a kilogram line.
  if (select unit from public.goods_receipt_items where id = v_receipt_item) <> 'kg' then
    raise exception 'SMOKE_FAIL receipt line unit was not normalized';
  end if;

  v_alias := public.confirm_material_alias(
    p_supplier_id => null,
    p_location => 'tan_tao',
    p_raw_name => v_name,
    p_raw_unit => 'Kg',
    p_kitchen_inventory_item_id => v_item,
    p_tan_tao_sku_id => null,
    p_entered_unit_label => null,
    p_conversion_factor => 7,
    p_jev_item_id => null,
    p_jev_probability => null,
    p_source_table => 'smoke_shared_catalog_units',
    p_source_id => v_receipt_item,
    p_line_class => 'stock'
  );

  select count(*) into v_moves
  from public.tan_tao_material_movements m
  where m.source = 'goods_receipt'
    and m.source_ref_key = 'gr-item:' || v_receipt_item::text
    and m.kitchen_inventory_item_id = v_item;
  if v_moves <> 1 then
    raise exception 'SMOKE_FAIL Tân Tạo NVL movement missing (got %), alias=%', v_moves, v_alias;
  end if;
  -- A kg line converts by its own unit (3 kg = 3000 g) whatever the alias factor says.
  if (select m.quantity from public.tan_tao_material_movements m
      where m.source_ref_key = 'gr-item:' || v_receipt_item::text) <> 3000 then
    raise exception 'SMOKE_FAIL 3 kg must post 3000 g';
  end if;
  insert into _smoke_shared_catalog(metric, value)
  values ('tan_tao_nvl_movement_written', v_moves::text);

  -- The Tân Tạo NVL ledger is append-only.
  v_probe := 0;
  begin
    update public.tan_tao_material_movements set quantity = quantity + 1
    where source_ref_key = 'gr-item:' || v_receipt_item::text;
    v_probe := 1;
  exception when others then
    v_probe := 0;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_FAIL Tân Tạo NVL movement was updatable';
  end if;

  -- The standard-unit trigger refuses an unknown unit.
  v_probe := 0;
  begin
    update public.kitchen_inventory_items set unit = 'PACK' where id = v_item;
    v_probe := 1;
  exception when others then
    if sqlerrm not like '%unit_not_allowed%' then
      raise;
    end if;
  end;
  if v_probe <> 0 then
    raise exception 'SMOKE_FAIL unknown unit was accepted';
  end if;

  update public.stock_ledger_settings
    set tan_tao_cutover_date = v_cutover_saved
    where id = 1;

  -- (6) the unknown-unit RPC is callable.
  select count(*) into v_probe from public.list_unknown_purchase_units(60);
  insert into _smoke_shared_catalog(metric, value)
  values ('unknown_unit_rows', v_probe::text);
end;
$smoke$;

select metric, value from _smoke_shared_catalog order by metric;

rollback;
