# HANDOFF

## Current Version
- apps/web: **0.0.33**
- websites/banhmique-com-rebuild: **0.1.0**
- Branch: `main`
- Latest commit at handoff time: `git log -1 --oneline`

## Latest update (2026-04-01 — v0.0.33)
### Finance Module — OCR Bug Fix + Reconciliation Overhaul

**OCR Fix (Edge Functions):**
- `scan-bank-slip/index.ts`: Changed GPT-4o-mini tool schema `amount` from `type: ['number','string','null']` → `type: 'string'` to prevent digit transposition (41.006.300 → 41.060.300). Added `amount_raw` audit field. Updated system prompt to instruct exact string output with Vietnamese format cross-check.
- `finance-extract-slip-amount/index.ts`: Same fix — schema `amount` from `type: "number"` → `type: "string"`. Added `parseAmountVN` server-side parsing + `amount_raw` audit field.

**Reconciliation Rules (FinanceControl.tsx):**
- UNC: Exact match required (`variance === 0`), no tolerance. Bank transfers are automated — any mismatch is flagged.
- QTM: Underspend allowed (CEO declared ≥ folder total = match). Only overspend (folder > declared) = mismatch.
- Overall status: both UNC and QTM must match.

**UX — 1-click Daily Close:**
- Replaced 3-button wizard (Reject/Conditional/Approve) with single "Khoá & Chốt ngày" button.
- Button runs: save → reconcile → lock → approve in one click.
- Unlock button available for re-editing after close.
- Added QTM summary section alongside UNC in closing card.

**Performance (FinanceControl.tsx):**
- Parallel batch processing (BATCH_SIZE=5) in `runFolderReconciliation` — replaced sequential for-loop with `Promise.allSettled`.
- Auto-save after `processSlipUpload` (OCR) — no manual save needed.

**DB Migration** (`20260401090000_finance_v033_reconciliation.sql`):
- Added columns to `daily_reconciliations`: `qtm_spent_from_folder`, `qtm_variance_amount`, `unc_status`, `qtm_status`
- Performance indexes: `idx_daily_reconciliations_closing_date`, `idx_ceo_declarations_closing_date` (DESC)

**Deferred:**
- Component refactoring (split FinanceControl.tsx 1,486 lines into smaller components) — hooks `useDeclarationForm.ts` and `useFolderScan.ts` created but not yet integrated.

## Previous update (2026-03-30 — v0.0.31)
### Feature — Module Sản Xuất (Production Management Pipeline)

**Tổng quan:** Pipeline 6 bước từ PO bán hàng → Sản xuất → QA → Xuất kho → Báo cáo tồn kho.
Kết hợp AI agent gợi ý + người dùng duyệt/xác nhận trên UI.

**Database migration** (`20260330120000_production_module.sql`):
- 6 enums mới: `production_order_status`, `production_shift_type`, `production_shift_status`, `qa_inspection_status`, `warehouse_dispatch_status`, `inventory_movement_type`
- 9 tables mới:
  1. `production_orders` — Lệnh sản xuất (link từ customer_po_inbox)
  2. `production_order_items` — Chi tiết lệnh SX (finished goods)
  3. `production_shifts` — Ca sản xuất
  4. `production_shift_items` — Items phân bổ vào ca
  5. `qa_inspections` — Phiếu kiểm tra QA
  6. `qa_inspection_items` — Chi tiết QA từng SKU
  7. `warehouse_dispatches` — Phiếu xuất kho
  8. `warehouse_dispatch_items` — Chi tiết xuất kho
  9. `inventory_movements` — Sổ kho thống nhất (unified stock ledger)
- RLS: authenticated full access cho tất cả tables mới
- Helper function: `generate_production_number(prefix, date)` cho SX/CA/QA/XK auto-numbering

**Sidebar (Sidebar.tsx):**
- Thêm section "Sản Xuất" với 3 items: Kế hoạch SX, Ca sản xuất, QA & Nhập kho TP
- Thêm 2 items vào section "Vận hành": Xuất kho, Báo cáo tồn kho
- Module key: `production` (cho sidebar permission filtering)

**5 pages mới:**
1. **ProductionPlanning.tsx** (`/production/planning`)
   - Hiển thị PO bán hàng (customer_po_inbox approved) chưa lên lệnh SX
   - Tạo lệnh sản xuất từ PO → production_orders + production_order_items
   - Stats cards: PO chờ SX, Đang thực hiện, Hoàn thành hôm nay
