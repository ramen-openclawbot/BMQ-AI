#!/usr/bin/env python3
"""Static contract tests for the finance auto-close Edge orchestration.

These checks intentionally avoid Supabase/Drive/OpenAI calls. They guard the
server-only orchestration contract: auth gates, VN-date selection, Drive
evidence/OCR/cache behavior, snapshot shape, sequential stop, RPC-only mutation,
and no secret/base64 logging.
"""
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
AUTO_CLOSE_FN = ROOT / "supabase/functions/finance-auto-close-day/index.ts"
EXTRACT_FN = ROOT / "supabase/functions/finance-extract-slip-amount/index.ts"
CONFIG = ROOT / "supabase/config.toml"


def read(path: Path) -> str:
    assert path.exists(), f"Missing file: {path}"
    return path.read_text(encoding="utf-8")


def compact(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def compact_lower(text: str) -> str:
    return compact(text).lower()


def assert_ordered(haystack: str, needles: list[str]) -> None:
    cursor = -1
    for needle in needles:
        next_pos = haystack.find(needle, cursor + 1)
        assert next_pos > cursor, f"Expected {needle!r} after position {cursor}"
        cursor = next_pos


def test_auth_cors_body_contract_and_secret_safe_logging():
    source = read(AUTO_CLOSE_FN)
    lower = compact_lower(source)

    assert 'if (req.method === "OPTIONS") return corsPreflightResponse(req)' in source
    assert "SUPABASE_SERVICE_ROLE_KEY" in source
    assert "FINANCE_AUTO_CLOSE_CRON_SECRET" in source
    assert "FINANCE_CRON_SECRET" in source
    assert 'Authorization")?.replace("Bearer ", "")' in source
    assert 'req.headers.get("x-finance-cron-secret")' in source
    assert "serviceRoleKey && bearer === serviceRoleKey" in source
    assert "async function authenticate(req: Request)" in source
    assert "/auth/v1/admin/users?page=1&per_page=1" in source
    assert "serviceBearerOk = Boolean(verification?.ok)" in source
    assert "const { serviceRoleKey, cronSecret } = await authenticate(req)" in source
    assert "cronSecret && cronHeader === cronSecret" in source
    assert "cronHeader && !cronSecret" in source
    assert "requireAuth(" not in source
    assert "requireCronSecret(" not in source

    assert "mode?: AutoCloseMode" in source
    assert "dates?: string[]" in source
    assert "limit?: number" in source
    assert "mode !== \"shadow\" && mode !== \"enforced\"" in source
    assert "limit < 1 || limit > 10" in source

    log_lines = [line for line in source.splitlines() if re.search(r"\bconsole\.", line)]
    assert log_lines, "Expected minimal non-secret operational logging"
    for line in log_lines:
      assert "imageBase64" not in line and "base64" not in line.lower(), line
      assert "serviceRoleKey" not in line and "cronSecret" not in line and "cronHeader" not in line and "bearer" not in line, line


def test_vn_date_validation_and_oldest_unclosed_query():
    source = read(AUTO_CLOSE_FN)
    lower = compact_lower(source)

    assert "Asia/Ho_Chi_Minh" in source
    assert "function vnToday" in source
    assert re.search(r"/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/", source), "Explicit dates must be ISO yyyy-MM-dd"
    assert "Cannot auto-close future Vietnam date" in source
    assert "new Set(dates)" in source or "new Set(body.dates" in source

    assert ".from(\"ceo_daily_closing_declarations\")" in source
    assert ".select(\"closing_date,extraction_meta\")" in source
    assert ".lt(\"closing_date\", todayVn)" in source
    assert ".order(\"closing_date\", { ascending: true })" in source
    assert ".limit(500)" in source
    assert ".slice(0, limit)" in source
    assert "close_approval_locked" in lower
    assert "filter((row" in source
    assert "row?.extraction_meta?.close_approval_locked !== true" in source


def test_drive_root_paths_scan_download_ocr_cache_and_blockers():
    source = read(AUTO_CLOSE_FN)
    lower = compact_lower(source)

    assert "finance_drive_root_folder_url" in source
    assert "google_drive_receipts_folder" in source
    assert "const UNC_PATH_TEMPLATE = \"yyyy/MM/dd/UNC\"" in source
    assert "const QTM_PATH_TEMPLATE = \"yyyy/MM/dd/QTM\"" in source
    assert "applyDatePathTemplate" in source
    assert_ordered(source, ["const uncScan = await scanEvidenceFolder(", "const qtmScan = await scanEvidenceFolder("])
    assert "folderType: \"bank_slip\"" in source
    assert "includeBase64: false" in source
    assert "skipProcessed: false" in source
    assert "mode: \"download_file\"" in source
    assert "finance-extract-slip-amount" in source
    assert "\"x-finance-cron-secret\": cronSecret" in source
    assert "slipType" in source

    for blocker in (
        "folder_not_found",
        "drive_connectivity",
        "unsupported_file",
        "duplicate_file_id",
        "missing_ocr",
        "low_confidence",
        "download_failed",
        "ocr_failed",
    ):
        assert blocker in source

    assert "blocker.code !== \"folder_not_found\" || declaredUnc > 0" in source
    assert "blocker.code !== \"folder_not_found\" || expectedQtmSpent > 0" in source

    assert ".from(\"drive_file_index\")" in source
    compact_source = compact(source)
    assert "processed_at" in source
    assert "cached.processedAt" in source
    assert "new Date(cached.processedAt).getTime() >= new Date(file.modifiedTime).getTime()" in compact_source
    assert "cached.amount !== null" in source
    assert ".upsert(cacheRows, { onConflict: \"file_id\"" in source
    assert "extracted_amount: evidence.amount" in source
    assert "fileId" in source and "amount" in source and "confidence" in source and "reference" in source and "name" in source


def test_snapshot_fields_blockers_sequential_stop_and_rpc_only_mutation():
    source = read(AUTO_CLOSE_FN)
    lower = compact_lower(source)

    for field in (
        "declaredUnc",
        "qtmTopup",
        "qtmOpening",
        "qtmSpent",
        "qtmClosing",
        "driveConnectivity",
        "uncEvidence",
        "qtmEvidence",
        "blockers",
        "lowConfidenceThreshold",
        "declarationMismatchFlags",
    ):
        assert field in source

    assert "unc_extracted_amount" in source and "unc_total_declared" in source
    assert "qtm_extracted_amount" in source and "cash_fund_topup_amount" in source
    assert "qtm_opening_balance" in source
    assert "LOW_CONFIDENCE_THRESHOLD = 0.85" in source
    assert "uncScan.completed && qtmScan.completed" in source
    assert "qtmOpening + qtmTopup - qtmSpent" in source
    assert "loadPreviousClosedQtmBalance" in source
    assert "priorQtmBalance?.closing ?? storedQtmOpening" in source
    assert "qtmOpeningSourceDate" in source
    assert "existing_declaration_reconciliation_mismatch" not in source
    assert "unc_folder_status_mismatch" not in source
    assert "unc_folder_delta_mismatch" not in source
    assert ".rpc(\"finance_auto_close_day\"" in source
    assert "p_closing_date" in source and "p_mode" in source and "p_snapshot" in source and "p_actor" in source

    assert "for (const closingDate of targetDates)" in source
    assert "break;" in source
    assert "stopped" in source
    assert_ordered(source, [".rpc(\"finance_auto_close_day\"", "if (hasBlockers)"])

    assert ".from(\"payment_requests\").update" not in lower
    assert ".from('payment_requests').update" not in lower
    assert ".from(\"payment_requests\").upsert" not in lower
    assert ".from(\"ceo_daily_closing_declarations\").update" not in lower
    assert ".from('ceo_daily_closing_declarations').update" not in lower
    assert ".from(\"ceo_daily_closing_declarations\").upsert" not in lower


def test_extraction_internal_bypass_is_minimal_and_existing_user_auth_remains():
    source = read(EXTRACT_FN)

    assert "requireAuth(req, getCorsHeaders(req))" in source
    assert "FINANCE_AUTO_CLOSE_CRON_SECRET" in source
    assert "FINANCE_CRON_SECRET" in source
    assert "isFinanceCronBypass(req)" in source
    assert "cronHeader && !cronSecret" in source
    assert "cronHeader === cronSecret" in source
    assert "if (!cronBypass)" in source
    assert "checkAndRecordRateLimit" in source
    assert "finance-extract-slip-amount" in source


def test_config_adds_only_new_auto_close_verify_jwt_section():
    config = read(CONFIG)
    lower = compact_lower(config)

    assert "[functions.finance-auto-close-day]" in config
    assert re.search(r"\[functions\.finance-auto-close-day\]\s*verify_jwt\s*=\s*false", config)
    assert "[functions.finance-extract-slip-amount]" in config
    assert "[functions.finance-extract-slip-amount] # verify_jwt disabled" not in config
    assert lower.count("[functions.finance-auto-close-day]") == 1
