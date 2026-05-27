# AI OCR Cost Classification Rules Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task after owner approval.

**Goal:** Add deterministic AI-assisted standardization and cost classification to current PR OCR and invoice creation flows so scanned supplier documents map to canonical BMQ cost groups/COGS names when a trusted mapping exists, while preserving the old OCR flow as a safe fallback for unmapped lines.

**Architecture:** Keep OCR extraction separate from business classification. `scan-invoice` continues extracting raw visible data, then a new normalization/classification layer resolves supplier, a canonical BMQ cost identity, cost category, COGS/product-line flags, and unit conversion hints. PR and invoice item creation must persist both raw OCR text and canonical classification metadata. The app should auto-apply deterministic approved mappings without asking staff to manage confidence/status fields. If the system cannot resolve a line to an approved standard cost code, it must still save the line using the scanned OCR name like the old flow and route the exception to finance review in the background.

**Tech Stack:** React/TypeScript, Supabase Edge Functions, Supabase Postgres/RLS/RPC, existing tables `payment_request_items`, `invoice_items`, `cost_categories`, `cost_classification_rules`, `cost_line_classifications`, BMQ reviewed mapping Google Sheet.

---

## Source findings

- Current OCR function: `apps/web/supabase/functions/scan-invoice/index.ts` extracts invoice/PR visible fields and line items, plus supplier alias/template learning.
- Current PR dialog: `apps/web/src/components/dialogs/AddPaymentRequestDialog.tsx` calls `scan-invoice`, then fills `product_name` directly from OCR and later inserts `payment_request_items`.
- Current invoice dialog: `apps/web/src/components/dialogs/AddInvoiceDialog.tsx` calls `scan-invoice`, fills `product_name` directly from OCR, and inserts `invoice_items`.
- Existing classification foundation already exists:
  - `cost_categories`
  - `cost_classification_rules`
  - `cost_line_classifications`
  - `cost_classification_audit_logs`
  - details/summary views used by `FinanceControl.tsx` / `useCostClassifications.ts`.
- Existing categories include:
  - `COGS_BMQ_BREAD` — Chi phí bánh mì que / bánh mì lớn
  - `COGS_SWEET_KITCHEN` — Chi phí bếp bánh ngọt
  - `PACKAGING_SALES` — Bao bì / tem nhãn / vật tư bán hàng
  - `OPEX_GENERAL`
  - `KITCHEN_SUPPLY_REPAIR`
  - `CAPEX_ASSET_PROJECT`
  - `UNMAPPED_REVIEW`
- Reviewed Google Sheet: `https://docs.google.com/spreadsheets/d/1u3J6q87Svdr4IqMcP6JYPRk-p-xyBXi7egryWCPU3yA/edit?gid=0#gid=0`.
- Sheet columns observed:
  - `Phân loại chi phí`
  - `Tên ingredient đã mua T5`
  - `AI recommend match NVL trong COGS`
  - `Tên SKU có sử dụng NVL này`
  - `Giá mua thực tế...`
  - `Giá mua TB đã quy đổi`
  - `Giá COGS`
  - `Review` (column I)
- Owner rule for column I as of 2026-05-27:
  - Blank `Review` cell = approved as written by the current row/category/mapping.
  - Non-blank `Review` cell = read and apply the comment. Some comments approve corrected mappings/conversions, some mark non-COGS, and some intentionally keep the line in `Cần Review`.
- CSV audit of current sheet: 90 data rows; 58 blank Review rows treated as approved; 32 rows with Review comments to parse explicitly.

---

## Owner-facing classification rule set

### Rule 0 — Never trust raw OCR as canonical

For every scanned PR/invoice line, store the raw supplier text plus the BMQ canonical cost identity:

1. `raw_product_name` / OCR text: exact visible supplier text for audit.
2. `suggested_standard_cost_code`: the system-suggested BMQ standard cost code. It can point to an NVL code for COGS/materials or an OPEX cost code for operating expenses.
3. `standard_cost_code_type`: `NVL`, `OPEX`, or another future code family.
4. `canonical_cost_item_name`: BMQ-approved standardized name used for reporting, SKU COGS trend, OPEX grouping, and matching.

UI should show one compact **Mã chuẩn** field with a code-family tag and canonical name, for example `NVL · BOT-MI-001 — Bột mì đa dụng` or `OPEX · VC-001 — Chi phí vận chuyển`. Dashboards and analysis must use approved canonical fields, not raw OCR names.

### Rule 1 — Mapping priority order

Classify each line using this priority:

1. **Owner-approved mapping sheet / DB alias rule**: exact normalized purchased name or approved regex/alias.
2. **Direct standard code match** from NVL material code, OPEX cost code, approved alias, or supplier+item alias pointing to a standard code.
3. **Existing manual override** in `cost_line_classifications` or approved cost item alias.
4. **Supplier + item rule** from `cost_classification_rules`.
5. **COGS formula/BOM semantic match** against finished-SKU ingredients and kitchen canonical items.
6. **Conservative AI suggestion** only when it can propose one standard code + canonical name with safe semantics.
7. **UNMAPPED_REVIEW** if ambiguous.

