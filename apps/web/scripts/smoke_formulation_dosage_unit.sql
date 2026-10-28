-- Smoke test for 20261103150000_formulation_dosage_unit.sql.
--
-- Do not run in this job.  The Maestro runs it on the live DB with the
-- migration prepended, e.g.:
--   supabase db query --linked -f scripts/smoke_formulation_dosage_unit.sql
--
-- Everything happens in one transaction and ends with ROLLBACK, so the
-- temporary null used to prove the fallback is never committed.

begin;

do $$
declare
  v_version_id constant uuid := '59b2950e-949f-4ab8-8b76-8d4c4eb642b2';
  v_revenue_line_id constant uuid := '7eaa39ef-9ca3-4e4b-8e5b-59299e033809';
  v_kg_rows integer;
  v_total numeric;
  v_nulled integer;
  v_gan record;
begin
  -- 11 TP-PATE version rows carry the explicit dosage unit.
  select count(*)
    into v_kg_rows
  from public.sku_cogs_version_formulations f
  where f.version_id = v_version_id
    and f.dosage_unit = 'Kg';
  if v_kg_rows <> 11 then
    raise exception 'smoke: expected 11 TP-PATE dosage_unit=Kg rows, found %', v_kg_rows;
  end if;

  -- dosage_qty and unit_price are unchanged.
  select round(coalesce(sum(f.dosage_qty * f.unit_price), 0))
    into v_total
  from public.sku_cogs_version_formulations f
  where f.version_id = v_version_id;
  if v_total <> 58544 then
    raise exception 'smoke: TP-PATE line cost changed, expected 58544, found %', v_total;
  end if;

  if not exists (
    select 1 from public.revenue_ledger_lines l where l.id = v_revenue_line_id
  ) then
    raise exception 'smoke: revenue line % not found', v_revenue_line_id;
  end if;

  -- With dosage_unit=Kg, Gan must be priced per kg with factor 1000 and the
  -- same stock quantity, even when the approved map is stored in g.
  select e.*
    into v_gan
  from public.cogs_explode_revenue(date '2026-10-28', date '2026-10-28') e
  where e.revenue_line_id = v_revenue_line_id
    and lower(btrim(e.material_name)) like 'gan%'
  order by e.depth, e.formulation_id
  limit 1;
  if not found then
    raise exception 'smoke: cogs_explode_revenue returned no Gan row for %', v_revenue_line_id;
  end if;
  if v_gan.status is distinct from 'ok' then
    raise exception 'smoke: Gan status expected ok, found %', v_gan.status;
  end if;
  if v_gan.recipe_unit is distinct from 'kg' then
    raise exception 'smoke: Gan recipe_unit expected kg, found %', v_gan.recipe_unit;
  end if;
  if v_gan.factor_used is distinct from 1000 then
    raise exception 'smoke: Gan factor_used expected 1000, found %', v_gan.factor_used;
  end if;
  if v_gan.stock_qty is null or abs(v_gan.stock_qty - 1111.1) > 0.5 then
    raise exception 'smoke: Gan stock_qty expected about 1111.1, found %', v_gan.stock_qty;
  end if;

  -- A depth-1 line must not be a gap when its material has an approved map in
  -- a convertible unit; the fallback has to find it.
  if exists (
    select 1
    from public.cogs_explode_revenue(date '2026-10-28', date '2026-10-28') e
    where e.revenue_line_id = v_revenue_line_id
      and e.depth = 1
      and e.status = 'gap_ingredient'
      and exists (
        select 1
        from public.cogs_ingredient_stock_map m
        where m.canonical_material_id = e.canonical_material_id
          and m.status in ('auto', 'confirmed')
          and m.action is not null
          and public.stock_unit_line_factor(e.recipe_unit, m.recipe_unit) is not null
      )
  ) then
    raise exception 'smoke: depth-1 line with a convertible approved map is gap_ingredient';
  end if;

  -- A null dosage_unit must fall back to the stored unit (g path).  Null one
  -- TP-PATE line inside this transaction (rolled back at the end) and re-run.
  update public.sku_cogs_version_formulations f
  set dosage_unit = null
  where f.version_id = v_version_id
    and (
      lower(btrim(f.ingredient_name)) like 'gan%'
      or exists (
        select 1
        from public.sku_cogs_materials m
        where m.id = f.canonical_material_id
          and lower(btrim(m.canonical_name)) like 'gan%'
      )
    );
  get diagnostics v_nulled = row_count;
  if v_nulled = 0 then
    raise exception 'smoke: no Gan TP-PATE version line to null-test';
  end if;

  select e.*
    into v_gan
  from public.cogs_explode_revenue(date '2026-10-28', date '2026-10-28') e
  where e.revenue_line_id = v_revenue_line_id
    and lower(btrim(e.material_name)) like 'gan%'
  order by e.depth, e.formulation_id
  limit 1;
  if not found then
    raise exception 'smoke: no Gan row after clearing dosage_unit';
  end if;
  if v_gan.recipe_unit is distinct from 'g' then
    raise exception 'smoke: null dosage_unit must fall back to g, found %', v_gan.recipe_unit;
  end if;
  if v_gan.factor_used is distinct from 1 then
    raise exception 'smoke: null dosage_unit must use factor 1, found %', v_gan.factor_used;
  end if;

  raise notice 'smoke: formulation dosage_unit contract holds';
end;
$$;

rollback;
