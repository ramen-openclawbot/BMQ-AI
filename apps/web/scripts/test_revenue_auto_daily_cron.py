#!/usr/bin/env python3
"""Static regression checks for revenue auto daily cron posting."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERCEL = ROOT / "vercel.json"
CRON_API = ROOT / "api/po-sync-cron.js"
MONTHLY = ROOT / "supabase/functions/revenue-monthly-parse-preview/index.ts"
GMAIL_SYNC = ROOT / "supabase/functions/po-gmail-sync/index.ts"
MIGRATION = ROOT / "supabase/migrations/20260510170000_revenue_auto_daily_post.sql"

vercel = json.loads(VERCEL.read_text(encoding="utf-8"))
cron_api = CRON_API.read_text(encoding="utf-8")
monthly = MONTHLY.read_text(encoding="utf-8")
gmail_sync = GMAIL_SYNC.read_text(encoding="utf-8")
migration = MIGRATION.read_text(encoding="utf-8")


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"missing {label}: expected to find {needle!r}"


def test_single_vercel_cron_at_2359_vietnam_time() -> None:
    crons = vercel.get("crons", [])
    assert crons == [{"path": "/api/po-sync-cron", "schedule": "59 16 * * *"}]


def test_proxy_calls_revenue_auto_daily_action() -> None:
    for needle, label in [
        ("revenue-monthly-parse-preview", "revenue function target"),
        ("REVENUE_MONTHLY_PARSE_PREVIEW_URL", "revenue override env"),
        ("REVENUE_CRON_SECRET || process.env.PO_SYNC_CRON_SECRET", "cron secret fallback"),
        ('action: "auto_daily_post"', "auto daily action body"),
        ("JSON.stringify(upstreamBody)", "validated upstream body"),
        ("reportComposioRevenueCron", "optional Composio report hook"),
        ("tam@bmq.vn", "report recipient"),
        ("temporary controlled revenue", "report controlled revenue wording"),
    ]:
        assert_contains(cron_api, needle, label)
    assert "po-sync-scheduler-run" not in cron_api, "proxy must not call legacy scheduler"


def test_revenue_function_cron_secret_before_owner_auth() -> None:
    for needle, label in [
        ("requireCronSecret", "cron secret helper import/use"),
        ('if (action === "auto_daily_post")', "auto daily branch"),
        ("requireRevenueCronSecret(req, corsHeaders)", "cron secret validation"),
        ("return await autoDailyPost(req, supabaseAdmin, body)", "cron branch returns before owner auth"),
        ("const { user } = await requireAuth(req, corsHeaders)", "manual owner auth still present"),
        ("await ensureOwner(supabaseAdmin, user.id)", "manual owner check still present"),
    ]:
        assert_contains(monthly, needle, label)
    assert monthly.index('if (action === "auto_daily_post")') < monthly.index("const { user } = await requireAuth(req, corsHeaders)")


def test_auto_daily_window_and_metadata() -> None:
    for needle, label in [
        ("const autoDailyWindow", "auto daily date window"),
        ("revenueDateFrom = current.date", "today revenue date from"),
        ("revenueDateTo = current.date", "today revenue date to"),
        ("poReceivedFrom = shiftLocalDate(current.date, -1)", "yesterday PO received start"),
        ("poReceivedTo = current.date", "today PO received end"),
        ('monthlyParseKind: "auto_daily_post"', "auto daily parse kind"),
        ('controlled_kind: "auto_daily_temporary_controlled_parse"', "temporary controlled kind"),
        ("temporary_controlled_revenue: true", "temporary revenue metadata"),
        ('trust_semantics: "not_trusted_month_end_audit_source"', "not trusted metadata"),
        ("owner_approval_required: false", "no owner approval metadata"),
        ("auto_daily_no_double_count_key", "no double count metadata"),
        ("syncGmail: true", "cron path imports fresh PO/email before parsing"),
        ('...(cronSecret ? { "x-cron-secret": cronSecret } : {})', "cron secret forwarded to Gmail sync"),
    ]:
        assert_contains(monthly, needle, label)


def test_explicit_revenue_date_cron_window_and_metadata() -> None:
    for needle, label in [
        ("const strictIsoDate", "strict date helper"),
        ('value.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/)', "strict YYYY-MM-DD only"),
        ("normalized === value", "real normalized date validation"),
        ("const explicitRevenueDateWindow", "explicit date window helper"),
        ("period: revenueDate.slice(0, 7)", "explicit period from date"),
        ("revenueDateFrom: revenueDate", "explicit revenue date from"),
        ("revenueDateTo: revenueDate", "explicit revenue date to"),
        ("poReceivedFrom: shiftLocalDate(revenueDate, -1)", "explicit PO received start"),
        ("poReceivedTo: revenueDate", "explicit PO received end"),
        ("hasRevenueWindow: true", "explicit revenue window enabled"),
        ("Object.prototype.hasOwnProperty.call(body, \"revenueDate\")", "body-only explicit date detection"),
        ("Invalid revenueDate. Expected a real date in YYYY-MM-DD format.", "invalid explicit date 400 message"),
        ('revenueDateSource = explicitRevenueDate ? "explicit" : "auto_daily_window"', "revenue date source metadata"),
        ("manualRecovery", "manual recovery response metadata"),
        ("explicitRevenueDate", "explicit date response metadata"),
        ("noDoubleCountKey", "response no-double-count key"),
        ("auto_daily_po_email_parse:${window.revenueDateFrom}", "stable date-based no-double-count key"),
        ("monthly_parse_kind: options.monthlyParseKind", "final run summary retains parse kind"),
        ("...(options.runSummary || {})", "run summary preserves explicit metadata"),
        ("revenue_date_source: revenueDateSource", "line payload explicit source metadata"),
        ("manual_recovery: manualRecovery", "line payload manual recovery metadata"),
    ]:
        assert_contains(monthly, needle, label)
    assert monthly.index("requireRevenueCronSecret(req, corsHeaders)") < monthly.index("return await autoDailyPost(req, supabaseAdmin, body)")
    assert "new URL(req.url)" not in monthly, "Supabase function must not read explicit date from query params"


def test_proxy_revenue_date_query_validation_and_pass_through() -> None:
    for needle, label in [
        ("function validStrictIsoDate", "proxy strict date helper"),
        ('value.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/)', "proxy strict YYYY-MM-DD only"),
        ("date.getUTCFullYear() !== year", "proxy real date validation"),
        ("function requestedRevenueDate", "proxy query parser"),
        ("query.revenueDate !== undefined ? query.revenueDate : query?.date", "revenueDate preferred over date alias"),
        ("Array.isArray(value)", "array query values handled"),
        ("res.status(400).json({ error: parsedRevenueDate.error })", "invalid date returns 400"),
        ("...(parsedRevenueDate.revenueDate ? { revenueDate: parsedRevenueDate.revenueDate } : {})", "explicit date upstream pass-through"),
        ("JSON.stringify(upstreamBody)", "upstream uses validated body"),
        ("revenueDateSource: upstreamPayload.revenueDateSource", "report summary includes explicit source"),
        ("noDoubleCountKey: upstreamPayload.noDoubleCountKey", "report summary includes no-double-count key"),
    ]:
        assert_contains(cron_api, needle, label)


def test_gmail_sync_accepts_cron_secret_for_auto_daily_import() -> None:
    for needle, label in [
        ("import { requireCronSecret }", "cron auth helper import"),
        ('const hasCronSecret = Boolean(req.headers.get("x-cron-secret"))', "cron secret branch"),
        ('Deno.env.get("REVENUE_CRON_SECRET") ? "REVENUE_CRON_SECRET" : "PO_SYNC_CRON_SECRET"', "revenue secret fallback"),
        ("requireCronSecret(req, envKey, getCorsHeaders(req))", "cron secret validation"),
        ("Invalid cron Gmail sync request", "cron Gmail sync request scoped to import po@bmq.vn"),
        ("if (error instanceof Response) return error", "auth response preserved"),
    ]:
        assert_contains(gmail_sync, needle, label)


def test_auto_daily_rpc_posts_all_review_rows_and_supersedes() -> None:
    for needle, label in [
        ("create or replace function public.auto_post_revenue_daily_parse", "auto post RPC"),
        ("_run.revenue_date_from <> _run.revenue_date_to", "one-day run validation"),
        ("summary->>'monthly_parse_kind' = 'auto_daily_post'", "auto daily source doc scope"),
        ("auto_daily_po_email_parse:", "stable no double count key"),
        ("approval_status = 'superseded'", "prior ledger superseded"),
        ("'posted_line_count', _line_count", "posted count equals all lines"),
        ("'review_flagged_line_count', _review_flagged_line_count", "review count retained"),
        ("'owner_approval_required', false", "no owner approval in RPC metadata"),
        ("'temporary_controlled_revenue', true", "temporary controlled RPC metadata"),
        ("'trust_semantics', 'not_trusted_month_end_audit_source'", "not trusted RPC metadata"),
        ("revoke all on function public.auto_post_revenue_daily_parse(uuid) from authenticated", "authenticated execute revoked"),
    ]:
        assert_contains(migration, needle, label)
    assert "and review_status <> 'needs_manual_review'" not in migration, "review rows must be posted"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
