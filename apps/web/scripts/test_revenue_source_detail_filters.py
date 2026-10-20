#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "pages" / "RevenueSourceDetail.tsx"


def main() -> None:
    text = SRC.read_text()
    removed = [
        "Bạn có quyền finance_revenue: có thể sửa dòng sai qua audited edit flow.",
        "Bạn chưa có quyền finance_revenue nên nút Edit đang bị khóa.",
        "Edit enabled",
        "Read only",
    ]
    for needle in removed:
        assert needle not in text, f"permission explainer box still present: {needle}"

    required = [
        'params.get("period")',
        'params.get("channel")',
        'params.get("revenue_date")',
        'type="month"',
        'type="date"',
        'id="ledger-channel-filter"',
        "Tất cả kênh",
        "Xóa lọc",
        "updateMonthFilter",
        "clearLedgerFilters",
        '.eq("revenue_date", revenueDate)',
        '.eq("channel", channel)',
    ]
    for needle in required:
        assert needle in text, f"missing ledger filter marker: {needle}"

    # A date range in another month must move the Tháng filter with it, because
    # the query filters by period AND revenue_date (Tháng 10 + 01/09–30/09 = 0 rows).
    handler = text[text.index("const updateDateRangeFilter"):]
    handler = handler[:handler.index("\n  };\n")]
    assert 'next.set("period", month)' in handler, "date change must align period"
    assert "next.delete(otherKey)" in handler, "the other bound from the old month must be dropped"
    effect = text[text.index("const month = (dateFrom || dateTo || revenueDate).slice(0, 7);"):]
    assert "setParams(next, { replace: true })" in effect[:400], "stale URLs must be aligned on load"

    print("revenue source detail filter checks passed")


if __name__ == "__main__":
    main()
