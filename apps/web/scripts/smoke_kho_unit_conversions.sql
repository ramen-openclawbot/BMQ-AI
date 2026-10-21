-- Smoke test for 20261102560000_kho_unit_conversions.sql.
--
-- Runs entirely inside BEGIN ... ROLLBACK: it never keeps a unit, an alias
-- factor, an audit row or a ledger correction.
--
-- It runs in a service_role context (the same JWT-claim switch the other
-- smokes use) so the RPC gates are exercised without an owner session:
--   1. adds a new count unit and prints the result;
--   2. reads every conversion of the live item named 'Băng keo lớn';
--   3. previews a factor of 6 for its 'cây' receipt group;
--   4. saves that factor (fixed request id, replay-safe);
--   5. selects the resulting 'unit_factor_fix' adjustment rows.
--
-- Run with:  psql "$DATABASE_URL" -f scripts/smoke_kho_unit_conversions.sql
-- The Maestro runs it on the linked project; Harness does not.

begin;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- 1. Add a new count unit. The suffix is letters only because the RPC rejects
--    digits and punctuation in a unit label.
-- ---------------------------------------------------------------------------
select public.kho_add_stock_unit(
  'thử ' || translate(
    substr(md5(random()::text), 1, 6),
    '0123456789abcdef',
    'abcdefghijklmnop'
  ),
  gen_random_uuid()
) as added_unit;

-- ---------------------------------------------------------------------------
-- 2. Every conversion of 'Băng keo lớn' (item counted in cuộn, receipts in cây).
-- ---------------------------------------------------------------------------
select public.kho_get_item_conversions((
  select kii.id
  from public.kitchen_inventory_items kii
  where public.normalize_stock_item_name(kii.name)
        = public.normalize_stock_item_name('Băng keo lớn')
  order by kii.active desc nulls last, kii.id
  limit 1
)) as conversions;

-- ---------------------------------------------------------------------------
-- 3. Dry run: 1 cây = 6 cuộn. Writes nothing.
-- ---------------------------------------------------------------------------
select public.kho_set_item_conversion(
  (
    select kii.id
    from public.kitchen_inventory_items kii
    where public.normalize_stock_item_name(kii.name)
          = public.normalize_stock_item_name('Băng keo lớn')
    order by kii.active desc nulls last, kii.id
    limit 1
  ),
  'cây',
  6,
  true,
  null
) as preview;

-- ---------------------------------------------------------------------------
-- 4. Save the same factor. Fixed request id keeps the smoke re-runnable.
-- ---------------------------------------------------------------------------
select public.kho_set_item_conversion(
  (
    select kii.id
    from public.kitchen_inventory_items kii
    where public.normalize_stock_item_name(kii.name)
          = public.normalize_stock_item_name('Băng keo lớn')
    order by kii.active desc nulls last, kii.id
    limit 1
  ),
  'cây',
  6,
  false,
  '00000000-0000-0000-0000-00000000c0de'::uuid
) as saved;

-- ---------------------------------------------------------------------------
-- 5. The correction movements written by the save.
-- ---------------------------------------------------------------------------
select
  m.movement_date,
  m.movement_type,
  m.quantity,
  m.unit,
  m.source,
  m.source_ref_key,
  m.note
from public.tan_tao_material_movements m
where m.kitchen_inventory_item_id = (
    select kii.id
    from public.kitchen_inventory_items kii
    where public.normalize_stock_item_name(kii.name)
          = public.normalize_stock_item_name('Băng keo lớn')
    order by kii.active desc nulls last, kii.id
    limit 1
  )
  and m.source = 'unit_factor_fix'
  and m.source_ref_key
      like 'unit-fix:%:00000000-0000-0000-0000-00000000c0de'
union all
select
  m.movement_date,
  m.movement_type,
  m.quantity,
  m.unit,
  m.source,
  m.source_ref_key,
  m.note
from public.q7_inventory_movements m
where m.kitchen_inventory_item_id = (
    select kii.id
    from public.kitchen_inventory_items kii
    where public.normalize_stock_item_name(kii.name)
          = public.normalize_stock_item_name('Băng keo lớn')
    order by kii.active desc nulls last, kii.id
    limit 1
  )
  and m.source = 'unit_factor_fix'
  and m.source_ref_key
      like 'unit-fix:%:00000000-0000-0000-0000-00000000c0de'
order by 1, 2, 6;

rollback;
