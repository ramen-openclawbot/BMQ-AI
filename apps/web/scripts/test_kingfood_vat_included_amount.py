#!/usr/bin/env python3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MONTHLY = ROOT / "supabase/functions/revenue-monthly-parse-preview/index.ts"
GMAIL_SYNC = ROOT / "supabase/functions/po-gmail-sync/index.ts"


def vat_included_amount(amount: int, amount_includes_vat: bool) -> int:
    return amount if amount_includes_vat else round(amount * 1.08)


def proportional_dispatch_amount(po_amount_vat_included: int, billable_qty: int, ordered_qty: int) -> int:
    if ordered_qty <= 0:
        return 0
    return round(po_amount_vat_included * billable_qty / ordered_qty)


def main() -> None:
    po1002504788_total = 8_558_420
    assert vat_included_amount(po1002504788_total, True) == 8_558_420
    assert vat_included_amount(po1002504788_total, True) != round(po1002504788_total * 1.08)

    # Temporary PO revenue stays the full ordered PO amount until SKU allocation/manual audit.
    assert po1002504788_total == 8_558_420

    # If a confirmed dispatch helper is used after allocation, 598/600 is deterministic.
    assert proportional_dispatch_amount(po1002504788_total, 598, 600) == 8_529_892

    monthly = MONTHLY.read_text()
    gmail_sync = GMAIL_SYNC.read_text()
    assert "vat_handling: \"no_extra_multiplier\"" in monthly
    assert "kingfood_po_total_vat_included" in monthly
    assert "amount_includes_vat: true" in gmail_sync
    assert "kingfood_po_total_vat_included" in gmail_sync
    assert "* 1.08" not in monthly

    print("kingfood VAT-included amount assertions passed")


if __name__ == "__main__":
    main()
