-- Repair the pre-Q7 production rows and bootstrap dedicated Q7 material
-- identities for active Q7 BOM leaves. This only updates master/source links;
-- it never creates an issue or writes either inventory ledger.

with exact_finished_sku as (
  select
    poi.id as production_order_item_id,
    (array_agg(ps.id order by ps.id::text))[1] as sku_id
  from public.production_order_items poi
  join public.product_skus ps
    on ps.sku_type = 'finished_good'
   and lower(btrim(ps.product_name)) = lower(btrim(poi.product_name))
   and lower(btrim(ps.unit)) = lower(btrim(poi.unit))
  where poi.sku_id is null
  group by poi.id
  having count(ps.id) = 1
)
update public.production_order_items poi
set sku_id = match.sku_id
from exact_finished_sku match
where poi.id = match.production_order_item_id
  and poi.sku_id is null;

create temp table q7_bootstrap_materials on commit drop as
with active_q7_order_lines as (
  select
    poi.sku_id as finished_sku_id,
    coalesce(
      po.planned_start_date,
      (
        select min(date_item.delivery_date)
        from public.production_order_items date_item
        where date_item.production_order_id = po.id
      ),
      (now() at time zone 'Asia/Ho_Chi_Minh')::date
    ) as issue_date
  from public.production_orders po
  join public.production_order_items poi
    on poi.production_order_id = po.id
  where po.location_code = 'q7'
    and po.status::text in ('planned', 'in_progress')
    and poi.sku_id is not null
), selected_versions as (
  select distinct version_row.id as version_id
  from active_q7_order_lines line
  join lateral (
    select v.id
    from public.sku_cogs_versions v
    where v.sku_id = line.finished_sku_id
      and v.effective_from <= line.issue_date
      and (v.effective_to is null or line.issue_date <= v.effective_to)
    order by v.effective_from desc, v.version_no desc, v.id::text desc
    limit 1
  ) version_row on true
), leaf_materials as (
  select distinct
    formulation.canonical_material_id,
    lower(nullif(btrim(formulation.unit), '')) as source_unit
  from selected_versions selected
  join public.sku_cogs_version_formulations formulation
    on formulation.version_id = selected.version_id
  where formulation.canonical_material_id is not null
    and nullif(btrim(formulation.unit), '') is not null
    and not exists (
      select 1
      from public.sku_cogs_version_formulations child
      where child.version_id = formulation.version_id
        and position(formulation.ingredient_name || ' > ' in child.ingredient_name) = 1
    )
)
select
  material.id as canonical_material_id,
  material.canonical_name,
  material.ingredient_sku_id,
  leaf.source_unit,
  'Q7-' || upper(substr(md5(material.id::text || ':' || leaf.source_unit), 1, 20)) as item_code,
  'q7-material:' || material.id::text || ':' || leaf.source_unit as normalized_key
from leaf_materials leaf
join public.sku_cogs_materials material
  on material.id = leaf.canonical_material_id
where material.active = true;

insert into public.kitchen_inventory_items (
  item_code,
  normalized_key,
  item_type,
  name,
  unit,
  standard_unit_cost,
  active,
  product_sku_id
)
select
  bootstrap.item_code,
  bootstrap.normalized_key,
  'ingredient',
  bootstrap.canonical_name,
  bootstrap.source_unit,
  0,
  true,
  bootstrap.ingredient_sku_id
from q7_bootstrap_materials bootstrap
on conflict (normalized_key) do nothing;

insert into public.q7_material_issue_material_mappings (
  canonical_material_id,
  source_unit,
  kitchen_inventory_item_id,
  kitchen_unit,
  conversion_factor,
  approval_status,
  approved_by,
  approved_at,
  notes,
  created_by
)
select
  bootstrap.canonical_material_id,
  bootstrap.source_unit,
  inventory_item.id,
  bootstrap.source_unit as kitchen_unit,
  1::numeric as conversion_factor,
  'approved',
  owner_row.user_id,
  now(),
  'Owner-approved Q7 bootstrap: canonical BOM unit maps 1:1 to its dedicated Q7 ledger identity.',
  owner_row.user_id
from q7_bootstrap_materials bootstrap
join public.kitchen_inventory_items inventory_item
  on inventory_item.normalized_key = bootstrap.normalized_key
cross join lateral (
  select user_id
  from public.user_roles
  where role = 'owner'
  order by user_id::text
  limit 1
) owner_row
on conflict (canonical_material_id, source_unit) do nothing;