Never let a lower-priority AI/fuzzy match overwrite an approved sheet/manual rule.

### Rule 1A — Auto-suggest one standard cost code

After scan/classification, the app should resolve each line to one best **Mã chuẩn** when an approved deterministic mapping exists.

- If an approved mapping exists, auto-fill and save the line with `standard_cost_code_type`, suggested/confirmed standard code, canonical name, cost category, product-line/allocation metadata, and source fields; then continue the existing PR/invoice flow normally.
- The scan UI should not show confidence, classification status, or review buttons. It should only show OCR text plus the selected **Mã chuẩn** + canonical name when useful for human sanity-checking.
- If staff sees a wrong suggested code, correction should happen through the existing item/code picker or the review page, not through extra scan buttons.
- If the app cannot resolve a standard code from the cost text, keep the scanned OCR item information as the line's display/main data, save normally, and route it to `Chi phí Cần Review` in the background according to Rule 3.
- The flow must not block daily entry just because no standard code was resolved.

### Rule 2 — COGS categories are business categories, not OCR categories

Map to these top-level categories:

- `COGS_BMQ_BREAD`: bread/banh mi direct inputs and fillings — flour used by BMQ bread, pate, chà bông, jambon, giò/chả, sauces/fillings used directly in BMQ bread.
- `COGS_SWEET_KITCHEN`: sweet-bakery/kitchen direct ingredients — butter, flour for pastry, whipping cream, cheese, chocolate, almond, raisin, eggs, honey, etc.
- `PACKAGING_SALES`: packaging/labels/sales material — hộp, khay, tem, túi, OPP, PE, bao bì. Some packaging may be relevant to product cost but should not be forced into ingredient COGS unless explicitly approved.
- `KITCHEN_SUPPLY_REPAIR`: kitchen tools/CCDC/cleaning/repair.
- `OPEX_GENERAL`: rent, utilities, shipping/vehicle/internet/general operating costs.
- `CAPEX_ASSET_PROJECT`: machines, construction, large equipment/project costs.
- `UNMAPPED_REVIEW`: anything uncertain.

### Rule 3 — Safe fallback keeps the old OCR flow alive

If no approved mapping/rule can confidently identify the cost category or canonical BMQ/COGS item:

- Save the line normally using the scanned OCR name as the main/display item name, same as the old flow.
- Preserve `raw_product_name` exactly from OCR.
- Leave `suggested_standard_cost_code` / `confirmed_standard_cost_code` and `standard_cost_code_type` null unless a standard code is resolved or staff manually chooses one.
- Set `canonical_cost_item_name` to the OCR name or null according to the current UI display need, but do **not** pretend it is an approved canonical COGS name.
- Set internal review routing metadata and `category_code = 'UNMAPPED_REVIEW'` unless a broad category is safely known.
- Add an internal note such as `Cần Review: hệ thống chưa nhận diện được mã chuẩn chi phí đã duyệt.`
- Show the row on the finance `Chi phí Cần Review` page for back-office correction, not as a front-line scan decision.

This protects launch: applying the new OCR classifier must not block daily PR/invoice entry, and must not break existing staff behavior.

### Rule 4 — Review creates durable learning rules

When finance/owner opens the `Chi phí Cần Review` page and corrects a line:

- update the line classification,
- create/update an approved alias mapping,
- store supplier constraint and unit conversion note if relevant,
- apply it to the current line,
- and use it automatically for the same future scanned item.

### Rule 5 — COGS line must carry product-line and allocation semantics

For COGS rows, save:

- `category_code`
- `product_line`: `bmq_bread`, `sweet_kitchen`, `shared`, or `general`
- `allocation_rule`:
  - `direct` if it belongs directly to a known product line/SKU group.
  - `manual` if shared/packaging needs allocation.
  - `none` if not COGS/product-related.
- Optional `matched_finished_sku_names` from the approved mapping sheet.

### Rule 6 — Unit conversion is separate from identity matching

A line can be identity-matched but still require unit review.

Examples:

- `Men Khô Ngọt Mauripan - Vàng (0.5x10kg/thùng)` → canonical `Phụ gia BM ngọt Mauri`, conversion `1 thùng = 10.000g`.
- `Nước bình 20L` → `Nước`, conversion `20L ≈ 20.000g`.
- `Trứng gà` → `Trứng gà`, conversion `1 quả ≈ 60g`.
- `Kem/whipping 1L` → `Whipping cream`, conversion `1L ≈ 1.000g` unless approved otherwise.

If conversion is uncertain, keep the resolved identity, add `unit_conversion_note`, and route only the conversion issue to the finance review queue.

### Rule 7 — Explicit rejection / non-COGS wins

If the reviewed sheet says `KHÔNG LIÊN QUAN COGS` or review note says not to update COGS, set:

