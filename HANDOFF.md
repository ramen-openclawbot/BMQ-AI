# HANDOFF

## Current Version
- apps/web: **0.0.21**
- websites/banhmique-com-rebuild: **0.1.0**
- Branch: `main`
- Latest commit at handoff time: `git log -1 --oneline`

## Latest update (2026-03-07 — v0.0.21)
### Supabase Linter Fixes — RLS Performance + Duplicate Indexes
- **Migration** `20260307140000_supabase_linter_fixes.sql`: Fix 23 cảnh báo từ Supabase Performance Advisor.
- **RLS InitPlan fix (5 policies)**: Thay `auth.uid()` → `(select auth.uid())` trên 4 bảng (`user_module_permissions`, `user_invitations`, `audit_logs`, `ai_function_rate_limits`). Ngăn re-evaluate auth function mỗi row.
- **Drop redundant permissive policies (11 bảng)**: Xoá SELECT policy thừa khi đã có FOR ALL policy. Ảnh hưởng: 6 bảng mini_crm, `cash_fund_topups`, `ceo_daily_closing_declarations`, `customer_po_inbox`, `daily_reconciliations`, `supplier_aliases`.
- **Drop duplicate indexes**: Xoá 2 index trùng trên `inventory_batches` (`idx_inventory_batches_expiry`, `idx_inventory_batches_inventory_item`).

## Previous update (2026-03-07 — v0.0.20)
### Performance Optimization — Tăng tốc hiển thị data
- **QueryClient config**: `staleTime` 30s → 2 phút, tắt `refetchOnWindowFocus` — giảm ~80% refetch spam.
- **usePaymentStats refactor**: thay fetch ALL rows + filter JS → 6 query song song với server-side `.eq()` + `count: "exact"`. Sidebar badge không còn gây refetch khi chuyển trang.
- **useSupplierStats refactor**: 4 query riêng → 1 query duy nhất với Supabase joins (`suppliers → purchase_orders, goods_receipts, payment_requests`). Giảm 75% round-trips.
- **useDebtStats + useMonthlyReceiptStats**: tăng staleTime lên 2 phút, chạy queries song song.
- **Code splitting**: 8 pages nặng chuyển sang `React.lazy()`: MiniCrm (92KB), FinanceControl (49KB), Reports, NiraanDashboard, SkuCosts*, FinanceRevenueControl. Recharts (393KB) giờ chỉ load khi vào trang chart.
- **Kết quả build**: main chunk giảm từ 3,674KB → 3,047KB (gzip: 1,049 → 886KB, giảm 16%).

## Previous update (2026-03-07 — v0.0.19)
### Rate Limiting cho AI Scan Functions — chống spam API tốn tiền
- **SQL migration** `20260307120000_ai_rate_limits.sql`: bảng `ai_function_rate_limits` — per-user per-function daily counter, RLS owner-read-only, cleanup function.
- **Shared utility** `_shared/rate-limiter.ts`: `checkAndRecordRateLimit()` + `getRateLimitHeaders()`. Dùng PostgreSQL, graceful degradation nếu DB lỗi (allow request).
- **6 functions được rate limit**:
  - `scan-invoice`: 100/ngày
  - `scan-bank-slip`: 100/ngày
  - `scan-purchase-order`: 100/ngày
  - `scan-sku-cost-sheet`: 50/ngày + **fix thêm requireAuth()** (trước đó public)
  - `finance-extract-slip-amount`: 200/ngày
  - `match-delivery-note`: 150/ngày
- **Frontend**: `callEdgeFunction()` xử lý HTTP 429 → `isRateLimited: true` + message tiếng Việt.
- **Response headers**: `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`.

