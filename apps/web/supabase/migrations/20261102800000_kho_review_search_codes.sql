-- 2026-10-23 — Rà soát nhập kho: "Tìm phiếu mua" also matches the receipt
-- number (GRN-…), the PO number and the supplier name.
--
-- Only public.kho_review_search_lines() is redefined (body from
-- 20261102790000_kho_review_search_dismiss.sql).  Query words are now raw
-- lower-case unaccented tokens, and each word may match the corrected name,
-- the scanned name, or "receipt number + PO number + supplier".  Gate, limits,
-- result shape and grants are unchanged.

create or replace function public.kho_review_search_lines(
  p_target_key text,
  p_query text,
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_words text[];
  v_result jsonb := '[]'::jsonb;
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

  -- A blank or single-character query is not a search.
  if length(btrim(coalesce(p_query, ''))) < 2 then
    return '[]'::jsonb;
  end if;

  -- Raw lower-case unaccented words: product-name normalization would strip a
  -- code like "GRN-000435" down to "grn-".
  v_words := array_remove(
    regexp_split_to_array(lower(extensions.unaccent(btrim(coalesce(p_query, '')))), '\s+'),
    ''
  );
  if coalesce(array_length(v_words, 1), 0) = 0 then
    return '[]'::jsonb;
  end if;

  with lines as materialized (
    select
      gri.id as receipt_item_id, gr.receipt_number, gr.receipt_date,
      coalesce(gr.receiving_location, 'tan_tao') as location, gr.supplier_id, s.name as supplier_name,
      nullif(btrim(gri.product_name), '') as corrected_name,
      nullif(btrim(gri.raw_product_name), '') as raw_name,
      public.normalize_stock_item_name(
        coalesce(nullif(btrim(gri.product_name), ''), nullif(btrim(gri.raw_product_name), ''))
      ) as norm_corrected,
      public.normalize_stock_item_name(
        coalesce(nullif(btrim(gri.raw_product_name), ''), nullif(btrim(gri.product_name), ''))
      ) as norm_raw,
      nullif(btrim(gri.unit), '') as unit,
      coalesce(gri.actual_quantity, nullif(gri.ordered_quantity, 0), nullif(gri.quantity, 0)) as actual_quantity,
      gri.unit_price,
      nullif(btrim(gr.image_url), '') as image_url,
      -- Receipt number, PO number and supplier are searchable next to the names.
      lower(extensions.unaccent(
        coalesce(gr.receipt_number, '') || ' ' || coalesce(po.po_number, '') || ' ' || coalesce(s.name, '')
      )) as doc_text
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    left join public.suppliers s on s.id = gr.supplier_id
    left join public.purchase_orders po on po.id = gr.purchase_order_id
    where gr.status in ('confirmed', 'received')
      and coalesce(gr.receiving_location, 'tan_tao') in ('q7', 'tan_tao')
  ),
  matched as materialized (
    select l.*
    from lines l
    where not exists (
      select 1
      from unnest(v_words) q(w)
      where coalesce(l.norm_corrected, '') not ilike '%' || q.w || '%'
        and coalesce(l.norm_raw, '') not ilike '%' || q.w || '%'
        and l.doc_text not ilike '%' || q.w || '%'
    )
  ),
  linked as materialized (
    select
      l.receipt_item_id,
      coalesce(
        (select e.item_id
         from public.kho_review_evidence_links e
         where e.receipt_item_id = l.receipt_item_id
           and e.removed_at is null
         order by e.created_at desc, e.id desc
         limit 1),
        (select min(a.kitchen_inventory_item_id::text)::uuid
         from public.stock_material_aliases a
         where a.location = l.location
           and a.normalized_name = l.norm_corrected
           and a.supplier_id is not distinct from l.supplier_id
           and a.kitchen_inventory_item_id is not null),
        (select min(a.kitchen_inventory_item_id::text)::uuid
         from public.stock_material_aliases a
         where a.location = l.location
           and a.normalized_name = l.norm_raw
           and a.supplier_id is not distinct from l.supplier_id
           and a.kitchen_inventory_item_id is not null
           and not exists (
             select 1 from public.stock_material_aliases c
             where c.location = l.location
               and c.normalized_name = l.norm_corrected
               and c.supplier_id is not distinct from l.supplier_id
           ))
      ) as linked_item_id
    from matched l
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'target_key', p_target_key,
           'receipt_item_id', m.receipt_item_id, 'receipt_number', m.receipt_number,
           'receipt_date', m.receipt_date, 'location', m.location, 'supplier_name', m.supplier_name,
           'product_name', coalesce(m.corrected_name, m.raw_name),
           'raw_name', case
             when m.raw_name is not null
              and public.normalize_stock_item_name(m.raw_name)
                  is distinct from public.normalize_stock_item_name(coalesce(m.corrected_name, m.raw_name))
              then m.raw_name
           end,
           'unit', m.unit, 'actual_quantity', m.actual_quantity,
           'unit_price', m.unit_price, 'image_url', m.image_url, 'score', 1,
           'linked_item_id', m.linked_item_id,
           'jev_verdict', null,
           'jev_probability', null,
           'jev_model', null,
           'posted', exists (
             select 1 from public.q7_inventory_movements mv
             where mv.source = 'goods_receipt' and mv.source_ref_key = 'gr-item:' || m.receipt_item_id::text
             union all
             select 1 from public.tan_tao_material_movements mv
             where mv.source = 'goods_receipt' and mv.source_ref_key = 'gr-item:' || m.receipt_item_id::text
           )
         ) order by m.receipt_date desc, m.receipt_item_id desc), '[]'::jsonb)
  into v_result
  from (
    select l.*, lk.linked_item_id
    from matched l
    left join linked lk on lk.receipt_item_id = l.receipt_item_id
    order by l.receipt_date desc, l.receipt_item_id desc
    limit v_limit
  ) m;

  return v_result;
end;
$$;

revoke all on function public.kho_review_search_lines(text, text, integer)
  from public, anon;
grant execute on function public.kho_review_search_lines(text, text, integer)
  to authenticated, service_role;
