-- Rollback-only production smoke for migration
-- 20261029130000_jev_catalog_options.sql.
--
-- Run as one file:
--   supabase db query --linked -f apps/web/scripts/smoke_jev_catalog_options.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_jev_catalog_options.sql).
--
-- The file opens one transaction, applies the migration SQL inline, asserts the
-- whole-catalog option rules for q7 and tan_tao, checks that service_role may
-- execute the new RPC while authenticated may not, then raises SMOKE_RESULT PASS.
-- The final RAISE aborts the transaction, so every change rolls back.
begin;

-- (1) Apply the migration SQL inline, byte-for-byte.
-- 2026-10-29 — Jev xem cả danh mục khi phân loại thùng chờ (phần dữ liệu).
--
-- Additive migration on top of 20261029120000 (renumbered from 20261029100000
-- to avoid the already-applied lock_cash_pr_payment_method migration on
-- origin/main). The stock-alias-jev edge function
-- in backlog mode used to offer Jev only the token matches from
-- public.material_alias_candidates; a receipt name with no shared token (a
-- translation, an abbreviation or an OCR-damaged name) got no candidate and was
-- skipped. This adds one read-only RPC that returns the whole catalog of a
-- location as options:
--
--   public.material_alias_catalog_options(p_location text)
--     returns table (item_id uuid, sku_id uuid, name text, unit text,
--                    score numeric, reason text)
--
-- Same columns as public.material_alias_candidates so the edge mapper
-- (mapCandidate in store.ts) reads it unchanged. Every row is a real, active,
-- unmerged option; score is 0 and reason is 'catalog' so the deterministic
-- exact-name short-circuit never treats a catalog option as a name exact match.
--
--   * q7     — kitchen_inventory_items where active, merged_into_id is null,
--              pastry_q7 is true and item_class is not 'non_stock'.
--   * tan_tao — every active, unmerged, non-'non_stock' kitchen item plus the
--              finished-goods SKUs the current public.material_alias_candidates
--              already returns for tan_tao (BMQ-001, BMQ-002, PATE-500G,
--              PATE-200G).
--
-- Read-only, security definer, pinned search_path, service_role only. Nothing
-- here writes or reads a business document, and the migration is applied as one
-- transaction. No DROP is used, so this is idempotent.

