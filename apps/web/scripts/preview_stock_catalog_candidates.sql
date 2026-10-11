-- Preview only: list the Q7 stock catalog candidate pairs straight from real data.
-- SELECT only; it never writes, merges or classifies anything.
--
-- Run with:  psql "$DATABASE_URL" -f scripts/preview_stock_catalog_candidates.sql
--
-- The pair rule mirrors public.get_stock_catalog_candidates(): active items of the
-- same item_type whose normalize_stock_item_name is equal, or whose non-number,
-- non-unit token Jaccard is at least 0.6.

with items as (
  select
    kii.id,
    kii.name,
    kii.unit,
    kii.item_type,
    kii.canonical_material_id,
    scm.material_code,
    public.normalize_stock_item_name(kii.name) as norm
  from public.kitchen_inventory_items kii
  left join public.sku_cogs_materials scm on scm.id = kii.canonical_material_id
  where kii.active = true
),
pairs as (
  select
    a.id as left_id,
    b.id as right_id,
    a.name as left_name,
    b.name as right_name,
    a.unit as left_unit,
    b.unit as right_unit,
    a.item_type,
    a.canonical_material_id as left_canonical_material_id,
    b.canonical_material_id as right_canonical_material_id,
    a.material_code as left_canonical_material_code,
    b.material_code as right_canonical_material_code,
    public.stock_catalog_token_jaccard(a.name, b.name) as token_jaccard,
    (a.norm is not null and a.norm = b.norm) as normalized_equal
  from items a
  join items b on a.id < b.id and a.item_type = b.item_type
  where (a.norm is not null and a.norm = b.norm)
     or public.stock_catalog_token_jaccard(a.name, b.name) >= 0.6
)
select
  p.left_id,
  p.left_name,
  p.left_unit,
  p.right_id,
  p.right_name,
  p.right_unit,
  p.item_type,
  p.normalized_equal,
  round(p.token_jaccard, 3) as token_jaccard,
  p.left_canonical_material_code,
  p.right_canonical_material_code,
  (
    select count(*)
    from public.production_material_issue_items pmii
    join public.production_material_issues pmi on pmi.id = pmii.material_issue_id
    where pmii.kitchen_inventory_item_id = p.left_id
      and pmi.issue_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90
  ) as left_issue_count_90d,
  (
    select count(*)
    from public.production_material_issue_items pmii
    join public.production_material_issues pmi on pmi.id = pmii.material_issue_id
    where pmii.kitchen_inventory_item_id = p.right_id
      and pmi.issue_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90
  ) as right_issue_count_90d,
  (
    select count(*) from public.q7_inventory_movements m
    where m.kitchen_inventory_item_id = p.left_id
      and m.movement_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90
  ) as left_movement_count_90d,
  (
    select count(*) from public.q7_inventory_movements m
    where m.kitchen_inventory_item_id = p.right_id
      and m.movement_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90
  ) as right_movement_count_90d,
  public.stock_unit_factor(p.left_unit, p.right_unit) as left_to_right_factor,
  public.stock_unit_factor(p.right_unit, p.left_unit) as right_to_left_factor
from pairs p
order by p.left_id, p.right_id;