- `category_code`: category according to the business nature, often `PACKAGING_SALES` or `OPEX_GENERAL`
- `cost_group`: not `cogs`
- `cost_review_routing`: `none` if the non-COGS decision came from owner-reviewed mapping
- `note`: include `Không dùng để update COGS`.

### Rule 8 — Ambiguous semantic traps must block automation

Do not auto-map:

- `Dầu hướng dương` → `Đường`
- `Sữa đặc` → `Đường`
- `Chả bông/Chà bông` → unrelated stale raw SKU like `Trứng gà`
- `Bột custard` / `Creamyvit` → `Đá`
- Short generic words like `Bánh mì` to a specific finished SKU.
- Fresh/tươi vs dry/khô ingredient forms unless approved.

These must become `UNMAPPED_REVIEW` or approved alias rules.

### Rule 9 — Confidence bands

- `>= 0.95`: approved rule/manual/sheet exact match; can auto-apply.
- `0.85–0.94`: suggested; can prefill but requires visible review if unit/category impact is material.
- `< 0.85`: needs review; do not let it update COGS trend automatically.

### Rule 10 — PR and invoice must converge to the same canonical result

The same scanned line should classify identically whether it enters through:

- Add PR / Đề nghị chi OCR
- Add Invoice / Tạo hóa đơn OCR
- Create invoice from approved PR

Classification should be generated by shared backend logic/RPC, not duplicated separately in two React dialogs.

### Rule 11 — No duplicate double-counting between PR and invoice

If invoice is created from PR, invoice classification should link back to PR and either:

- use the invoice as final accounting source and mark PR as preliminary, or
- aggregate only one source in cost dashboards.

Do not count both PR line and invoice line into monthly COGS total unless intentionally showing requested-vs-actual.

### Rule 12 — Persist every correction as a durable alias/rule

When finance/owner corrects a line category/name, create/update a durable alias/rule:

- normalized raw name pattern
- supplier constraint if needed
- canonical name
- category/product-line/allocation
- conversion note/factor if approved
- effective date
- audit actor/time/source line

---

## Phased rollout plan

Because this is a large change touching OCR, finance data, mapping rules, review UI, and reporting, implement in small approved slices. Each phase should be locally verified before moving to the next.

### Phase 0 — Lock requirements, naming, and sheet interpretation

**Status:** Approved by owner on 2026-05-27. Completed as planning/spec lock only; no app code or DB migration in this phase.

**Objective:** Treat the reviewed Google Sheet as the trusted owner review source, lock the shared OCR naming model, and remove previous ambiguity around review/fallback behavior.

**Scope:**
- Lock terminology:
  - UI label: **Mã chuẩn**
  - `standard_cost_code_type = NVL` means the code is the same code family as the COGS/Giá vốn `Mã NVL`.
  - `standard_cost_code_type = OPEX` means the code is an operating-expense cost code.
  - Future code families can use `OTHER` or a more specific type without changing the scan UI.
- Lock scan UI:
  - Show only concise operational fields: `Tên OCR`, `Mã chuẩn`, `Nhóm`.
  - Do not show confidence, classification status, `Đổi mã`, or `Cần Review` buttons in the scan result.
- Lock automation rule:
  - Approved deterministic match = auto-apply **Mã chuẩn** and canonical name.
  - Unresolved/ambiguous line = save using OCR fallback and route to `Chi phí Cần Review` in the background.
- Read/export the sheet by `gid=0`.
- Interpret column I `Review` exactly:
  - blank = approved,
  - text = apply comment.
- Produce an import preview summary: approved rows, non-COGS rows, still-needs-review rows, conversion-note rows, dangerous-AI-correction rows.
- No DB writes yet.

**Verification:** Plan now consistently uses **Mã chuẩn** with `NVL`/`OPEX` code types, preserves the existing OCR fallback, and keeps review routing as a back-office queue instead of a scan-screen decision.

### Phase 1 — Add non-breaking schema fields

**Status:** Approved by owner on 2026-05-27. Implemented locally as migration `apps/web/supabase/migrations/20260527151000_ocr_standard_cost_fields.sql` plus Supabase TypeScript type updates. Not applied to production and not pushed.

**Objective:** Add canonical/fallback metadata without changing current staff behavior.

**Scope:**
- Add nullable OCR/classification fields to PR and invoice line tables.
- Add `cost_item_alias_mappings` or equivalent mapping table.
- Add indexes/constraints/audit fields.
- Existing PR/invoice creation must still work if all new fields are null.

**Verification:** Migration is additive/idempotent, contains no destructive data operations, and `types.ts` syntax check passes. No production behavior change yet because no runtime code reads/writes these fields in Phase 1.

### Phase 2 — Import approved mappings from the sheet

**Status:** Approved by owner on 2026-05-27. Completed locally as preview/import tooling only; no DB write, no production apply, no push.

**Objective:** Turn the reviewed sheet into durable rules, but avoid activating unsafe comments incorrectly.

