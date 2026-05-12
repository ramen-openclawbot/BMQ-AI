#!/usr/bin/env python3
from dataclasses import dataclass


@dataclass
class State:
    quantity: int
    amount: int
    revenue_amount_status: str
    dispatch_confirmation_status: str
    needs_manual_review: bool


def preview_state(po_qty: int, po_amount: int, confirmation: dict | None) -> State:
    if confirmation is None:
        return State(po_qty, po_amount, "temporary_po_amount", "missing", False)

    if confirmation["amount_status"] == "needs_sku_allocation":
        return State(po_qty, po_amount, "temporary_po_amount", "needs_sku_allocation", True)

    if confirmation["status"] in {"confirmed", "revised"} and confirmation["amount_status"] in {
        "confirmed_dispatch_amount",
        "month_end_audit_adjusted",
    }:
        return State(
            confirmation["billable_qty"],
            confirmation["confirmed_amount"],
            confirmation["amount_status"],
            confirmation["status"],
            False,
        )

    return State(po_qty, po_amount, "temporary_po_amount", confirmation["status"], False)


def header_amount_status(lines: list[dict], manual_amount: int | None = None, note: str | None = None) -> str:
    shortage_lines = [line for line in lines if line["ordered_qty"] > line["billable_qty"] or line.get("defect_qty", 0) > 0]
    missing_allocation = any(not line.get("sku") or not line.get("shortage_reason_code") for line in shortage_lines)
    if manual_amount and note:
        return "confirmed_dispatch_amount"
    if shortage_lines and missing_allocation:
        return "needs_sku_allocation"
    if any(line.get("confirmed_amount", 0) > 0 for line in lines):
        return "confirmed_dispatch_amount"
    return "temporary_po_amount"


def safe_confirmed_amount(ordered_qty: int, billable_qty: int, sku: str, manual_amount: int, computed_amount: int) -> int | None:
    has_shortage = ordered_qty > billable_qty
    if has_shortage and not sku:
        return None
    return manual_amount or computed_amount or None


def main() -> None:
    missing = preview_state(600, 8_558_420, None)
    assert missing.amount == 8_558_420
    assert missing.revenue_amount_status == "temporary_po_amount"
    assert missing.dispatch_confirmation_status == "missing"

    needs_sku = header_amount_status([
        {"ordered_qty": 600, "billable_qty": 598, "defect_qty": 2, "sku": "", "shortage_reason_code": "production_defect"},
    ])
    assert needs_sku == "needs_sku_allocation"
    assert safe_confirmed_amount(600, 598, "", 0, 8_529_892) is None
    needs_state = preview_state(600, 8_558_420, {"status": "draft", "amount_status": needs_sku})
    assert needs_state.amount == 8_558_420
    assert needs_state.needs_manual_review

    confirmed_status = header_amount_status([
        {"ordered_qty": 600, "billable_qty": 598, "defect_qty": 2, "sku": "SP001", "shortage_reason_code": "production_defect", "confirmed_amount": 8_529_892},
    ])
    assert confirmed_status == "confirmed_dispatch_amount"
    assert safe_confirmed_amount(600, 598, "SP001", 0, 8_529_892) == 8_529_892
    confirmed = preview_state(600, 8_558_420, {
        "status": "confirmed",
        "amount_status": confirmed_status,
        "billable_qty": 598,
        "confirmed_amount": 8_529_892,
    })
    assert confirmed.quantity == 598
    assert confirmed.amount == 8_529_892
    assert confirmed.revenue_amount_status == "confirmed_dispatch_amount"

    manual = header_amount_status([
        {"ordered_qty": 600, "billable_qty": 598, "defect_qty": 2, "sku": "", "shortage_reason_code": ""},
    ], manual_amount=8_500_000, note="Month-end audited amount")
    assert manual == "confirmed_dispatch_amount"

    print("dispatch revenue confirmation state assertions passed")


if __name__ == "__main__":
    main()
