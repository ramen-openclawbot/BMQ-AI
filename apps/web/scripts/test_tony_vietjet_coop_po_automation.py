#!/usr/bin/env python3
"""Regression checks for Tony, Vietjet, Coopmart PO automation guardrails."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SYNC = ROOT / "supabase/functions/po-gmail-sync/index.ts"
SCHED = ROOT / "supabase/functions/po-sync-scheduler-run/index.ts"
MONTHLY = ROOT / "supabase/functions/revenue-monthly-parse-preview/index.ts"
MONTHLY_APPROVE_MIGRATION = ROOT / "supabase/migrations/20260510122949_monthly_parse_owner_controlled_approve.sql"
SPEC = ROOT.parents[1] / "PO_AUTO_PARSE_FLOW_SPEC.md"

sync = SYNC.read_text(encoding="utf-8")
scheduler = SCHED.read_text(encoding="utf-8")
monthly = MONTHLY.read_text(encoding="utf-8")
monthly_approve_migration = MONTHLY_APPROVE_MIGRATION.read_text(encoding="utf-8")
spec = SPEC.read_text(encoding="utf-8")


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"missing {label}: expected to find {needle!r}"


def test_tony_sender_rule_date_shift_and_quantities() -> None:
    for needle, label in [
        ("TONY_THANH_AUTOMATION", "Tony automation constants"),
        ("tonythanh@hotmail.com", "Tony sender"),
        ("tony_thanh_npp_text", "Tony rule id"),
        ("po_order_date_plus_1_day", "Tony +1 day mapping"),
        ("revenue_qty: orderedQty", "ordered qty is revenue qty"),
        ("physical_qty: orderedQty + exchangeQty + makeupQty", "physical qty includes đổi/bù"),
        ("ĐẠI LÝ TOP MARKET ÂU CƠ", "Top Market/Âu Cơ alias"),
        ("reply/update/supplement semantics require manual reconciliation", "update/reply guardrail"),
    ]:
        assert_contains(sync, needle, label)
    assert_contains(spec, "ledger_date = po_order_date + 1 day", "locked Tony date rule in spec")


def test_vietjet_cumulative_xlsx_rule_and_monthly_dedupe() -> None:
    for needle, label in [
        ("VIETJET_AUTOMATION", "Vietjet automation constants"),
        ("vietjetair.com", "Vietjet sender domain"),
        ("vietjet_cumulative_xlsx", "Vietjet rule id"),
        ("TỔNG CỘNG THEO NGÀY", "total by day marker"),
        ("excelSerialToIsoDate", "Excel serial service date conversion"),
        ("40000294", "Vietjet product code"),
        ("row?.[18]", "one-based column 19 quantity"),
        ("keep_latest_gmail_timestamp_per_service_date_product", "dedupe strategy"),
    ]:
        assert_contains(sync, needle, label)
    for needle, label in [
        ("latestVietjetByKey", "monthly preview latest-by-key dedupe"),
        ("Fetch through the current local day", "monthly preview fetches enough rows for cumulative latest schedules"),
        ('rule === "vietjet_cumulative_xlsx"', "monthly preview Vietjet rule check"),
    ]:
        assert_contains(monthly, needle, label)


def test_coopmart_guardrail_blocks_auto_posting() -> None:
    for needle, label in [
        ("COOPMART_AUTOMATION", "Coopmart constants"),
        ("mai-hnp@saigonco-op.com.vn", "Coopmart original sender"),
        ("tram-nht@saigonco-op.com.vn", "Coopmart alternate sender seen in production mailbox"),
        ("isCoopmartSenderEmail", "Coopmart sender/domain matcher"),
        ("coopmart_manual_trusted_ledger_only", "Coopmart manual/trusted-ledger status"),
        ("do not auto-post PO parse revenue", "Coopmart no-auto-post reason"),
        ("revenue_posting_allowed: false", "Coopmart no revenue posting flag"),
    ]:
        assert_contains(sync, needle, label)
    for needle, label in [
        ("COOPMART_SENDERS", "scheduler Coopmart explicit sender list"),
        ("tram-nht@saigonco-op.com.vn", "scheduler Coopmart alternate sender fetch"),
        ("Coopmart giữ manual/trusted ledger", "scheduler Coopmart exception label"),
    ]:
        assert_contains(scheduler, needle, label)


def test_monthly_preview_uses_parser_service_date_before_fallback() -> None:
    for needle, label in [
        ("lineRevenueDate", "line-level revenue date resolver"),
        ("normalizeRevenueDate", "date normalization before monthly filtering"),
        ("MM/DD/YYYY", "Kingfood spreadsheet date format support"),
        ("item.service_date", "item service date precedence"),
        ("parseMeta.service_date", "parse meta service date precedence"),
        ("parser_service_date_or_po_received_local_date_plus_1_day_fallback", "explicit fallback label"),
        ("vietjet_cumulative_evidence_only", "Vietjet evidence-only review status"),
        ("coopmart_manual_trusted_ledger_only", "Coopmart review status"),
    ]:
        assert_contains(monthly, needle, label)


def test_monthly_preview_uses_dashboard_canonical_channels() -> None:
    for needle, label in [
        ("dashboardRevenueChannel", "dashboard channel mapper"),
        ('return "ĐẠI LÝ"', "agency canonical dashboard channel"),
        ('return "BÁNH NGỌT"', "bakery canonical dashboard channel"),
        ('return "B2B BMQ"', "B2B canonical dashboard channel"),
        ('return "Retail Kiosk"', "retail canonical dashboard channel"),
        ("raw_parse_channel", "raw parse channel preserved in payload"),
        ("DAM_XESG_T4_GROSS_REVENUE", "Retail Kiosk T4 estimate constant"),
        ("t4_xesg_sent_qty_revenue_estimate", "Retail Kiosk T4 estimate metadata"),
        ("combined.includes(\"king\")", "Kingfood overrides stale b2b channel signal"),
    ]:
        assert_contains(monthly, needle, label)


def test_scheduler_keeps_new_rules_in_exception_review_path() -> None:
    for needle, label in [
        ("TONY_THANH_SENDER", "Tony sender-scoped fetch"),
        ("VIETJET_SENDER_DOMAIN", "Vietjet sender-scoped fetch"),
        ("COOPMART_SENDER", "Coop sender-scoped fetch"),
        ("vietjet_cumulative_evidence_only", "Vietjet evidence-only blocks pending draft"),
        ("coopmart_manual_trusted_ledger_only", "Coopmart blocks pending draft"),
        ('automationRule === "tony_thanh_npp_text"', "Tony rule-aware scheduler label"),
        ('automationRule === "vietjet_cumulative_xlsx"', "Vietjet rule-aware scheduler label"),
        ('automationRule === "coopmart_manual_trusted_ledger_only"', "Coop rule-aware scheduler label"),
        ("canCreatePendingDraft = isTier1 && !automationNeedsReview", "review status blocks pending drafts"),
    ]:
        assert_contains(scheduler, needle, label)


def test_monthly_approval_posts_all_preview_rows_to_controlled_ledger() -> None:
    for needle, label in [
        ("owner_controlled_ledger_first", "ledger-first approval semantics marker"),
        ("'posted_line_count', _line_count", "posted line count matches all preview rows"),
        ("'review_flagged_line_count', _review_flagged_line_count", "review flag count preserved as metadata"),
        ("'trust_semantics', 'not_trusted_month_end_audit_source'", "PO/email parse is not trusted month-end source"),
        ("from public.revenue_monthly_parse_lines\n  where run_id = _run.id\n  order by source_row_number", "all preview lines inserted without review-status filter"),
        ("approval_status = 'superseded'", "old ledger rows superseded on replace"),
    ]:
        assert_contains(monthly_approve_migration, needle, label)
    assert "and review_status <> 'needs_manual_review'" not in monthly_approve_migration, "approval must not exclude parser-review rows"
    assert "excluded_review_line_count" not in monthly_approve_migration, "approval should not report review rows as excluded"


def test_monthly_preview_summary_exposes_ledger_first_counts() -> None:
    for needle, label in [
        ("postedRows: lines.length", "preview posted rows equals all lines"),
        ("ledgerRows: lines.length", "preview ledger rows equals all lines"),
        ("dashboardGrossRevenue: grossRevenue", "dashboard gross equals total preview gross"),
        ("reviewFlaggedRows: needsReview", "review flags preserved as metadata"),
        ("approvalSemantics: \"owner_controlled_ledger_first\"", "preview approval semantics marker"),
    ]:
        assert_contains(monthly, needle, label)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
