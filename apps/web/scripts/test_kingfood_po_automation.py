#!/usr/bin/env python3
"""Lightweight regression checks for Kingfood PO automation edge-function wiring.

These checks intentionally avoid secrets/network. They verify the production edge
function contains the Kingfood-specific automation guardrails agreed with the user:
- sender-scoped rule for dathang@kingfoodmart.com
- cancellation detection that does not create a normal parsed PO
- PDF-only/manual-review path
- XLSX auto-parse path that writes production_items/subtotal fields during Gmail sync
- default schedule migration for Kingfood automation
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SYNC = ROOT / "supabase/functions/po-gmail-sync/index.ts"
SCHED = ROOT / "supabase/functions/po-sync-scheduler-run/index.ts"
MIGRATIONS = ROOT / "supabase/migrations"

sync = SYNC.read_text(encoding="utf-8")
scheduler = SCHED.read_text(encoding="utf-8")
migrations = "\n".join(p.read_text(encoding="utf-8") for p in MIGRATIONS.glob("*.sql"))


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"missing {label}: expected to find {needle!r}"


def test_kingfood_gmail_sync_sender_rule_and_xlsx_parse() -> None:
    assert_contains(sync, "dathang@kingfoodmart.com", "Kingfood sender rule")
    assert_contains(sync, "KINGFOOD_AUTOMATION", "Kingfood automation constants")
    assert_contains(sync, "import * as XLSX", "XLSX parsing import in Gmail sync")
    assert_contains(sync, "parseKingfoodXlsx", "Kingfood XLSX parser")
    assert_contains(sync, "service_date", "Kingfood item ISO service date support")
    assert_contains(sync, "normalizeKingfoodSpreadsheetDate", "Kingfood spreadsheet date normalization")
    assert_contains(sync, "production_items", "Gmail sync writes parsed items")
    assert_contains(sync, "subtotal_amount", "Gmail sync writes subtotal")


def test_kingfood_cancel_and_pdf_only_guardrails() -> None:
    assert_contains(sync, "cancel_signal", "cancel signal status")
    assert_contains(sync, "pdf_only_needs_review", "PDF-only review status")
    assert_contains(sync, "parseKingfoodPdf", "Kingfood PDF parser")
    assert_contains(sync, "kingfood_pdf_text:v1", "Kingfood PDF text parser marker")
    assert_contains(sync, "kingfood_pdf_row_item", "Kingfood PDF production row marker")
    assert_contains(sync, "parsed_valid", "valid XLSX parsed status")
    assert_contains(sync, "automation_status", "automation status metadata")


def test_kingfood_pdf_croissant_160g_keeps_canonical_finished_sku_name() -> None:
    assert_contains(sync, "croissant160g40gx4cai", "Kingfood Croissant 160g PDF alias")
    assert_contains(sync, "BMQ - BÁNH CROISSANT 160G (40G x 4 CÁI)", "canonical Croissant 160g finished SKU name")
    assert "return \"Croissant (40g)\"" not in sync, "Kingfood Croissant 160g must not be shortened; strict production SKU matching will hide it"


def test_scheduler_keeps_unparsed_exception_out_of_pending_revenue() -> None:
    assert_contains(scheduler, "po_automation", "scheduler reads PO automation metadata")
    assert_contains(scheduler, "pdf_only_needs_review", "scheduler flags PDF-only exception")
    assert_contains(scheduler, "cancel_signal", "scheduler flags cancel exception")
    assert_contains(scheduler, "Kingfood PO cần review", "Vietnamese review exception copy")


def test_default_kingfood_schedule_migration_exists() -> None:
    assert_contains(migrations, "kingfood_po_automation", "Kingfood schedule migration marker")
    assert_contains(migrations, "po_sync_schedules", "PO sync schedule upsert")
    assert_contains(migrations, "dathang@kingfoodmart.com", "schedule notes mention sender filter")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