**Scope:**
- Import blank-column-I rows as approved mappings.
- Import comment rows according to comment meaning:
  - corrected mapping/conversion = approved mapping with note,
  - `không liên quan COGS` = approved non-COGS rule,
  - comments like `Đưa vào chi phí Cần Review`, `Kế toán check lại`, `Chưa có NVL...`, `Đang test...` = review rule/reference, not final COGS automation.
- Store source sheet URL, source row number, and original review text.

**Verification:** Known traps do not regress: `Dầu hướng dương` does not map to `Đường`; `Chả bông` does not map to `Trứng gà`; `Hạnh nhân` is not excluded by `nhãn/tem nhãn` regex.

**Local artifacts:**
- Script: `apps/web/scripts/import_ocr_cost_mapping_sheet.py`
- Tests: `apps/web/scripts/test_ocr_cost_mapping_import.py`
- Generated preview files outside repo:
  - `/tmp/bmq_ocr_cost_mapping_preview.json`
  - `/tmp/bmq_ocr_cost_mapping_seed.sql`

**Current sheet result:**
- Source rows: 90
- Blank Review rows: 58
- Comment Review rows: 32
- Approved alias mappings prepared for future seed: 38
  - `NVL`: 26
  - `OPEX`: 7
  - `OTHER`: 5
- Needs-review aliases kept out of approved seed: 52

**Safety adjustment:** Comments like `Kế toán check lại` / `Kế toán review lại` now block automation and route to review. Comments like `Không có trong COGS` can create an OPEX code only when the comment gives a deterministic non-COGS meaning, e.g. `Tên NVL là tiền điện`.

**Verification run:** `python3 apps/web/scripts/test_ocr_cost_mapping_import.py` passes 7 tests. The generated SQL seed contains only `insert ... on conflict do update`; no `drop`, `truncate`, destructive `delete`, or schema mutation.

### Phase 3 — Shared classifier with safe fallback

**Status:** Approved by owner on 2026-05-27. Completed locally as shared classifier/test only; not wired into PR OCR, invoice OCR, or production DB yet.

**Objective:** Build one classifier used by PR OCR and invoice OCR.

**Scope:**
- Classifier input: supplier, raw item name, code/unit/price, document type.
- Classifier output: suggested **Mã chuẩn**, code type (`NVL`/`OPEX`/future), canonical name, cost category, product line/allocation, source, and internal review routing.
- Classifier priority: approved mapping → direct standard-code/alias match → manual override → supplier+item rule → safe BOM semantic match → conservative AI suggestion with standard code → fallback.
- Automation model: approved deterministic mapping auto-saves canonical standard code. Changed/corrected mapping becomes a reviewed mapping candidate for future scans. No resolved code keeps OCR data and routes to `Chi phí Cần Review`.
- Fallback behavior: keep OCR name as display/main name, route to review queue internally, and add note; do not block save.

**Verification:** Same sample line returns the same suggested **Mã chuẩn** + name in PR and invoice contexts. Approved mappings persist canonical fields automatically. Unmapped sample still saves with OCR name and appears in `Chi phí Cần Review`.

**Local artifacts:**
- Shared classifier: `apps/web/supabase/functions/_shared/ocr-cost-classifier.ts`
- Test harness: `apps/web/scripts/test_ocr_cost_classifier.mjs`

**Implemented behavior:**
- Exact approved alias lookup by normalized OCR name.
- Supplier-specific approved alias wins over generic alias when present.
- Direct standard-code lookup from OCR `product_code` / raw text.
- Ambiguous approved mappings do not auto-apply; they fall back to review.
- Existing `needs_review` alias does not auto-apply; it keeps OCR fallback and routes to review.
- Resolved rows return payload fields for both PR and invoice line inserts:
  - raw OCR name
  - suggested/confirmed standard code
  - code type `NVL` / `OPEX` / `OTHER`
  - canonical name
  - category/product-line/allocation
  - internal review routing
  - unit conversion note
  - matched SKU list
  - compact JSON audit payload

**Verification run:** `node scripts/test_ocr_cost_classifier.mjs` passes. TypeScript transpile check for `_shared/ocr-cost-classifier.ts` passes. Tested same `Dầu hướng dương` sample in PR and invoice contexts returning the same `Mã chuẩn`; tested OPEX `tiền điện`; tested unknown OCR fallback; tested `needs_review`; tested ambiguous duplicate mapping fallback.

### Phase 4 — Wire into PR OCR first

**Status:** Approved by owner on 2026-05-27. Completed locally for PR OCR only; not deployed, not applied to production, not committed/pushed.

**Objective:** Pilot the behavior in `Đề nghị chi` before touching invoice/reporting broadly.

