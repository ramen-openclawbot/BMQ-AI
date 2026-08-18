from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260818213000_cogs_rooted_material_supplier_sync.sql"
HOOK = ROOT / "src/hooks/useMaterialMaster.ts"
PAGE = ROOT / "src/pages/material-master/MaterialMasterAdmin.tsx"


def compact(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()


def test_cogs_rooted_supplier_suggestion_rpc_is_read_only_exact_and_permissioned():
    sql = compact(MIGRATION.read_text())
    assert "function public.get_material_supplier_suggestions(" in sql
    assert "public.can_view_material_master()" in sql
    assert "has_module_permission((select auth.uid()), 'payment_requests', 'view')" in sql
    assert "from public.sku_cogs_materials" in sql
    assert "m.ingredient_sku_id" in sql
    assert "material_master_normalize" in sql
    assert "candidate_source" in sql
    assert "evidence_count" in sql
    body = sql.split("function public.get_material_supplier_suggestions(", 1)[1].split("$$;", 1)[0]
    assert not re.search(r"\b(insert into|update|delete from|truncate)\b", body)


def test_supplier_product_confirmation_uses_real_supplier_product_identity_and_no_invented_conversion():
    sql = compact(MIGRATION.read_text())
    assert "function public.confirm_material_supplier_product(" in sql
    assert "p_product_sku_id uuid" in sql
    assert "from public.product_skus" in sql
    assert "sku_type::text = 'raw_material'" in sql
    assert "v_product.supplier_id is distinct from p_supplier_id" in sql
    assert "v_product.canonical_material_id = p_material_id" in sql
    assert "v_material.ingredient_sku_id = v_product.id" in sql
    assert "supplier product is not linked to selected cogs material" in sql
    assert "payment request product evidence required" in sql
    assert "insert into public.material_supplier_products" in sql
    assert "insert into public.material_scoped_aliases" in sql
    assert "'exact_future_resolution', true" in sql
    assert "conversion_pending" in sql
    assert "base_unit" in sql
    assert "approved_by" in sql and "approved_at" in sql
    assert "public.material_master_audit_append(" in sql
    assert "material version conflict" in sql
    assert "supplier_product_unchanged" in sql
    assert sql.index("'status', 'supplier_product_unchanged'") < sql.index("material version conflict")


def test_one_click_payment_sync_is_exact_atomic_idempotent_and_finance_immutable():
    sql = compact(MIGRATION.read_text())
    assert "function public.sync_material_supplier_payment_requests(" in sql
    assert "has_module_permission((select auth.uid()), 'payment_requests', 'edit')" in sql
    assert "for update" in sql
    assert "public.material_master_normalize(pri.product_name)" in sql
    assert "public.material_master_normalize(v_supplier_product.supplier_product_name)" in sql
    assert "lower(btrim(coalesce(pri.unit, ''))) = lower(btrim(v_supplier_product.purchase_unit))" in sql
    assert "payment request item already linked to another material" in sql
    assert "public.link_material_payment_request_item(" in sql
    assert "payment_requests_synced" in sql
    assert "payment_requests_sync_unchanged" in sql
    sync_body = sql.split("function public.sync_material_supplier_payment_requests(", 1)[1].split("$$;", 1)[0]
    assert sync_body.index("'status', 'payment_requests_sync_unchanged'") < sync_body.index("material version conflict")
    assert "linked_count" in sql
    assert "candidate_count" in sql
    for field in ("unit_price", "line_total", "quantity", "status", "payment_status", "total_amount"):
        assert not re.search(rf"update public\.(?:payment_request_items|payment_requests)[^;]*\b{field}\s*=", sql)


def test_frontend_uses_cogs_rooted_supplier_review_and_bulk_sync_not_per_line_confirmation():
    hook = HOOK.read_text()
    page = PAGE.read_text()
    assert 'db.rpc<MaterialSupplierSuggestion[]>("get_material_supplier_suggestions"' in hook
    assert 'db.rpc("confirm_material_supplier_product"' in hook
    assert 'db.rpc("sync_material_supplier_payment_requests"' in hook
    assert "useMaterialSupplierSuggestions" in hook
    assert "useConfirmMaterialSupplierProduct" in hook
    assert "useSyncMaterialSupplierPaymentRequests" in hook
    assert "NVL từ Giá vốn" in page
    assert "Hệ thống gợi ý NCC" in page
    assert "Xác nhận và lưu" in page
    assert "Chọn NCC khác" in page
    assert "Xác nhận và đồng bộ" in page
    assert "data-bmq-cogs-rooted-material-list" in page
    assert "data-bmq-material-supplier-review" in page
    assert "data-bmq-payment-request-bulk-sync" in page
    assert "useMaterialPaymentRequestLinks(selected.id)" in page
    assert "paymentPreviewError" in page
    assert "paymentPreviewLoading" in page
    assert "chooseMaterial" in page
    assert 'setActiveTab("suppliers")' in page
    assert "onEdit={openMaterialEditor}" in page
    assert "Liên kết Duyệt chi" not in page
    assert "useLinkMaterialPaymentRequestItem" not in page
    assert "min-h-11" in page and "min-w-0" in page
