#!/usr/bin/env python3
"""Task 8/9 WarehouseDispatch materials-retirement source contracts.

Q7 signed-slip workflow is moved to /production/q7/inventory. WarehouseDispatch must
keep only finished-goods dispatch and read-only automatic receipt issue audit.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "src/pages/WarehouseDispatch.tsx"
Q7_COMPONENT = ROOT / "src/components/q7-material-inventory/Q7SignedMaterialIssueQueue.tsx"

LEGACY_KFM_TOKENS = (
    "KfmDailyMaterialIssue", "KfmDailyIssue", "kfmDaily", "KFM", "data-kfm",
    "upsert_kfm_daily_material_issue", "mark_kfm_daily_material_issue_printed",
    "kfm_daily_material_issue", "printKfmDailyIssue", "Legacy material issue preview",
)

MOVED_Q7_TOKENS = (
    "Q7SignedMaterialIssue", "q7SignedMaterialIssue", "Q7_SIGNED_MATERIAL_ISSUE_STATUSES",
    "q7-signed-material-issue-queue", "q7-material-issue-confirmation-dialog",
    "production-material-issue-signed-upload", "production-material-issue-check",
    "confirm_q7_material_issue", "Nguyên vật liệu", "Phiếu NVL Q7 đã ký",
)

LEGACY_PREVIEW_TOKENS = (
    "ProductionOrderForMaterials", "ProductionOrderItemForMaterials", "MaterialSkuRow", "SkuFormulaRow",
    "KitchenItemRow", "ProductionMaterialIssueItem", "MaterialPreviewRow", "selectedMaterialOrder",
    "selectedMaterialIssue", "materialOrder", "materialSkus", "skuFormulations", "kitchenItems",
    "aggregateMaterialRows", "normalizeMaterialName", "buildMaterialCode", "stripLevel2Prefix",
    "sku_formulations", "kitchen_inventory_items", "material_issue_product_skus",
    "material_issue_sku_formulations", "material_issue_kitchen_items", "production_order_items_for_material_issue",
    "Mã NVL", "BOM", "cost source", "unit_cost", "standard_unit_cost", "material_code",
    "dosage_qty", "wastage_percent",
)

AUTO_COST_TOKENS = ("unit_cost", "amount", "total_amount", "Đơn giá", "Thành tiền", "Chi phí")

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

def auto_logic(src: str) -> str:
    return region(src, "// Trigger-created receipt issues are audit-only", "// Approved sales POs for dispatch")

def auto_dom(src: str) -> str:
    return region(src, "{/* ── Read-only automatic issue detail", "{/* ── Create Dialog")

def create_mutation(src: str) -> str:
    return region(src, "const createMutation = useMutation", "const updateStatusMutation")

def test_warehouse_dispatch_has_no_materials_or_q7_signed_slip_workflow() -> None:
    src = read_page()
    assert 'activeWorkflow, setActiveWorkflow' in src
    assert '"finished" | "auto"' in src
    assert 'setActiveWorkflow("materials")' not in src
    assert 'activeWorkflow === "materials"' not in src
    for moved in MOVED_Q7_TOKENS:
        assert moved not in src, f"WarehouseDispatch still contains moved Q7 workflow token {moved!r}"
    assert Q7_COMPONENT.exists(), "Q7 queue must live in reusable Q7 component"


def test_warehouse_dispatch_has_no_legacy_kfm_or_material_cost_preview_internals() -> None:
    src = read_page()
    for legacy in LEGACY_KFM_TOKENS + LEGACY_PREVIEW_TOKENS:
        assert legacy not in src, f"WarehouseDispatch still contains retired legacy material internals {legacy!r}"
    assert "useRef" not in src, "KFM print/date refs should be retired"
    assert "Camera" not in src and "Printer" not in src, "legacy material preview/print icons should be removed"


def test_auto_goods_receipt_issue_items_drop_all_cost_fields_from_query_type_and_detail() -> None:
    src = read_page()
    logic = auto_logic(src)
    detail = auto_dom(src)
    item_type = region(src, "type GoodsReceiptAutoIssueItem = {", "};")
    for required in ["id: string", "auto_issue_id: string", "product_name: string", "quantity: number", "unit: string"]:
        assert required in item_type
    for forbidden in AUTO_COST_TOKENS:
        assert forbidden not in item_type
        assert forbidden not in logic
        assert forbidden not in detail
    assert '.select("id,auto_issue_id,product_name,quantity,unit")' in logic
    assert "<TableHead>Sản phẩm</TableHead>" in detail
    assert '<TableHead className="text-right">Số lượng</TableHead>' in detail
    assert "<TableHead>ĐVT</TableHead>" in detail
    assert "colSpan={3}" in detail


def test_finished_goods_revenue_and_billable_workflow_is_preserved() -> None:
    src = read_page()
    mutation = create_mutation(src)
    for token in [
        "unit_price_vat_included", "source_line_amount_vat_included", "temporary_revenue_amount_vat_included",
        "confirmed_revenue_amount_vat_included", "billable_qty", "upsert_po_dispatch_revenue_confirmation",
        "confirm_po_dispatch_revenue", "po_dispatch_revenue_confirmations", "Công nợ lấy theo",
        "Thành tiền thực tế", "Số tính tiền",
    ]:
        assert token in src, f"finished-goods revenue behavior token disappeared: {token}"
    assert "amount_status" in mutation
    assert "needs_sku_allocation" in mutation
    assert "po?.total_amount" in mutation

if __name__ == "__main__":
    failures: list[str] = []
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn(); print(f"PASS {name}")
            except Exception as exc:
                failures.append(f"FAIL {name}: {exc}"); print(failures[-1])
    if failures: raise SystemExit(1)
    print("Task8 WarehouseDispatch moved-Q7 retirement contracts passed")