## Previous update (2026-03-07 — v0.0.18)
### Security Hardening — Comprehensive fix cho 16 lỗ hổng bảo mật
- **Shared CORS module** (`supabase/functions/_shared/cors.ts`): Origin whitelist thay vì wildcard `*`. Áp dụng cho tất cả 26 edge functions.
- **Shared auth helper** (`supabase/functions/_shared/auth.ts`): `requireAuth()` validate JWT, `requireCronSecret()` validate cron secret. Fail hard nếu thiếu config.
- **Open Redirect fix**: `google-drive-auth` và `google-gmail-auth` — validate redirect URL chỉ cho phép domain whitelisted.
- **Auth enforcement**:
  - `finance-extract-slip-amount`: thêm `requireAuth()` (trước đó hoàn toàn public).
  - `scan-invoice`: chuyển từ auth optional → bắt buộc via `requireAuth()`.
  - `po-gmail-sync`: enforce JWT auth (trước đó chỉ log, không chặn).
  - `finance-auto-reconcile`: `requireCronSecret()` — fail 500 nếu env var trống.
  - `po-gmail-ingest`: tương tự, required cron secret.
- **verify_jwt bật cho 14 functions** trong `config.toml`: scan-invoice, scan-purchase-order, scan-drive-folder, sync-drive-index, create-invoice-from-pr, match-delivery-note, create-warehouse-receipt, scan-bank-slip, scan-sku-cost-sheet, user-invite-member, user-delete-member, finance-extract-slip-amount, po-gmail-sync, get-ai-credit-balance.
- **verify_jwt giữ false** cho: google-drive-auth, google-gmail-auth (OAuth callbacks), finance-auto-reconcile, po-gmail-ingest (cron jobs), + 8 functions cần audit thêm.
- **Audit logging**: bảng `audit_logs` (migration `20260307100000_audit_logs.sql`), RLS owner-read-only. Logging trong `user-invite-member` và `user-delete-member`.
- **Bug fix**: Xoá reference `authInfo` không tồn tại trong `po-gmail-sync` response.
- **Deferred**: M2 (implicit→PKCE), M3 (rate limiting), L2 (audit 8 remaining functions).

## Previous update (2026-03-07 — v0.0.17)
### User Role Management — RBAC UI cho Owner
- **SQL migration**: `supabase/migrations/20260307000000_user_management_tables.sql`
  - Bảng `user_module_permissions`: per-user per-module access (can_view/can_edit), RLS owner-only + user đọc quyền chính mình.
  - Bảng `user_invitations`: email invite + role, RLS owner-only.
  - Auto-seed default permissions cho existing users dựa trên role.
- **AuthContext mở rộng**: fetch `user_roles` + `user_module_permissions` khi auth init.
  - Expose: `roles`, `isOwner`, `canAccessModule(key)`, `canEditModule(key)`, `refreshRoles()`.
  - Owner bypass: luôn return true cho mọi module.
- **Hooks mới** (`src/hooks/useUserManagement.ts`):
  - `useUsersList()`, `useAllPermissions()`, `useAssignRole()`, `useUpdatePermission()`, `useInvitations()`, `useInviteUser()`, `useCancelInvitation()`.
- **Trang mới** `/user-management` (`src/pages/UserManagement.tsx`) — 3 tabs:
  - Tab 1 "Người dùng": bảng user + dropdown đổi role + guardrail (không đổi role mình, không xoá owner cuối).
  - Tab 2 "Mời thành viên": form invite email + role + danh sách pending + cancel.
  - Tab 3 "Phân quyền": matrix checkbox 16 modules × non-owner users (can_view/can_edit).
- **Sidebar cập nhật**: mục "Quản lý người dùng" (icon Shield) đầu Execution section, chỉ Owner thấy.
  - Tất cả nav items đều lọc theo `canAccessModule(moduleKey)`.
- **OwnerRoute** (`src/components/OwnerRoute.tsx`): redirect nếu !isOwner.
- **AppRoutes**: route `/user-management` bọc OwnerRoute.
- **LanguageContext**: thêm key `userManagement` (EN: "User Management", VI: "Quản lý người dùng").
- **16 module keys** phân quyền: dashboard, reports, niraan_dashboard, finance_cost, finance_revenue, crm, sales_po_inbox, purchase_orders, inventory, goods_receipts, sku_costs, suppliers, invoices, payment_requests, low_stock, settings.