2. **ProductionShifts.tsx** (`/production/shifts`)
   - Board view 7 ngày (tuần), mỗi cột 1 ngày hiển thị shift cards
   - Tạo ca, phân bổ items từ lệnh SX, gán người
   - Transition: scheduled → in_progress → completed (cập nhật actual_qty)
3. **QAInspection.tsx** (`/production/qa`)
   - Tạo phiếu QA, kiểm tra qty approved/rejected
   - **Business logic quan trọng**: Duyệt QA → nhập kho thành phẩm:
     - Upsert inventory_items cho finished goods
     - Insert inventory_movements type='production_output'
   - TODO: Raw material consumption via BOM (sku_formulations) chưa implement
4. **WarehouseDispatch.tsx** (`/warehouse/dispatch`)
   - Tạo phiếu xuất kho giao khách
   - Status flow: pending → picked → dispatched → delivered
   - Xuất kho (dispatched) → deduct inventory_items + insert inventory_movements type='dispatch_out'
5. **StockReport.tsx** (`/warehouse/stock-report`)
   - Báo cáo tồn kho theo kỳ (date range)
   - 3 sections: Tồn kho hiện tại, Lịch sử nhập xuất, Đối soát tồn kho
   - Filter theo SKU type (NVL/TP) và search theo tên

**LanguageContext** — thêm translations cho: sectionProduction, productionPlanning, productionShifts, qaInspection, warehouseDispatch, stockReport

**Routing (AppRoutes.tsx)** — 5 lazy-loaded routes mới

**Kho hàng:** Cùng 1 kho, phân biệt NVL vs TP bằng `product_skus.sku_type`

**TODO cho phases tiếp theo:**
- AI agent tự động suggest production plan từ PO (Edge Function)
- Raw material consumption tự động từ BOM (sku_formulations) khi QA duyệt
- AI agent QA phân tích ảnh thành phẩm
- Realtime notification khi có PO mới / QA cần duyệt
- Module permission `production` cần add cho users qua User Management

**Deploy:**
1. `supabase db push` hoặc chạy migration `20260330120000_production_module.sql`
2. Deploy frontend (Vercel hoặc build + upload)
3. Add `production` module permission cho users cần truy cập

## Previous update (2026-03-24 — v0.0.30)
### Bug Fix — "Duyệt & áp dụng KB" không thông báo sau AI Tính Toán

**Root cause:**
- `approveKbLatestRequestMutation` chỉ hoạt động khi có pending change request trong DB (tạo bởi "Gửi duyệt KB")
- Khi user chạy "AI Tính Toán" xong rồi click "Duyệt & áp dụng KB" trực tiếp (bỏ qua "Gửi duyệt KB"), không có pending record → mutation throw silent error → không có toast nào hiện ra
- UI không giải thích tại sao không có phản hồi → confusing UX

**Fix (`MiniCrm.tsx` — `approveKbLatestRequestMutation`):**
- Nếu **có** pending request: dùng data từ pending request (behavior cũ, giữ nguyên)
- Nếu **không có** pending request: dùng current form state trực tiếp (profile name, po_mode, calc_notes, business_description, `kbAiSuggestion`, operational_notes) — áp dụng ngay không qua bước "Gửi duyệt"
- Version snapshot vẫn được insert trong cả 2 trường hợp
- `change_note` dùng: `pending.change_note` → `kbChangeNote` → fallback `"Direct KB apply"`

**Kết quả:** User có thể chạy AI Tính Toán → click "Duyệt & áp dụng KB" → thấy toast "Đã duyệt & áp dụng KB" ngay, không cần bước "Gửi duyệt KB" trung gian.

## Previous update (2026-03-24 — v0.0.29)
### Bug Fix — KB AI "AI Tính Toán" 401: ES256 vs HS256 JWT algorithm mismatch

