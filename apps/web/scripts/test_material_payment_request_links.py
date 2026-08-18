from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260818190000_material_payment_request_links.sql"
HOOK = ROOT / "src/hooks/useMaterialMaster.ts"
PAGE = ROOT / "src/pages/material-master/MaterialMasterAdmin.tsx"


def read(path: Path) -> str:
    assert path.exists(), f"missing expected file: {path}"
    return path.read_text(encoding="utf-8")


def compact_sql() -> str:
    return re.sub(r"\s+", " ", read(MIGRATION).lower())


def test_read_rpc_is_material_scoped_safe_and_view_permissioned():
    sql = compact_sql()
    assert "function public.get_material_payment_request_links(" in sql
    assert "public.can_view_material_master()" in sql
    assert "public.has_module_permission((select auth.uid()), 'payment_requests', 'view')" in sql
    assert "where m.id = p_material_id" in sql
    assert "payment_request_items" in sql and "payment_requests" in sql and "suppliers" in sql
    for field in [
        "payment_request_item_id",
        "payment_request_id",
        "request_number",
        "request_status",
        "vendor_display_name",
        "product_name",
        "product_code",
        "quantity",
        "unit",
        "unit_price",
        "line_total",
        "link_state",
        "candidate_source",
        "canonical_material_id",
    ]:
        assert field in sql
    for forbidden in ["image_url", "notes", "description", "approved_by", "created_by"]:
        assert forbidden not in sql
    assert "grant execute on function public.get_material_payment_request_links(uuid) to authenticated" in sql
    assert "revoke all on function public.get_material_payment_request_links(uuid) from public, anon" in sql


def test_link_rpc_recomputes_exact_evidence_locks_versions_and_is_idempotent():
    sql = compact_sql()
    assert "function public.link_material_payment_request_item(" in sql
    assert "public.can_edit_material_master()" in sql
    assert "public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')" in sql
    assert "from public.sku_cogs_materials" in sql and "for update" in sql
    assert "from public.payment_request_items" in sql and "for update" in sql
    assert "payment_request_link_unchanged" in sql
    assert sql.index("'status', 'payment_request_link_unchanged'") < sql.index("material version conflict")
    assert "approved_supplier_product" in sql
    assert "legacy_raw_sku_exact" in sql
    assert "v_line.sku_id = v_material.ingredient_sku_id" in sql
    assert "select count(*) from public.sku_cogs_materials m_unique" in sql
    assert "lock table public.sku_cogs_materials in share mode" in sql
    assert sql.index("lock table public.sku_cogs_materials in share mode") < sql.index("from public.sku_cogs_materials where id = p_material_id")
    assert "m_unique.ingredient_sku_id = v_material.ingredient_sku_id" in sql
    assert "public.material_master_normalize(v_line.product_name)" in sql
    assert "public.material_master_normalize(supplier_product_name)" in sql
    assert "payment request material candidate is not exact" in sql
    assert "base_quantity" not in sql, "linking identity must not invent a unit conversion"
    assert "payment request supplier required for manual canonical confirmation" in sql
    assert "public.request_material_resolution(" in sql
    assert "public.confirm_material_resolution(" in sql
    assert "set_config('material_master.procurement_line_resolution'" in sql
    assert "where id = v_line.id" in sql
    assert re.search(r"public\.material_master_audit_append\(\s*'link_material_payment_request_item'", sql)
    assert "grant execute on function public.link_material_payment_request_item(uuid, integer, uuid, text) to authenticated" in sql
    assert "revoke all on function public.link_material_payment_request_item(uuid, integer, uuid, text) from public, anon" in sql


def test_migration_never_bulk_backfills_or_mutates_financial_state():
    sql = compact_sql()
    updates = re.findall(r"update public\.payment_request_items set", sql)
    assert len(updates) == 1, "only the guarded one-row canonical-link update is allowed"
    assert "update public.payment_request_items set canonical_material_id = p_material_id" in sql
    assert "where id = v_line.id" in sql
    assert not re.search(r"update public\.payment_requests", sql)
    assert not re.search(r"(insert into|update|delete from) public\.payments", sql)
    for field in ["total_amount =", "status = 'approved'", "payment_status =", "paid_at =", "approved_at ="]:
        assert field not in sql


def test_hook_reads_selected_material_on_demand_and_uses_audited_rpc_only():
    hook = read(HOOK)
    assert "MaterialPaymentRequestLink" in hook
    assert "useMaterialPaymentRequestLinks" in hook
    assert '"get_material_payment_request_links"' in hook and "db.rpc<MaterialPaymentRequestLink[]>" in hook
    assert "enabled: Boolean(materialId)" in hook
    assert "useLinkMaterialPaymentRequestItem" in hook
    assert 'db.rpc("link_material_payment_request_item"' in hook
    assert "p_expected_material_version" in hook
    assert "nonEmptyReason(payload.reason)" in hook
    assert "payment_request_linked" in hook and "payment_request_link_unchanged" in hook
    assert '.from("payment_request_items").update' not in hook


def test_page_has_supplier_confirmed_bulk_payment_sync_and_fail_closed_controls():
    page = read(PAGE)
    for text in [
        "NCC & Duyệt chi",
        "Duyệt chi liên quan",
        "Đã liên kết NVL",
        "Hệ thống gợi ý NCC",
        "Lý do xác nhận",
        "Xác nhận và lưu",
        "Xác nhận và đồng bộ",
        "Không tải được Duyệt chi liên quan",
    ]:
        assert text in page
    assert "data-bmq-material-payment-request-links" in page
    assert "data-bmq-material-supplier-review" in page
    assert "data-bmq-payment-request-bulk-sync" in page
    assert "useMaterialPaymentRequestLinks" in page
    assert "useSyncMaterialSupplierPaymentRequests" in page
    assert "useLinkMaterialPaymentRequestItem" not in page
    assert "paymentLinksError" in page
    assert "selected.version" in page
    assert "min-h-11" in page
    assert "break-words" in page
    assert "max-h-[90dvh]" in page