### Files tạo mới
- `supabase/migrations/20260307000000_user_management_tables.sql`
- `apps/web/src/pages/UserManagement.tsx`
- `apps/web/src/hooks/useUserManagement.ts`
- `apps/web/src/components/OwnerRoute.tsx`

### Files sửa
- `apps/web/src/contexts/AuthContext.tsx` — thêm roles, permissions, isOwner, canAccessModule, canEditModule
- `apps/web/src/contexts/LanguageContext.tsx` — thêm key userManagement
- `apps/web/src/components/layout/Sidebar.tsx` — thêm mục mới + permission filtering
- `apps/web/src/components/AppRoutes.tsx` — thêm route /user-management + OwnerRoute
- `apps/web/package.json` — version 0.0.17

### Pending
- Chạy migration SQL trên Supabase Dashboard trước khi deploy.
- Security fixes (27 verify_jwt=false functions, Open Redirect, RLS, CORS) — deferred.

## Previous update (2026-03-06 — v0.0.16)
### Performance optimization: Finance Control page load speed
- **staleTime + gcTime** cho tất cả React Query hooks trong finance:
  - Daily queries: staleTime 30s, Monthly: 5 phút, gcTime: 10 phút.
  - Loại bỏ refetch không cần thiết khi focus tab hoặc re-render.
- **Lazy load monthly query**: chỉ fetch khi user click tab "Chốt tháng" (thêm param `enabled`).
- **Loại bỏ base64 images khỏi initial query**: `useDailyDeclaration` chỉ select lightweight columns, ảnh slip được load riêng qua `useDailyDeclarationImages()` (triggered on hover vào khu vực CEO upload).
- **Tạo `useQtmOpeningBalance()` hook**: thay thế raw useEffect với 2 Supabase query → React Query hook với cache + dedup + error handling.
- **Optimize `useUncDetailAmount`**: thử single `.or()` query thay vì 2 query song song; fallback tự động nếu PostgREST không hỗ trợ.
- **Error handling**: destructure `error` từ tất cả useQuery hooks, hiển thị toast khi có lỗi tải dữ liệu.

### QA fixes
- `useQtmOpeningBalance`: thêm check `error` từ cả 2 Supabase query (trước đó silent fail trả 0).
- `FinanceControl.tsx`: surface tất cả query errors ra toast cho user thấy.

### Security audit (report only — chưa fix)
- Phát hiện 27 Edge Functions có `verify_jwt = false`.
- Phát hiện Open Redirect trong google-drive-auth.
- Phát hiện RLS policies dùng `using (true)` cho 8+ bảng CRM.
- Phát hiện CORS `*` trên tất cả edge functions.
- Xem chi tiết trong session notes. Cần fix ở phiên tiếp theo.

### Files changed
- `apps/web/src/hooks/useFinanceReconciliation.ts` — rewrite: 5 hooks mới/cải tiến
- `apps/web/src/pages/FinanceControl.tsx` — integrate hooks mới, lazy load, error handling
- `apps/web/package.json` — bump 0.0.15 → 0.0.16

## Latest update (2026-03-06 night)
### Finance Control reconciliation hotfixes (UNC/QTM scan + OCR timeout mitigation)
- Fix auth profile fetch 406 (PGRST116): đổi `single()` -> `maybeSingle()` trong `AuthContext`.
- Tối ưu scan folder cho đối soát:
  - `scan-drive-folder` hỗ trợ `skipProcessed` + `folderType`, lọc file đã xử lý ở server-side trước khi tải base64.
  - thêm timeout cho từng request Google Drive (list/download) để tránh treo cả request UNC.
- Tối ưu OCR UNC/QTM:
  - nén/resize ảnh slip client-side trước khi gọi `finance-extract-slip-amount` để giảm payload, giảm xác suất timeout.
- Đánh dấu processed ngay sau đối soát:
  - sau khi quét & đối soát ngày xong, upsert `drive_file_index` với `processed=true`, `processed_at`, `last_seen_at` để lần chạy sau bỏ qua nhanh hơn, kể cả khi sync index nền bị chậm.
- User validation:
  - 2026-03-06 22:59 ICT: user xác nhận bản fix mới chạy tốt trên luồng đối soát.

