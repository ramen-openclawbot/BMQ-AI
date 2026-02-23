# HANDOFF

## Current Version
- apps/web: **0.0.5**
- websites/banhmique-com-rebuild: **0.1.0**
- Branch: `main`
- Latest commit at handoff time: `95dfe16`

## What is done (latest)
1. Dashboard đã rút gọn theo hướng overview ngắn; bỏ các block dài gây rối.
2. Chuẩn hóa nhãn UI tiếng Việt ngắn gọn cho các khối dashboard.
3. Đã fix scan hóa đơn ở Add Invoice (mobile-friendly fallback + thông báo lỗi rõ ràng + toast thành công).
4. Đã fix tạo phiếu nhập kho theo flow an toàn hơn:
   - tạo receipt ở `draft` trước,
   - tạo items,
   - rồi mới chuyển `confirmed`.
5. Đã fix tương thích schema lệch môi trường cho phiếu nhập (fallback khi thiếu cột `manufacture_date`).
6. Đã tách domain nghiệp vụ rõ ràng:
   - Phiếu nhập kho = **nguyên vật liệu**,
   - COGS/SKU Cost = **SKU thành phẩm**.
7. Đã đổi nhãn module cost sang ngữ nghĩa COGS:
   - “Tính chi phí giá vốn hàng bán”,
   - “Tổng quan giá vốn”, “Quản trị SKU thành phẩm”, “Phân tích giá vốn”.
8. Đã triển khai tách loại SKU ở tầng dữ liệu + guardrail DB:
   - thêm `sku_type` (`raw_material` | `finished_good`) cho `product_skus`,
   - backfill từ `category`,
   - trigger chặn `goods_receipt_items` nếu dùng SKU thành phẩm.
9. User xác nhận đã chạy xong migration SQL production.

## Migration mới quan trọng
- `apps/web/supabase/migrations/20260223203000_supplier_aliases.sql`
- `apps/web/supabase/migrations/20260223173000_sku_type_and_goods_receipt_guardrails.sql`
- `apps/web/supabase/migrations/20260223193000_supplier_scan_templates.sql`

## Confirmed by user
- User đồng ý release luôn sau khi chạy SQL migration.

## Pending / Follow-up (khuyến nghị)
1. Viết migration đồng bộ schema để bỏ fallback tạm cho `manufacture_date` khi tất cả env đã đồng nhất.
2. Bổ sung UAT checklist chính thức cho 2 domain:
   - Kho NVL,
   - COGS thành phẩm.
3. (Tuỳ chọn) tăng ràng buộc DB cho các flow nhập/xuất thành phẩm nếu mở rộng kho thành phẩm đầy đủ.

## Recent commits
- `758edf6` feat(ncc-alias): implement Supplier Alias Manager UI and alias-priority scan matching
- `dd4f74d` feat(scan-learning): add supplier template memory and stronger canonical supplier matching
- `95dfe16` feat(domain): enforce SKU type separation for raw-material receiving vs finished-goods COGS
- `0ab6b3e` refactor(domain): separate raw-material GRN SKU flow from finished-goods COGS module
- `524729d` fix(goods-receipt): tolerate missing manufacture_date column when inserting receipt items
- `6cec5ec` fix(goods-receipt): create as draft then confirm after items; surface real DB errors and rollback on failure
- `777bedb` fix(invoice-scan): add apikey header fallback and user-facing scan errors on mobile

## Notes for next assignee
- Đảm bảo environment production đã có migration `20260223173000_sku_type_and_goods_receipt_guardrails.sql` (user báo đã run).
- Verify sau deploy:
  - `/goods-receipts`: chỉ nhận SKU nguyên vật liệu.
  - `/sku-costs/*`: chỉ xử lý SKU thành phẩm cho COGS.
  - Add Invoice scan hoạt động ổn trên mobile.
  - `/settings` hiển thị version từ semver package (`0.0.5`).


## Shortcut/output rule (user preference)
- Với mọi tác vụ tạo file mới (đặc biệt SQL migration), luôn tạo shortcut tại `output/_latest/` để user mở nhanh.
- Chuẩn tối thiểu:
  - `output/_latest/latest-migration.sql` -> migration SQL mới nhất
  - `output/_latest/<ten-file-goc>.sql` -> shortcut theo đúng tên file
- Nếu đã có shortcut cũ, cập nhật lại bằng symlink mới nhất (`ln -sfn`).


## Latest update (NCC Alias Manager UI)
- Added Settings section **NCC Alias Manager** for alias CRUD (map alias -> NCC chuẩn).
- Scan backend now ưu tiên alias match trước scoring fallback, giúp case STC ổn định hơn.
- Goods Receipt dialog hiển thị metadata NCC quét được + nguồn match (alias/scoring).
- Shortcut migration đã tạo tại `output/_latest/latest-migration.sql` và `output/_latest/20260223203000_supplier_aliases.sql`.
