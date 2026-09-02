#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SYNC = ROOT / "supabase/functions/po-gmail-sync/index.ts"
BREAD = ROOT / "supabase/functions/dealer-warehouse-notify/index.ts"
SHARED = ROOT / "supabase/functions/_shared/daily-bread-order.ts"
MIGRATION = ROOT / "supabase/migrations/20260903010000_mam_non_may_tuyet_anh_flow.sql"


def must(text: str, needle: str, label: str) -> None:
    assert needle in text, f"missing {label}: {needle}"


def test_mail_parser_keeps_revenue_exact_and_supplier_rounding_separate() -> None:
    sync = SYNC.read_text(encoding="utf-8")
    shared = SHARED.read_text(encoding="utf-8")
    for needle, label in [
        ("parseMamNonMayEmailOrder", "shared exact parser"),
        ('rule: "mam_non_may_bread_order"', "dedicated automation rule"),
        ('customerName: "Mầm non May"', "exact CRM customer"),
        ("revenue_qty: mamNonOrder.revenueQuantity", "exact revenue quantity"),
        ("supplier_order_qty: mamNonOrder.supplierQuantity", "separate supplier quantity"),
        ("warehouse_surplus_qty: mamNonOrder.warehouseSurplusQuantity", "surplus evidence"),
        ("isMamNonMayEmailSubject(subject || \"\")", "exact subject-scoped customer override"),
        ("mamNonMaySubject ||", "exact-subject unmatched mail remains auditable"),
        ("matchedCustomerId", "subject-scoped exact customer override"),
        ("mini_crm_customer_price_list", "approved customer price lookup"),
        ("mamNonUnitPrice", "resolved customer price"),
        ("mamNonUnitPrice === MAM_NON_MAY_AUTOMATION.approvedUnitPrice", "exact approved price gate"),
        ("mamNonMayAutomation || thuyDirectDealerAutomation", "dedicated parser precedence"),
    ]:
        must(sync, needle, label)
    must(shared, "supplierQuantity - orderedQuantity", "rounding surplus arithmetic")


def test_supplier_worker_syncs_mail_before_compiling_order() -> None:
    bread = BREAD.read_text(encoding="utf-8")
    for needle, label in [
        ("syncMamNonMayMailbox", "pre-order mailbox sync"),
        ("await syncMamNonMayMailbox", "sync before supplier calculation"),
        ("dayRange.startsAt", "Vietnam-day Gmail lower epoch boundary"),
        ("dayRange.endsBefore", "Vietnam-day Gmail upper epoch boundary"),
        ('rule === "mam_non_may_bread_order"', "dedicated row filter"),
        ("mamNonOrderedQuantity", "supplier message input"),
        ('mam_non: {', "source snapshot"),
        ("warehouse_surplus_quantity", "surplus source evidence"),
        ("blockedMamNonOrders", "fail-closed invalid Mầm non source guard"),
    ]:
        must(bread, needle, label)


def test_sent_supplier_order_creates_exact_customer_reservation_only() -> None:
    sql = MIGRATION.read_text(encoding="utf-8")
    for needle, label in [
        ("sync_tan_tao_mam_non_reservation", "dedicated reservation trigger"),
        ("mam_non_may_bread_order", "source rule guard"),
        ("ordered_quantity", "exact customer reservation source"),
        ("warehouse_surplus_quantity", "surplus audit metadata"),
        ("supplier_order_quantity", "rounded supplier evidence"),
        ("customer_po_email", "source type"),
        ("on conflict (idempotency_key) do nothing", "idempotency"),
    ]:
        must(sql.lower(), needle.lower(), label)


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
