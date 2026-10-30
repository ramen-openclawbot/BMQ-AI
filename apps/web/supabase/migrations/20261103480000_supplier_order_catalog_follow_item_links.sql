-- 2026-10-30 — Món gắn nhà cung cấp tự vào trang Đặt hàng.
--
-- Mỗi liên kết trong kitchen_item_suppliers của một món đang hoạt động và chưa
-- bị gộp luôn có đúng một dòng supplier_order_catalog_items đang hoạt động cùng
-- cặp (supplier_id, kitchen_inventory_item_id):
--   1. AFTER INSERT trên kitchen_item_suppliers tạo dòng catalog còn thiếu, hoặc
--      bật lại dòng đã có nhưng đang tắt (giữ nguyên po_unit, pack_size_po, giá
--      và VAT đã cài; product_name để trigger tên kho điền).
--   2. AFTER DELETE chỉ đặt active = false, không xoá dòng, để lần gắn lại khôi
--      phục đúng cài đặt cũ.  kho_set_item_suppliers xoá rồi chèn lại trong cùng
--      giao dịch vì vậy kết thúc với dòng catalog active.
--   3. Món active = false hoặc đã gộp (merged_into_id is not null) không được
--      tạo dòng catalog.
--
-- Backfill chạy hàm đồng bộ cho 25 liên kết hiện đang thiếu dòng catalog active.
-- Các dòng catalog thêm tay không có liên kết (12 dòng) không bị đụng tới.
--
-- Hàm nội bộ, không cấp quyền execute cho anon/authenticated.

-- ===========================================================================
-- 1. Internal sync helper
-- ===========================================================================

create or replace function public.supplier_order_catalog_sync_link(
  p_supplier_id uuid,
  p_item_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.kitchen_inventory_items%rowtype;
  v_row public.supplier_order_catalog_items%rowtype;
  v_factor numeric;
  v_default_rate numeric;
begin
  if p_supplier_id is null or p_item_id is null then
    return;
  end if;

  select * into v_item
  from public.kitchen_inventory_items
  where id = p_item_id;

  -- Retired and merged items never enter the supplier order catalog.
  if not found
     or v_item.active is not true
     or v_item.merged_into_id is not null then
    return;
  end if;

  select * into v_row
  from public.supplier_order_catalog_items
  where supplier_id = p_supplier_id
    and kitchen_inventory_item_id = p_item_id
  for update;

  if found then
    -- Already active: leave every setting untouched.
    if v_row.active then
      return;
    end if;

    -- Re-link: keep the old unit, pack, price and VAT; just switch it back on.
    update public.supplier_order_catalog_items
       set active = true,
           updated_at = now()
     where id = v_row.id;
    return;
  end if;

  -- Same default as the p_vat_rate is null branch of
  -- supplier_order_catalog_set: the nearest of 0/5/8/10 to the VAT ratio of the
  -- supplier's latest PO.
  select coalesce(
    (
      select v.c
      from (values (0::numeric), (5::numeric), (8::numeric), (10::numeric)) v(c)
      order by abs(v.c - t.vat_ratio) asc, v.c asc
      limit 1
    ),
    0
  )
  into v_default_rate
  from (
    select case
      when sum(poi.line_total) > 0
        then po.vat_amount / sum(poi.line_total) * 100
      else 0
    end as vat_ratio
    from public.purchase_orders po
    join public.purchase_order_items poi on poi.purchase_order_id = po.id
    where po.supplier_id = p_supplier_id
    group by po.id, po.vat_amount, po.order_date
    having sum(poi.line_total) > 0
    order by po.order_date desc, po.id desc
    limit 1
  ) t;
  v_default_rate := coalesce(v_default_rate, 0);

  -- PO unit is the kho unit; count units have no weight/volume conversion and
  -- fall back to 1.
  v_factor := coalesce(
    public.stock_unit_line_factor(v_item.unit, v_item.unit),
    1
  );

  insert into public.supplier_order_catalog_items (
    supplier_id, kitchen_inventory_item_id, product_name, po_unit,
    po_unit_factor, pack_size_po, vat_rate, sort_order, active, created_by
  ) values (
    p_supplier_id, p_item_id, null, v_item.unit,
    v_factor, null, v_default_rate,
    coalesce((
      select max(c.sort_order) + 1
      from public.supplier_order_catalog_items c
      where c.supplier_id = p_supplier_id
    ), 1),
    true, auth.uid()
  )
  on conflict (supplier_id, kitchen_inventory_item_id) do nothing;
end;
$$;

revoke all on function public.supplier_order_catalog_sync_link(uuid, uuid)
  from public, anon, authenticated;

-- ===========================================================================
-- 2. Follow link inserts / deletes
-- ===========================================================================

create or replace function public.supplier_order_catalog_follow_item_link()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if TG_OP = 'INSERT' then
    perform public.supplier_order_catalog_sync_link(NEW.supplier_id, NEW.item_id);
    return NEW;
  end if;

  -- Un-link: keep the catalog row and its settings for a later re-link.
  update public.supplier_order_catalog_items
     set active = false,
         updated_at = now()
   where supplier_id = OLD.supplier_id
     and kitchen_inventory_item_id = OLD.item_id
     and active;
  return OLD;
end;
$$;

revoke all on function public.supplier_order_catalog_follow_item_link()
  from public, anon, authenticated;

drop trigger if exists trg_kitchen_item_suppliers_catalog_sync
  on public.kitchen_item_suppliers;
create trigger trg_kitchen_item_suppliers_catalog_sync
  after insert on public.kitchen_item_suppliers
  for each row
  execute function public.supplier_order_catalog_follow_item_link();

drop trigger if exists trg_kitchen_item_suppliers_catalog_unsync
  on public.kitchen_item_suppliers;
create trigger trg_kitchen_item_suppliers_catalog_unsync
  after delete on public.kitchen_item_suppliers
  for each row
  execute function public.supplier_order_catalog_follow_item_link();

-- ===========================================================================
-- 3. Backfill: every live link missing an active catalog row
-- ===========================================================================

do $$
declare
  v_link record;
begin
  for v_link in
    select kis.supplier_id, kis.item_id
    from public.kitchen_item_suppliers kis
    join public.kitchen_inventory_items kii on kii.id = kis.item_id
    where kii.active is true
      and kii.merged_into_id is null
      and not exists (
        select 1
        from public.supplier_order_catalog_items c
        where c.supplier_id = kis.supplier_id
          and c.kitchen_inventory_item_id = kis.item_id
          and c.active
      )
  loop
    perform public.supplier_order_catalog_sync_link(
      v_link.supplier_id, v_link.item_id
    );
  end loop;
end;
$$;
