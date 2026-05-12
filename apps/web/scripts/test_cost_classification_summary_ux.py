#!/usr/bin/env python3
"""Static regression checks for finance cost classification summary UX.

Guards the product rule that category_code is the authoritative grouping field:
- the monthly summary UI aggregates by canonical category, not review_status/product_line/allocation
- detail fetches for a summary row use month + category_code only
- review_status remains informational metadata, not a grouping/filtering key
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FINANCE = ROOT / "src/pages/FinanceControl.tsx"
HOOK = ROOT / "src/hooks/useCostClassifications.ts"

finance = FINANCE.read_text(encoding="utf-8")
hook = HOOK.read_text(encoding="utf-8")

assert "classificationMonthlyDisplayRows" in finance, "FinanceControl must use display rows aggregated by canonical category"
assert "review_status_counts" in finance, "Aggregated summary rows must keep review status only as note/count metadata"
assert "classificationMonthlyRows.map((row)" not in finance, "Raw monthly rows must not render directly because they are split by review_status"
assert "Product line" not in finance[finance.index("Tổng theo tháng và nhóm"):finance.index("selectedCostSummaryRow &&")], "Summary table should not expose product_line as a grouping column"
assert "Allocation" not in finance[finance.index("Tổng theo tháng và nhóm"):finance.index("selectedCostSummaryRow &&")], "Summary table should not expose allocation as a grouping column"
assert "row.review_status}</TableCell>" not in finance, "Review status must not be rendered as the row grouping value"

filter_block_start = hook.index("export interface CostClassificationDetailFilter")
filter_block_end = hook.index("function normalizeCategoryOption", filter_block_start)
filter_block = hook[filter_block_start:filter_block_end]
assert "product_line" not in filter_block, "Detail filter should not include product_line"
assert "allocation_rule" not in filter_block, "Detail filter should not include allocation_rule"
assert "review_status" not in filter_block, "Detail filter should not include review_status"

hook_detail_start = hook.index("export function useCostClassificationLineDetails")
hook_detail = hook[hook_detail_start:]
assert '.eq("category_code", filter.category_code)' in hook_detail, "Detail query must still filter by authoritative category_code"
assert '.eq("product_line"' not in hook_detail, "Detail query must not filter product_line"
assert '.eq("allocation_rule"' not in hook_detail, "Detail query must not filter allocation_rule"
assert '.eq("review_status"' not in hook_detail, "Detail query must not filter review_status"

print("cost classification summary UX regression checks passed")
