-- Rollback-only smoke checks for 20261121150000_dealer_heo_dat_tet.sql.
--
-- Run after the migration inside one transaction. Every fixture is rolled back
-- at the end; no real order, customer or spin is kept. Seeding uses
-- session_replication_role=replica, like the other superuser-only smoke tests.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/migrations/20261121150000_dealer_heo_dat_tet.sql \
--     -f supabase/tests/dealer_heo_dat_tet_smoke.sql

begin;

-- Fixture rows include a test order without a test contact. Seeding as replica
-- bypasses the production contact -> order is_test trigger; the setting is
-- transaction-local and is rolled back with the fixtures.
set local session_replication_role = replica;

do $$
declare
  v_campaign uuid;
  v_customer uuid;
  v_customer_zero uuid;
  v_sku uuid;
  v_order_main uuid;
  v_order_below uuid;
  v_order_outside uuid;
  v_order_real uuid;
  v_order_test uuid;
  v_order_zero uuid;
  v_order_budget_a uuid;
  v_order_budget_b uuid;
  v_order_no_jackpot uuid;
  v_order_jackpot_seed uuid;
  v_order_jackpot_extra uuid;
  v_order_week_check uuid;
  v_result jsonb;
  v_second jsonb;
  v_error text;
  v_count integer;
  v_baseline numeric;
  v_week text;
  v_seed double precision;
  v_next double precision;
  v_i integer;
