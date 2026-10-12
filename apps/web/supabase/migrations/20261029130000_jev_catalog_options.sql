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