**Scope:**
- `scan-invoice` returns classification payload for PR OCR.
- Add compact preview showing OCR name, suggested **Mã chuẩn**, code type tag, tên chuẩn, and nhóm chi phí.
- Do not show confidence, status, `Đổi mã`, or `Cần Review` buttons in the scan result. The normal item/code picker remains available if staff needs to correct a wrong code.
- If there is no resolved standard code, the PR line uses OCR data as before and is routed to review internally.
- Persist classification fields on `payment_request_items`.
- Unresolved rows save normally but show on review queue.

**Verification:** Staff can create PR as before; approved rows auto-fill a visible `Mã chuẩn` + name; unknown rows keep OCR name and appear in `Chi phí Cần Review`.

**Local implementation:**
- `scan-invoice` now loads active approved `cost_item_alias_mappings`, classifies every OCR item with the shared classifier, and returns:
  - `ocr_cost_classification`
  - `standard_cost_label`
- PR OCR request sends `documentType: "payment_request"`.
- `AddPaymentRequestDialog` preserves the classifier payload per scanned line.
- PR item insert now saves the Phase 1 fields:
  - raw OCR name
  - suggested/confirmed standard code
  - code type
  - canonical name/source
  - cost category/product-line/allocation
  - review routing
  - unit conversion note
  - matched SKU list
  - JSON audit payload
- Scan item table shows only a compact line under item name when resolved:
  - `Mã chuẩn NVL/OPEX/OTHER · CODE — Tên chuẩn · Nhóm`
- No confidence/status/`Đổi mã`/`Cần Review` controls were added.

**Verification run:**
- `npx tsc --noEmit --pretty false` passes for the app.
- `node scripts/test_ocr_cost_classifier.mjs` passes.
- `python3 scripts/test_ocr_cost_mapping_import.py` passes 7 tests.
- Direct TypeScript transpile check passes for:
  - `supabase/functions/scan-invoice/index.ts`
  - `supabase/functions/_shared/ocr-cost-classifier.ts`
  - `src/components/dialogs/AddPaymentRequestDialog.tsx`
- Targeted ESLint still fails on pre-existing `no-explicit-any` debt in `scan-invoice`; not refactored in this phase to avoid scope creep.

### Phase 5 — Wire into invoice OCR and PR→invoice

**Status:** Approved by owner on 2026-05-27. Completed locally for invoice OCR and PR→invoice metadata copy; not deployed, not applied to production, not committed/pushed.

**Objective:** Make invoice creation converge with PR classification while avoiding double-count.

**Scope:**
- Add the same classifier payload to `AddInvoiceDialog`.
- When creating invoice from PR, copy/link classification and revalidate only if needed.
- Set dashboard policy: invoice is final accounting source; linked PR is preliminary/audit.

**Verification:** Invoice-created-from-PR does not double-count in COGS summaries.

**Local implementation:**
- `AddInvoiceDialog` direct invoice scan now sends `documentType: "invoice"` to `scan-invoice` and preserves `ocr_cost_classification` per scanned item.
- Direct invoice item insert now persists the same Phase 1 standard-cost fields as PR items.
- When a user links an approved PR in `AddInvoiceDialog`, invoice draft items copy the PR item classification metadata.
- `useInvoices.ts` accepts/returns invoice item standard-cost metadata.
- `create-invoice-from-pr` edge function now selects PR item classification fields and copies them into `invoice_items`.
- `CreateInvoiceFromRequestDialog` client-side fallback also copies PR classification fields when the edge-function path is unavailable.
- Accounting policy remains: invoice is the final accounting source; linked PR is preliminary/audit. Broad reporting query changes are left for the reporting/review phase so daily invoice creation is not blocked.

**Verification run:**
- `npx tsc --noEmit --pretty false` passes for the app.
- `node scripts/test_ocr_cost_classifier.mjs` passes.
- `python3 scripts/test_ocr_cost_mapping_import.py` passes 7 tests.
- Direct TypeScript transpile check passes for:
  - `src/components/dialogs/AddInvoiceDialog.tsx`
  - `src/components/dialogs/CreateInvoiceFromRequestDialog.tsx`
  - `src/hooks/useInvoices.ts`
  - `supabase/functions/create-invoice-from-pr/index.ts`
  - `supabase/functions/scan-invoice/index.ts`
  - `supabase/functions/_shared/ocr-cost-classifier.ts`
- Targeted ESLint still fails on existing `no-explicit-any`/hook dependency debt in invoice dialogs; not refactored in this phase to avoid broad cleanup.

### Phase 6 — Build/adjust `Chi phí Cần Review` workflow

**Status:** Approved by owner on 2026-05-27. Completed locally for review queue and manual learning workflow; not deployed, not applied to production, not committed/pushed.

**Objective:** Let finance correct fallback rows and teach the system for next time.

**Scope:**
- Show rows with `needs_review` / `UNMAPPED_REVIEW` / review note.
- Allow edit: canonical name, category, product line, allocation, SKU links, conversion note.
- On confirm, create/update approved alias mapping and apply to current line.
- Keep audit logs.

**Verification:** Correcting one reviewed row causes the next scan of the same name/supplier to auto-map.