begin
  select id into v_campaign
  from public.dealer_heo_campaigns
  where code = 'heo-tet-2026';

  if v_campaign is null then
    raise exception 'SMOKE FAIL campaign heo-tet-2026 is missing';
  end if;

  select id into v_sku
  from public.product_skus
  where sku_code = 'BMQ-001'
  limit 1;

  if v_sku is null then
    insert into public.product_skus (
      sku_code, product_name, unit, sku_type, unit_price, hide_from_dealer_portal
    ) values (
      'BMQ-001', 'SMOKE Bánh mì que', 'que', 'finished_good', 5000, false
    )
    returning id into v_sku;
  end if;

  insert into public.mini_crm_customers (
    customer_name, customer_group, product_group, is_active, order_locked
  ) values (
    'SMOKE Heo Đất Tết', 'banhmi_agency', 'banhmi', true, false
  ) returning id into v_customer;

  insert into public.mini_crm_customers (
    customer_name, customer_group, product_group, is_active, order_locked
  ) values (
    'SMOKE Heo Đất Tết baseline 0', 'banhmi_agency', 'banhmi', true, false
  ) returning id into v_customer_zero;

  -- November baseline: 40 + 20 que here, plus the 5-que 30/11 order below = 65 / 30.
  insert into public.dealer_orders (
    order_number, customer_id, status, requested_delivery_date, submitted_at, is_test
  ) values (
    'SMOKE-HEO-NOV-A-' || substr(md5(random()::text), 1, 8),
    v_customer, 'submitted', date '2026-11-05', timestamptz '2026-11-04 09:00:00+07', false
  ) returning id into v_order_main;
  insert into public.dealer_order_items (
    order_id, sku_id, sku_code, product_name, unit, quantity, unit_price_vnd, line_total_vnd
  ) values (
    v_order_main, v_sku, 'BMQ-001', 'SMOKE Bánh mì que', 'que', 40, 5000, 200000
  );

  insert into public.dealer_orders (
    order_number, customer_id, status, requested_delivery_date, submitted_at, is_test
  ) values (
    'SMOKE-HEO-NOV-B-' || substr(md5(random()::text), 1, 8),
    v_customer, 'submitted', date '2026-11-20', timestamptz '2026-11-19 09:00:00+07', false
  ) returning id into v_order_below;
  insert into public.dealer_order_items (
    order_id, sku_id, sku_code, product_name, unit, quantity, unit_price_vnd, line_total_vnd
  ) values (
    v_order_below, v_sku, 'BMQ-001', 'SMOKE Bánh mì que', 'que', 20, 5000, 100000
  );

  -- Main real order for the idempotency check.
  insert into public.dealer_orders (
    order_number, customer_id, status, requested_delivery_date, submitted_at, is_test
  ) values (
    'SMOKE-HEO-MAIN-' || substr(md5(random()::text), 1, 8),
    v_customer, 'submitted', date '2026-12-05', timestamptz '2026-12-04 09:00:00+07', false
  ) returning id into v_order_main;
  insert into public.dealer_order_items (
    order_id, sku_id, sku_code, product_name, unit, quantity, unit_price_vnd, line_total_vnd
  ) values (
    v_order_main, v_sku, 'BMQ-001', 'SMOKE Bánh mì que', 'que', 5, 5000, 25000
  );

  -- Below the 2/day baseline.
  insert into public.dealer_orders (
    order_number, customer_id, status, requested_delivery_date, submitted_at, is_test
  ) values (
    'SMOKE-HEO-BELOW-' || substr(md5(random()::text), 1, 8),
    v_customer, 'submitted', date '2026-12-06', timestamptz '2026-12-05 09:00:00+07', false
  ) returning id into v_order_below;
  insert into public.dealer_order_items (
    order_id, sku_id, sku_code, product_name, unit, quantity, unit_price_vnd, line_total_vnd
  ) values (
    v_order_below, v_sku, 'BMQ-001', 'SMOKE Bánh mì que', 'que', 1, 5000, 5000
  );

  -- Outside the December window.
  insert into public.dealer_orders (
    order_number, customer_id, status, requested_delivery_date, submitted_at, is_test
  ) values (
    'SMOKE-HEO-OUTSIDE-' || substr(md5(random()::text), 1, 8),
    v_customer, 'submitted', date '2026-11-30', timestamptz '2026-11-29 09:00:00+07', false
  ) returning id into v_order_outside;
  insert into public.dealer_order_items (
    order_id, sku_id, sku_code, product_name, unit, quantity, unit_price_vnd, line_total_vnd
  ) values (
    v_order_outside, v_sku, 'BMQ-001', 'SMOKE Bánh mì que', 'que', 5, 5000, 25000
  );

  -- Eligible real order used while spin_enabled is still false.
  insert into public.dealer_orders (
    order_number, customer_id, status, requested_delivery_date, submitted_at, is_test
  ) values (
    'SMOKE-HEO-REAL-' || substr(md5(random()::text), 1, 8),
    v_customer, 'submitted', date '2026-12-07', timestamptz '2026-12-06 09:00:00+07', false
  ) returning id into v_order_real;
  insert into public.dealer_order_items (
    order_id, sku_id, sku_code, product_name, unit, quantity, unit_price_vnd, line_total_vnd
  ) values (
    v_order_real, v_sku, 'BMQ-001', 'SMOKE Bánh mì que', 'que', 5, 5000, 25000
  );

  -- Test order: allowed by the test window from 2026-11-01.
  insert into public.dealer_orders (
    order_number, customer_id, status, requested_delivery_date, submitted_at, is_test
  ) values (
    'SMOKE-HEO-TEST-' || substr(md5(random()::text), 1, 8),
    v_customer, 'submitted', date '2026-11-02', timestamptz '2026-11-01 09:00:00+07', true
  ) returning id into v_order_test;
  insert into public.dealer_order_items (
    order_id, sku_id, sku_code, product_name, unit, quantity, unit_price_vnd, line_total_vnd
  ) values (
    v_order_test, v_sku, 'BMQ-001', 'SMOKE Bánh mì que', 'que', 5, 5000, 25000
  );

  -- Zero-baseline customer: one que is enough to spin.
  insert into public.dealer_orders (
    order_number, customer_id, status, requested_delivery_date, submitted_at, is_test
  ) values (
    'SMOKE-HEO-ZERO-' || substr(md5(random()::text), 1, 8),
    v_customer_zero, 'submitted', date '2026-12-05', timestamptz '2026-12-04 09:00:00+07', false
  ) returning id into v_order_zero;
  insert into public.dealer_order_items (
    order_id, sku_id, sku_code, product_name, unit, quantity, unit_price_vnd, line_total_vnd
  ) values (
    v_order_zero, v_sku, 'BMQ-001', 'SMOKE Bánh mì que', 'que', 1, 5000, 5000
  );

  -- Budget and weekly-jackpot fixtures.
  insert into public.dealer_orders (
    order_number, customer_id, status, requested_delivery_date, submitted_at, is_test
  ) values
    ('SMOKE-HEO-BUDGET-A-' || substr(md5(random()::text), 1, 8), v_customer, 'submitted', date '2026-12-08', timestamptz '2026-12-07 09:00:00+07', false),
    ('SMOKE-HEO-BUDGET-B-' || substr(md5(random()::text), 1, 8), v_customer, 'submitted', date '2026-12-09', timestamptz '2026-12-08 09:00:00+07', false),
    ('SMOKE-HEO-JACKPOT-A-' || substr(md5(random()::text), 1, 8), v_customer, 'submitted', date '2026-12-10', timestamptz '2026-12-09 09:00:00+07', false),
    ('SMOKE-HEO-JACKPOT-B-' || substr(md5(random()::text), 1, 8), v_customer, 'submitted', date '2026-12-11', timestamptz '2026-12-10 09:00:00+07', false),
    ('SMOKE-HEO-NOJACKPOT-' || substr(md5(random()::text), 1, 8), v_customer, 'submitted', date '2026-12-12', timestamptz '2026-12-11 09:00:00+07', false),
    ('SMOKE-HEO-CHECK-' || substr(md5(random()::text), 1, 8), v_customer, 'submitted', date '2026-12-13', timestamptz '2026-12-12 09:00:00+07', false);

  select id into v_order_budget_a from public.dealer_orders where order_number like 'SMOKE-HEO-BUDGET-A-%' order by created_at desc limit 1;
  select id into v_order_budget_b from public.dealer_orders where order_number like 'SMOKE-HEO-BUDGET-B-%' order by created_at desc limit 1;
  select id into v_order_jackpot_seed from public.dealer_orders where order_number like 'SMOKE-HEO-JACKPOT-A-%' order by created_at desc limit 1;
  select id into v_order_jackpot_extra from public.dealer_orders where order_number like 'SMOKE-HEO-JACKPOT-B-%' order by created_at desc limit 1;
  select id into v_order_no_jackpot from public.dealer_orders where order_number like 'SMOKE-HEO-NOJACKPOT-%' order by created_at desc limit 1;
  select id into v_order_week_check from public.dealer_orders where order_number like 'SMOKE-HEO-CHECK-%' order by created_at desc limit 1;

  insert into public.dealer_order_items (
    order_id, sku_id, sku_code, product_name, unit, quantity, unit_price_vnd, line_total_vnd
  ) values
    (v_order_budget_a, v_sku, 'BMQ-001', 'SMOKE Bánh mì que', 'que', 5, 5000, 25000),
    (v_order_budget_b, v_sku, 'BMQ-001', 'SMOKE Bánh mì que', 'que', 5, 5000, 25000),
    (v_order_jackpot_seed, v_sku, 'BMQ-001', 'SMOKE Bánh mì que', 'que', 5, 5000, 25000),
    (v_order_jackpot_extra, v_sku, 'BMQ-001', 'SMOKE Bánh mì que', 'que', 5, 5000, 25000),
    (v_order_no_jackpot, v_sku, 'BMQ-001', 'SMOKE Bánh mì que', 'que', 5, 5000, 25000),
    (v_order_week_check, v_sku, 'BMQ-001', 'SMOKE Bánh mì que', 'que', 5, 5000, 25000);

  -- -------------------------------------------------------------------------
  -- Baselines
  -- -------------------------------------------------------------------------
  v_count := public.dealer_heo_compute_baselines(v_campaign);
  if v_count < 2 then
    raise exception 'SMOKE FAIL compute_baselines returned % rows', v_count;
  end if;

  select baseline_avg_per_day into v_baseline
  from public.dealer_heo_baselines
  where campaign_id = v_campaign and customer_id = v_customer;
  -- November orders: 40 + 20 + 5 (the 30/11 'outside' order) = 65 que / 30.
  if v_baseline is null or abs(v_baseline - 65.0 / 30) > 0.000001 then
    raise exception 'SMOKE FAIL main baseline expected 65/30, got %', v_baseline;
  end if;

  select baseline_avg_per_day into v_baseline
  from public.dealer_heo_baselines
  where campaign_id = v_campaign and customer_id = v_customer_zero;
  if v_baseline is null or v_baseline <> 0 then
    raise exception 'SMOKE FAIL zero baseline expected 0, got %', v_baseline;
  end if;

  -- -------------------------------------------------------------------------
  -- Real dealer is blocked while spin_enabled = false.
  -- -------------------------------------------------------------------------
  update public.dealer_heo_campaigns set spin_enabled = false where id = v_campaign;

  v_error := null;
  begin
    perform public.dealer_heo_spin(
      v_campaign, v_customer, v_order_real, false, date '2026-12-01', date '2026-12-31'
    );
  exception when others then
    v_error := sqlerrm;
  end;
  if v_error is null or position('heo_spin_disabled' in v_error) = 0 then
    raise exception 'SMOKE FAIL spin_disabled expected, got %', coalesce(v_error, '<no error>');
  end if;

  -- A test order can spin while the real spin switch is off.
  v_result := public.dealer_heo_spin(
    v_campaign, v_customer, v_order_test, true, date '2026-11-01', date '2026-12-31'
  );
  if (v_result->>'order_id')::uuid <> v_order_test or (v_result->>'is_test')::boolean is not true then
    raise exception 'SMOKE FAIL test spin returned %', v_result;
  end if;

  update public.dealer_heo_campaigns set spin_enabled = true where id = v_campaign;

  -- -------------------------------------------------------------------------
  -- Idempotency, thresholds and windows.
  -- -------------------------------------------------------------------------
  v_result := public.dealer_heo_spin(
    v_campaign, v_customer, v_order_main, false, date '2026-12-01', date '2026-12-31'
  );
  v_second := public.dealer_heo_spin(
    v_campaign, v_customer, v_order_main, false, date '2026-12-01', date '2026-12-31'
  );
  if v_result->>'id' is distinct from v_second->>'id'
     or v_result->>'prize_key' is distinct from v_second->>'prize_key'
     or v_result->>'amount_vnd' is distinct from v_second->>'amount_vnd' then
    raise exception 'SMOKE FAIL spin is not idempotent: % vs %', v_result, v_second;
  end if;
  select count(*) into v_count from public.dealer_heo_spins where order_id = v_order_main;
  if v_count <> 1 then
    raise exception 'SMOKE FAIL order has % spins', v_count;
  end if;

  v_result := public.dealer_heo_spin(
    v_campaign, v_customer_zero, v_order_zero, false, date '2026-12-01', date '2026-12-31'
  );
  if v_result is null then
    raise exception 'SMOKE FAIL zero-baseline spin returned nothing';
  end if;

  v_error := null;
  begin
    perform public.dealer_heo_spin(
      v_campaign, v_customer, v_order_below, false, date '2026-12-01', date '2026-12-31'
    );
  exception when others then
    v_error := sqlerrm;
  end;
  if v_error is null or position('heo_order_not_eligible' in v_error) = 0 then
    raise exception 'SMOKE FAIL below-baseline expected not_eligible, got %', coalesce(v_error, '<no error>');
  end if;

  v_error := null;
  begin
    perform public.dealer_heo_spin(
      v_campaign, v_customer, v_order_outside, false, date '2026-12-01', date '2026-12-31'
    );
  exception when others then
    v_error := sqlerrm;
  end;
  if v_error is null or position('heo_outside_window' in v_error) = 0 then
    raise exception 'SMOKE FAIL outside-window expected outside_window, got %', coalesce(v_error, '<no error>');
  end if;

  v_error := null;
  begin
    perform public.dealer_heo_spin(
      v_campaign, v_customer_zero, v_order_below, false, date '2026-12-01', date '2026-12-31'
    );
  exception when others then
    v_error := sqlerrm;
  end;
  if v_error is null or position('heo_order_not_found' in v_error) = 0 then
    raise exception 'SMOKE FAIL wrong-customer expected order_not_found, got %', coalesce(v_error, '<no error>');
  end if;

  v_error := null;
  begin
    perform public.dealer_heo_spin(
      v_campaign, v_customer, v_order_test, false, date '2026-12-01', date '2026-12-31'
    );
  exception when others then
    v_error := sqlerrm;
  end;
  if v_error is null or position('heo_order_not_eligible' in v_error) = 0 then
    raise exception 'SMOKE FAIL test/real mismatch expected not_eligible, got %', coalesce(v_error, '<no error>');
  end if;

  -- -------------------------------------------------------------------------
  -- Budget ceiling: the second winning draw becomes "none".
  -- -------------------------------------------------------------------------
  delete from public.dealer_heo_spins where campaign_id = v_campaign;
  update public.dealer_heo_campaigns
  set spin_enabled = true,
      weekly_jackpot_vnd = 0,
      spin_budget_vnd = 50000,
      prizes = '[{"key":"coin_50000","label":"50.000đ","kind":"coin","amount_vnd":50000,"bread_qty":0,"weight":1}]'::jsonb
  where id = v_campaign;

  v_result := public.dealer_heo_spin(
    v_campaign, v_customer, v_order_budget_a, false, date '2026-12-01', date '2026-12-31'
  );
  if (v_result->>'amount_vnd')::integer <> 50000 then
    raise exception 'SMOKE FAIL budget first spin expected 50000, got %', v_result;
  end if;

  v_result := public.dealer_heo_spin(
    v_campaign, v_customer, v_order_budget_b, false, date '2026-12-01', date '2026-12-31'
  );
  if v_result->>'prize_kind' <> 'none' or (v_result->>'amount_vnd')::integer <> 0 then
    raise exception 'SMOKE FAIL budget ceiling expected none, got %', v_result;
  end if;

  -- -------------------------------------------------------------------------
  -- Weekly Heo Vàng: one non-test winner per ISO week, test spins do not hold it.
  -- -------------------------------------------------------------------------
  delete from public.dealer_heo_spins where campaign_id = v_campaign;
  update public.dealer_heo_campaigns
  set spin_enabled = true,
      weekly_jackpot_vnd = 500000,
      spin_budget_vnd = 2000000,
      prizes = '[{"key":"none","label":"Chúc may mắn","kind":"none","amount_vnd":0,"bread_qty":0,"weight":1}]'::jsonb
  where id = v_campaign;

  v_week := to_char((now() at time zone 'Asia/Ho_Chi_Minh')::date, 'IYYY-"W"IW');

  -- Find a seed whose second random draw is outside the 2% jackpot band. This
  -- makes the "no jackpot" path deterministic instead of waiting for a 98% run.
  v_seed := null;
  for v_i in 1..10000 loop
    perform setseed(v_i / 10000.0);
    perform random();
    v_next := random();
    if v_next >= 0.02 then
      v_seed := v_i / 10000.0;
      exit;
    end if;
  end loop;
  if v_seed is null then
    raise exception 'SMOKE FAIL could not find a non-jackpot random seed';
  end if;
  perform setseed(v_seed);
  perform random();

  v_result := public.dealer_heo_spin(
    v_campaign, v_customer, v_order_no_jackpot, false, date '2026-12-01', date '2026-12-31'
  );
  if (v_result->>'is_jackpot')::boolean then
    raise exception 'SMOKE FAIL unexpected jackpot outside the forced band: %', v_result;
  end if;

  -- Seed a weekly Heo Vàng directly, then force a seed that would win the 2%
  -- draw. The function must skip it because the week already has its winner.
  insert into public.dealer_heo_spins (
    campaign_id, customer_id, order_id, is_test, prize_key, prize_kind,
    amount_vnd, bread_qty, is_jackpot, iso_week
  ) values (
    v_campaign, v_customer, v_order_jackpot_seed, false, 'heo_vang', 'coin',
    500000, 0, true, v_week
  );

  v_seed := null;
  for v_i in 1..10000 loop
    perform setseed(v_i / 10000.0);
    perform random();
    v_next := random();
    if v_next < 0.02 then
      v_seed := v_i / 10000.0;
      exit;
    end if;
  end loop;
  if v_seed is null then
    raise exception 'SMOKE FAIL could not find a jackpot random seed';
  end if;
  perform setseed(v_seed);
  perform random();

  v_result := public.dealer_heo_spin(
    v_campaign, v_customer, v_order_week_check, false, date '2026-12-01', date '2026-12-31'
  );
  if (v_result->>'is_jackpot')::boolean then
    raise exception 'SMOKE FAIL second Heo Vàng in one week: %', v_result;
  end if;
  if v_result->>'prize_kind' <> 'none' then
    raise exception 'SMOKE FAIL forced jackpot seed should fall back to none: %', v_result;
  end if;

  select count(*) into v_count
  from public.dealer_heo_spins
  where campaign_id = v_campaign
    and is_test = false
    and is_jackpot = true
    and iso_week = v_week;
  if v_count <> 1 then
    raise exception 'SMOKE FAIL expected 1 weekly Heo Vàng, got %', v_count;
  end if;

  -- The partial unique index is the database-level guarantee.
  v_error := null;
  begin
    insert into public.dealer_heo_spins (
      campaign_id, customer_id, order_id, is_test, prize_key, prize_kind,
      amount_vnd, bread_qty, is_jackpot, iso_week
    ) values (
      v_campaign, v_customer, v_order_jackpot_extra, false, 'heo_vang', 'coin',
      500000, 0, true, v_week
    );
  exception when unique_violation then
    v_error := sqlerrm;
  end;
  if v_error is null then
    raise exception 'SMOKE FAIL weekly Heo Vàng unique index did not reject a second row';
  end if;

  raise notice 'SMOKE PASS dealer_heo_dat_tet';
end;
$$;

set local session_replication_role = origin;
rollback;