**Root cause xác nhận bằng browser diagnostic (đọc JWT từ localStorage trực tiếp):**
- User JWT dùng **`alg: ES256`** (asymmetric, có `kid: "97b091d5-..."`) — Supabase project đã upgrade lên asymmetric JWT signing
- Anon key vẫn dùng **`alg: HS256`** (symmetric, format cũ)
- Edge function `kb-suggest-po-rules` được deploy từ trước khi project upgrade → gateway cũ chỉ biết verify HS256 → gặp ES256 user token → reject `"Invalid JWT" 401`
- Anon key (HS256) pass được proxy → đó là lý do test với anon key trả về lỗi khác (`"Invalid or expired token"` từ `requireAuth()`) trong khi user token bị proxy reject trước

**Fix:**
- **`supabase/config.toml`**: `kb-suggest-po-rules` → `verify_jwt = false`. Proxy không còn validate JWT nữa; auth được xử lý hoàn toàn bởi `requireAuth()` bên trong function, gọi `supabaseAdmin.auth.getUser(token)` — Supabase auth server tự biết verify ES256.
- **`kb-suggest-po-rules/index.ts`**: Xoá debug logs, cập nhật comment giải thích lý do `verify_jwt = false`.
- **Deploy**: `supabase functions deploy kb-suggest-po-rules --project-ref cxntbdvfsikwmitapony`

**Lưu ý quan trọng cho các functions khác:**
- Tất cả functions có `verify_jwt = true` đều có thể gặp lỗi tương tự nếu user dùng với ES256 token
- Khi nào cần fix: chỉ fix khi có báo cáo 401 từ function đó
- Cách fix: đặt `verify_jwt = false` + đảm bảo function có `requireAuth()` trong code

**Các thay đổi v0.0.28 giữ nguyên** (defensive coding, không harmful):
- `getFreshAccessToken()` helper trong `supabase-helpers.ts` — vẫn hữu ích đảm bảo token fresh
- Các call site dùng `getFreshAccessToken()` thay `getSession()` — best practice

## Previous update (2026-03-24 — v0.0.28)
### [SUPERSEDED] Hypothesis: stale cached token — root cause thực tế là ES256 mismatch (xem v0.0.29)
- `getFreshAccessToken()` helper trong `supabase-helpers.ts`
- Fix `MiniCrm.tsx`, `useUserManagement.ts`, `CreateInvoiceFromRequestDialog.tsx`, `DataMigrationSettings.tsx` — thay `getSession()` bằng `getFreshAccessToken()` trước các `functions.invoke()` calls

## Previous update (2026-03-24 — v0.0.27)
### Bug Fix — KB AI "AI Tính Toán" error handling + auth consistency
- **`MiniCrm.tsx`**: Fix bug trong `kbAiSuggestMutation` error handling — `catch` block nuốt mất detailed error message. Trước đây: `throw new Error(detail)` nằm TRONG `try` → `catch` bắt luôn rồi bỏ qua → user luôn thấy generic "Edge Function returned a non-2xx status code". Sau: tách JSON parsing ra riêng, chỉ throw 1 lần cuối cùng với detail nếu có.
- **`kb-suggest-po-rules/index.ts`**: Refactor auth — thay inline bearer token parsing bằng `requireAuth()` từ `_shared/auth.ts` (nhất quán với 25 functions khác). Thêm `console.error` cho OpenAI errors. Catch block xử lý đúng Response objects từ `requireAuth()`.
- **Không thay đổi**: `config.toml` đã có `verify_jwt = true` — giữ nguyên.

## Previous update (2026-03-07 — v0.0.26)
### Perf Fix — Tổng số tiền quỹ load nhanh hơn khi chuyển ngày
- **File**: `src/hooks/useFinanceReconciliation.ts`
- **staleTime**: `DAILY_STALE_MS` tăng từ 30s → **5 phút**. Trước đây sau 30s không dùng là cache hết hạn, mỗi lần chuyển ngày đều thấy spinner. Giờ dữ liệu cùng ngày được dùng lại trong 5 phút.
- **gcTime**: Tăng từ 10 phút → **15 phút** — data các ngày đã xem được giữ lâu hơn trong bộ nhớ, hỗ trợ việc navigate qua lại giữa các ngày.
- **`useQtmOpeningBalance` parallel queries**: Thay 2 queries chạy nối tiếp (sequential waterfall) → **`Promise.all()`** chạy song song. Trước: query 2 chờ query 1 xong mới fire. Sau: cả 2 fire cùng lúc, thời gian chờ giảm ~50%.