**Local implementation:**
- `useCostClassifications.ts` now merges the existing `cost_classification_line_details` view with OCR standard-cost fallback rows from `payment_request_items` and `invoice_items`.
- OCR rows with `cost_review_routing = needs_review` or `cost_category_code = UNMAPPED_REVIEW` appear in the `Chi phí Cần Review` detail path, even before legacy classification backfill exists.
- `FinanceControl.tsx` review edit UI now supports category plus standard-cost correction:
  - `Loại mã`: `NVL`, `OPEX`, `OTHER`
  - `Mã chuẩn`
  - `Tên chuẩn`
  - `Ghi chú quy đổi`
- Saving an OCR review row updates the current PR/invoice item with approved standard-cost fields, clears `cost_review_routing`, and creates/updates an approved `cost_item_alias_mappings` row so the same future OCR text can auto-map.
- Legacy `cost_line_classifications` manual category edits still use the existing classification update/audit/rule path.
- The review UI still avoids scan-screen style confidence/status/change buttons; review controls live only inside the back-office finance page.

**Verification run:**
- `npx tsc --noEmit --pretty false` passes for the app.
- `node scripts/test_ocr_cost_classifier.mjs` passes.
- `python3 scripts/test_ocr_cost_mapping_import.py` passes 7 tests.
- Direct TypeScript transpile check passes for:
  - `src/hooks/useCostClassifications.ts`
  - `src/pages/FinanceControl.tsx`
  - `supabase/functions/_shared/ocr-cost-classifier.ts`
  - `supabase/functions/scan-invoice/index.ts`
  - `supabase/functions/create-invoice-from-pr/index.ts`

### Phase 7 — Reporting and backfill

**Status:** Approved by owner on 2026-05-27. Completed locally for canonical reporting views, visible pending-review totals, and dry-run preview tooling; not deployed, not applied to production, not committed/pushed.

**Objective:** Move `Xu hướng giá vốn` and finance reports to canonical data without hiding review risk.

**Scope:**
- Use canonical approved names/categories for COGS trends.
- Show separate totals/counts for pending review and non-COGS.
- Dry-run backfill current-month/historical rows; apply only after preview approval.

**Verification:** Reports no longer fragment by OCR spelling; pending review amount remains visible and auditable.

**Local implementation:**
- Added migration `apps/web/supabase/migrations/20260527162000_cost_classification_canonical_reporting.sql`.
- Replaced cost classification summary/detail views so reporting:
  - prefers `canonical_cost_item_name` and confirmed/suggested `Mã chuẩn` when present,
  - includes OCR standard-cost rows even before legacy backfill writes `cost_line_classifications`,
  - routes unresolved rows to `UNMAPPED_REVIEW` / `needs_review`,
  - treats invoice items as final accounting source and excludes linked PR lines to avoid PR+invoice double count.
- Added read-only view `cost_classification_ocr_backfill_preview` to summarize canonical-ready/category-only/pending-review rows before any real backfill.
- Added dry-run SQL helper `apps/web/scripts/preview_ocr_cost_backfill.sql`; it only reads the preview view by date range and performs no writes.
- Updated `FinanceControl.tsx` to show a dedicated pending-review amount/count card so unresolved cost stays visible instead of being hidden inside approved totals.

**Verification run:**
- `npx tsc --noEmit --pretty false` passes for the app.
- `node scripts/test_ocr_cost_classifier.mjs` passes.
- `python3 scripts/test_ocr_cost_mapping_import.py` passes 7 tests.
- Targeted ESLint for Phase 7 touched TSX passes:
  - `src/pages/FinanceControl.tsx`

### Phase 8 — Release gates

**Objective:** Ship safely.

**Scope:**
- Targeted ESLint/build.
- Supabase migration dry-run.
- Edge Function deploy check.
- Production verification on `https://ai.banhmique.vn`.
- Commit/push only after explicit approval.

---

## Data model additions

### Task 1: Add canonical OCR/classification fields to line tables

**Objective:** Preserve raw OCR while storing canonical classified metadata on PR and invoice lines.

**Files:**
- Create migration: `apps/web/supabase/migrations/YYYYMMDDHHMMSS_add_ocr_cost_classification_fields.sql`
- Update types: `apps/web/src/integrations/supabase/types.ts`

**Proposed columns on `payment_request_items` and `invoice_items`:**

