-- Read-only smoke test for the all-suppliers seed / supplier-list migration.
--
-- Run with psql against a database that already has 20261103080000 applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/scripts/smoke_supplier_order_all_suppliers.sql
--
-- Everything happens inside BEGIN ... ROLLBACK. It never keeps a row, sends an
-- email or changes a supplier order.

begin;

create temp table smoke_catalog_before as
select c.id, to_jsonb(c) as row_json
from public.supplier_order_catalog_items c
where c.supplier_id in (
  'bc39ded3-755c-4b31-9e4c-d7729e009608'::uuid, -- Phúc Thịnh
  '9546bd80-18d7-4ec7-b0e5-de50798ea718'::uuid  -- TV Food
);

do $$
declare
  v_first jsonb;
  v_rerun jsonb;
  v_suppliers jsonb;
  v_changed integer;
  v_target_rows integer;
  v_snapshot_rows integer;
begin
  -- First run: may insert newly seen pairs (rolled back), but must return the
  -- documented summary and must not alter any existing target row.
  v_first := public.supplier_order_seed_recent_catalog(60);
  if v_first is null
     or not (v_first ? 'inserted')
     or not (v_first ? 'skipped_no_conversion')
     or not (v_first ? 'suppliers') then
    raise exception 'seed summary missing keys: %', v_first;
  end if;

  select count(*)
  into v_changed
  from smoke_catalog_before b
  where not exists (
    select 1
    from public.supplier_order_catalog_items c
    where c.id = b.id
      and to_jsonb(c) = b.row_json
  );
  if v_changed <> 0 then
    raise exception 'seed changed % existing Phúc Thịnh / TV Food rows', v_changed;
  end if;

  select count(*), (select count(*) from smoke_catalog_before)
  into v_target_rows, v_snapshot_rows
  from public.supplier_order_catalog_items c
  where c.supplier_id in (
    'bc39ded3-755c-4b31-9e4c-d7729e009608'::uuid,
    '9546bd80-18d7-4ec7-b0e5-de50798ea718'::uuid
  );
  if v_target_rows < v_snapshot_rows then
    raise exception 'seed removed Phúc Thịnh / TV Food rows (% -> %)',
      v_snapshot_rows, v_target_rows;
  end if;

  -- Second run is the idempotency assertion: it must insert exactly zero rows.
  v_rerun := public.supplier_order_seed_recent_catalog(60);
  if coalesce((v_rerun ->> 'inserted')::integer, -1) <> 0 then
    raise exception 'second seed run inserted % rows, expected 0', v_rerun ->> 'inserted';
  end if;

  -- Existing target rows must still be byte-identical after both runs.
  select count(*)
  into v_changed
  from smoke_catalog_before b
  where not exists (
    select 1
    from public.supplier_order_catalog_items c
    where c.id = b.id
      and to_jsonb(c) = b.row_json
  );
  if v_changed <> 0 then
    raise exception 'second seed run changed % existing target rows', v_changed;
  end if;

  -- The supplier list must expose the new urgency / activity fields.
  v_suppliers := public.supplier_order_suppliers();
  if jsonb_typeof(v_suppliers) <> 'array' then
    raise exception 'supplier_order_suppliers() did not return an array: %', jsonb_typeof(v_suppliers);
  end if;
  if jsonb_array_length(v_suppliers) = 0 then
    raise exception 'supplier_order_suppliers() returned no suppliers';
  end if;

  if not (
    (v_suppliers -> 0) ? 'has_email'
    and (v_suppliers -> 0) ? 'active_item_count'
    and (v_suppliers -> 0) ? 'need_order_count'
    and (v_suppliers -> 0) ? 'low_stock_count'
    and (v_suppliers -> 0) ? 'out_of_stock_count'
    and (v_suppliers -> 0) ? 'last_activity_at'
    and (v_suppliers -> 0) ? 'locations'
    and (v_suppliers -> 0) ? 'urgency_rank'
  ) then
    raise exception 'supplier_order_suppliers() missing a new field: %', v_suppliers -> 0;
  end if;

  if jsonb_typeof(v_suppliers -> 0 -> 'locations') <> 'array' then
    raise exception 'locations is not an array: %', v_suppliers -> 0 -> 'locations';
  end if;
end;
$$;

-- Show the shape for a human running the smoke manually.
select
  jsonb_array_length(public.supplier_order_suppliers()) as supplier_count,
  public.supplier_order_suppliers() -> 0 as first_supplier;

rollback;