## Previous update (2026-03-07 — v0.0.25)
### Security Hardening — Critical RLS fixes + Function search_path (94 warnings từ Security Advisor)
- **Migration** `20260307180000_security_hardening_rls_and_functions.sql`
- **`user_roles` (CRITICAL)**: Drop write policies cho tất cả authenticated users → chỉ `owner` mới có thể INSERT/UPDATE/DELETE. Trước đây bất kỳ user nào cũng có thể tự cấp quyền owner (privilege escalation).
- **`app_settings` (HIGH)**: Drop write policies → chỉ `owner` mới được sửa global config.
- **`profiles` (HIGH)**: Drop write policies → user chỉ UPDATE được profile của chính mình; owner có full access.
- **14 functions search_path (MEDIUM)**: `ALTER FUNCTION ... SET search_path = public` cho tất cả 14 functions bị mutable search_path. Bao gồm: set_updated_at, touch_updated_at, handle_updated_at, update_updated_at_column, normalize_email_before_write, set_mini_crm_po_templates_updated_at, set_mini_crm_customer_price_list_updated_at, set_mini_crm_knowledge_profiles_updated_at, enforce_goods_receipt_raw_material_sku, guard_inventory_batch_expiry_once, set_supplier_alias_key, normalize_storage_path, increment_supplier_template_hit, cleanup_expired_rate_limits.
- **DEFER**: 75 warnings còn lại (`rls_policy_always_true` trên business tables) — intentional cho internal app với trusted staff.
- **TODO (Dashboard)**: Auth → Password settings → Enable "Leaked Password Protection" (HaveIBeenPwned).

## Previous update (2026-03-07 — v0.0.24)
### Performance Fix — Gộp RLS policies + Drop duplicate index
- **Migration** `20260307170000_fix_remaining_linter_warnings.sql`: Fix 6 warnings còn lại từ Supabase Performance Advisor.
- **`user_module_permissions` (5 warnings)**: Gộp 2 SELECT policies (`owner_full_access_module_permissions` FOR ALL + `users_read_own_permissions` FOR SELECT) thành 1 policy SELECT duy nhất với OR logic: `uid() = user_id OR has_role(uid(), 'owner')`. Owner write ops tách riêng thành policy `owner_write_module_permissions`. Logic access không đổi, Postgres chỉ evaluate 1 policy thay vì 2.
- **`ceo_daily_closing_declarations` (1 warning)**: Drop index `idx_ceo_declarations_closing_date` do v0.0.22 tạo trùng với index `idx_ceo_daily_closing_declarations_closing_date` đã có sẵn trên production.

## Previous update (2026-03-07 — v0.0.23)
### Security Fix — Enable RLS trên 3 bảng bị thiếu (Supabase Security Advisor)
- **Migration** `20260307160000_enable_rls_missing_tables.sql`: Fix 3 lỗi ERROR từ Supabase Security Advisor.
- **`supplier_scan_templates`**: Enable RLS, không có policy cho `authenticated` — chỉ edge function `scan-invoice` (dùng `service_role`) mới được access. Direct API call từ frontend bị chặn hoàn toàn.
- **`mini_crm_po_template_learning_logs`**: Enable RLS + policy `authenticated FOR ALL` — nhất quán với các bảng mini_crm khác.
- **`sku_formulations`**: Enable RLS + policy `authenticated FOR ALL` — SkuCostsManagement.tsx CRUD không bị ảnh hưởng.

## Previous update (2026-03-07 — v0.0.22)
### Database Index Optimization — Dựa trên Supabase Query Performance Advisor
- **Migration** `20260307150000_add_missing_indexes.sql`: Thêm 12 index còn thiếu.
- **`ceo_daily_closing_declarations(closing_date DESC)`**: Index quan trọng nhất — bảng này chiếm ~60% tổng DB time (query date range mean 2,412ms). Kỳ vọng giảm xuống <5ms sau khi index.
- **`payment_requests`**: Thêm 6 index cho các cột filter thường dùng (`status`, `payment_status`, `delivery_status`, `invoice_created`, composite `status+payment_status`, `created_at DESC`). Hỗ trợ các query server-side filtering từ v0.0.20.
- **Các bảng ORDER BY**: `purchase_orders`, `goods_receipts`, `suppliers` (cột `created_at DESC`), `product_skus` (cột `sku_code ASC`) — tổng 4 index.

## Previous update (2026-03-07 — v0.0.21)
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
