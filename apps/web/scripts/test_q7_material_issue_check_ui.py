#!/usr/bin/env python3
"""Task 6B contracts for Q7 one-time material-issue verification UI in Q7 Material Inventory.

Source-level RED/GREEN checks for a local-only UI implementation. The UI must query only
safe check fields, invoke the one-time verification endpoint with JSON + bearer token, guard
per issue, summarize safe results, and avoid retry/confirm/stock side effects.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "src/components/q7-material-inventory/Q7SignedMaterialIssueQueue.tsx"

FORBIDDEN_CHECK_TOKENS = (
    "signed_pdf_path",
    "pdf_path",
    "signed_pdf_sha256",
    "pdf_sha256",
    "storage_path",
    "download_url",
    "raw_ocr",
    "ocr_text",
    "model_raw_output",
    "ingredient_name",
    "material_code",
    "sku_code",
    "unit_cost",
    "total_amount",
    "amount",
    "dosage_qty",
    "wastage_percent",
)

FORBIDDEN_CHECK_DOM_LABELS = (
    "Đơn giá",
    "Chi phí",
    "Thành tiền",
    "BOM",
    "Mã NVL",
    "Định mức",
    "Khấu hao",
    "Xác nhận xuất",
    "Khấu trừ tồn",
    "Trừ kho",
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


def queue_logic(src: str) -> str:
    return region(src, "// ── Q7 signed material issue upload queue", "// ── End Q7 signed material issue upload queue")


def check_logic(src: str) -> str:
    return region(src, "const checkQ7SignedIssueMutation", "const createMutation")


def queue_dom(src: str) -> str:
    return region(src, 'data-testid="q7-signed-material-issue-queue"', "{/* ── Q7 explicit material issue confirmation dialog boundary")


def test_q7_check_query_selects_only_safe_fields_for_visible_issue_ids_and_fails_closed() -> None:
    src = read_page()
    logic = queue_logic(src)
    flat = compact(logic)
    assert 'queryKey: ["q7_material_issue_checks", q7SignedMaterialIssueIds.join(",")]' in logic
    assert 'from("production_material_issue_checks")' in logic
    assert '.select("id,issue_id,status,result,model,checked_at")' in logic
    assert '.in("issue_id", q7SignedMaterialIssueIds)' in logic
    assert '.order("checked_at", { ascending: false })' in logic
    assert "q7MaterialIssueChecksQuery.isError" in src
    assert "Không tải được kết quả kiểm tra phiếu NVL Q7" in src
    assert "Không kiểm tra để tránh chạy trùng khi chưa đọc được lịch sử kiểm tra" in src
    assert "q7MaterialIssueCheckByIssueId" in src
    assert "new Map<string, Q7MaterialIssueCheck>()" in src
    assert "if (!map.has(check.issue_id)) map.set(check.issue_id, check)" in flat
    for forbidden in FORBIDDEN_CHECK_TOKENS:
        assert forbidden not in logic, f"check query/logic must not select or expose unsafe field {forbidden!r}"


def test_q7_check_action_is_edit_gated_signed_uploaded_only_one_time_and_accessible() -> None:
    src = read_page()
    dom = queue_dom(src)
    logic = check_logic(src)
    flat_dom = compact(dom)
    assert "canCheckQ7SignedMaterialIssue" in src
    assert 'canEditModule("production_q7")' in src
    assert 'canEditModule("warehouse")' in src
    assert 'canEditModule("kitchen_inventory")' in src
    assert 'canEditModule("q7_material_inventory")' in src
    assert 'issue.status !== "signed_uploaded"' in logic
    assert "existingCheck" in dom and "!existingCheck" in dom
    assert "q7MaterialIssueChecksQuery.isError" in dom
    assert "checkingQ7SignedIssueIds[issue.id]" in dom
    assert "Đang kiểm tra" in dom
    assert "Kiểm tra một lần" in dom
    assert "tự động chỉ chạy một lần" in dom
    assert 'aria-label={`Kiểm tra một lần phiếu ${issue.issue_number}`}' in dom
    assert 'data-testid={`q7-material-issue-check-${issue.id}`}' in dom
    assert "min-h-12" in dom or "h-12" in dom, "check action needs >=48px touch target"
    assert "disabled={!canCheckQ7SignedMaterialIssue || Boolean(existingCheck) || q7MaterialIssueChecksQuery.isLoading || q7MaterialIssueChecksQuery.isFetching || q7MaterialIssueChecksQuery.isError || checkingQ7SignedIssueIds[issue.id]}" in flat_dom
    assert "q7-material-issue-check" not in dom[dom.index('issue.status === "pdf_ready"'):dom.index('issue.status === "signed_uploaded"')]


def test_q7_check_endpoint_uses_access_token_json_safe_issue_id_guard_and_invalidates_queries() -> None:
    src = read_page()
    logic = check_logic(src)
    flat = compact(logic)
    assert "supabase.auth.getSession()" in logic
    assert "session?.access_token" in logic
    assert "production-material-issue-check" in logic
    assert "VITE_SUPABASE_URL" in logic
    assert "method: \"POST\"" in logic
    assert "Authorization: `Bearer ${session.access_token}`" in logic
    assert '"Content-Type": "application/json"' in logic
    assert "JSON.stringify({ issue_id: issue.id })" in logic
    assert "setCheckingQ7SignedIssueIds((prev) => ({ ...prev, [issue.id]: true }))" in logic
    assert "setCheckingQ7SignedIssueIds((prev) =>" in logic and "delete next[issue.id]" in logic
    assert "safeParseQ7MaterialIssueCheckJson" in src
    assert "result?.error || result?.message" in logic
    assert "Đã gửi kiểm tra phiếu NVL Q7" in logic
    assert "Không kiểm tra được phiếu" in logic
    assert "queryClient.invalidateQueries({ queryKey: [\"q7_signed_material_issue_queue\"] })" in flat
    assert "queryClient.invalidateQueries({ queryKey: [\"q7_material_issue_checks\"] })" in flat


def test_q7_check_statuses_and_safe_result_summary_without_retry_or_sensitive_data() -> None:
    src = read_page()
    dom = queue_dom(src)
    assert "Đã kiểm tra · Chờ xác nhận" in dom
    assert "Cần xem lại" in dom
    assert "q7-material-issue-check-summary" in dom
    for label in ["Định danh", "Bảng NVL", "Chữ ký", "Dễ đọc", "Số trang", "Tin cậy", "Chênh lệch"]:
        assert label in dom or label in src
    assert "summarizeQ7MaterialIssueCheckResult" in src
    for field in ["identity_exact", "rows_exact", "document_legible", "pages_complete", "preparer_signed", "warehouse_keeper_signed", "receiver_signed"]:
        assert field in src, f"UI must render backend summary field {field}"
    assert "boundedDiscrepancies" in src
    assert ".slice(0, 3)" in src
    assert "Không có nút kiểm tra lại" not in dom  # explanatory copy is fine, but no retry CTA
    retry_region = dom[dom.index('issue.status === "signed_uploaded"'):]
    assert "Kiểm tra lại" not in retry_region
    for forbidden in FORBIDDEN_CHECK_TOKENS:
        assert forbidden not in dom, f"Q7 check DOM leaks forbidden token {forbidden!r}"
    for forbidden in FORBIDDEN_CHECK_DOM_LABELS:
        assert forbidden not in dom, f"Q7 check DOM includes forbidden action/data label {forbidden!r}"
    assert "confirmQ7" not in dom.lower()
    assert "deduct" not in dom.lower()
    assert "stock" not in dom.lower()


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
    print("Q7 material issue one-time check UI contracts passed")
