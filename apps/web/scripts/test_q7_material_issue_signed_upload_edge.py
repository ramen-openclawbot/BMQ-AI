#!/usr/bin/env python3
"""Task 5A contracts for private signed Q7 material issue PDF uploads.

RED before the signed upload SQL/Edge exists; GREEN after the local DB/Edge
foundation records private signed-paper uploads without OCR/check/posting.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "apps/web/supabase/migrations/20260816181000_q7_signed_material_issue_workflow.sql"
CONFIG = ROOT / "apps/web/supabase/config.toml"
EDGE_DIR = ROOT / "apps/web/supabase/functions/production-material-issue-signed-upload"
EDGE = EDGE_DIR / "index.ts"

FORBIDDEN_COST_FIELDS = (
    "unit_cost",
    "amount",
    "total_amount",
    "material_code",
    "sku_cogs",
    "bom",
    "formulation",
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


def test_signed_upload_rate_limit_rpc_is_service_role_only_atomic_vietnam_day() -> None:
    sql = compact(read(MIGRATION))
    fn = function_sql("consume_q7_material_issue_signed_upload_rate_limit")
    assert "security definer" in fn
    assert "set search_path = public, pg_temp" in fn
    assert "coalesce(auth.role(), '') <> 'service_role'" in fn
    assert "insufficient_privilege" in fn
    assert "p_user_id is null" in fn and "p_daily_limit" in fn
    assert "p_daily_limit < 1" in fn and "p_daily_limit > 500" in fn
    assert "exists (select 1 from auth.users" in fn and "u.id = p_user_id" in fn
    assert "production-material-issue-signed-upload" in fn
    assert "asia/ho_chi_minh" in fn
    assert "insert into public.ai_function_rate_limits" in fn
    assert "on conflict (user_id, function_name, window_start) do update" in fn
    assert "usage_count = public.ai_function_rate_limits.usage_count + 1" in fn
    assert "returning usage_count" in fn
    for key in ("allowed", "remaining", "reset", "retry_after_seconds"):
        assert key in fn
    assert "revoke execute on function public.consume_q7_material_issue_signed_upload_rate_limit(uuid, integer) from public" in sql
    assert "revoke execute on function public.consume_q7_material_issue_signed_upload_rate_limit(uuid, integer) from authenticated" in sql
    assert "grant execute on function public.consume_q7_material_issue_signed_upload_rate_limit(uuid, integer) to service_role" in sql


def test_record_signed_upload_rpc_state_path_hash_idempotency_event_acl_no_side_effects() -> None:
    sql = compact(read(MIGRATION))
    fn = function_sql("record_q7_material_issue_signed_upload")
    assert "security definer" in fn
    assert "set search_path = public, pg_temp" in fn
    assert "coalesce(auth.role(), '') <> 'service_role'" in fn
    assert "exists (select 1 from auth.users" in fn and "u.id = p_actor_id" in fn
    assert "p_signed_sha256 is null or p_signed_sha256 !~ '^[a-fa-f0-9]{64}$'" in fn
    assert "for update" in fn
    assert "v_issue.location_code is distinct from 'q7'" in fn
    assert "v_issue.is_current is not true" in fn
    assert "v_issue.superseded_by_issue_id is not null" in fn
    assert "v_issue.pdf_path is null or v_issue.pdf_sha256 is null" in fn
    assert "v_issue.status <> 'pdf_ready'" in fn
    assert "v_issue.status = 'signed_uploaded'" in fn
    assert "signed_uploaded_unchanged" in fn
    assert "q7/" in fn and "revision-" in fn and "/signed/" in fn and ".pdf" in fn
    assert "lower(p_signed_sha256)" in fn
    assert "signed_file_path" in fn and "signed_file_sha256" in fn
    assert "signed_uploaded_by" in fn and "signed_uploaded_at" in fn
    assert "insert into public.production_material_issue_events" in fn
    assert "material_issue_signed_uploaded" in fn
    assert "jsonb_build_object('signed_sha256'" in fn
    event_region = fn[fn.index("insert into public.production_material_issue_events"):]
    assert "p_signed_path" not in event_region and "signed_file_path" not in event_region
    assert "insert into public.production_material_issue_checks" not in fn
    for forbidden in (
        "insert into public.kitchen_inventory_movements",
        "update public.kitchen_inventory_movements",
        "delete from public.kitchen_inventory_movements",
        "truncate public.kitchen_inventory_movements",
    ):
        assert forbidden not in fn
    assert "revoke execute on function public.record_q7_material_issue_signed_upload(uuid, text, text, uuid) from public" in sql
    assert "revoke execute on function public.record_q7_material_issue_signed_upload(uuid, text, text, uuid) from authenticated" in sql
    assert "grant execute on function public.record_q7_material_issue_signed_upload(uuid, text, text, uuid) to service_role" in sql


def test_private_bucket_remains_pdf_only_no_browser_write_policy() -> None:
    sql = compact(read(MIGRATION))
    assert "production-material-issue-documents" in sql
    assert "public = false" in sql or "public=false" in sql
    assert "allowed_mime_types" in sql and "application/pdf" in sql
    assert "file_size_limit" in sql and "20971520" in sql
    assert "create policy" not in sql or not re.search(
        r"create\s+policy\s+[^;]+production-material-issue-documents[^;]+\b(authenticated|anon)\b[^;]+(insert|update|delete|all)",
        sql,
        flags=re.S,
    )


def test_edge_config_auth_cors_multipart_pdf_validation_and_private_upload() -> None:
    config = compact(read(CONFIG))
    edge = read(EDGE)
    edge_lower = edge.lower()
    assert "[functions.production-material-issue-signed-upload]" in config
    assert re.search(r"\[functions\.production-material-issue-signed-upload\].*?verify_jwt\s*=\s*false", config)
    assert "npm:@supabase/supabase-js@2.90.1" in edge
    assert "../_shared/auth.ts" in edge and "requireAuth" in edge
    assert "../_shared/cors.ts" in edge and "corsPreflightResponse" in edge and "getCorsHeaders" in edge
    assert 'req.method !== "POST"' in edge and "OPTIONS" in edge
    assert "formData" in edge and 'form.get("issue_id")' in edge and 'form.get("file")' in edge
    assert "CANONICAL_UUID_RE" in edge and "issue_id không hợp lệ" in edge
    assert "application/pdf" in edge and "MAX_UPLOAD_BYTES" in edge and "20 * 1024 * 1024" in edge
    assert "%PDF-" in edge and "%%EOF" in edge and "PDF không hợp lệ" in edge
    assert "sha256Hex" in edge and "crypto.subtle.digest" in edge_lower
    assert "production-material-issue-documents" in edge
    assert "upsert: false" in edge
    assert "isStorageObjectAlreadyExistsError" in edge
    assert "remove([signedPath])" in edge
    assert "record_q7_material_issue_signed_upload" in edge
    assert "consume_q7_material_issue_signed_upload_rate_limit" in edge
    assert "isValidRateLimitResult" in edge and "rateLimitError" in edge and "503" in edge
    assert ".from(\"ai_function_rate_limits\")" not in edge
    assert "allowed: true" not in edge_lower
    assert "createSignedUrl" not in edge and "getPublicUrl" not in edge
    assert "signed_url" not in edge_lower and "download_url" not in edge_lower and "public_url" not in edge_lower
    assert "console.log" not in edge_lower
    assert "console.error(`[${FUNCTION_NAME}] request failed`)" in edge


def test_edge_permission_safe_select_safe_response_no_cost_fields_or_task6_work() -> None:
    edge = read(EDGE)
    edge_lower = edge.lower()
    for module in ("production_q7", "warehouse", "kitchen_inventory", "q7_material_inventory"):
        assert module in edge
    assert "row.can_edit === true" in edge
    assert "owner" in edge
    assert "ISSUE_SELECT" in edge
    assert "id,issue_number,status,revision,location_code,is_current,superseded_by_issue_id,pdf_path,pdf_sha256,signed_file_path,signed_file_sha256" in edge
    selects = ",".join(re.findall(r'\.select\("([^"]+)"', edge)).lower()
    response_region = edge_lower[edge_lower.index("return jsonresponse(req, {"):]
    for forbidden in FORBIDDEN_COST_FIELDS:
        assert forbidden not in selects, f"Edge function must not select forbidden field: {forbidden}"
        assert forbidden not in response_region, f"Edge function must not return forbidden field: {forbidden}"
    for forbidden in ("ocr", "validation", "check_status", "confirm", "posting", "ledger"):
        assert forbidden not in edge_lower, f"Task5A Edge must not implement future workflow: {forbidden}"
    final_response_region = edge_lower[edge_lower.rindex("signed_sha256") - 300:]
    assert "signed_path" not in final_response_region and "signed_file_path" not in final_response_region
    assert "issue_id" in final_response_region and "issue_number" in final_response_region
    assert "revision" in final_response_region and "status" in final_response_region
    assert "signed_sha256" in final_response_region and "size" in final_response_region


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
