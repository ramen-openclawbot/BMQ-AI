-- Anh Tâm 31/10: các PO KFM tháng 10 không có trong bảng final của kế toán
-- (kế toán chỉ liệt kê PO giao thiếu) đều đã giao đủ 100%. Ghi nhận SL giao
-- = SL PO, nguồn kế toán, để dashboard không còn "tạm tính". Không ghi đè PO đã có số.
insert into public.kfm_po_deliveries (po_number, customer_po_inbox_id, delivery_date, po_qty, delivered_qty, source, note)
select p.po_number, p.id, p.delivery_date, p.po_qty, p.po_qty, 'ke_toan', 'Kế toán xác nhận giao đủ 100% (31/10)'
from (
  select distinct on (upper(btrim(i.po_number)))
    upper(btrim(i.po_number)) as po_number, i.id, i.delivery_date,
    coalesce((select sum(poi.ordered_qty) from public.production_orders po
              join public.production_order_items poi on poi.production_order_id = po.id
              where po.source_po_inbox_id = i.id), 0) as po_qty
  from public.customer_po_inbox i
  where i.delivery_date between date '2026-10-01' and date '2026-10-31'
    and i.po_number ilike 'PO100%'
    and i.match_status = 'approved'
  order by upper(btrim(i.po_number)), i.created_at asc nulls last, i.id
) p
where not exists (select 1 from public.kfm_po_deliveries d where upper(btrim(d.po_number)) = p.po_number)
on conflict (po_number) do nothing;
