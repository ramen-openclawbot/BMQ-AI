-- Rollback-only smoke for 20261103090000_cogs_backflush_rounding_fix.sql.
--
-- Run with:  supabase db query --linked -f scripts/smoke_cogs_backflush_rounding.sql
-- The whole file is one transaction and ends with ROLLBACK. It never commits a
-- ledger row and does not change any setting outside the transaction.
--
-- It checks the ledger-precision helpers, the frozen stock-count date for the
-- Q7 Bơ Peerless item, a real nightly run, the rows that run would insert and
-- the abnormal 28/10 usage it must hold instead of posting.

begin;

-- 1. Rounding helper: sub-ledger deltas vanish, real deltas survive.
do $$
begin
  if public.cogs_backflush_ledger_qty(0.0003) is not null then
    raise exception 'smoke: cogs_backflush_ledger_qty(0.0003) must be null';
  end if;
  if public.cogs_backflush_ledger_qty(0.0006) is distinct from 0.001 then
    raise exception 'smoke: cogs_backflush_ledger_qty(0.0006) must be 0.001';
  end if;
  if public.cogs_backflush_ledger_qty(-0.0004) is not null then
    raise exception 'smoke: cogs_backflush_ledger_qty(-0.0004) must be null';
  end if;
  if public.cogs_backflush_ledger_qty(-2.5) is distinct from -2.5 then
    raise exception 'smoke: cogs_backflush_ledger_qty(-2.5) must be -2.5';
  end if;
end $$;

-- 2. The Q7 Peerless item is frozen through its 27/10 stock count.
do $$
declare
  v_frozen date;
begin
  v_frozen := public.cogs_backflush_item_frozen_through(
    'q7', '3c16ed3f-54c7-427f-a316-5aa4fcadda5a'::uuid
  );
  if v_frozen is distinct from date '2026-10-27' then
    raise exception
      'smoke: q7 Peerless frozen through expected 2026-10-27, got %', v_frozen;
  end if;
end $$;

-- 3. A real nightly run over the scheduled window must not raise. The wrapper
--    is SECURITY DEFINER and sets the service_role claim for auth.uid()/RLS.
create temporary table _cogs_smoke_run on commit drop as
select public.run_cogs_backflush_nightly() as result;

do $$
declare
  v_result jsonb;
begin
  select result into v_result from _cogs_smoke_run;
  if v_result is null then
    raise exception 'smoke: run_cogs_backflush_nightly returned null';
  end if;
  if (v_result ->> 'run_id') is null then
    raise exception 'smoke: run_cogs_backflush_nightly returned no run_id';
  end if;
  if (v_result ->> 'held_rows') is null then
    raise exception 'smoke: run summary is missing held_rows';
  end if;
  if (v_result ->> 'rejected_skip_rows') is null then
    raise exception 'smoke: run summary is missing rejected_skip_rows';
  end if;
end $$;

-- 4. Ledger rows this run actually wrote (run id is the source_ref_key suffix)
--    and all current hold rows for the summary.
create temporary table _cogs_smoke_inserted on commit drop as
select 'q7'::text as kho,
       m.kitchen_inventory_item_id as item_id,
       m.movement_date,
       m.movement_type,
       m.quantity,
       m.unit
from public.q7_inventory_movements m
where m.source = 'revenue_cogs'
  and m.source_ref_key like (
    'cogs:%:' || (select result ->> 'run_id' from _cogs_smoke_run)
  )
union all
select 'tan_tao'::text as kho,
       m.kitchen_inventory_item_id as item_id,
       m.movement_date,
       m.movement_type,
       m.quantity,
       m.unit
from public.tan_tao_material_movements m
where m.source = 'revenue_cogs'
  and m.source_ref_key like (
    'cogs:%:' || (select result ->> 'run_id' from _cogs_smoke_run)
  );

create temporary table _cogs_smoke_holds on commit drop as
select h.*
from public.cogs_backflush_holds h;

-- 5. Per-kho/date summary of what was inserted and what was held.
select 'inserted'::text as kind,
       kho,
       movement_date,
       count(*)::integer as row_count,
       sum(quantity) as qty_sum
from _cogs_smoke_inserted
group by kho, movement_date
union all
select 'hold'::text as kind,
       location as kho,
       movement_date,
       count(*)::integer as row_count,
       sum(desired_qty) as qty_sum
from _cogs_smoke_holds
group by location, movement_date
order by kind, kho, movement_date;

do $$
declare
  v_peerless constant uuid := '3c16ed3f-54c7-427f-a316-5aa4fcadda5a';
begin
  if exists (
    select 1 from _cogs_smoke_inserted where quantity = 0
  ) then
    raise exception 'smoke: a revenue_cogs row rounded to quantity 0';
  end if;

  -- The kitchen item is "Peerless Úc 25kg"; the supplier product is
  -- "Bơ Peerless Úc 25kg". Match the known id first, then the name.
  if exists (
    select 1
    from _cogs_smoke_inserted i
    where i.movement_date <= date '2026-10-27'
      and (
        i.item_id = v_peerless
        or exists (
          select 1
          from public.kitchen_inventory_items kii
          where kii.id = i.item_id
            and kii.name like '%Peerless Úc 25kg%'
        )
      )
  ) then
    raise exception
      'smoke: revenue_cogs posted for Bơ Peerless Úc 25kg on/before 2026-10-27';
  end if;

  -- The abnormal 28/10 usage must be held, not posted as > 50 kg.
  if exists (
    select 1
    from _cogs_smoke_inserted i
    where i.item_id = v_peerless
      and i.movement_date = date '2026-10-28'
      and i.movement_type = 'production_usage'
      and i.quantity > 50000
  ) then
    raise exception
      'smoke: abnormal Peerless usage on 2026-10-28 was posted instead of held';
  end if;

  if not exists (
    select 1
    from _cogs_smoke_holds h
    where h.location = 'q7'
      and h.kitchen_inventory_item_id = v_peerless
      and h.movement_date = date '2026-10-28'
      and h.reason in ('outlier', 'no_reference')
  ) then
    raise exception
      'smoke: missing q7 Peerless hold on 2026-10-28 (outlier/no_reference)';
  end if;
end $$;

rollback;
