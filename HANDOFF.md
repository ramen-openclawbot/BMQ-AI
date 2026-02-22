# HANDOFF

## Current Version
- apps/web: **0.0.1**
- websites/banhmique-com-rebuild: **0.1.0**
- Branch: `main`
- Latest commit at handoff time: `53800b1`

## What is done (SKU Costs)
1. Fixed edit flow to load formulation rows into dialog.
2. Fixed save flow to persist formulation rows on edit/create.
3. Added inline save error + loading state for Save SKU button.
4. Added read-only SKU detail dialog when clicking SKU name.
5. Aligned SKU detail NVL row and summary calculations with edit/formula values.

## Confirmed by user
- "Tốt rồi" for detail calculation/costing fixes.

## Not implemented yet (explicitly pending)
### Request
Only account `tam@bmq.vn` can delete SKU in "SKU thành phẩm" list; other accounts must not see Delete button.

### Proposed implementation plan (pending approval to execute)
1. FE: hide Delete button unless logged-in email equals `tam@bmq.vn`.
2. BE/RLS: enforce delete permission by email at DB policy level.
3. Refactor `removeSku` to single delete on `product_skus` + rely on cascade.
4. Test matrix with `tam@bmq.vn` and non-authorized accounts.

## Recent commits
- `53800b1` fix(sku-detail): align summary metrics with edit formula per-unit costing
- `3a7338e` fix(sku-detail): render NVL cost from formulation values to match edit dialog
- `5554cd7` feat(sku-costs): add read-only SKU detail dialog from SKU name click
- `c404f77` fix(sku-costs): show inline save error and add save loading state
- `bdc36ff` fix(sku-costs): load and persist formulation rows when editing SKU

## Notes for next assignee
- If implementing delete restriction, do **both FE + RLS**, not FE-only.
- Production DB had schema drifts earlier (`cost_template`, `ingredient_sku_id`), check before rollout.
