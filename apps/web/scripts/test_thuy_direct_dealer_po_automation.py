#!/usr/bin/env python3
"""Regression checks for Thuy direct-dealer PO evidence guardrails."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SYNC = ROOT / "supabase/functions/po-gmail-sync/index.ts"
SCHED = ROOT / "supabase/functions/po-sync-scheduler-run/index.ts"
RULES = ROOT / "supabase/po-automation-rules/revenue_po_rules.json"
SPEC = ROOT.parents[1] / "PO_AUTO_PARSE_FLOW_SPEC.md"

sync = SYNC.read_text(encoding="utf-8")
scheduler = SCHED.read_text(encoding="utf-8")
rules = RULES.read_text(encoding="utf-8")
spec = SPEC.read_text(encoding="utf-8")


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"missing {label}: expected to find {needle!r}"


def test_thuy_sender_text_parser_and_direct_dealer_scope() -> None:
    for needle, label in [
        ("THUY_DIRECT_DEALER_AUTOMATION", "Thuy automation constants"),
        ("thuy@bmq.vn", "Thuy sender"),
        ("thuy_direct_dealer_text", "Thuy rule id"),
        ("direct_company_dealer_not_npp", "direct dealer scope"),
        ("manual_revenue_management_required: true", "manual revenue path"),
        ("revenue_posting_allowed: false", "no auto revenue posting"),
    ]:
        assert_contains(sync, needle, label)


def test_thuy_ledger_only_missing_days_are_documented() -> None:
    for text in [rules, spec]:
        assert_contains(text, "ledger-only", "ledger-only missing day acceptance")
        assert_contains(text, "trusted ledger", "trusted ledger accounting truth")


def test_scheduler_keeps_thuy_in_review_manual_path() -> None:
    for needle, label in [
        ("line_level_manual_revenue_ready", "manual-ready status stays review"),
        ('automationRule === "thuy_direct_dealer_text"', "rule-aware Thuy label"),
        ("Thúy đại lý trực tiếp cần đối soát Quản lý doanh thu", "Vietnamese review copy"),
        ("canCreatePendingDraft = isTier1 && !automationNeedsReview", "review status blocks pending drafts"),
        ("THUY_DIRECT_DEALER_SENDER", "sender-scoped scheduler constant"),
        ('.eq("from_email", THUY_DIRECT_DEALER_SENDER)', "fetch Thuy rows even without matched_customer_id"),
        ("Sender-scoped evidence can store final/customer mapping", "documented null customer guardrail"),
    ]:
        assert_contains(scheduler, needle, label)


def test_thuy_service_date_uses_email_sent_plus_one_day() -> None:
    for needle, label in [
        ("the local email-sent date + 1 day", "email sent +1 day canonical service date"),
        ("staff typos", "subject/body date typo diagnostic guardrail"),
        ("return shiftIsoDate(localDateFromTimestamp(receivedAt), 1)", "implemented sent-date shift"),
    ]:
        assert_contains(sync, needle, label)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
