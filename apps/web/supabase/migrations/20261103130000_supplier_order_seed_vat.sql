-- Đặt hàng: the 84 catalog rows seeded by 20261103080000 were inserted with vat_rate 0,
-- so orders to those suppliers showed no VAT (owner 28/10: Nam Nguyễn decal 15 cuộn,
-- the invoice has 8%). Set each seeded row's rate from the supplier's latest PO that
-- carries the item (VAT amount / line total, snapped to 0, 5, 8 or 10 %), else from the
-- supplier's latest PO, else leave 0. Rows added by a person (created_by set) and rows
-- older than the seed (the original Phúc Thịnh / TV Food rows) are not touched.

create or replace function public.supplier_order_po_vat_rate(
  p_supplier_id uuid,
  p_item_id uuid default null
)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with pos as (
    select po.id, po.order_date, po.vat_amount, sum(poi.line_total) as subtotal,
           bool_or(
             p_item_id is not null and exists (
               select 1
               from public.stock_material_aliases a
               where a.kitchen_inventory_item_id = p_item_id
                 and a.normalized_name = public.normalize_stock_item_name(poi.product_name)
                 and (a.supplier_id = p_supplier_id or a.supplier_id is null)
             )
           ) as has_item
    from public.purchase_orders po
    join public.purchase_order_items poi on poi.purchase_order_id = po.id
    where po.supplier_id = p_supplier_id
      and po.status <> 'cancelled'::public.purchase_order_status
    group by po.id, po.order_date, po.vat_amount
    having sum(poi.line_total) > 0
  ),
  picked as (
    select coalesce(vat_amount, 0) / subtotal * 100 as ratio
    from pos
    order by has_item desc, order_date desc, id desc
    limit 1
  )
  select (
    select v.c
    from (values (0::numeric), (5::numeric), (8::numeric), (10::numeric)) v(c)
    order by abs(v.c - picked.ratio) asc, v.c asc
    limit 1
  )
  from picked;
$$;

revoke all on function public.supplier_order_po_vat_rate(uuid, uuid) from public, anon, authenticated;
grant execute on function public.supplier_order_po_vat_rate(uuid, uuid) to service_role;

update public.supplier_order_catalog_items c
set vat_rate = r.rate,
    updated_at = now()
from (
  select c2.id, public.supplier_order_po_vat_rate(c2.supplier_id, c2.kitchen_inventory_item_id) as rate
  from public.supplier_order_catalog_items c2
  where c2.created_by is null
    and c2.vat_rate = 0
    and c2.created_at >= timestamptz '2026-10-28 00:00:00+07'
) r
where c.id = r.id
  and r.rate is not null
  and r.rate > 0;
