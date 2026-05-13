#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REVENUE_SOURCE = ROOT / "src" / "pages" / "RevenueSourceDetail.tsx"
WAREHOUSE_DISPATCH = ROOT / "src" / "pages" / "WarehouseDispatch.tsx"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_revenue_source_links_po_lines_to_dispatch_confirmation() -> None:
    src = read(REVENUE_SOURCE)
    required = [
        "getInboxRowId",
        "openDispatchConfirmation",
        "Xác nhận số xuất",
        "PO đặt nhưng thực tế giao không đủ",
        "dispatchPoId",
        "/warehouse-dispatch?",
    ]
    for needle in required:
        assert needle in src, f"missing RevenueSourceDetail marker: {needle}"


def test_warehouse_dispatch_supports_deep_linked_po_confirmation() -> None:
    src = read(WAREHOUSE_DISPATCH)
    required = [
        "useSearchParams",
        "dispatchPoId",
        "autoOpenDispatchFromLedger",
        "Xử lý giao thiếu từ ledger",
        "setSelectedPoId(dispatchPoId)",
        "po_dispatch_revenue_confirmations",
        "tránh cộng trùng công nợ",
    ]
    for needle in required:
        assert needle in src, f"missing WarehouseDispatch marker: {needle}"


def test_database_prevents_duplicate_active_confirmation_per_po() -> None:
    migrations = "\n".join(path.read_text(encoding="utf-8") for path in (ROOT / "supabase" / "migrations").glob("*.sql"))
    required = [
        "uq_po_dispatch_revenue_confirmations_active_po",
        "on public.po_dispatch_revenue_confirmations(customer_po_inbox_id)",
        "where status <> 'cancelled'",
    ]
    for needle in required:
        assert needle in migrations, f"missing duplicate guard marker: {needle}"


def main() -> None:
    test_revenue_source_links_po_lines_to_dispatch_confirmation()
    test_warehouse_dispatch_supports_deep_linked_po_confirmation()
    test_database_prevents_duplicate_active_confirmation_per_po()
    print("dispatch shortage ledger flow checks passed")


if __name__ == "__main__":
    main()