### Commit đáng chú ý (2026-03-06)
- `32fc855` fix(auth): avoid 406 when profile row is missing by using maybeSingle
- `6b99ecd` perf(reconcile): skip processed files server-side before downloading base64
- `185d1b7` fix(reconcile): persist processed bank-slip markers after daily scan to speed reruns
- `c02d41e` perf(ocr): compress slip images client-side before extract to reduce timeout risk
- `c7af090` perf(scan-drive-folder): add per-request timeouts to avoid UNC scan hanging

## Latest update (2026-03-03 early morning)
### PO Quick View + Revenue Control filter hardening
- PO Quick View:
  - thêm parse từ nội dung email (cho case không có attachment),
  - mở rộng parser bắt thêm pattern `name qty: note` và `name: (0 ...)`,
  - fix lưu `po_number` vào top-level DB (không chỉ trong `raw_payload`),
  - thêm status inline cho nút lưu tóm tắt PO (đang lưu/thành công/thất bại + lỗi chi tiết),
  - thêm tổng SL trong tab QL sản xuất,
  - fix VAT để tôn trọng giá trị user nhập (không auto normalize tăng lên).
- Đẩy sang kiểm soát doanh thu:
  - giữ status thành công/thất bại hiển thị ổn định sau khi refetch,
  - chỉ reset status khi đổi sang PO khác.
- Kiểm soát doanh thu (`/finance-revenue-control`):
  - bổ sung lọc theo **khoảng ngày** (from/to),
  - bổ sung lọc theo **tháng**,
  - danh sách PO + widget tổng doanh thu đồng bộ theo bộ lọc đã chọn.

### Commit đáng chú ý (2026-03-03)
- `54fb932` ux(po-quickview): show clearer success/failure feedback for revenue post with detailed error message
- `c59bd3d` feat(po-quickview): add parse-from-email-body action for non-attachment PO emails
- `1c82479` fix(po-quickview): persist top-level po_number on save, add inline save status, and show total qty in production tab
- `2598389` fix(email-body-parse): support 'name qty: note' and '(0 ...)' patterns in PO quickview
- `0d9289f` fix(po-quickview): stop auto-inflating VAT to 8% and respect user-entered VAT values
- `35435a5` fix(po-quickview): keep revenue post status visible after save/invalidate and reset only when switching PO
- `ff68b11` feat(revenue-control): support date-range and month filters with synced PO list/widgets

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

## Latest update (2026-03-02) — PO Gmail Sync popup + JWT incident

### What was implemented
- Reworked PO Gmail sync UX to **2-step flow**:
  1) Preview in popup (không ghi DB)
  2) Import on explicit user action (mới ghi `customer_po_inbox`)
- Added popup states: syncing / preview success / import success / error.
- Added preview list + selected item detail (from, subject, snippet, attachments).
- Added explicit import button: **"Nhập PO vào hệ thống"** and cancel button.

### Incident summary
- Symptom: popup showed `HTTP 401 - Invalid JWT` even after re-login.
- Root cause: `po-gmail-sync` function **missing config** in `supabase/config.toml`, so JWT verification remained enabled at gateway level.
- Why other syncs still worked: those functions already had `verify_jwt = false`.

### Fixes applied
- Added:
  - `[functions.po-gmail-sync]`
  - `verify_jwt = false`
- Redeployed `po-gmail-sync` with `--no-verify-jwt`.
- Frontend error handling improved to show step + HTTP status + raw message.

### Commits (main)
- `323f083` feat(po-sync): preview popup + explicit import
- `efdb0a8` fix(po-sync-ui): detailed HTTP errors in popup
- `6e5e278` fix(auth): pre-validate session + friendly Invalid JWT message
- `8822c5c` fix(po-gmail-sync): remove hard JWT gate in function code
- `6c8405c` fix(supabase): disable JWT verification for `po-gmail-sync`

### Current status
- User confirmed flow is working again.
- Remaining work (next session): security review for all exposed functions using `verify_jwt = false` and apply scoped auth controls where needed.