```sql
alter table public.payment_request_items
  add column if not exists raw_product_name text,
  add column if not exists suggested_standard_cost_code text,
  add column if not exists confirmed_standard_cost_code text,
  add column if not exists standard_cost_code_type text,
  add column if not exists canonical_cost_item_name text,
  add column if not exists canonical_cost_item_source text,
  add column if not exists cost_category_code text references public.cost_categories(code),
  add column if not exists cost_product_line text,
  add column if not exists cost_allocation_rule text,
  add column if not exists cost_review_routing text default 'none',
  add column if not exists unit_conversion_note text,
  add column if not exists matched_finished_skus text[],
  add column if not exists ocr_classification_json jsonb;

alter table public.invoice_items
  add column if not exists raw_product_name text,
  add column if not exists suggested_standard_cost_code text,
  add column if not exists confirmed_standard_cost_code text,
  add column if not exists standard_cost_code_type text,
  add column if not exists canonical_cost_item_name text,
  add column if not exists canonical_cost_item_source text,
  add column if not exists cost_category_code text references public.cost_categories(code),
  add column if not exists cost_product_line text,
  add column if not exists cost_allocation_rule text,
  add column if not exists cost_review_routing text default 'none',
  add column if not exists unit_conversion_note text,
  add column if not exists matched_finished_skus text[],
  add column if not exists ocr_classification_json jsonb;
```

**Verification:** New columns exist locally/remote; existing inserts still work with nullable fields.

### Task 2: Create approved alias/mapping table

**Objective:** Convert reviewed Google Sheet mappings into durable DB rules.

**Files:**
- Same or separate migration.

**Proposed table:**

```sql
create table if not exists public.cost_item_alias_mappings (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_name_key text not null,
  supplier_id uuid references public.suppliers(id),
  canonical_cost_item_name text not null,
  category_code text not null references public.cost_categories(code),
  product_line text not null,
  allocation_rule text not null default 'direct',
  unit_conversion_note text,
  matched_finished_skus text[],
  source_sheet_url text,
  source_review_note text,
  active boolean not null default true,
  effective_from date,
  effective_to date,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_name_key, coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid))
);
```

**Verification:** Sheet-imported rows can be queried by normalized `Tên ingredient đã mua T5`.

### Task 3: Build shared classifier RPC / Edge helper

**Objective:** A single backend classifier handles both PR and invoice line classification.

**Files:**
- `apps/web/supabase/functions/scan-invoice/index.ts` or shared helper `apps/web/supabase/functions/_shared/cost-classifier.ts`
- Migration for RPC if implemented in SQL.

**Input:** supplier, raw product name, product code, unit, quantity, unit price, source type.

**Output:**

```ts
{
  raw_product_name: string;
  suggested_standard_cost_code: string | null;
  confirmed_standard_cost_code: string | null;
  standard_cost_code_type: 'NVL' | 'OPEX' | 'OTHER' | null;
  canonical_cost_item_name: string | null;
  category_code: string;
  product_line: string;
  allocation_rule: 'direct' | 'manual' | 'none';
  cost_review_routing: 'none' | 'needs_review';
  classification_source: 'approved_alias' | 'manual_override' | 'rule' | 'bom_semantic' | 'ai_suggestion' | 'fallback';
  unit_conversion_note?: string;
  matched_finished_skus?: string[];
  warning_flags?: string[];
}
```

**Verification:** Same sample line returns same classification in PR and invoice flows.

### Task 4: Extend `scan-invoice` result schema

**Objective:** OCR returns enriched line items; frontend no longer only receives raw product names.

**Files:**
- `apps/web/supabase/functions/scan-invoice/index.ts`
- `AddPaymentRequestDialog.tsx`
- `AddInvoiceDialog.tsx`

**Change:** Add fields per item:

```ts
cost_classification?: {
  raw_product_name: string;
  suggested_standard_cost_code?: string | null;
  confirmed_standard_cost_code?: string | null;
  standard_cost_code_type?: 'NVL' | 'OPEX' | 'OTHER' | null;
  canonical_cost_item_name: string | null;
  category_code: string;
  category_label?: string;
  product_line: string;
  allocation_rule: string;
  cost_review_routing: 'none' | 'needs_review';
  source: string;
  unit_conversion_note?: string;
  matched_finished_skus?: string[];
  warning_flags?: string[];
}
```

**Verification:** UI preview shows standardized name/category badges before save.

### Task 5: Persist classification when creating PR/invoice items

**Objective:** Save raw + canonical metadata and create/update `cost_line_classifications` rows immediately after line insert.

**Files:**
- `AddPaymentRequestDialog.tsx`
- `AddInvoiceDialog.tsx`
- Optionally a hook/helper: `apps/web/src/lib/finance/costClassification.ts`

**Rules:**
- `product_name` may remain display/editable, but `raw_product_name` stores OCR original.
- `canonical_cost_item_name` stores the standard name for analytics.
- `cost_line_classifications` must be upserted for both `payment_request_item` and `invoice_item`.

**Verification:** New PR/invoice line appears in `cost_classification_line_details` with expected category.

### Task 6: Add OCR review UI block

**Objective:** Let staff see and correct AI classification before saving.

**Files:**
- `AddPaymentRequestDialog.tsx`
- `AddInvoiceDialog.tsx`
- Possible component: `apps/web/src/components/finance/CostClassificationPreview.tsx`

**UI:**
- Line item card/table columns:
  - OCR name
  - Mã chuẩn
  - Loại mã
  - Tên chuẩn BMQ
  - Nhóm chi phí
  - COGS/SKU liên quan
