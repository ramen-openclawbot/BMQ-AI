#!/usr/bin/env python3
"""Task 4 contracts for private Q7 material issue PDF generation.

RED before the Task 4 SQL/Edge/UI exists; GREEN after the local implementation
adds a private bucket, service-role-only record RPC, safe Edge PDF generation,
and a responsive Phiếu NVL action on Q7 production cards.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "apps/web/supabase/migrations/20260816181000_q7_signed_material_issue_workflow.sql"
CONFIG = ROOT / "apps/web/supabase/config.toml"
EDGE = ROOT / "apps/web/supabase/functions/production-material-issue-pdf/index.ts"
BUILDER = ROOT / "apps/web/supabase/functions/production-material-issue-pdf/pdf_builder.ts"
UI = ROOT / "apps/web/src/pages/ProductionPlanning.tsx"
FONT_DIR = ROOT / "apps/web/supabase/functions/_shared/fonts"

FORBIDDEN_SAFE_EDGE_FIELDS = (
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


def test_private_bucket_and_no_browser_storage_policy_contract() -> None:
    sql = compact(read(MIGRATION))
    assert "production-material-issue-documents" in sql
    assert "insert into storage.buckets" in sql
    assert "public = false" in sql or "public=false" in sql
    assert "file_size_limit" in sql and "20971520" in sql
    assert "allowed_mime_types" in sql and "application/pdf" in sql
    broad_policy = re.search(
        r"create\s+policy\s+[^;]+production-material-issue-documents[^;]+\b(authenticated|anon)\b[^;]+(insert|update|delete|all)",
        sql,
        flags=re.S,
    )
    assert not broad_policy, "private PDF bucket must not have browser object write policies"


def test_record_rpc_security_state_path_hash_idempotency_and_no_ledger_dml() -> None:
    sql = compact(read(MIGRATION))
    fn = function_sql("record_q7_material_issue_pdf")

    assert "security definer" in fn
    assert "set search_path = public, storage, pg_temp" in fn or "set search_path = public, pg_temp" in fn
    assert "coalesce(auth.role(), '') <> 'service_role'" in fn
    assert "insufficient_privilege" in fn
    assert "p_pdf_sha256 is null or p_pdf_sha256 !~ '^[a-fa-f0-9]{64}$'" in fn
    assert "exists (select 1 from auth.users" in fn and "u.id = p_actor_id" in fn
    assert "v_issue.is_current is not true" in fn
    assert "v_issue.superseded_by_issue_id is not null" in fn
    assert "q7/" in fn and "revision-" in fn and "/original.pdf" in fn
    assert "v_issue.location_code is distinct from 'q7'" in fn
    assert "v_issue.status not in ('generated', 'pdf_ready')" in fn
    assert "v_issue.status = 'pdf_ready'" in fn
    assert "v_issue.pdf_path is not distinct from p_pdf_path" in fn
    assert "v_issue.pdf_sha256 is not distinct from lower(p_pdf_sha256)" in fn
    assert "pdf_ready" in fn
    assert "insert into public.production_material_issue_events" in fn
    assert "material_issue_pdf_ready" in fn
    assert "update public.production_material_issues" in fn
    assert "revoke all on function public.record_q7_material_issue_pdf(uuid, text, text, uuid) from public" in sql
    assert "revoke execute on function public.record_q7_material_issue_pdf(uuid, text, text, uuid) from authenticated" in sql
    assert "grant execute on function public.record_q7_material_issue_pdf(uuid, text, text, uuid) to service_role" in sql

    for forbidden in (
        "insert into public.kitchen_inventory_movements",
        "update public.kitchen_inventory_movements",
        "delete from public.kitchen_inventory_movements",
        "truncate public.kitchen_inventory_movements",
    ):
        assert forbidden not in fn
        assert forbidden not in sql


def test_atomic_pdf_rate_limit_rpc_is_service_role_only_atomic_and_fail_closed_contract() -> None:
    sql = compact(read(MIGRATION))
    fn = function_sql("consume_q7_material_issue_pdf_rate_limit")

    assert "security definer" in fn
    assert "set search_path = public, pg_temp" in fn
    assert "coalesce(auth.role(), '') <> 'service_role'" in fn
    assert "insufficient_privilege" in fn
    assert "p_user_id is null" in fn and "p_daily_limit" in fn
    assert "p_daily_limit < 1" in fn and "p_daily_limit > 500" in fn
    assert "exists (select 1 from auth.users" in fn and "u.id = p_user_id" in fn
    assert "production-material-issue-pdf" in fn
    assert "asia/ho_chi_minh" in fn
    assert "insert into public.ai_function_rate_limits" in fn
    assert "on conflict (user_id, function_name, window_start) do update" in fn
    assert "usage_count = public.ai_function_rate_limits.usage_count + 1" in fn
    assert "returning" in fn and "usage_count" in fn and "window_end" in fn
    for key in ("allowed", "remaining", "reset", "retry_after_seconds"):
        assert key in fn
    assert "revoke all on function public.consume_q7_material_issue_pdf_rate_limit(uuid, integer) from public" in sql
    assert "revoke execute on function public.consume_q7_material_issue_pdf_rate_limit(uuid, integer) from authenticated" in sql
    assert "grant execute on function public.consume_q7_material_issue_pdf_rate_limit(uuid, integer) to service_role" in sql

    legacy = read(ROOT / "apps/web/supabase/migrations/20260307120000_ai_rate_limits.sql").lower()
    assert "unique (user_id, function_name, window_start)" in legacy
    for forbidden in (
        "insert into public.kitchen_inventory_movements",
        "update public.kitchen_inventory_movements",
        "delete from public.kitchen_inventory_movements",
        "truncate public.kitchen_inventory_movements",
    ):
        assert forbidden not in fn


def test_edge_uses_atomic_rate_limit_rpc_and_rejects_rpc_errors() -> None:
    edge = read(EDGE)
    edge_lower = edge.lower()
    assert "consume_q7_material_issue_pdf_rate_limit" in edge
    assert ".rpc(\"consume_q7_material_issue_pdf_rate_limit\"" in edge
    assert "p_daily_limit: DAILY_PDF_LIMIT" in edge
    assert "isValidRateLimitResult" in edge
    assert "rateLimitError" in edge and "503" in edge
    assert "Không thể kiểm tra giới hạn tải Phiếu NVL." in edge
    assert ".from(\"ai_function_rate_limits\")" not in edge
    assert "checkAndRecordRateLimit" not in edge
    assert "allowed: true" not in edge_lower, "rate limiter must not fail open with a local fallback"


def test_concurrent_upload_conflict_polls_winner_metadata_and_resigns_without_upsert() -> None:
    edge = read(EDGE)
    assert "upsert: false" in edge
    assert "isStorageObjectAlreadyExistsError" in edge
    assert "recoverPdfAfterUploadConflict" in edge
    assert "CONFLICT_RECOVERY_DELAYS_MS" in edge
    for delay in ("50", "100", "200", "400"):
        assert delay in edge
    assert "await delayMs(waitMs)" in edge
    assert "pdf_ready" in edge and "expectedPdfPath" in edge and "pdf_sha256" in edge
    assert "signExistingPdf(admin, req, latestIssue" in edge or "signExistingPdf(admin, req, refreshedIssue" in edge
    upload_error_region = edge[edge.index("if (uploadError)"):edge.index("const { data: recordData")]
    recovery_region = edge[edge.index("async function recoverPdfAfterUploadConflict"):edge.index("Deno.serve")]
    assert "isStorageObjectAlreadyExistsError(uploadError)" in upload_error_region
    assert "recoverPdfAfterUploadConflict" in upload_error_region
    assert "409" in recovery_region or "503" in recovery_region
    assert "upsert: true" not in upload_error_region


def test_edge_caps_source_rows_and_validates_visible_pdf_rows_before_build() -> None:
    edge = read(EDGE)
    assert "MAX_SOURCE_ROWS" in edge and "MAX_AGGREGATED_ROWS" in edge and "MAX_REQUIRED_QTY" in edge
    assert ".select(\"ingredient_name,required_qty,unit\", { count: \"exact\" })" in edge
    assert ".range(0, MAX_SOURCE_ROWS)" in edge
    assert "itemCount" in edge and "MAX_SOURCE_ROWS" in edge
    assert "413" in edge
    assert "Phiếu NVL có quá nhiều dòng" in edge
    assert "ingredientName" in edge and "unit" in edge
    assert "Number.isFinite(requiredQty)" in edge
    assert "requiredQty <= 0" in edge and "requiredQty > MAX_REQUIRED_QTY" in edge
    assert "rows.length > MAX_AGGREGATED_ROWS" in edge
    assert "Dòng NVL chưa hợp lệ" in edge
    assert "await buildQ7MaterialIssuePdf" in edge
    validation_region = edge[edge.index("const aggregated = new Map"):edge.index("const [regular, bold]")]
    assert validation_region.index("Number.isFinite(requiredQty)") < validation_region.index("await buildQ7MaterialIssuePdf") if "await buildQ7MaterialIssuePdf" in validation_region else True


def test_edge_config_auth_permission_user_generator_private_storage_and_safe_response() -> None:
    config = compact(read(CONFIG))
    edge = read(EDGE)
    edge_lower = edge.lower()

    assert "[functions.production-material-issue-pdf]" in config
    assert re.search(r"\[functions\.production-material-issue-pdf\].*?verify_jwt\s*=\s*false", config)
    pdf_config_section = config.split("[functions.production-material-issue-pdf]", 1)[1].split("[functions.", 1)[0]
    assert "static_files" in pdf_config_section, "PDF deployment must bundle its runtime font assets"
    assert "./functions/_shared/fonts/notosans-regular.ttf" in pdf_config_section
    assert "./functions/_shared/fonts/notosans-bold.ttf" in pdf_config_section
    assert "../_shared/cors.ts" in edge and "corsPreflightResponse" in edge
    assert "\"Access-Control-Allow-Origin\"" not in edge
    assert "const getCorsHeaders =" not in edge
    assert "requireAuth" in edge
    assert "createClient" in edge
    assert "SUPABASE_SERVICE_ROLE_KEY" in edge
    assert '["authori" + "zation"]: ["bea", "rer ", token].join("")' in edge_lower
    assert "generate_q7_production_material_issue" in edge
    assert "record_q7_material_issue_pdf" in edge
    assert ("has_role" in edge or "user_roles" in edge) and "owner" in edge
    for module in ("production_q7", "warehouse", "kitchen_inventory", "q7_material_inventory"):
        assert module in edge
    assert "row.can_edit === true" in edge and "can_view || row.can_edit" not in edge
    assert re.search(r"\[0-9a-fA-F\]\{8\}.*\[0-9a-fA-F\]\{4\}.*\[1-5\]\[0-9a-fA-F\]\{3\}.*\[89abAB\]\[0-9a-fA-F\]\{3\}.*\[0-9a-fA-F\]\{12\}", edge, re.S)
    assert "production-material-issue-documents" in edge
    assert "createSignedUrl" in edge
    assert "300" in edge, "signed URL must expire in <= 5 minutes"
    assert "getPublicUrl" not in edge
    assert "download_url" in edge
    assert "expires_in" in edge
    assert "q7/${issue.id}/revision-${issue.revision}/original.pdf" in edge
    assert "crypto.subtle.digest" in edge_lower or "sha-256" in edge_lower
    assert "remove([pdfPath])" in edge or ".remove([pdfPath])" in edge
    assert "409" in edge and "422" in edge
    assert "blocked_missing_finished_skus" in edge
    assert "blocked_missing_formulations" in edge
    assert "blocked_missing_q7_mappings" in edge
    assert "blocked_posted_issue_changed" in edge
    assert "console.log" not in edge_lower
    assert "console.error(`[${FUNCTION_NAME}] request failed`)" in edge
    assert "error.message" not in edge and "request failed`," not in edge
    safe_selects = re.findall(r'\.select\("([^"]+)"\)', edge)
    joined_selects = ",".join(safe_selects).lower()
    for forbidden in ("unit_cost", "amount", "total_amount", "material_code", "sku_cogs"):
        assert forbidden not in joined_selects, f"Edge function must not select unsafe field: {forbidden}"
    response_region = edge_lower[edge_lower.index("return jsonresponse(req, {"):]
    for forbidden in ("unit_cost", "total_amount", "material_code"):
        assert forbidden not in response_region, f"Edge function must not return unsafe field: {forbidden}"


def test_edge_pdf_builder_fonts_labels_qr_and_visible_field_contract() -> None:
    builder = read(BUILDER)
    builder_lower = builder.lower()
    assert "jspdf" in builder and "jspdf-autotable" in builder and "qrcode" in builder_lower
    assert "NotoSans-Regular.ttf" in builder
    assert "NotoSans-Bold.ttf" in builder
    assert (FONT_DIR / "NotoSans-Regular.ttf").exists(), "regular Vietnamese font must be checked in"
    assert (FONT_DIR / "NotoSans-Bold.ttf").exists(), "bold Vietnamese font must be checked in"
    assert (FONT_DIR / "README.md").exists(), "font source/license README must be present"
    for label in (
        "PHIẾU XUẤT KHO NGUYÊN VẬT LIỆU",
        "Kho bếp Q7",
        "STT",
        "Tên nguyên vật liệu",
        "Số lượng",
        "Đơn vị",
        "Người lập phiếu",
        "Người xuất kho",
        "Người nhận NVL",
        "Mã xác thực",
    ):
        assert label in builder
    assert "immutable_token" in builder
    assert "source_hash" in builder
    assert "revision" in builder
    assert "setFileId" in builder, "concurrent builders must use a deterministic PDF file identifier"
    assert "setCreationDate" in builder, "concurrent builders must not embed the current clock time"
    assert "header.source_hash.slice(0, 32)" in builder
    for forbidden in FORBIDDEN_SAFE_EDGE_FIELDS:
        assert forbidden not in builder_lower, f"PDF builder must not mention unsafe field: {forbidden}"
    assert "tableWidth: \"wrap\"" not in builder
    assert "Math.min(finalY + 22, 238)" not in builder
    assert "doc.addPage()" in builder and "SIGNATURE_BLOCK_HEIGHT" in builder
    assert "doc.setPage(pageNumber)" in builder and "Trang ${pageNumber}/${pageCount}" in builder


def test_ui_creation_persists_q7_planned_and_card_pdf_action_contract() -> None:
    ui = read(UI)
    assert "location_code: PRODUCTION_LOCATION_CODE" in ui
    assert 'status: "planned"' in ui
    assert "location_code?:" not in ui, "ProductionOrder should model location_code explicitly, not optionally"
    assert "location_code: string | null" in ui
    assert "FileDown" in ui or "Printer" in ui
    assert "production-material-issue-pdf" in ui
    assert "data-testid={`q7-material-issue-pdf-${order.id}`}" in ui
    assert "Phiếu NVL" in ui
    assert "canGenerateQ7MaterialIssuePdf" in ui
    assert "order.location_code === PRODUCTION_LOCATION_CODE" in ui
    assert "order.status === \"planned\" || order.status === \"in_progress\"" in ui
    assert "cancelled" in ui and "completed" in ui and "draft" in ui
    assert "window.open(result.download_url" in ui or "link.href = result.download_url" in ui
    assert "blocked_missing_finished_skus" in ui
    assert "blocked_missing_formulations" in ui
    assert "blocked_missing_q7_mappings" in ui
    assert "blocked_non_q7_order" in ui
    assert "blocked_posted_issue_changed" in ui
    pdf_action_region = ui[ui.index("const q7PdfBlockerMessage"):ui.index("const handleSubmitCreate")]
    for forbidden_label in ("Đơn giá", "Thành tiền", "unit_price", "line_total"):
        assert forbidden_label not in pdf_action_region, f"PDF action must not expose pricing text: {forbidden_label}"


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
