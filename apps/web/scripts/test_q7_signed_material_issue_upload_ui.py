#!/usr/bin/env python3
"""Task 5B contracts for Q7 signed material-issue PDF upload queue in Q7 Material Inventory.

These are source-level UI contracts: RED before Q7 Material Inventory owns the signed-PDF
queue, GREEN once the page queries only safe issue fields and uploads signed PDFs via
multipart FormData without exposing storage paths/hashes/costs.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "src/components/q7-material-inventory/Q7SignedMaterialIssueQueue.tsx"

FORBIDDEN_QUEUE_TOKENS = (
    "unit_cost",
    "amount",
    "total_amount",
    "material_code",
    "sku_code",
    "pdf_path",
    "signed_pdf_path",
    "pdf_sha256",
    "signed_pdf_sha256",
    "storage_path",
    "download_url",
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


def queue_dom(src: str) -> str:
    return region(src, 'data-testid="q7-signed-material-issue-queue"', "{/* ── Q7 explicit material issue confirmation dialog boundary")


def upload_logic(src: str) -> str:
    return region(src, "const uploadQ7SignedIssueMutation", "const createMutation")


def test_q7_queue_imports_auth_and_safe_fileup_icon() -> None:
    src = read_page()
    assert 'import { useAuth } from "@/contexts/AuthContext";' in src
    assert "FileUp" in src, "signed PDF upload action must use FileUp icon"
    assert "const { canEditModule" in src
    assert 'canEditModule("production_q7")' in src
    assert 'canEditModule("warehouse")' in src
    assert 'canEditModule("kitchen_inventory")' in src
    assert 'canEditModule("q7_material_inventory")' in src
    assert "canUploadQ7SignedMaterialIssue" in src


def test_q7_queue_queries_only_safe_current_non_superseded_statuses_joined_to_production_number() -> None:
    src = read_page()
    logic = queue_logic(src)
    flat = compact(logic)
    assert 'queryKey: ["q7_signed_material_issue_queue"]' in logic
    assert 'from("production_material_issues")' in logic
    assert '.select("id,issue_number,production_order_id,issue_date,status,revision,created_at,production_orders(production_number)")' in logic
    assert '.eq("location_code", "q7")' in logic
    assert '.eq("is_current", true)' in logic
    assert '.is("superseded_by_issue_id", null)' in logic
    assert '.in("status", Q7_SIGNED_MATERIAL_ISSUE_STATUSES)' in logic
    for status in ("pdf_ready", "signed_uploaded", "checking", "ready_to_confirm", "needs_review"):
        assert status in src
    assert '.order("issue_date", { ascending: false })' in logic
    assert '.order("created_at", { ascending: false })' in logic
    assert '.limit(50)' in logic
    for forbidden in FORBIDDEN_QUEUE_TOKENS:
        assert forbidden not in logic, f"Q7 upload queue query/logic must not expose unsafe field {forbidden!r}"
    assert "production_number" in flat


def test_q7_queue_has_responsive_safe_cards_states_and_no_cost_or_path_dom() -> None:
    src = read_page()
    dom = queue_dom(src)
    for marker in [
        'data-testid="q7-signed-material-issue-queue"',
        'data-testid="q7-signed-material-issue-loading"',
        'data-testid="q7-signed-material-issue-error"',
        'data-testid="q7-signed-material-issue-empty"',
        'data-testid={`q7-signed-material-issue-card-${issue.id}`}',
        'data-testid={`q7-signed-material-issue-file-${issue.id}`}',
        'data-testid={`q7-signed-material-issue-upload-${issue.id}`}',
        'data-testid={`q7-signed-material-issue-selected-${issue.id}`}',
    ]:
        assert marker in dom
    for label in [
        "Phiếu NVL Q7 đã ký",
        "Số phiếu",
        "Lệnh SX",
        "Ngày phiếu",
        "Lần sửa",
        "Tải phiếu đã ký",
        "Không tải được danh sách phiếu NVL Q7 đã ký",
        "Chưa có phiếu NVL Q7 cần tải bản ký",
        "Bạn chỉ có quyền xem. Cần quyền sửa sản xuất Q7, kho hoặc kho bếp để tải PDF đã ký.",
    ]:
        assert label in dom
    for status_label in ["Đã tải · Chờ kiểm tra", "Đang kiểm tra", "Sẵn sàng xác nhận", "Cần xem lại"]:
        assert status_label in src
    assert "min-w-0" in dom and "break-words" in dom and "grid gap-3" in dom
    assert "min-h-12" in dom or "h-12" in dom, "upload action needs >=48px touch target"
    assert 'accept="application/pdf,.pdf"' in dom
    assert 'type="file"' in dom
    assert 'aria-label={`Tải PDF đã ký cho phiếu ${issue.issue_number}`}' in dom
    for forbidden in FORBIDDEN_QUEUE_TOKENS + ("Đơn giá", "Chi phí", "Thành tiền", "BOM", "Nguyên vật liệu"):
        assert forbidden not in dom, f"Q7 signed upload queue DOM leaks forbidden token {forbidden!r}"


def test_q7_upload_validates_pdf_size_uses_access_token_formdata_and_no_content_type() -> None:
    src = read_page()
    logic = upload_logic(src)
    flat = compact(logic)
    assert "MAX_Q7_SIGNED_PDF_BYTES" in src and "20 * 1024 * 1024" in src
    assert "validateQ7SignedPdfFile" in src
    assert 'file.type !== "application/pdf"' in src
    assert 'file.name.toLowerCase().endsWith(".pdf")' in src
    assert "file.size <= 0" in src
    assert "file.size > MAX_Q7_SIGNED_PDF_BYTES" in src
    assert "supabase.auth.getSession()" in logic
    assert "session?.access_token" in logic
    assert "new FormData()" in logic
    assert 'formData.append("issue_id", issue.id)' in logic
    assert 'formData.append("file", selected.file)' in logic
    assert "production-material-issue-signed-upload" in logic
    assert "VITE_SUPABASE_URL" in logic
    assert "Authorization: `Bearer ${session.access_token}`" in logic
    assert "method: \"POST\"" in logic
    assert "body: formData" in logic
    assert "Content-Type" not in logic and "content-type" not in logic.lower()
    assert "safeParseQ7SignedUploadJson" in src
    assert "queryClient.invalidateQueries({ queryKey: [\"q7_signed_material_issue_queue\"] })" in flat
    assert "setSelectedQ7SignedFiles((prev) =>" in logic
    assert "Đã tải phiếu NVL Q7 đã ký" in logic
    assert "Không tải được phiếu đã ký" in logic


def test_q7_upload_is_per_issue_pdf_ready_only_and_prevents_double_upload() -> None:
    src = read_page()
    dom = queue_dom(src)
    logic = upload_logic(src)
    assert "uploadingQ7SignedIssueId" in src
    assert "setUploadingQ7SignedIssueId(issue.id)" in logic
    assert "setUploadingQ7SignedIssueId(null)" in logic
    assert "issue.status !== \"pdf_ready\"" in logic
    assert "if (uploadingQ7SignedIssueId)" in logic
    assert "selectedSignedFile?.file" in dom
    assert "uploadingQ7SignedIssueId === issue.id" in dom
    assert "disabled={!canUploadQ7SignedMaterialIssue || !selectedSignedFile?.file || uploadingQ7SignedIssueId === issue.id}" in compact(dom)
    non_pdf_ready_region = dom[dom.index('issue.status === "pdf_ready"') :]
    assert "q7SignedMaterialIssueStatusLabels[issue.status]" in non_pdf_ready_region
    assert "Đã tải · Chờ kiểm tra" in src


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
    print("Q7 signed material issue upload UI contracts passed")
