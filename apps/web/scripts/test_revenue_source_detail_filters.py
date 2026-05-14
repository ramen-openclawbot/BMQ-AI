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

    print("revenue source detail filter checks passed")


if __name__ == "__main__":
    main()
