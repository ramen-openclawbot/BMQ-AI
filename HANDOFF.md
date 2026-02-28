# HANDOFF

## Current Version
- apps/web: **0.0.9**
- websites/banhmique-com-rebuild: **0.1.0**
- Branch: `main`
- Latest commit at handoff time: `a370e0f`

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
- `apps/web/supabase/migrations/20260227093000_finance_reconciliation.sql`
- `apps/web/supabase/migrations/20260228111500_finance_slip_images_and_amounts.sql`

## Confirmed by user
- User đồng ý release luôn sau khi chạy SQL migration.

## Pending / Follow-up (khuyến nghị)
1. Viết migration đồng bộ schema để bỏ fallback tạm cho `manufacture_date` khi tất cả env đã đồng nhất.
2. Bổ sung UAT checklist chính thức cho 2 domain:
   - Kho NVL,
   - COGS thành phẩm.
3. (Tuỳ chọn) tăng ràng buộc DB cho các flow nhập/xuất thành phẩm nếu mở rộng kho thành phẩm đầy đủ.

## Recent commits
- `3881f08` fix(scan-invoice): replace rpc().catch chain with try/catch in edge runtime
- `089f1b4` fix(scan-vi): improve Vietnamese seller extraction and alias matching across seller candidates
- `2976191` fix(alias-match): resolve supplier from DB when FE supplier list not loaded during scan
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
  - `/settings` hiển thị version từ semver package (`0.0.9`).


## Shortcut/output rule (user preference)
- Với mọi tác vụ tạo file mới (đặc biệt SQL migration), luôn tạo shortcut tại `output/_latest/` để user mở nhanh.
- Chuẩn tối thiểu:
  - `output/_latest/latest-migration.sql` -> migration SQL mới nhất
  - `output/_latest/<ten-file-goc>.sql` -> shortcut theo đúng tên file
- Nếu đã có shortcut cũ, cập nhật lại bằng symlink mới nhất (`ln -sfn`).


## Latest update (2026-02-27)
- Đã rollback OCR về default OpenAI-only (gỡ hoàn toàn flow Ollama hybrid).
- Đã triển khai trang **Niraan Dashboard** cho investor:
  - route mới `/niraan-dashboard`, menu mới ở sidebar,
  - UI tiếng Anh, layout đơn giản/chuyên nghiệp,
  - quy đổi số liệu từ VND sang USD bằng realtime FX (API + cache refresh định kỳ),
  - hiển thị FX rate và thời điểm cập nhật.
- Đã triển khai module mới **Finance Control** (`/finance-control`) cho đối soát chi phí ngày/tháng theo RO:
  - Daily Reconciliation: UNC detail (auto) vs UNC declared (CEO).
  - Monthly Closing: tổng hợp match/mismatch theo tháng.
  - Migration DB mới: `20260227093000_finance_reconciliation.sql`.

### Workflow ASCII (approved)
```text
[A] UNC folder (auto scan slips) -> UNC Detail Ledger (sum theo ngày)
[B] CEO upload: top-up slip + UNC total declared -> CEO Daily Declaration

Reconciliation Engine:
  compare UNC_DETAIL(day) vs UNC_DECLARED(day)
  variance = detail - declared
  status = MATCH | MISMATCH | PENDING

Output:
  Daily Closing Report + Monthly Closing Summary
```

### UI/UX ASCII (implemented baseline)
```text
Finance Control
 ├─ Daily Reconciliation
 │   - Date
 │   - UNC Detail (auto)
 │   - UNC Declared (CEO input)
 │   - Cash Fund Top-up (CEO input)
 │   - Variance + Status badge
 │   - Save Declaration / Run Reconcile
 └─ Monthly Closing
     - Month picker
     - Total UNC Detail / Declared / Net Variance / Match Rate
     - Daily result table (MATCH/MISMATCH/PENDING)
```

### Auto reconcile 23:59 + email (new)
- Added Edge Function: `finance-auto-reconcile`
  - computes daily reconciliation automatically,
  - upserts `daily_reconciliations`,
  - sends email report via Resend.
- Email settings:
  - From: `ramen@bmq.vn`
  - To: `ketoantruong@bmq.vn`, `tam@bmq.vn`
- Added scheduler job at 23:59 Asia/Saigon:
  - Job name: `finance-auto-reconcile-2359`
  - Trigger endpoint: `/functions/v1/finance-auto-reconcile`
- Required env/secrets for full operation:
  - `RESEND_API_KEY`
  - `FINANCE_CRON_SECRET`
  - `FINANCE_REPORT_FROM`
  - `FINANCE_REPORT_TO`
- Note: if reconciliation tables migration is not yet applied in production, auto job will fail until migration is run.
- CEO daily input updated: upload 2 slips (QTM + UNC), system auto OCR amount and stores slip images directly in DB columns (`qtm_slip_image_base64`, `unc_slip_image_base64`), no manual Top-up URL field.
- Sidebar icons updated to avoid confusion:
  - Niraan Dashboard: `Landmark`
  - Finance Control: `Scale`
  - Reports: `BarChart3`
