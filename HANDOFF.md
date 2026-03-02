# HANDOFF

## Current Version
- apps/web: **0.0.12**
- websites/banhmique-com-rebuild: **0.1.0**
- Branch: `main`
- Latest commit at handoff time: `534f5a8`

## Latest update (2026-03-02 evening)
### Mini-CRM cleanup: remove duplicated fields + save flow hardening
- Đã xử lý triệt để luồng edit khách hàng CRM:
  - thông báo lưu thành công/lỗi rõ ràng,
  - tránh silent-fail,
  - cải thiện feedback inline theo theme app.
- Đã chuẩn hóa nhóm khách hàng còn 4 nhóm: `Online`, `Bán lẻ`, `Đại lý`, `B2B`.
- Đã bỏ hoàn toàn các field trùng lặp khỏi UI:
  - `default_revenue_channel` (đã xoá khỏi UI + DB),
  - `customer_code` (đã xoá khỏi Mini-CRM UI).
- Đã cập nhật các Supabase Edge Functions liên quan PO để không phụ thuộc `default_revenue_channel` nữa; kênh doanh thu được map theo `customer_group`.
- Đã chạy migration production để drop cột `default_revenue_channel`.

### Commit đáng chú ý (2026-03-02)
- `1c576b3` fix(db): allow b2b in mini_crm_customers customer_group check
- `20f1f22` refactor(crm): remove default revenue channel field and polish save feedback UI
- `ec2e5d7` refactor(crm): remove default revenue channel field from UI and DB
- `534f5a8` refactor(crm): remove customer code input from mini CRM UI

## Latest update (2026-03-01 night)
### Data Migration + Settings UX
- Đã thêm block **Data Migration** trong `/settings` với 5 phần:
  1) Summary (tables/records/files/estimated size)
  2) Export DB (Schema/JSON/SQL)
  3) Export Storage (Manifest + ZIP)
  4) Guardrails checklist
  5) Import guide checklist
- Đã deploy Edge Function mới: `migration-storage-archive` (Supabase) để tạo ZIP storage theo dữ liệu `drive_file_index`.
- Đã fix UX mobile:
  - dùng `h-dvh` + `safe-area-inset-bottom` để tránh cảm giác lock scroll ở iOS/WebView,
  - thêm điều hướng nội bộ trong trang Settings,
  - thêm anchor tới `#data-migration`.
- Đã nới quyền fallback cho migration UI khi hệ thống chưa cấu hình role (`user_roles` rỗng/lỗi):
  - mặc định cho phép user đã đăng nhập,
  - nếu có role data thì chỉ `owner` mới được phép.

### Commit đáng chú ý
- `1deebef` feat(settings): add Data Migration section + mobile scroll fixes
- `85ee9b9` fix(settings): fallback migration access when roles not configured

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
  - `/settings` hiển thị version từ semver package (`0.0.12`).

## Latest hotfix handoff (2026-03-01)
### Context
- User report liên tiếp trên Mini-CRM PO parse: fail schema, sai VAT, sai subtotal, sai total, sai amount khi đẩy qua Finance.

### What was fixed
1. Bỏ phụ thuộc cột `po_number` trong flow runtime, chuyển qua `raw_payload.po_number` fallback từ subject.
2. Sửa flow post revenue: ghi snapshot `raw_payload.revenue_post` gồm `subtotal`, `vat`, `total`, `posted_at`, `posted_by`.
3. Sửa Finance display: ưu tiên đọc snapshot `revenue_post.total` để tránh lệch nguồn.
4. Harden parser số tiền (`toNum`) theo locale dấu `.`/`,`.
5. Chặn số VAT/Total bất thường bằng sanity check (`sanitizeVat`, `sanitizeTotal`).
6. Fix Kingfood parse để đọc 3 cột tổng theo **tên header**:
   - `Tổng tiền PO (-VAT)`
   - `Tổng thuế`
   - `Tổng tiền PO (+VAT)`
7. UI Mini-CRM ép `Tổng tiền = Tạm tính + VAT` cho save/post để chặn số cũ sai.

### Deploy status
- `po-parse-inbox-order` đã deploy lại nhiều vòng; bản hiện tại parser: `v4`.
- Branch: `main`.

### Process improvement (mandatory next)
- Viết bộ test fixture xlsx thật (Kingfood) + golden expected cho subtotal/vat/total.
- Thêm chế độ `parse_debug` lưu log cột map vào `raw_payload.parse_meta` (chỉ nội bộ).
- Áp dụng canary parse: parse mới chạy song song parse cũ 1 tuần, mismatch thì alert.
- Không merge parser finance nếu chưa có 3 testcase pass: normal / shifted-column / locale-number-mixed.

### New reusable skill (created)
- Path: `skills/po-xlsx-parse-guardrails/SKILL.md`
- References:
  - `skills/po-xlsx-parse-guardrails/references/test-cases.md`
  - `skills/po-xlsx-parse-guardrails/references/rollout-checklist.md`
- Purpose: checklist chuẩn để tránh lặp lại vòng sửa parser PO XLSX.
- Note: để auto-trigger ổn định qua session mới, cần add skill này vào danh sách available skills của OpenClaw runtime.


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
