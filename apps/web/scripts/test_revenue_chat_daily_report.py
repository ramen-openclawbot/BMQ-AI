#!/usr/bin/env python3
"""Static regression checks for revenue daily chat report UX."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHAT = ROOT / "src/components/agent/GlobalAgentChatWidget.tsx"
DETAIL = ROOT / "src/pages/RevenueSourceDetail.tsx"
MONTHLY = ROOT / "supabase/functions/revenue-monthly-parse-preview/index.ts"

chat = CHAT.read_text(encoding="utf-8")
detail = DETAIL.read_text(encoding="utf-8")
monthly = MONTHLY.read_text(encoding="utf-8")


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"missing {label}: expected to find {needle!r}"


def test_chat_daily_report_card_and_buttons() -> None:
    for needle, label in [
        ('action: "latest_auto_daily_report"', "latest daily report action"),
        ("Auto daily cron report", "compact cron card heading"),
        ("Doanh thu tạm kiểm soát", "temporary controlled wording"),
        ("chưa phải trusted/month-end audited source", "not trusted wording"),
        ("Ledger chi tiết", "ledger detail button copy"),
        ("Chạy parse daily", "parse daily button copy"),
        ("sourceDocumentId: dailyReport.sourceDocumentId", "detail route source filter"),
        ("revenue_date: dailyReport.revenueDate", "detail route date filter"),
        ("setOpen(false)", "detail button closes chat"),
    ]:
        assert_contains(chat, needle, label)
    assert "Pledge chi tiết" not in chat, "chat copy should use Ledger chi tiết"


def test_chat_safe_compare_before_confirm() -> None:
    for needle, label in [
        ('action: "preview_daily_compare"', "preview compare action"),
        ("setDailyCompare({", "compare result stored before confirm"),
        ("comparison.channels.map", "channel-level detailed changes"),
        ("Confirm overwrite", "explicit overwrite confirm"),
        ("Confirm ghi ledger", "explicit write confirm when missing current daily"),
        ("cancel_daily_preview", "cancel action cleanup"),
        ("confirm_daily_overwrite", "confirm action"),
    ]:
        assert_contains(chat, needle, label)
    assert chat.index('action: "preview_daily_compare"') < chat.index('action: "confirm_daily_overwrite"')


def test_frontend_does_not_expose_cron_or_service_role_secrets() -> None:
    forbidden = [
        "REVENUE_CRON_SECRET",
        "PO_SYNC_CRON_SECRET",
        "SUPABASE_SERVICE_ROLE_KEY",
        "x-cron-secret",
    ]
    for secret in forbidden:
        assert secret not in chat, f"frontend must not reference {secret}"


def test_backend_owner_actions_preserve_cron_boundary() -> None:
    for needle, label in [
        ('if (action === "auto_daily_post")', "cron branch"),
        ("requireRevenueCronSecret(req, corsHeaders)", "cron secret check"),
        ("const { user } = await requireAuth(req, corsHeaders)", "owner auth after cron"),
        ('action === "latest_auto_daily_report"', "latest report owner action"),
        ('action === "preview_daily_compare"', "preview compare owner action"),
        ('action === "confirm_daily_overwrite" || action === "confirm_daily_post"', "confirm daily owner action aliases"),
        ("fetchLatestAutoDailyReport", "latest controlled daily source aggregation"),
        ("summarizeLedgerRows", "ledger aggregate summary"),
        ("auto_post_revenue_daily_parse", "confirm uses service-role RPC inside function"),
        ("runSummary.chat_safe_preview_compare !== true", "confirm requires chat safe compare run"),
    ]:
        assert_contains(monthly, needle, label)
    assert monthly.index('if (action === "auto_daily_post")') < monthly.index("const { user } = await requireAuth(req, corsHeaders)")
    assert monthly.index("const { user } = await requireAuth(req, corsHeaders)") < monthly.index('action === "latest_auto_daily_report"')


def test_source_detail_filters_controlled_daily_source() -> None:
    for needle, label in [
        ('params.get("sourceDocumentId")', "source document query param"),
        ('params.get("revenue_date")', "revenue date query param"),
        ('.eq("source_document_id", sourceDocumentId)', "source document ledger filter"),
        ('.eq("revenue_date", revenueDate)', "revenue date ledger filter"),
        ('.eq("source_document.status", "controlled")', "controlled source status filter for daily route"),
        ('.eq("source_document.source_type", "po_email_parse")', "daily route source type guard"),
        ('.eq("source_document.summary->>monthly_parse_kind", "auto_daily_post")', "daily route auto daily kind guard"),
        ('query = query.eq("source_document.status", "trusted")', "trusted filter only for default view"),
        ("Auto daily source", "controlled daily source badge"),
    ]:
        assert_contains(detail, needle, label)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
