-- Smoke test for 20261103320000_formulation_price_unit.sql.
--
-- Do not run in this job.  The Maestro runs it on the live DB with the
-- migration prepended, e.g.:
--   supabase db query --linked -f scripts/smoke_formulation_price_unit.sql
--
-- Everything happens in one transaction and ends with ROLLBACK.
--
-- The migration is prepended, so "before" below is the legacy expression the
-- app used (unit_price * dosage_qty * (1 + wastage/100)).  "After" applies the
-- new price_unit conversion.  Because the migration backfills no row, the two
-- numbers must be identical for every current SKU version.

begin;

do $$
declare
  v_version record;
  v_column_count integer;
  v_before numeric;
  v_after numeric;
begin
  -- Both new columns exist as nullable text.
  select count(*)
    into v_column_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name in ('sku_formulations', 'sku_cogs_version_formulations')
    and column_name = 'price_unit'
    and data_type = 'text'
    and is_nullable = 'YES';
  if v_column_count <> 2 then
    raise exception 'smoke: expected two nullable text price_unit columns, found %', v_column_count;
  end if;

  -- Only g/ml dosage lines on a kg/l material get price_unit = unit.
  if exists (select 1 from public.sku_cogs_version_formulations where price_unit is not null
             and not (public.normalize_document_unit(dosage_unit) in ('g','ml') and public.normalize_document_unit(unit) in ('kg','l'))) then
    raise exception 'smoke: price_unit set outside the g/ml-on-kg/l rule';
  end if;

  -- For every current SKU version, the price_unit-aware cost equals the legacy
  -- cost.  With price_unit null the effective price unit is the effective
  -- dosage unit, so the conversion factor is 1 and no line moved.
  for v_version in
    select v.id, v.sku_id, v.version_no
    from public.sku_cogs_versions v
    where v.effective_to is null
    order by v.sku_id, v.version_no
  loop
    select coalesce(sum(
        f.unit_price
        * f.dosage_qty
        * (1 + coalesce(f.wastage_percent, 0) / 100)
      ), 0)
      into v_before
    from public.sku_cogs_version_formulations f
    where f.version_id = v_version.id;

    select coalesce(sum(
        f.unit_price
        * f.dosage_qty
        * (1 + coalesce(f.wastage_percent, 0) / 100)
        * coalesce(
            public.stock_unit_line_factor(
              coalesce(nullif(btrim(f.dosage_unit), ''), nullif(btrim(f.unit), ''), 'g'),
              coalesce(nullif(btrim(f.price_unit), ''), nullif(btrim(f.dosage_unit), ''), nullif(btrim(f.unit), ''), 'g')
            ),
            1
          )
      ), 0)
      into v_after
    from public.sku_cogs_version_formulations f
    where f.version_id = v_version.id;

    -- Lines whose price_unit was just set legitimately change (that is the fix);
    -- every other version keeps its cost.
    if v_before <> v_after and not exists (select 1 from public.sku_cogs_version_formulations f2 where f2.version_id = v_version.id and f2.price_unit is not null) then
      raise exception 'smoke: SKU version % v% cost moved from % to %',
        v_version.sku_id, v_version.version_no, v_before, v_after;
    end if;
  end loop;

  raise notice 'smoke: formulation price_unit contract holds';
end;
$$;

rollback;