- Do not show confidence/status/review buttons in the scan result.
- If the line needs review, save it normally and route it to the finance review queue in the background.

**Verification:** Unresolved lines save normally and appear in `Chi phí Cần Review`, without adding extra scan-screen decisions for staff.

### Task 7: Import reviewed Google Sheet into mapping table

**Objective:** Turn the approved sheet into seed/maintenance data.

**Files:**
- Create script: `apps/web/scripts/import_cost_item_alias_mappings_from_sheet.py`
- Or migration seed file for initial reviewed rows.

**Transform rules:**
- `Phân loại chi phí` → `category_code`.
- `Tên ingredient đã mua T5` → `source_name` and normalized key.
- `AI recommend match NVL trong COGS` → candidate canonical name, but final approval comes from column I rules.
- `Tên SKU có sử dụng NVL này` → `matched_finished_skus`.
- `Review` column I → owner decision/comment.
- Blank column I = approved row as currently written.
- Non-blank column I = parse comment:
  - `Đã xử lý...`, corrected match/conversion comments = approved corrected mapping with the comment stored as rule note.
  - `không liên quan COGS` = approved non-COGS mapping.
  - `Đưa vào chi phí Cần Review`, `Kế toán check lại`, `Chưa có NVL...`, `Đang test...`, or similar uncertainty = keep/create review reference, not final COGS automation.
- Store original sheet row number and comment so the import can be audited later.

**Verification:** Known sheet examples classify as expected:
- `Dầu hướng dương` → `COGS_SWEET_KITCHEN` / Dầu hướng dương, not Đường.
- `Chả bông (1kg)` → Chà bông, not Trứng gà.
- `Men Khô Ngọt Mauripan...` → Phụ gia BM ngọt Mauri with thùng→g conversion note.
- `Bao bánh mì` marked non-COGS per review note.

### Task 8: Adjust dashboard aggregation rules

**Objective:** `Xu hướng giá vốn` and finance classification views use canonical categories/names.

**Files:**
- `apps/web/src/pages/FinanceControl.tsx`
- `apps/web/src/hooks/useCostClassifications.ts`
- `apps/web/src/pages/SkuCostsDjango.tsx` or related analysis page if applicable.
- SQL views if aggregation is DB-backed.

**Rule:** Monthly COGS trend should use approved/suggested canonical classification, and separately expose:
- total COGS counted,
- lines pending review,
- amount excluded as non-COGS,
- PR-vs-invoice source policy.

**Verification:** Classification summary no longer fragments by raw OCR spelling.

### Task 9: Backfill existing PR/invoice lines

**Objective:** Reclassify historical lines from current month onward using the same rules.

**Files:**
- Script: `apps/web/scripts/backfill_cost_classifications.py`

**Rules:**
- Do not overwrite approved/manual overrides.
- Write audit logs for changed rows.
- Dry-run summary first: counts by old/new category, unresolved lines, top amount impact.

**Verification:** Dry-run reviewed before apply; apply idempotent.

### Task 10: Test and deploy

**Commands:**

```bash
cd /home/ubuntu/projects/BMQ-AI/apps/web
npx eslint src/components/dialogs/AddPaymentRequestDialog.tsx src/components/dialogs/AddInvoiceDialog.tsx src/hooks/useCostClassifications.ts
npm run build
```

**Supabase checks:**
- Dry-run migration SQL with `begin; ... rollback;` if using Management API.
- Deploy/update `scan-invoice` Edge Function.
- Verify `ai.banhmique.vn` custom domain bundle after push.

---

## Acceptance criteria

- Staff scan hóa đơn/PR daily and sees standardized BMQ cost item names, not only raw OCR text.
- COGS-related payments classify into `COGS_BMQ_BREAD` or `COGS_SWEET_KITCHEN` with product-line metadata.
- Packaging/OPEX/CCDC/CAPEX do not leak into ingredient COGS just because OCR text is similar.
- Ambiguous/unresolved lines are saved normally and visible in Finance classification queue.
- Manual correction creates a durable rule so the same supplier/item scans correctly next time.
- PR-created invoice does not double-count in monthly COGS unless explicitly configured.
- Existing approved manual mappings are not overwritten by AI.

---

## Open approval questions

The latest owner direction resolves the previous open questions:

1. `Review` column I is now authoritative: blank = approve, text = apply/read comment.
2. New OCR rollout must preserve the old flow as fallback: if no approved mapping exists, save the OCR-scanned name as the main name and route to `Chi phí Cần Review` internally instead of blocking entry.
3. UI calls the resolved code **Mã chuẩn**. When `standard_cost_code_type = NVL`, the code is the same family as the Giá vốn `Mã NVL`; when `OPEX`, it is an operating-expense cost code.
4. Implement in phased slices, with approval before each phase and before build/commit/push.

Next approval needed: Phase 1 — add non-breaking schema fields.
