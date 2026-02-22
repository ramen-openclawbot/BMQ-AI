# HANDOFF

## Current Version
- apps/web: **0.0.3**
- websites/banhmique-com-rebuild: **0.1.0**
- Branch: `main`
- Latest commit at handoff time: `38f9ae1`

## What is done (latest)
1. SKU Management page simplified to keep only **Danh sách SKU thành phẩm** section.
2. Removed other management UI sections (batch coding, trace links, cost widgets/legacy blocks in that page).
3. Added DB cleanup migration for removed sections:
   - `production_batch_materials`
   - `production_batches`
   - `batch_code_patterns`
   - File: `apps/web/supabase/migrations/20260223003000_cleanup_sku_management_non_list_sections.sql`
4. SKU Dashboard fixed to load directly from `product_skus` (finished SKU filter), so existing SKU always shows.
5. SKU Analysis bridge fixed to align with current schema (`cost_values`) and current costing logic.
6. Settings → App info → Version fixed to read semver from `apps/web/package.json` (no stale `v1.0.0` fallback).

## Confirmed by user
- User confirmed dashboard/analysis fixes and settings version display fix.

## Pending request (not implemented yet)
### Permission control for delete SKU
Only account `tam@bmq.vn` can delete SKU in finished list; other accounts should not see Delete button.

### Proposed implementation plan
1. FE: hide Delete button unless login email is `tam@bmq.vn`.
2. BE/RLS: enforce delete permission by email at policy level.
3. Refactor delete flow to avoid partial delete risk.
4. Verify with authorized and non-authorized accounts.

## Recent commits
- `38f9ae1` fix(settings): show app version from package semver instead of stale fallback
- `b063e88` docs(handoff): refresh status and bump web version to 0.0.2
- `1a6ccfe` fix(sku-analysis): align bridge with current product_skus schema and cost_values logic
- `6c1054b` fix(sku-dashboard): load dashboard from product_skus so finished SKU data always shows
- `fa3f044` refactor(sku-management): keep only finished SKU list section and cleanup batch/trace data migration

## Notes for next assignee
- Run migration `20260223003000_cleanup_sku_management_non_list_sections.sql` in production if not yet applied.
- After deploy, verify:
  - `/sku-costs/management` only has finished SKU list section.
  - `/sku-costs/dashboard` shows existing finished SKU rows.
  - `/sku-costs/analysis` numbers follow `cost_values` + formulation logic.
  - `/settings` shows app version from current package semver.
