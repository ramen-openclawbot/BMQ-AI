#!/usr/bin/env python3
"""Contracts for dedicated no-price Q7 XNT material inventory UI."""
from __future__ import annotations
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "src/pages/Q7MaterialInventory.tsx"
HOOK = ROOT / "src/hooks/useQ7MaterialInventory.ts"
QUEUE = ROOT / "src/components/q7-material-inventory/Q7SignedMaterialIssueQueue.tsx"
ROUTES = ROOT / "src/components/AppRoutes.tsx"
SIDEBAR = ROOT / "src/components/layout/Sidebar.tsx"
LANG = ROOT / "src/contexts/LanguageContext.tsx"
PERMS = ROOT / "src/hooks/useUserManagement.ts"
PLANNING = ROOT / "src/pages/ProductionPlanning.tsx"

FORBIDDEN_SAFE_SOURCE = (
  "unit_cost", "standard_unit_cost", "total_amount", "amount", "price", "unit_price", "line_total",
  "material_code", "sku_code", "BOM", "bom", "pdf_path", "signed_file_path", "pdf_sha256",
  "signed_file_sha256", "storage_path", "download_url", "source_ref_id", "hash",
)

def read(path: Path) -> str:
    assert path.exists(), f"missing {path}"
    return path.read_text(encoding="utf-8")

def compact(text: str) -> str:
    return re.sub(r"\s+", " ", text)

def region(src: str, start: str, end: str) -> str:
    assert start in src, f"missing start marker {start!r}"
    s = src.index(start); e = src.find(end, s + len(start)); assert e != -1, f"missing end marker {end!r}"; return src[s:e]

def test_route_sidebar_language_and_permission_registry() -> None:
    routes, sidebar, lang, perms = map(read, [ROUTES, SIDEBAR, LANG, PERMS])
    assert 'const Q7MaterialInventory = lazy(() => import("@/pages/Q7MaterialInventory"));' in routes
    assert 'path="/production/q7/inventory"' in routes and 'moduleKey="q7_material_inventory"' in routes and '<Q7MaterialInventory />' in routes
    assert 'q7_material_inventory: "Xuất-nhập-tồn NVL Q7"' in routes
    prod = region(sidebar, 'labelKey: "productionPlanning"', '  { icon: CalendarClock')
    assert '{ icon: Factory, labelKey: "productionQ7", path: "/production/planning/q7", section: "production", moduleKey: "production_q7" }' in prod
    assert '{ icon: PackageSearch, labelKey: "q7MaterialInventory", path: "/production/q7/inventory", section: "production", moduleKey: "q7_material_inventory" }' in prod
    assert prod.index('labelKey: "productionQ7"') < prod.index('labelKey: "q7MaterialInventory"')
    assert 'q7MaterialInventory: string;' in lang
    assert 'q7MaterialInventory: "Q7 Material Inventory"' in lang
    assert 'q7MaterialInventory: "Xuất-nhập-tồn NVL Q7"' in lang
    assert '{ key: "q7_material_inventory", labelEn: "Q7 Material Inventory", labelVi: "Xuất-nhập-tồn NVL Q7" }' in perms
    assert '"q7_material_inventory"' in region(perms, 'const ALL_MODULE_KEYS', '];')


def test_snapshot_cards_null_opening_negative_text_and_safe_fields() -> None:
    page, hook = read(PAGE), read(HOOK)
    assert 'format(new Date(), "yyyy-MM-dd")' in page
    for label in ["Tồn âm", "Xuất dùng hôm nay", "Phiếu chờ xử lý", "Nhập hôm nay", "XNT", "Hàng đợi phiếu ký", "Audit tồn đầu", "Lịch sử phát sinh"]:
        assert label in page
    assert 'rpc("get_q7_inventory_snapshot", { p_as_of_date: asOfDate })' in hook
    assert 'opening_qty' in hook and 'receipt_qty' in hook and 'usage_qty' in hook and 'adjustment_qty' in hook and 'balance_qty' in hook
    assert '— Chưa audit' in page
    assert 'Âm tồn để kế toán audit sau' in page
    assert 'blocking' not in page.lower() and 'insufficient' not in page.lower() and 'baseline' not in page.lower()
    safe_region = read(HOOK) + read(PAGE)
    for forbidden in FORBIDDEN_SAFE_SOURCE:
        assert forbidden not in safe_region, f"Q7 inventory source exposes forbidden token {forbidden!r}"