create or replace function public.material_alias_catalog_options(p_location text)
returns table (
  item_id uuid,
  sku_id uuid,
  name text,
  unit text,
  score numeric,
  reason text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with items as (
    select
      kii.id as item_id,
      null::uuid as sku_id,
      kii.name::text as name,
      kii.unit::text as unit,
      0::numeric as score,
      'catalog'::text as reason
    from public.kitchen_inventory_items kii
    where p_location = 'q7'
      and kii.active = true
      and kii.merged_into_id is null
      and kii.pastry_q7 = true
      and coalesce(kii.item_class, '') <> 'non_stock'
    union all
    select
      kii.id,
      null::uuid,
      kii.name::text,
      kii.unit::text,
      0::numeric,
      'catalog'::text
    from public.kitchen_inventory_items kii
    where p_location = 'tan_tao'
      and kii.active = true
      and kii.merged_into_id is null
      and coalesce(kii.item_class, '') <> 'non_stock'
    union all
    select
      null::uuid,
      ps.id,
      ps.product_name::text,
      ps.unit::text,
      0::numeric,
      'catalog'::text
    from public.product_skus ps
    where p_location = 'tan_tao'
      and upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G')
  )
  select i.item_id, i.sku_id, i.name, i.unit, i.score, i.reason
  from items i
  order by i.name asc, i.item_id asc nulls last, i.sku_id asc nulls last;
$$;

revoke all on function public.material_alias_catalog_options(text) from public, anon, authenticated;
grant execute on function public.material_alias_catalog_options(text) to service_role;

-- (2) Assert the catalog-option rules and the grant surface.
do $smoke$
declare
  v_bad integer;
  v_item_count integer;
  v_sku_count integer;
  v_catalog_count integer;
begin
  -- (a) q7: every option is a real, active, unmerged, pastry_q7, non-non_stock
  -- kitchen item. A SKU or an empty id can never appear for q7.
  select count(*) into v_bad
  from public.material_alias_catalog_options('q7') o
  where o.item_id is null
     or o.sku_id is not null
     or o.score <> 0
     or o.reason <> 'catalog'
     or not exists (
       select 1
       from public.kitchen_inventory_items kii
       where kii.id = o.item_id
         and kii.active = true
         and kii.merged_into_id is null
         and kii.pastry_q7 = true
         and coalesce(kii.item_class, '') <> 'non_stock'
     );
  if v_bad <> 0 then
    raise exception 'SMOKE_RESULT FAIL q7_options bad=%', v_bad;
  end if;

  -- (b) q7: every returned name doubles as the catalog row name.
  select count(*) into v_bad
  from public.material_alias_catalog_options('q7') o
  join public.kitchen_inventory_items kii on kii.id = o.item_id
  where kii.name <> o.name or coalesce(kii.unit, '') <> o.unit;
  if v_bad <> 0 then
    raise exception 'SMOKE_RESULT FAIL q7_name_unit bad=%', v_bad;
  end if;

  -- (c) tan_tao: the count is exactly the active, unmerged, non-non_stock
  -- kitchen items plus the four finished-goods SKUs.
  select count(*) into v_item_count
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.merged_into_id is null
    and coalesce(kii.item_class, '') <> 'non_stock';

  select count(*) into v_sku_count
  from public.product_skus ps
  where upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G');

  select count(*) into v_catalog_count
  from public.material_alias_catalog_options('tan_tao');

  if v_catalog_count <> v_item_count + v_sku_count then
    raise exception 'SMOKE_RESULT FAIL tan_tao_count catalog=% expected=%',
      v_catalog_count, v_item_count + v_sku_count;
  end if;

  -- (d) tan_tao: every option is a valid item or a valid SKU, reason 'catalog'.
  select count(*) into v_bad
  from public.material_alias_catalog_options('tan_tao') o
  where o.score <> 0
     or o.reason <> 'catalog'
     or (o.item_id is null and o.sku_id is null)
     or (o.item_id is not null and o.sku_id is not null)
     or (
       o.item_id is not null and not exists (
         select 1
         from public.kitchen_inventory_items kii
         where kii.id = o.item_id
           and kii.active = true
           and kii.merged_into_id is null
           and coalesce(kii.item_class, '') <> 'non_stock'
       )
     )
     or (
       o.sku_id is not null and not exists (
         select 1
         from public.product_skus ps
         where ps.id = o.sku_id
           and upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G')
       )
     );
  if v_bad <> 0 then
    raise exception 'SMOKE_RESULT FAIL tan_tao_options bad=%', v_bad;
  end if;

  -- (e) an unknown location returns no option instead of an error.
  select count(*) into v_bad from public.material_alias_catalog_options('nowhere');
  if v_bad <> 0 then
    raise exception 'SMOKE_RESULT FAIL unknown_location rows=%', v_bad;
  end if;

  -- (f) the grant surface: service_role yes, authenticated no.
  if not has_function_privilege(
    'service_role',
    'public.material_alias_catalog_options(text)',
    'execute'
  ) then
    raise exception 'SMOKE_RESULT FAIL service_role_no_execute';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.material_alias_catalog_options(text)',
    'execute'
  ) then
    raise exception 'SMOKE_RESULT FAIL authenticated_has_execute';
  end if;

  raise notice 'SMOKE_RESULT checks q7/tan_tao/grants ok';
end;
$smoke$;

-- (3) service_role can actually call it.
set local role service_role;
do $service$
declare
  v_count integer;
begin
  select count(*) into v_count from public.material_alias_catalog_options('q7');
  if v_count is null then
    raise exception 'SMOKE_RESULT FAIL service_role_call_null';
  end if;
  raise notice 'SMOKE_RESULT service_role q7 options=%', v_count;
end;
$service$;
reset role;

-- (4) authenticated cannot call it. The role switch is attempted; when this
-- database does not allow it, the static has_function_privilege check in (f)
-- above already proved the revoke, so the check is skipped with a notice.
do $auth$
begin
  begin
    perform set_config('role', 'authenticated', true);
  exception when others then
    raise notice 'SMOKE_RESULT skip authenticated call check: %', sqlerrm;
    return;
  end;

  begin
    perform 1 from public.material_alias_catalog_options('q7');
    raise exception 'SMOKE_RESULT FAIL authenticated_can_execute';
  exception
    when insufficient_privilege then
      raise notice 'SMOKE_RESULT authenticated denied as expected';
    when others then
      raise;
  end;
end;
$auth$;

do $pass$
begin
  raise exception 'SMOKE_RESULT PASS: jev catalog options';
end;
$pass$;
