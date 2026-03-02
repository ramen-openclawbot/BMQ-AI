## [LRN-20260222-001] correction

**Logged**: 2026-02-22T16:10:00+07:00
**Priority**: high
**Status**: pending
**Area**: frontend

### Summary
Auto-seed SKU flow claimed success but SKU was not visible due silent failure.

### Details
User reported "Chưa có SKU thành phẩm" after assistant said sample SKU would be auto-created. Root cause likely insert payload in ensureBmcbSampleSku missed required field(s) and errors were swallowed in useEffect catch.

### Suggested Action
Include required fields in insert payload (unit_price), and stop swallowing errors silently; log to console and/or surface toast for diagnostics.

### Metadata
- Source: user_feedback
- Related Files: apps/web/src/pages/SkuCostsManagement.tsx
- Tags: sku, silent-failure, validation

---
## [LRN-20260302-004] correction

**Logged**: 2026-03-02T08:56:00+07:00
**Priority**: high
**Status**: pending
**Area**: frontend

### Summary
Fix precedence bug alone was insufficient for PO supplier display; needed fallback mapping by supplier_id.

### Details
User reported "Vẫn chưa được" after fixing JSX precedence in PurchaseOrders.tsx. Root cause likely includes missing `suppliers` join payload on some rows (or relation null), while edit flow still resolves supplier via `supplier_id`. Added `useSuppliers` and `supplierMap` fallback so list displays supplier name from `order.supplier_id` when `order.suppliers?.name` is null.

### Suggested Action
When listing relational labels in UI, always provide fallback resolution from foreign key + cached master table data.

### Metadata
- Source: user_feedback
- Related Files: apps/web/src/pages/PurchaseOrders.tsx
- Tags: supplier, fallback, relation-null, purchase-orders
- See Also: ERR-20260302-003

---
## [LRN-20260302-005] correction

**Logged**: 2026-03-02T09:36:00+07:00
**Priority**: high
**Status**: pending
**Area**: frontend

### Summary
Goods Receipts page crashed from unsafe date formatting when receipt_date is null/invalid.

### Details
User reported runtime error after creating receipts. `format(new Date(receipt.receipt_date), ...)` can throw `Invalid time value`, tripping ErrorBoundary and showing generic crash screen.

### Suggested Action
Always guard date parsing in table renderers with null/invalid checks; show fallback `-` instead of direct format call.

### Metadata
- Source: user_feedback
- Related Files: apps/web/src/pages/GoodsReceipts.tsx
- Tags: goods-receipts, date, runtime-crash

---
## [LRN-20260302-001] correction

**Logged**: 2026-03-02T18:02:00+07:00
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
User asked to remove a duplicated UI/DB field, but I performed an extra data-null migration before confirming scope.

### Details
In CRM revenue channel cleanup, I interpreted "bỏ field" too broadly and set `default_revenue_channel` to NULL for existing records. User clarified they wanted field removal from UI and DB model alignment, not ad-hoc data mutation first.

### Suggested Action
When request says "bỏ field", implement schema/UI removal path first and confirm whether historical data should be preserved, migrated, or deleted before running destructive updates.

### Metadata
- Source: user_feedback
- Related Files: apps/web/src/pages/MiniCrm.tsx, apps/web/supabase/migrations/20260302175800_clear_default_revenue_channel_existing_customers.sql
- Tags: correction, scope, migration-safety

---
## [LRN-20260303-001] correction

**Logged**: 2026-03-03T00:15:00+07:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Summary
Widget tổng doanh thu đang cộng theo danh mục kênh cũ nên không phản ánh PO đã đồng bộ theo CRM.

### Details
Sau khi đổi bảng "Danh sách PO của khách hàng" sang dùng group/product_group từ CRM, phần widget tổng vẫn tính theo `breadChannels/cakeChannels` cũ (keys legacy như `online_grab`, `cake_kingfoodmart`). Dữ liệu mới có `customer_group=b2b` + `product_group=banhmi` nên total bị về 0 dù PO có giá trị.

### Suggested Action
Tính tổng theo `mini_crm_customers.product_group` của từng PO đã post trong ngày (fallback từ channel khi thiếu), không phụ thuộc danh sách channel hardcode cũ.

### Metadata
- Source: user_feedback
- Related Files: apps/web/src/pages/FinanceRevenueControl.tsx
- Tags: revenue, crm-sync, totals, correction

### Resolution
- **Resolved**: 2026-03-03T00:17:00+07:00
- **Commit/PR**: pending commit
- **Notes**: Reworked totals reducer to aggregate by `product_group` directly.

---
## [LRN-20260303-002] correction

**Logged**: 2026-03-03T00:34:00+07:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Summary
Template analyzer fail 0% khi PO mẫu ở dạng row-item (mỗi dòng là 1 sản phẩm), không phải ma trận theo ngày/cột.

### Details
Logic phân tích mẫu đang hard-code `headerRow=2`, `date ở cột B`, `quantityColumns theo cột sản phẩm`. File Export-PO-Data.xlsx có header ở row 1 và dữ liệu sản phẩm theo từng dòng (product/qty/date là cột cố định), khiến preview rỗng.

### Suggested Action
Bổ sung auto-detect header row + row-item mode trong analyzer UI và parser function để parse theo cột product/qty/date khi nhận diện mẫu row-based.

### Metadata
- Source: user_feedback
- Related Files: apps/web/src/pages/MiniCrm.tsx, apps/web/supabase/functions/po-parse-inbox-order/index.ts
- Tags: po-template, xlsx, parser, row-mode

### Resolution
- **Resolved**: 2026-03-03T00:36:00+07:00
- **Commit/PR**: pending commit
- **Notes**: Added `rowItemMode` + `rowItemColumns` and fallback support in edge parse.

---
