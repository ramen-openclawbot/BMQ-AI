#!/usr/bin/env python3
"""Task 7 contracts for explicit Q7 material-issue confirmation UI.

Source-level RED/GREEN checks. The confirmation UI must be explicit, accessible,
permission gated, fail closed, call only the authenticated Supabase RPC, parse only
safe response fields, and never expose sensitive material/cost/storage details.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "src/components/q7-material-inventory/Q7SignedMaterialIssueQueue.tsx"

FORBIDDEN_CONFIRM_DOM_TOKENS = (
    "unit_cost",
    "total_amount",
    "amount",
    "material_code",
    "sku_code",
    "bom",
    "BOM",
    "Đơn giá",
    "Chi phí",
    "Thành tiền",
    "Mã NVL",
    "pdf_path",
    "signed_pdf_path",
    "pdf_sha256",
    "signed_pdf_sha256",
    "storage_path",
    "download_url",
    "signedUrl",
    "raw_ocr",
    "model_raw_output",
)

FORBIDDEN_RPC_ERROR_PATTERNS = (
    "error.message ||",
    "error?.message ||",
    "description: error.message",
    "description: e?.message",
    "throw error",
)


def read_page() -> str:
    assert PAGE.exists(), f"missing {PAGE}"
    return PAGE.read_text(encoding="utf-8")


def compact(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def region(src: str, start_marker: str, end_marker: str) -> str:
    assert start_marker in src, f"missing start marker {start_marker!r}"
    start = src.index(start_marker)
    end = src.find(end_marker, start + len(start_marker))
    assert end != -1, f"missing end marker {end_marker!r}"
    return src[start:end]


def confirm_logic(src: str) -> str:
    return region(src, "// ── Q7 explicit material issue confirmation", "// ── End Q7 explicit material issue confirmation")


def confirm_mutation(src: str) -> str:
    return region(src, "const confirmQ7MaterialIssueMutation", "const createMutation")


def queue_dom(src: str) -> str:
    return region(src, 'data-testid="q7-signed-material-issue-queue"', "{/* ── Q7 explicit material issue confirmation dialog boundary")


def alert_dialog_dom(src: str) -> str:
    return region(src, "{/* ── Q7 explicit material issue confirmation dialog", "{/* ── Read-only automatic issue detail")


def test_confirm_imports_alert_dialog_not_window_confirm_and_uses_accessible_text() -> None:
    src = read_page()
    dom = alert_dialog_dom(src)
    queue = queue_dom(src)
    assert "@/components/ui/alert-dialog" in src
    for component in [
        "AlertDialog",
        "AlertDialogContent",
        "AlertDialogHeader",
        "AlertDialogTitle",
        "AlertDialogDescription",
        "AlertDialogFooter",
        "AlertDialogAction",
        "AlertDialogCancel",
    ]:
        assert component in src
    assert "window.confirm" not in src
    assert "data-testid=\"q7-material-issue-confirmation-dialog\"" in dom
    assert "aria-labelledby=\"q7-material-issue-confirm-title\"" in dom
    assert "aria-describedby=\"q7-material-issue-confirm-description\"" in dom
    assert "Xác nhận" in queue and "ghi sổ xuất Q7" in queue, "trigger must render Xác nhận ghi sổ xuất Q7"
    for text in [
        "Phiếu này sẽ được ghi sổ xuất Q7 theo số thực tế đã kiểm tra.",
        "Âm tồn được phép để kế toán audit sau; không bị chặn bởi tồn mở đầu.",
        "Không thể tự động lặp lại hoặc đảo ngược thao tác này.",
        "Bạn có chắc chắn muốn xác nhận không?",
        "Xác nhận ghi sổ xuất Q7",
        "Huỷ",
    ]:
        assert text in dom
    assert "min-h-12" in dom or "h-12" in dom, "dialog buttons need >=48px touch targets"
    assert "focus-visible" in dom or "focus:ring" in dom or "focus-visible:ring" in src


def test_confirm_button_is_ready_passed_edit_gated_and_fails_closed() -> None:
    src = read_page()
    logic = confirm_logic(src)
    dom = queue_dom(src)
    flat_dom = compact(dom)
    assert "canConfirmQ7MaterialIssue" in src
    assert 'canEditModule("production_q7")' in src
    assert 'canEditModule("warehouse")' in src
    assert 'canEditModule("kitchen_inventory")' in src
    assert 'canEditModule("q7_material_inventory")' in src
    assert "isQ7MaterialIssueCheckFullyPassed" in src
    assert 'check?.status === "passed"' in src or 'check?.status !== "passed"' in src or 'String(check?.status || "") === "passed"' in src
    for field in ["identity_exact", "rows_exact", "document_legible", "pages_complete", "preparer_signed", "warehouse_keeper_signed", "receiver_signed"]:
        assert field in logic, f"confirmation readiness must require backend boolean {field}"
    assert "confidence" in logic and ">= 0.8" in logic and "<= 1" in logic
    assert 'issue.status === "ready_to_confirm"' in dom
    assert "q7CanOpenConfirmation" in dom
    assert "selectedQ7MaterialIssueForConfirmation" in src
    assert "q7SignedMaterialIssueQueueQuery.isLoading" in src
    assert "q7SignedMaterialIssueQueueQuery.isFetching" in src
    assert "q7SignedMaterialIssueQueueQuery.isError" in src
    assert "q7MaterialIssueChecksQuery.isLoading" in src
    assert "q7MaterialIssueChecksQuery.isFetching" in src
    assert "q7MaterialIssueChecksQuery.isError" in src
    assert "confirmingQ7MaterialIssueIds[issue.id]" in src
    assert "confirmQ7MaterialIssueMutation.isPending" in src
    assert "disabled={!q7CanOpenConfirmation}" in flat_dom
    assert "data-testid={`q7-material-issue-confirm-open-${issue.id}`}" in dom
    assert "aria-label={`Xác nhận ghi sổ xuất Q7 phiếu ${issue.issue_number}`}" in dom or "aria-label={`Xác nhận ghi sổ xuất Q7 phiếu ${issue.issue_number}`}" in dom


def test_confirm_rpc_uses_auth_jwt_safe_parse_double_submit_and_invalidates_families() -> None:
    src = read_page()
    mutation = confirm_mutation(src)
    flat = compact(mutation)
    assert 'rpc("confirm_q7_material_issue", { p_issue_id: issue.id })' in mutation
    assert "supabase.auth.getSession()" in mutation
    assert "session?.access_token" in mutation
    assert "confirmingQ7MaterialIssueIds[issue.id]" in mutation
    assert "setConfirmingQ7MaterialIssueIds((prev) => ({ ...prev, [issue.id]: true }))" in mutation
    assert "delete next[issue.id]" in mutation
    assert "safeParseQ7MaterialIssueConfirmationResult" in src
    for allowed in ["status", "issue_id", "issue_number", "movement_count", "blockers"]:
        assert allowed in src
    for private in ["unit_cost", "amount", "material_code", "sku_code", "bom", "hash", "storage_path", "signed_url", "pdf_path"]:
        assert private not in mutation.lower(), f"confirmation mutation must not expose/query/render {private}"
    for key in [
        '["q7_signed_material_issue_queue"]',
        '["q7_material_issue_checks"]',
        '["production_material_issues"]',
        '["production_material_issue_items"]',
        '["q7_inventory_snapshot"]',
        '["q7_inventory_movements"]',
    ]:
        assert f"queryKey: {key}" in flat
    assert "Đã ghi sổ xuất Q7" in mutation
    assert "setSelectedQ7MaterialIssueForConfirmation(null)" in mutation
    assert "posted_unchanged" in mutation and "posted" in mutation


def test_confirm_error_handling_is_sanitized_vietnamese_and_bounded() -> None:
    src = read_page()
    mutation = confirm_mutation(src)
    logic = confirm_logic(src)
    assert "formatQ7MaterialIssueConfirmationBlockers" in src
    assert ".slice(0, 10)" in logic
    assert ".slice(0, 80)" in logic or ".slice(0, 96)" in logic
    for field in ["ingredient_name", "item_name", "required_qty", "available_qty", "unit"]:
        assert field in logic
    assert "baseline" not in logic.lower()
    for private in ["unit_cost", "amount", "material_code", "sku_code", "bom", "storage_path", "signed_url", "pdf_path", "hash"]:
        assert private not in logic.lower(), f"blocker formatting must not expose private field {private}"
    for message in [
        "Âm tồn được phép để kế toán audit sau",
        "Không ghi sổ được phiếu này.",
        "Không ghi sổ được phiếu này.",
        "Phiếu chưa đủ điều kiện xác nhận",
        "Không xác nhận được phiếu. Vui lòng thử lại hoặc liên hệ quản trị.",
    ]:
        assert message in src
    for bad in FORBIDDEN_RPC_ERROR_PATTERNS:
        assert bad not in mutation, f"RPC raw error must not be surfaced via {bad!r}"


def test_confirm_dom_has_no_sensitive_cost_material_code_or_private_storage_fields() -> None:
    src = read_page()
    dom = queue_dom(src) + alert_dialog_dom(src)
    for forbidden in FORBIDDEN_CONFIRM_DOM_TOKENS:
        assert forbidden not in dom, f"Q7 confirmation DOM leaks forbidden token {forbidden!r}"


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
    print("Q7 material issue explicit confirmation UI contracts passed")
