-- Gỡ 2 liên kết món – NCC gắn nhầm (anh Tâm 31/10: "Túi bánh mì" lại hiện ở
-- Bao bì Minh Tuấn và bị hiểu là bánh mì).
--
-- Seed kitchen_item_suppliers ngày 30/10 lấy từ các dòng danh mục đặt hàng đã
-- được đánh dấu nghi ghép nhầm món kho (xem 20261103410000):
--   - Bao bì Minh Tuấn "Túi bánh mì" đang trỏ vào món kho "Bánh mì lớn".
--   - Queen Pack "Bánh mì que" đang trỏ vào món kho "Bánh mì que".
-- Bánh mì là hàng của Tuyết Anh; hai NCC bao bì này không bán bánh mì. Xoá
-- liên kết thì trigger unsync tắt dòng danh mục (giữ lại, không xoá), nên món
-- rút khỏi trang Đặt hàng của hai NCC này. Liên kết Tuyết Anh giữ nguyên.

delete from public.kitchen_item_suppliers kis
using public.suppliers s, public.kitchen_inventory_items kii
where s.id = kis.supplier_id
  and kii.id = kis.item_id
  and (btrim(s.name), btrim(kii.name)) in (
    ('Bao bì Minh Tuấn', 'Bánh mì lớn'),
    ('Queen Pack', 'Bánh mì que')
  );
