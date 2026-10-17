-- 2026-10-17 — get_item_receipt_lines: same rows, ~25x faster.
--
-- Owner 17/10 (IMG_5833): Xuan Mai's "Quy đổi tồn 16/10" cards all showed
-- "Chưa tải được phiếu nhập". Each card calls get_item_receipt_lines; the old
-- body read receipt_lines_for_game_base(null), which runs the name normaliser
-- and the non-stock check on every receipt line (~1 500 rows, ~2.2 s per call).
-- Six cards plus retries ran in parallel and every call hit the 8 s
-- statement_timeout of the authenticated role (logs 05:55 UTC: 57014).
--
-- The new body applies the cheap filters of receipt_lines_for_game_base first and
-- keeps only receipts from the item's alias suppliers (every live alias has a
-- supplier; a null-supplier alias still matches null-supplier receipts), then
-- normalises names. Checked on live data before shipping: the same line set for
-- all 78 items with aliases (77 byte-identical, one differed only in the order of
-- two lines of one receipt); average 2 266 ms -> 102 ms. Order now breaks ties
-- by goods_receipt_item_id so it is stable. Gate, signature and grants unchanged.

create or replace function public.get_item_receipt_lines(
  p_item_id uuid,
  p_limit integer default 12
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 12), 30));
begin
  -- Owner or Q7 stock admin only, exactly like the backlog review.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  return coalesce((
    with al as (
      select a.location, a.normalized_name, a.supplier_id
      from public.stock_material_aliases a
      where a.kitchen_inventory_item_id = p_item_id
    ),
    -- Cheap filters first: only this item's suppliers, so the name normaliser
    -- runs on a few dozen lines instead of every receipt line (owner 17/10:
    -- 12 parallel calls each scanned ~1 500 lines and hit the 8 s timeout).
    cand as materialized (
      select
        gr.id as goods_receipt_id,
        gri.id as goods_receipt_item_id,
        coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao') as location,
        gr.supplier_id,
        coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as line_name,
        gr.receipt_number,
        gr.receipt_date,
        gr.status::text as status,
        nullif(btrim(gri.unit), '') as unit,
        gri.unit_price,
        nullif(btrim(gr.image_url), '') as image_path,
        coalesce(gr.product_photos, '{}'::text[]) as photo_paths,
        public.goods_receipt_effective_quantity(
          gri.actual_quantity, gri.quantity, gri.ordered_quantity, gr.status::text
        ) as quantity
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      left join public.suppliers s on s.id = gr.supplier_id
      where (
          gr.supplier_id in (select al.supplier_id from al where al.supplier_id is not null)
          or (gr.supplier_id is null and exists (select 1 from al where al.supplier_id is null))
        )
        and gr.status in ('confirmed', 'received')
        and coalesce(s.stock_exempt, false) = false
        and coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao') in ('q7', 'tan_tao')
    ),
    b as materialized (
      select c.*, public.normalize_stock_item_name(c.line_name) as normalized_name
      from cand c
      where public.stock_line_auto_non_stock(c.line_name) is null
    )
    select jsonb_agg(to_jsonb(t) order by t.receipt_date desc, t.receipt_number desc, t.goods_receipt_item_id)
    from (
      select
        b.goods_receipt_id,
        b.goods_receipt_item_id,
        b.receipt_number,
        b.receipt_date,
        b.status,
        sup.name as supplier_name,
        coalesce(
          (select c.corrected_name
             from public.stock_name_corrections c
            where c.normalized_name = b.normalized_name),
          b.line_name
        ) as raw_name,
        b.quantity,
        b.unit,
        b.unit_price,
        b.quantity * b.unit_price as line_total,
        b.image_path,
        b.photo_paths
      from b
      join al
        on al.location = b.location
       and al.normalized_name = b.normalized_name
       and al.supplier_id is not distinct from b.supplier_id
      left join public.suppliers sup on sup.id = b.supplier_id
      order by b.receipt_date desc, b.receipt_number desc, b.goods_receipt_item_id
      limit v_limit
    ) t
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.get_item_receipt_lines(uuid, integer) from public, anon;
grant execute on function public.get_item_receipt_lines(uuid, integer) to authenticated, service_role;
