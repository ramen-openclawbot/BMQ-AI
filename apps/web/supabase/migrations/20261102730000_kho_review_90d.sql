-- 2026-10-22 — Rà soát nhập kho: only receipt lines of the last 90 days
-- (owner), and old lines without actual_quantity show the ordered quantity.
-- Body copied from 20261102720000_kho_review.sql; only the lines CTE changes.

create or replace function public.kho_review_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_items jsonb := '[]'::jsonb;
  v_materials jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null
       or not (
         public.q7_material_inventory_can_edit(v_actor)
         or public.has_module_permission(v_actor, 'inventory', 'edit')
       ) then
      raise exception 'kho_review_forbidden' using errcode = '42501';
    end if;
  end if;

  with expanded as (
    select
      (e ->> 'id')::uuid as item_id,
      e ->> 'item_code' as item_code,
      e ->> 'name' as name,
      e ->> 'unit' as unit,
      e ->> 'item_class' as item_class,
      coalesce((e ->> 'doc_lines')::integer, 0) as doc_lines,
      coalesce((e #>> '{qty,tan_tao}')::numeric, 0) as qty_tan_tao,
      coalesce((e #>> '{qty,q7}')::numeric, 0) as qty_q7,
      coalesce((e ->> 'in_tan_tao')::boolean, false) as in_tan_tao,
      coalesce((e ->> 'in_q7')::boolean, false) as in_q7
    from jsonb_array_elements(coalesce(public.kho_get_items() -> 'items', '[]'::jsonb)) e
    where coalesce((e ->> 'active')::boolean, false)
  ),
  item_gaps as materialized (
    select item_id, item_code, name, unit, item_class, 'tan_tao'::text as location, qty_tan_tao as qty,
           case when doc_lines = 0 and qty_tan_tao < 0 then 'no_docs_negative' when doc_lines = 0 then 'no_docs' else 'negative' end as reason
    from expanded where in_tan_tao and (doc_lines = 0 or qty_tan_tao < 0)
    union all
    select item_id, item_code, name, unit, item_class, 'q7', qty_q7,
           case when doc_lines = 0 and qty_q7 < 0 then 'no_docs_negative' when doc_lines = 0 then 'no_docs' else 'negative' end
    from expanded where in_q7 and (doc_lines = 0 or qty_q7 < 0)
  ),
  latest_versions as (
    select distinct on (v.sku_id) v.id, v.sku_id
    from public.sku_cogs_versions v
    where v.effective_from <= current_date + 30
    order by v.sku_id, v.effective_from desc, v.version_no desc, v.id::text desc
  ),
  recipe_rows as (
    select ps.sku_code, f.canonical_material_id, public.normalize_document_unit(f.unit) as recipe_unit
    from latest_versions v
    join public.product_skus ps on ps.id = v.sku_id and ps.sku_type is distinct from 'raw_material'
    join public.sku_cogs_version_formulations f on f.version_id = v.id
    where f.canonical_material_id is not null
      and public.normalize_document_unit(f.unit) is not null
      and not exists (
        select 1 from public.sku_cogs_version_formulations child
        where child.version_id = f.version_id
          and position(f.ingredient_name || ' > ' in child.ingredient_name) = 1
      )
      and public.cogs_resolve_child_sku(f.ingredient_sku_id, f.canonical_material_id, f.material_code) is null
  ),
  material_gaps as materialized (
    select r.canonical_material_id, mat.canonical_name as name, r.recipe_unit,
           jsonb_agg(distinct r.sku_code order by r.sku_code) as sku_codes
    from recipe_rows r
    join public.sku_cogs_materials mat on mat.id = r.canonical_material_id
    left join public.cogs_ingredient_stock_map sm
      on sm.canonical_material_id = r.canonical_material_id and sm.recipe_unit = r.recipe_unit
    where sm.id is null or sm.status = 'suggested' or sm.action is null
    group by r.canonical_material_id, mat.canonical_name, r.recipe_unit
  ),
  -- One key per target: items by item+kho, materials by material+unit.
  targets as materialized (
    select 'i:' || item_id::text || ':' || location as tkey, name, location as target_location, item_id
    from item_gaps
    union all
    select 'm:' || canonical_material_id::text || ':' || recipe_unit, name, null::text, null::uuid
    from material_gaps
  ),
  target_words as materialized (
    select distinct t.tkey, w
    from targets t,
         unnest(regexp_split_to_array(coalesce(public.normalize_stock_item_name(t.name), ''), '\s+')) w
    where w <> ''
  ),
  target_sizes as materialized (
    select tkey, count(*) as n from target_words group by tkey
  ),
  lines as materialized (
    select
      gri.id as receipt_item_id, gr.receipt_number, gr.receipt_date,
      coalesce(gr.receiving_location, 'tan_tao') as location, gr.supplier_id, s.name as supplier_name,
      coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as product_name,
      public.normalize_stock_item_name(coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)) as normalized_name,
      nullif(btrim(gri.unit), '') as unit, coalesce(gri.actual_quantity, nullif(gri.ordered_quantity, 0), nullif(gri.quantity, 0)) as actual_quantity, gri.unit_price,
      nullif(btrim(gr.image_url), '') as image_url
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    left join public.suppliers s on s.id = gr.supplier_id
    where gr.status in ('confirmed', 'received')
      -- Owner 22/10: only purchases of the last 90 days are offered.
      and gr.receipt_date >= current_date - 90
      and coalesce(gr.receiving_location, 'tan_tao') in ('q7', 'tan_tao')
      and coalesce(s.stock_exempt, false) = false
      -- stock_line_auto_non_stock() per line cost ~2 s; a non-stock line only
      -- shows up as a candidate when its words match, and the owner skips it.
  ),
  line_words as materialized (
    select distinct l.receipt_item_id, w
    from lines l, unnest(regexp_split_to_array(coalesce(l.normalized_name, ''), '\s+')) w
    where w <> ''
  ),
  scored as materialized (
    select tw.tkey, lw.receipt_item_id, count(*)::numeric / ts.n as score
    from target_words tw
    join line_words lw on lw.w = tw.w
    join target_sizes ts on ts.tkey = tw.tkey
    group by tw.tkey, lw.receipt_item_id, ts.n
    having count(*)::numeric / ts.n >= 0.5
  ),
  linked as materialized (
    select l.receipt_item_id, min(a.kitchen_inventory_item_id::text)::uuid as linked_item_id
    from lines l
    join public.stock_material_aliases a
      on a.location = l.location and a.normalized_name = l.normalized_name
     and a.supplier_id is not distinct from l.supplier_id and a.kitchen_inventory_item_id is not null
    group by l.receipt_item_id
  ),
  ranked as materialized (
    select sc.tkey, l.*, sc.score, lk.linked_item_id,
           row_number() over (partition by sc.tkey order by sc.score desc, l.receipt_date desc, l.receipt_item_id desc) as rn
    from scored sc
    join lines l on l.receipt_item_id = sc.receipt_item_id
    join targets t on t.tkey = sc.tkey
    left join linked lk on lk.receipt_item_id = l.receipt_item_id
    -- A line already linked to another item is not offered to an item row.
    where t.item_id is null or lk.linked_item_id is null or lk.linked_item_id = t.item_id
  ),
  cand as materialized (
    select r.tkey, jsonb_agg(jsonb_build_object(
             'receipt_item_id', r.receipt_item_id, 'receipt_number', r.receipt_number,
             'receipt_date', r.receipt_date, 'location', r.location, 'supplier_name', r.supplier_name,
             'product_name', r.product_name, 'unit', r.unit, 'actual_quantity', r.actual_quantity,
             'unit_price', r.unit_price, 'image_url', r.image_url, 'score', round(r.score, 4),
             'linked_item_id', r.linked_item_id,
             'posted', exists (
               select 1 from public.q7_inventory_movements m
               where m.source = 'goods_receipt' and m.source_ref_key = 'gr-item:' || r.receipt_item_id::text
               union all
               select 1 from public.tan_tao_material_movements m
               where m.source = 'goods_receipt' and m.source_ref_key = 'gr-item:' || r.receipt_item_id::text
             )
           ) order by r.rn) as candidates
    from ranked r
    where r.rn <= 5
    group by r.tkey
  ),
  item_out as (
    select g.*, coalesce(c.candidates, '[]'::jsonb) as candidates,
           case g.reason when 'no_docs_negative' then 0 when 'no_docs' then 1 else 2 end as ord
    from item_gaps g
    left join cand c on c.tkey = 'i:' || g.item_id::text || ':' || g.location
    order by ord, g.name, g.location
    limit 300
  ),
  material_out as (
    select g.*, coalesce(c.candidates, '[]'::jsonb) as candidates
    from material_gaps g
    left join cand c on c.tkey = 'm:' || g.canonical_material_id::text || ':' || g.recipe_unit
    order by g.name, g.recipe_unit
    limit 100
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object(
      'item_id', x.item_id, 'item_code', x.item_code, 'name', x.name, 'unit', x.unit,
      'item_class', x.item_class, 'location', x.location, 'qty', x.qty, 'reason', x.reason,
      'candidates', x.candidates) order by x.ord, x.name, x.location) from item_out x), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object(
      'canonical_material_id', x.canonical_material_id, 'name', x.name, 'recipe_unit', x.recipe_unit,
      'sku_codes', x.sku_codes, 'candidates', x.candidates) order by x.name, x.recipe_unit) from material_out x), '[]'::jsonb)
  into v_items, v_materials;

  return jsonb_build_object('items', v_items, 'materials', v_materials);
end;
$$;

revoke all on function public.kho_review_list() from public, anon;
grant execute on function public.kho_review_list() to authenticated, service_role;
