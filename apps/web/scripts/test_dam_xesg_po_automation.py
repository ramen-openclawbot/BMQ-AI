#!/usr/bin/env python3
"""Lightweight regression checks for Dam/XESG PO evidence automation wiring.

These checks intentionally avoid secrets/network. They verify the production edge
functions contain the Dam/XESG-specific guardrails agreed with the user:
- sender-scoped text-body parser for damvovan33@gmail.com
- direct subject service date without Tony-style +1 shifting
- route alias normalization, including 00 quantities and optional trailing *
- evidence-only metadata that does not auto-post revenue
- scheduler review/exception behavior for downstream trusted-ledger reconciliation
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SYNC = ROOT / "supabase/functions/po-gmail-sync/index.ts"
SCHED = ROOT / "supabase/functions/po-sync-scheduler-run/index.ts"

sync = SYNC.read_text(encoding="utf-8")
scheduler = SCHED.read_text(encoding="utf-8")


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"missing {label}: expected to find {needle!r}"


def test_dam_xesg_sender_rule_and_text_body_parser() -> None:
    assert_contains(sync, "DAM_XESG_AUTOMATION", "Dam/XESG automation constants")
    assert_contains(sync, "damvovan33@gmail.com", "Dam/XESG sender")
    assert_contains(sync, "dam_xesg_text_body", "Dam/XESG rule")
    assert_contains(sync, "po-gmail-sync:dam-xesg-text-body:v1", "Dam/XESG parser name")
    assert_contains(sync, "extractGmailTextPlainBody", "decoded text/plain Gmail body parser")
    assert_contains(sync, "gmail_text_plain_body", "text body source metadata")
    assert_contains(sync, "fromEmail === DAM_XESG_AUTOMATION.sender", "Dam/XESG included in unmatched sender allowlist")
    assert_contains(scheduler, "DAM_XESG_SENDER", "scheduler Dam/XESG sender-scoped fetch")


def test_subject_date_is_direct_service_date() -> None:
    assert_contains(sync, "parseDamXesgSubjectDate", "Dam/XESG subject date parser")
    assert_contains(sync, "Đặt\\s+bánh\\s+điểm\\s+bán", "subject marker")
    assert_contains(sync, "delivery_date: damXesgServiceDate", "service date becomes delivery date")
    assert "+ 1" not in sync[sync.index("parseDamXesgSubjectDate") : sync.index("stripQuotedDamXesgBody")], (
        "Dam/XESG subject date parser must not apply Tony-style +1 day shifting"
    )


def test_route_aliases_qty_zero_and_optional_star() -> None:
    for route in ["Bùi Viện", "Bùi Hữu Nghĩa", "Bến Vân Đồn", "Phạm Văn Chí", "213 Phạm Văn Chí", "Thống Nhất", "Lê Văn Quới"]:
        assert_contains(sync, route, f"route alias {route}")
    assert_contains(sync, r"(\d+)\s*(\*)?", "trailing quantity with optional star regex")
    assert_contains(sync, "raw_qty", "raw qty preservation supports 00")
    assert_contains(sync, "has_star", "optional trailing star preservation")


def test_evidence_metadata_preserves_operational_fields() -> None:
    for needle, label in [
        ("production_items", "production items"),
        ("raw_payload", "raw payload"),
        ("po_automation", "PO automation metadata"),
        ("raw_line", "raw line preservation"),
        ("gmail_message_id", "Gmail message id preservation"),
        ("subject", "subject preservation"),
        ("timestamp", "timestamp preservation"),
        ("route", "route preservation"),
        ("qty", "qty preservation"),
        ("sent_qty", "sent quantity evidence preservation"),
        ("sold_qty", "sold quantity accounting separation"),
        ("trusted_ledger_sold_qty", "trusted ledger sold quantity source"),
        ("662 bánh", "T4 inventory note"),
        ("confidence", "confidence preservation"),
        ("po_evidence_only", "evidence-only status"),
        ("trusted_source_used_qty_delta", "trusted-ledger reconciliation status"),
        ("trusted ledger reconciliation decides accounting revenue", "trusted ledger reason"),
    ]:
        assert_contains(sync, needle, label)


def test_dam_xesg_review_parse_meta_is_written() -> None:
    parse_meta_start = sync.index(": damXesgAutomation")
    parse_meta_end = sync.index(": kingfoodAutomation?.automation_status", parse_meta_start)
    dam_parse_meta = sync[parse_meta_start:parse_meta_end]
    assert "po_evidence_only" not in dam_parse_meta, "Dam/XESG parse_meta must not be limited to successful evidence-only parses"
    for needle, label in [
        ('source: "dam_xesg_gmail_text_body_auto"', "Dam/XESG parse_meta source"),
        ("parser: DAM_XESG_AUTOMATION.parser", "Dam/XESG parse_meta parser"),
        ("service_date: damXesgServiceDate", "Dam/XESG parse_meta service date"),
        ("item_count: Number(damXesgAutomation.item_count || 0)", "Dam/XESG zero item count metadata"),
        ("trusted_ledger_required: true", "Dam/XESG trusted ledger required metadata"),
        ("status: damXesgAutomation.automation_status", "Dam/XESG review status metadata"),
        ("reason: damXesgAutomation.reason", "Dam/XESG review reason metadata"),
    ]:
        assert_contains(dam_parse_meta, needle, label)


def test_scheduler_keeps_dam_xesg_out_of_pending_revenue() -> None:
    assert_contains(scheduler, "po_evidence_only", "scheduler review status for evidence-only rows")
    assert_contains(scheduler, "AUTOMATION_REVIEW_STATUSES", "central scheduler automation review statuses")
    assert_contains(scheduler, 'automationRule === "dam_xesg_text_body"', "rule-aware Dam/XESG exception copy")
    assert_contains(scheduler, "Dam/XESG PO evidence cần review", "Dam/XESG review exception copy")
    assert_contains(scheduler, "canCreatePendingDraft = isTier1 && !automationNeedsReview", "review statuses block pending drafts")


def test_scheduler_review_label_is_rule_aware() -> None:
    assert_contains(scheduler, 'automationRule === "dam_xesg_text_body"', "Dam/XESG rule-specific label")
    assert_contains(scheduler, 'automationRule === "kingfood_po_automation"', "Kingfood rule-specific label")
    assert_contains(scheduler, "Kingfood PO cần review", "Kingfood review label")
    assert_contains(scheduler, "PO automation cần review", "neutral automation review fallback")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
