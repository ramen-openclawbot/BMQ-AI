# HANDOFF

## Current Version
- apps/web: **0.0.4**
- websites/banhmique-com-rebuild: **0.1.0**
- Branch: `main`
- Latest commit at handoff time: `256e1ad`

## What is done (latest)
1. SKU Management page now keeps only **Danh sách SKU thành phẩm**.
2. Removed extra SKU management sections (batch coding, trace links, legacy long blocks).
3. Added DB cleanup migration for removed sections:
   - `production_batch_materials`
   - `production_batches`
   - `batch_code_patterns`
   - File: `apps/web/supabase/migrations/20260223003000_cleanup_sku_management_non_list_sections.sql`
4. SKU Dashboard fixed to load from `product_skus` (finished SKU) so created SKU always appears.
5. SKU Analysis bridge aligned with current schema (`cost_values`) and current costing logic.
6. Settings → App info → Version now reads semver from `apps/web/package.json` (removed stale `v1.0.0` behavior).
7. Dashboard overview simplified to compact widgets (short, non-verbose).
8. Replaced long EN headings in remaining dashboard sections with concise VN labels.

## Confirmed by user
- User confirmed dashboard/analysis/settings fixes and requested compact overview presentation.

## Pending request (not implemented yet)
### Permission control for delete SKU
Only account `tam@bmq.vn` can delete SKU in finished list; other accounts should not see Delete button.

### Proposed implementation plan
1. FE: hide Delete button unless login email is `tam@bmq.vn`.
2. BE/RLS: enforce delete permission by email at policy level.
3. Refactor delete flow to avoid partial delete risk.
4. Verify with authorized and non-authorized accounts.

## Recent commits
- `256e1ad` chore(ui): replace verbose EN dashboard section headings with concise VN labels
- `7d288e0` refactor(dashboard): remove verbose inventory/supplier blocks and keep compact overview widgets
- `a4bc144` refactor(sku-dashboard): simplify overview with compact smart widgets
- `ff4feac` docs(handoff): update latest status and bump web version to 0.0.3
- `38f9ae1` fix(settings): show app version from package semver instead of stale fallback

## Notes for next assignee
- Run migration `20260223003000_cleanup_sku_management_non_list_sections.sql` in production if not yet applied.
- After deploy, verify:
  - `/sku-costs/management` only has finished SKU list section.
  - `/sku-costs/dashboard` shows compact widgets and correct finished SKU data.
  - `/sku-costs/analysis` numbers follow `cost_values` + formulation logic.
  - `/settings` shows app version from current package semver.
