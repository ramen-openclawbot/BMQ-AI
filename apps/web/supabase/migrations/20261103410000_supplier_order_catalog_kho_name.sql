-- Tên món đặt hàng = tên trong danh mục kho (anh Tâm 29/10: email Cholimex ghi
-- "T. Ối gói 10g" thay vì "Tương ớt Cholimex gói 10g").
--
-- supplier_order_catalog_items.product_name là nguồn tên cho catalog, quote,
-- PO, email và tin Zalo. Nó từng được seed từ tên trên hoá đơn cũ của NCC.
--   1. Món mới hoặc đổi món kho: product_name lấy tên kho.
--   2. Đổi tên món kho: các dòng catalog đang dùng tên cũ đi theo tên mới.
--   3. Backfill toàn bộ, trừ các dòng nghi gắn nhầm món kho (giữ nguyên để
--      không gửi sai tên cho NCC; chờ anh Tâm xác nhận ghép lại).
-- Sửa tay product_name trong "Sửa danh mục" vẫn được giữ.

create or replace function public.supplier_order_catalog_use_kho_name()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  if TG_OP = 'UPDATE'
     and NEW.kitchen_inventory_item_id is not distinct from OLD.kitchen_inventory_item_id then
    return NEW;
  end if;

  select nullif(btrim(name), '')
    into v_name
  from public.kitchen_inventory_items
  where id = NEW.kitchen_inventory_item_id;

  if v_name is not null then
    NEW.product_name := v_name;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_supplier_order_catalog_use_kho_name
  on public.supplier_order_catalog_items;
create trigger trg_supplier_order_catalog_use_kho_name
  before insert or update of kitchen_inventory_item_id
  on public.supplier_order_catalog_items
  for each row
  execute function public.supplier_order_catalog_use_kho_name();

create or replace function public.supplier_order_catalog_follow_kho_rename()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(btrim(NEW.name), '') is null
     or NEW.name is not distinct from OLD.name then
    return NEW;
  end if;

  update public.supplier_order_catalog_items
     set product_name = btrim(NEW.name),
         updated_at = now()
   where kitchen_inventory_item_id = NEW.id
     and (
       product_name is null
       or btrim(product_name) = ''
       or lower(btrim(product_name)) = lower(btrim(coalesce(OLD.name, '')))
     );
  return NEW;
end;
$$;

drop trigger if exists trg_kitchen_item_rename_supplier_catalog
  on public.kitchen_inventory_items;
create trigger trg_kitchen_item_rename_supplier_catalog
  after update of name on public.kitchen_inventory_items
  for each row
  execute function public.supplier_order_catalog_follow_kho_rename();

revoke all on function public.supplier_order_catalog_use_kho_name()
  from public, anon, authenticated;
revoke all on function public.supplier_order_catalog_follow_kho_rename()
  from public, anon, authenticated;

-- Backfill. Các dòng dưới đây có tên NCC khác hẳn món kho đang gắn (nghi ghép
-- nhầm): giữ nguyên tên cũ cho tới khi được ghép lại đúng món.
update public.supplier_order_catalog_items c
   set product_name = btrim(kii.name),
       updated_at = now()
  from public.kitchen_inventory_items kii, public.suppliers s
 where kii.id = c.kitchen_inventory_item_id
   and s.id = c.supplier_id
   and nullif(btrim(kii.name), '') is not null
   and coalesce(btrim(c.product_name), '') is distinct from btrim(kii.name)
   and (btrim(s.name), btrim(coalesce(c.product_name, ''))) not in (
     ('Bao bì Minh Tuấn', 'Túi bánh mì'),
     ('Bao bì Minh Tuấn', 'Bao tấm (giao đợt 1717)'),
     ('Đại Tân Việt', 'Feta Cheese 1kg'),
     ('Ngọc Trân- Cô Trang', 'Gạo nếp 1kg'),
     ('Ngọc Trân- Cô Trang', 'THỚI B BĂNG KEO VÀNG -VP (Bao 100 Cái)'),
     ('Queen Pack', 'Hộp đựng bánh Vuông nâu Kraft ( Hàng Nhập)'),
     ('T&T Foods', 'Mỡ cắt Famadesa (MC)'),
     ('T&T Foods', 'Nạc đùi frimesa ( 1 thùng 25kg)')
   );