def test_receipt_and_opening_forms_call_exact_rpcs_with_no_cost_and_double_submit_guard() -> None:
    page, hook = read(PAGE), read(HOOK)
    assert 'canEditModule("q7_material_inventory")' in page
    assert 'canEditModule("kitchen_inventory")' in page
    assert 'canEditModule("production_q7")' not in page
    assert 'receiptSubmitLockRef.current' in page
    assert 'openingSubmitLockRef.current' in page
    assert 'recordReceiptMutation.isPending' in page
    assert 'backfillOpeningMutation.isPending' in page
    assert 'rpc("record_q7_inventory_receipt", {' in hook
    for arg in ['p_movement_date', 'p_kitchen_inventory_item_id', 'p_quantity', 'p_unit', 'p_source_ref_key', 'p_note']:
        assert arg in hook
    assert 'rpc("backfill_q7_inventory_opening", {' in hook
    for arg in ['p_effective_date', 'p_opening_qty', 'p_physical_count_qty', 'p_physical_count_date']:
        assert arg in hook
    assert 'Đã ghi nhận nhập Q7' in page
    assert 'Đã ghi audit tồn đầu Q7' in page
    assert 'Bạn không có quyền ghi sổ Q7' in page
    for control_id in ["q7-as-of-date", "q7-receipt-item", "q7-receipt-qty", "q7-receipt-unit", "q7-receipt-reference", "q7-receipt-note", "q7-opening-item", "q7-opening-qty", "q7-opening-unit", "q7-physical-qty", "q7-physical-date", "q7-opening-note"]:
        assert f'id="{control_id}"' in page
        assert f'htmlFor="{control_id}"' in page
    assert '!selectedSignedFile?.file' in read(QUEUE)
    for forbidden in ("price", "cost", "unit_cost", "amount", "Đơn giá", "Chi phí", "Thành tiền"):
        assert forbidden not in (page + hook)


def test_movement_history_safe_selects_and_actual_review_loaded_before_confirm() -> None:
    page, hook, queue = read(PAGE), read(HOOK), read(QUEUE)
    assert 'from("q7_inventory_movements")' in hook
    assert '.select("id,kitchen_inventory_item_id,movement_date,movement_type,quantity,unit,note,created_at,kitchen_inventory_items(name)")' in hook
    assert 'from("production_material_issue_check_actuals")' in queue
    assert '.select("id,check_id,issue_item_id,planned_qty,actual_qty,difference_qty,unit,evidence_kind,confidence,production_material_issue_items!inner(material_issue_id,kitchen_inventory_items(name))")' in queue
    for label in ["Kế hoạch", "Thực tế", "Chênh lệch", "Bút tay được phép chênh lệch"]:
        assert label in queue
    assert 'q7MaterialIssueActualsByIssueId' in queue
    assert 'actualRows.length > 0' in queue
    assert 'issue_item_actual_snapshot_mismatch' not in queue
    assert 'rpc("confirm_q7_material_issue", { p_issue_id: issue.id })' in queue
    assert 'actual_qty' not in region(queue, 'rpc("confirm_q7_material_issue"', '});')
    assert 'ghi sổ xuất Q7' in queue
    assert 'trừ tồn kho' not in queue
    assert 'Không đủ tồn kho' not in queue and 'baseline' not in queue.lower()


def test_pdf_button_still_in_production_planning() -> None:
    planning = read(PLANNING)
    assert 'data-testid={`q7-material-issue-pdf-${order.id}`}' in planning
    assert 'Phiếu NVL' in planning
    assert 'openQ7MaterialIssuePdf' in planning

if __name__ == "__main__":
    failures=[]
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            try: fn(); print(f"PASS {name}")
            except Exception as exc: failures.append(f"FAIL {name}: {exc}"); print(failures[-1])
    if failures: raise SystemExit(1)
    print("Q7 material inventory UI contracts passed")
