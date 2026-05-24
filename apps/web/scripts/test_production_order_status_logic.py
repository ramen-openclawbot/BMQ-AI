#!/usr/bin/env python3
"""Regression guard for Q7 production order date/status behavior.

A production order for tomorrow must not be created or displayed as
"Đang sản xuất" on today's production screen. Active orders with delivery
items for the Vietnam business day should display as in-progress.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src/pages/ProductionPlanning.tsx"
text = SOURCE.read_text(encoding="utf-8")

assert "const getProductionOrderDisplayStatus" in text, "missing date-aware production order display-status helper"
assert "hasTodayItems" in text, "helper must check whether the order has items for the current VN production date"
assert "return \"in_progress\";" in text, "today's active orders must render as in_progress"
assert "return \"draft\";" in text, "future active orders must render as draft, not in_progress"
assert "status: \"draft\"" in text, "new future production orders should be created as draft by default"
assert "getStatusBadge(getProductionOrderDisplayStatus(order, tvProductionDateIso))" in text, "order list must use date-aware display status"
assert "const productionDateIso = normalizeDateForDb(input.planned_start_date) || vietnamTodayInputValue();" in text, "production_number must be based on the production/delivery date, not the creation date"
assert ".like(\"production_number\", `SX-${dateStr}-%`)" in text, "production_number sequence must be counted per production date prefix"
assert "const dateStr = vietnamTodayInputValue().replace" not in text, "old creation-date-based production_number logic must not return"

print("production order date/status/numbering logic guard passed")
