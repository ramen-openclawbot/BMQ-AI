from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260818234500_material_supplier_scan_unit_suggestions.sql"
EDGE = ROOT / "supabase/functions/match-delivery-note/index.ts"
HOOK = ROOT / "src/hooks/useGoodsReceipts.ts"
MATERIAL_HOOK = ROOT / "src/hooks/useMaterialMaster.ts"
PAGE = ROOT / "src/pages/material-master/MaterialMasterAdmin.tsx"


def test_scan_evidence_is_append_only_private_and_service_recorded():
    sql = MIGRATION.read_text()
    assert "create table public.material_supplier_unit_scan_evidence" in sql
    assert "goods_receipt_item_id uuid not null" in sql
    assert "raw_product_name text not null" in sql
    assert "raw_purchase_unit text not null" in sql
    assert "document_path text not null" in sql
    assert "document_checksum text not null" in sql
    assert "package_quantity numeric" in sql
    assert "package_unit text" in sql
    assert "unique" in sql.lower()
    assert "enable row level security" in sql.lower()
    assert "record_material_supplier_unit_scan_evidence" in sql
    assert "record_material_supplier_unit_scan_evidence(uuid, text, text, uuid, jsonb)" in sql
    assert "v_item_id := nullif(v_line->>'goods_receipt_item_id', '')::uuid" in sql
    assert "grant execute on function public.record_material_supplier_unit_scan_evidence" in sql
    assert "to service_role" in sql
    assert "to authenticated" not in sql.split("record_material_supplier_unit_scan_evidence", 2)[-1].split("create or replace function", 1)[0]
    assert "direct scan evidence update/delete is not allowed" in sql


def test_scan_suggestions_are_read_only_and_cogs_rooted():
    sql = MIGRATION.read_text()
    assert "supplier_delivery_note_scan" in sql
    assert "join public.sku_cogs_materials" in sql
    assert "gri.canonical_material_id" in sql
    assert "scan_evidence_id" in sql
    assert "source_reference" in sql
    assert "suggested_base_quantity" in sql
    assert "suggested_base_unit" in sql
    assert "se.package_quantity * 1000" in sql
    assert "v_document_path || '#'" not in sql
    assert "when 'supplier_delivery_note_scan' then 2" in sql
    assert "m.default_unit" in sql
    assert "payment_history_name_contains" in sql


def test_confirmation_requires_matching_scan_evidence_and_explicit_conversion():
    sql = MIGRATION.read_text()
    assert "p_scan_evidence_id uuid default null" in sql
    assert "p_confirmed_base_quantity numeric default null" in sql
    assert "p_confirmed_base_unit text default null" in sql
    assert "scan evidence does not belong to selected material/supplier/name/unit" in sql
    assert "confirmed base unit must equal COGS unit" in sql
    assert "v_base_unit := v_material.default_unit" in sql
    assert "and p_confirmed_base_quantity is null" in sql
    assert "when lower(btrim(se.raw_purchase_unit)) = 'kg' and lower(btrim(m.default_unit)) = 'g' then 1000::numeric" in sql
    assert "insert into public.material_unit_conversions" in sql
    assert "supplier_delivery_note_scan" in sql
    assert "explicit_user_confirmation" in sql
    # The scoped migration must never mutate payment/finance rows.
    forbidden = ["update public.payment_requests", "update public.payment_request_items", "update public.invoices", "update public.goods_receipt_items"]
    for token in forbidden:
        assert token not in sql.lower()


def test_delivery_note_ocr_persists_only_source_evidence_after_receipt_image_is_saved():
    edge = EDGE.read_text()
    hook = HOOK.read_text()
    assert "package_quantity" in edge
    assert "package_unit" in edge
    assert "deliveryNotePath" in edge
    assert "sha256Hex" in edge
    assert 'p_document_checksum: documentChecksum' in edge
    assert 'item.status !== "missing" && item.lineIdentityExact' in edge
    assert 'supabase.rpc("record_material_supplier_unit_scan_evidence"' in edge
    assert "p_actor_id: user.id" in edge
    assert "p_lines:" in edge
    assert '.update({ image_url: deliveryNotePath })' in hook
    assert "deliveryNotePath," in hook
    assert "useServerMaterialResolutionOnly" in hook


def test_edge_is_bounded_to_selected_receipt_and_hides_internal_errors():
    edge = EDGE.read_text()
    assert '.from("payment_requests")' not in edge
    assert "Không tìm thấy dòng phù hợp trong phiếu nhập đã chọn." in edge
    assert "Không thể xử lý phiếu giao hàng. Vui lòng thử lại." in edge
    assert "error instanceof Error ? error.message" not in edge


def test_material_master_shows_scan_source_cogs_unit_and_explicit_factor_confirmation():
    hook = MATERIAL_HOOK.read_text()
    page = PAGE.read_text()
    for field in ["scan_evidence_id", "source_reference", "package_quantity", "package_unit", "suggested_base_quantity", "suggested_base_unit"]:
        assert field in hook
    assert 'supplier_delivery_note_scan' in hook
    assert "Đơn vị Giá vốn" in page
    assert "Gợi ý từ phiếu xuất hàng NCC" in page
    assert "Quy cách OCR" in page
    assert "1 đơn vị mua" in page
    assert "p_scan_evidence_id" not in page  # frontend uses typed camelCase payload, not raw RPC naming
    assert "scanEvidenceId" in page
    assert "confirmedBaseQuantity" in page
    assert "confirmedBaseUnit" in page
    assert "Không tự đổi Duyệt chi" in page
