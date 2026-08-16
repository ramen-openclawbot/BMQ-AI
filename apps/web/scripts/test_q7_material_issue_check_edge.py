#!/usr/bin/env python3
"""Task 6A contracts for one-time signed-document verification DB + Edge.

These tests are intentionally local/static so Task6A can be developed without
applying migrations or deploying Edge functions. They should fail before the
Task6A SQL/Edge files exist and pass once the local contract is implemented.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "apps/web/supabase/migrations/20260816181000_q7_signed_material_issue_workflow.sql"
CONFIG = ROOT / "apps/web/supabase/config.toml"
EDGE_DIR = ROOT / "apps/web/supabase/functions/production-material-issue-check"
EDGE = EDGE_DIR / "index.ts"

FORBIDDEN_MODEL_OR_RESPONSE_TERMS = (
    "unit_cost",
    "amount",
    "total_amount",
    "material_code",
    "canonical_material_id",
    "q7_mapping_id",
    "kitchen_inventory_item_id",
    "source_ref_key",
    "sku_cogs",
    "bom",
    "formulation",
)
LEDGER_DML_PATTERNS = (
    r"insert\s+into\s+public\.kitchen_inventory_movements\b",
    r"update\s+public\.kitchen_inventory_movements\b",
    r"delete\s+from\s+public\.kitchen_inventory_movements\b",
    r"truncate\s+public\.kitchen_inventory_movements\b",
)


def read(path: Path) -> str:
    assert path.exists(), f"missing required file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def strip_comments(sql: str) -> str:
    return re.sub(r"--.*", "", sql)


def compact(text: str) -> str:
    return re.sub(r"\s+", " ", strip_comments(text).lower()).strip()


def function_sql(name: str) -> str:
    sql = compact(read(MIGRATION))
    match = re.search(
        rf"create or replace function public\.{re.escape(name)}\(.*?\bend;\s*\$\$;",
        sql,
        flags=re.S,
    )
    assert match, f"function public.{name} must be defined"
    return match.group(0)


def assert_no_ledger_dml(text: str) -> None:
    lower = compact(text)
    for pattern in LEDGER_DML_PATTERNS:
        assert not re.search(pattern, lower), f"Task6A must not write ledger: {pattern}"


def test_check_rate_limit_rpc_is_service_role_only_atomic_vietnam_day_acl() -> None:
    sql = compact(read(MIGRATION))
    fn = function_sql("consume_q7_material_issue_check_rate_limit")
    assert "security definer" in fn
    assert "set search_path = public, pg_temp" in fn
    assert "coalesce(auth.role(), '') <> 'service_role'" in fn
    assert "p_user_id is null" in fn and "p_daily_limit" in fn
    assert "p_daily_limit < 1" in fn and "p_daily_limit > 500" in fn
    assert "exists (select 1 from auth.users" in fn and "u.id = p_user_id" in fn
    assert "production-material-issue-check" in fn
    assert "asia/ho_chi_minh" in fn
    assert "insert into public.ai_function_rate_limits" in fn
    assert "on conflict (user_id, function_name, window_start) do update" in fn
    assert "usage_count = public.ai_function_rate_limits.usage_count + 1" in fn
    assert "returning usage_count" in fn
    for key in ("allowed", "remaining", "reset", "retry_after_seconds"):
        assert key in fn
    assert "revoke execute on function public.consume_q7_material_issue_check_rate_limit(uuid, integer) from public" in sql
    assert "revoke execute on function public.consume_q7_material_issue_check_rate_limit(uuid, integer) from authenticated" in sql
    assert "grant execute on function public.consume_q7_material_issue_check_rate_limit(uuid, integer) to service_role" in sql


def test_begin_check_rpc_claims_once_locks_issue_returns_safe_private_metadata() -> None:
    sql = compact(read(MIGRATION))
    fn = function_sql("begin_q7_material_issue_check")
    assert "security definer" in fn
    assert "set search_path = public, pg_temp" in fn
    assert "coalesce(auth.role(), '') <> 'service_role'" in fn
    assert "p_actor_id is null" in fn and "actor_required" in fn
    assert "exists (select 1 from auth.users" in fn and "u.id = p_actor_id" in fn
    assert "where id = p_issue_id for update" in fn
    assert "v_issue.location_code is distinct from 'q7'" in fn
    assert "v_issue.is_current is not true" in fn
    assert "v_issue.superseded_by_issue_id is not null" in fn
    assert "v_issue.pdf_path is null or v_issue.pdf_sha256 is null" in fn
    assert "v_issue.signed_file_path is null or v_issue.signed_file_sha256 is null" in fn
    assert "v_issue.signed_file_sha256 !~ '^[a-fa-f0-9]{64}$'" in fn
    assert "v_issue.status not in ('signed_uploaded', 'checking', 'ready_to_confirm', 'needs_review')" in fn
    assert "insert into public.production_material_issue_checks" in fn
    assert "attempt_no" in fn and "1" in fn and "'checking'" in fn
    assert "on conflict (issue_id, signed_file_sha256) do nothing" in fn
    assert "get diagnostics v_inserted_count = row_count" in fn
    assert "status = 'checking'" in fn and "check_status = 'pending'" in fn
    assert "where id = p_issue_id and status = 'signed_uploaded'" in fn
    assert "material_issue_check_started" in fn
    assert "blocked_missing_check_state" in fn
    assert "checking_unchanged" in fn
    assert "already_checked" in fn
    assert "check_id" in fn and "issue_number" in fn and "issue_date" in fn and "revision" in fn
    assert "signed_file_path" in fn and "signed_file_sha256" in fn
    assert "production_order_number" in fn
    assert "revoke execute on function public.begin_q7_material_issue_check(uuid, uuid) from authenticated" in sql
    assert "grant execute on function public.begin_q7_material_issue_check(uuid, uuid) to service_role" in sql
    assert_no_ledger_dml(fn)


def test_finalize_check_rpc_single_terminal_transition_safe_events_and_idempotency() -> None:
    sql = compact(read(MIGRATION))
    fn = function_sql("finalize_q7_material_issue_check")
    assert "security definer" in fn
    assert "set search_path = public, pg_temp" in fn
    assert "coalesce(auth.role(), '') <> 'service_role'" in fn
    assert "p_outcome not in ('passed', 'needs_review', 'failed', 'failed_transient', 'error')" in fn
    assert "jsonb_typeof(p_result) <> 'object'" in fn
    assert "octet_length(p_result::text) > 20000" in fn
    assert "for update" in fn and "v_check" in fn and "v_issue" in fn
    assert "v_check.signed_file_sha256 is distinct from lower(p_signed_sha256)" in fn
    assert "v_issue.signed_file_sha256 is distinct from lower(p_signed_sha256)" in fn
    assert "v_check.checked_by is distinct from p_actor_id" in fn
    assert "v_check.status <> 'checking'" in fn and "already_final" in fn
    assert "v_issue.status <> 'checking'" in fn
    assert "v_to_status := case when p_outcome = 'passed' then 'ready_to_confirm' else 'needs_review' end" in fn
    assert "jsonb_typeof(p_result -> 'confidence') <> 'number'" in fn
    assert "invalid_pass_result" in fn and "v_confidence >= 0.8" in fn
    assert "v_check_status := case when p_outcome = 'passed' then 'passed' when p_outcome in ('failed', 'failed_transient', 'error') then 'error' else 'needs_review' end" in fn
    assert "update public.production_material_issue_checks" in fn
    assert "status = p_outcome" in fn and "result = p_result" in fn and "checked_at = now()" in fn
    assert "update public.production_material_issues" in fn
    assert "status = v_to_status" in fn and "check_status = v_check_status" in fn
    assert "jsonb_build_object('outcome'" in fn and "'confidence'" in fn
    assert "material_issue_check_completed" in fn
    event_region = fn[fn.index("insert into public.production_material_issue_events"):]
    assert "signed_file_path" not in event_region and "p_result" not in event_region and "raw" not in event_region
    assert "revoke execute on function public.finalize_q7_material_issue_check(uuid, text, text, jsonb, text, text, uuid) from authenticated" in sql
    assert "grant execute on function public.finalize_q7_material_issue_check(uuid, text, text, jsonb, text, text, uuid) to service_role" in sql
    assert_no_ledger_dml(fn)


def test_check_table_trigger_allows_only_one_terminal_update_and_never_second_attempt() -> None:
    lower = compact(read(MIGRATION))
    assert "unique (issue_id, signed_file_sha256)" in lower
    assert "attempt_no integer not null default 1 check (attempt_no = 1)" in lower
    assert "old.status = 'checking'" in lower
    assert "new.status in ('passed', 'failed', 'failed_transient', 'error', 'needs_review')" in lower
    assert "old.issue_id is not distinct from new.issue_id" in lower
    assert "old.signed_file_sha256 is not distinct from new.signed_file_sha256" in lower
    assert "old.attempt_no is not distinct from new.attempt_no" in lower
    assert "old.checked_by is not distinct from new.checked_by" in lower
    assert "raise exception 'production_material_issue_checks are append/finalize-only'" in lower
    assert_no_ledger_dml(lower)


def test_edge_config_auth_rate_begin_concurrency_and_private_download_hash() -> None:
    config = compact(read(CONFIG))
    edge = read(EDGE)
    edge_lower = edge.lower()
    assert "[functions.production-material-issue-check]" in config
    assert re.search(r"\[functions\.production-material-issue-check\].*?verify_jwt\s*=\s*false", config)
    assert "npm:@supabase/supabase-js@2.90.1" in edge
    assert "../_shared/auth.ts" in edge and "requireAuth" in edge
    assert '"q7_material_inventory"' in edge
    assert "../_shared/cors.ts" in edge and "corsPreflightResponse" in edge and "getCorsHeaders" in edge
    assert 'req.method !== "POST"' in edge and "OPTIONS" in edge
    assert "CANONICAL_UUID_RE" in edge and "issue_id" in edge
    assert "consume_q7_material_issue_check_rate_limit" in edge
    assert "isValidRateLimitResult" in edge and "rateLimitError" in edge and "503" in edge
    assert ".from(\"ai_function_rate_limits\")" not in edge
    assert "begin_q7_material_issue_check" in edge
    assert edge.index("consume_q7_material_issue_check_rate_limit") < edge.index("begin_q7_material_issue_check"), "quota must be checked before claiming the one-time attempt"
    assert "checking_unchanged" in edge and "already_checked" in edge
    assert "return jsonResponse(req, inProgressResponse" in edge or "409" in edge
    assert "admin.storage.from(BUCKET).download(beginResult.signed_file_path)" in edge
    assert "MAX_PDF_BYTES = 20 * 1024 * 1024" in edge
    assert "MIN_PDF_BYTES = 1" in edge
    assert "%PDF-" in edge and "%%EOF" in edge
    assert "sha256Hex" in edge and "crypto.subtle.digest" in edge_lower
    assert "computedSha256 !== beginResult.signed_file_sha256" in edge
    assert "finalize_q7_material_issue_check" in edge
    assert "finalizeCheckWithRetry" in edge and "attempt < 3" in edge
    assert "createSignedUrl" not in edge and "getPublicUrl" not in edge
    assert "signed_file_path" not in edge_lower[edge_lower.index("return jsonresponse"):] or "sanitize" in edge_lower


def test_edge_safe_expected_facts_prompt_openai_once_schema_server_derived_outcome() -> None:
    edge = read(EDGE)
    edge_lower = edge.lower()
    assert "OPENAI_API_KEY" in edge
    assert "Q7_MATERIAL_ISSUE_CHECK_MODEL" in edge and "gpt-4.1-mini" in edge
    assert "https://api.openai.com/v1/responses" in edge
    assert "store: false" in edge
    assert "AbortController" in edge and "setTimeout" in edge and "90_000" in edge
    assert "input_file" in edge and "data:application/pdf;base64," in edge
    assert "json_schema" in edge and "additionalProperties: false" in edge
    for field in (
        "identity_exact",
        "rows_exact",
        "document_legible",
        "pages_complete",
        "preparer_signed",
        "warehouse_keeper_signed",
        "receiver_signed",
        "actual_rows",
        "line_no",
        "actual_qty",
        "unit",
        "evidence_kind",
        "confidence",
    ):
        assert field in edge
    assert "deriveOutcome" in edge
    assert "summary.identity_exact === true" in edge
    assert "summary.rows_exact === true" in edge
    assert "summary.document_legible === true" in edge
    assert "summary.pages_complete === true" in edge
    assert "summary.preparer_signed === true" in edge
    assert "summary.warehouse_keeper_signed === true" in edge
    assert "summary.receiver_signed === true" in edge
    assert "summary.actual_rows.every" in edge
    assert "summary.confidence >= PASS_CONFIDENCE_THRESHOLD" in edge
    assert "model decision" not in edge_lower
    assert "sanitizeCheckSummary" in edge and "MAX_DISCREPANCIES" in edge and "MAX_STRING_LENGTH" in edge
    assert "Never persist model-authored free text" in edge
    assert "normalized.discrepancies.push" in edge
    assert "actual_quantity_incomplete_or_ambiguous" in edge
    assert "expectedFacts" in edge and "issue_item_id:id,ingredient_name,required_qty,unit" in edge
    assert "toProviderExpectedRows" in edge and "display_name" in edge and "planned_qty" in edge
    assert "MAX_SOURCE_ROWS" in edge and "500" in edge
    assert "MAX_AGGREGATED_ROWS" in edge and "200" in edge
    assert "MAX_REQUIRED_QTY" in edge
    for forbidden in FORBIDDEN_MODEL_OR_RESPONSE_TERMS:
        assert forbidden not in edge_lower, f"Edge must not expose/select/prompt forbidden field: {forbidden}"
    assert "response_format" not in edge_lower or "json_schema" in edge_lower
    assert "console.log" not in edge_lower
    assert "console.error(`[${FUNCTION_NAME}] request failed`)" in edge


def test_edge_actual_rows_are_line_numbered_validated_and_finalized_with_actuals() -> None:
    edge = read(EDGE)
    edge_lower = edge.lower()
    assert "type ExpectedLine" in edge and "issue_item_id: string" in edge
    assert "type ProviderExpectedLine" in edge and "line_no: number" in edge
    assert "type ActualLine" in edge and "issue_item_id: string" in edge
    assert "toProviderExpectedRows" in edge
    provider_region = edge[edge.index("const toProviderExpectedRows"):edge.index("const ALLOWED_EVIDENCE_KINDS")]
    assert "issue_item_id" not in provider_region[provider_region.index("return"):], "provider facts must not expose item UUIDs"
    assert "line_no: index + 1" in provider_region
    assert "display_name: row.display_name" in provider_region
    assert "planned_qty: row.planned_qty" in provider_region
    assert "unit: row.unit" in provider_region
    assert "validateActualRows" in edge
    for marker in (
        "missing_actual_row",
        "extra_actual_row",
        "duplicate_actual_row",
        "invalid_actual_qty",
        "actual_qty_precision_exceeded",
        "actual_qty_vs_planned_out_of_bounds",
        "unit_mismatch",
        "invalid_evidence_kind",
        "low_actual_confidence",
    ):
        assert marker in edge
    assert "ALLOWED_EVIDENCE_KINDS" in edge and "handwritten_final" in edge and "printed_planned" in edge and "ambiguous" in edge
    assert "Math.round(actualQty * 1000) / 1000" in edge
    assert "line.issue_item_id" in edge and "expected.issue_item_id" in edge
    assert "finalize_q7_material_issue_check_with_actuals" in edge
    assert "p_actual_rows" in edge
    assert "outcome === \"passed\" ? actualRows.map" in edge
    assert "finalize_q7_material_issue_check\"" not in edge_lower
    response_region = edge_lower[edge_lower.rfind("return jsonresponse") :]
    assert "actual_rows" not in response_region, "Edge response must not expose actual rows; UI reads DB state separately"


def test_edge_finalize_errors_once_safe_response_no_path_hash_raw_provider() -> None:
    edge = read(EDGE)
    edge_lower = edge.lower()
    assert "finalizeWithSafeError" in edge
    for reason in ("download_failed", "hash_mismatch", "provider_failed", "provider_timeout", "provider_parse_failed"):
        assert reason in edge
    assert "p_outcome: \"failed_transient\"" in edge or "p_outcome: outcome" in edge
    assert "p_outcome: \"error\"" in edge or "p_outcome: outcome" in edge
    assert "rawProvider" not in edge and "raw_ocr" not in edge_lower and "base64" not in edge_lower[edge_lower.rfind("return jsonresponse") :]
    response_region = edge_lower[edge_lower.rfind("return jsonresponse") :]
    for forbidden in ("signed_file_path", "signed_path", "signed_file_sha256", "private", "input_file", "openai"):
        assert forbidden not in response_region, f"safe response must not expose {forbidden}"
    assert_no_ledger_dml(edge)


if __name__ == "__main__":
    failures: list[str] = []
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as exc:  # noqa: BLE001
                failures.append(f"FAIL {name}: {exc}")
                print(failures[-1])
    if failures:
        raise SystemExit(1)
