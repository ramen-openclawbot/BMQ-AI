from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260818223000_material_supplier_suggestion_fallback.sql"
PAGE = ROOT / "src/pages/material-master/MaterialMasterAdmin.tsx"
HOOK = ROOT / "src/hooks/useMaterialMaster.ts"


def compact(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()


def test_name_containment_is_suggestion_only_and_never_auto_links():
    sql = compact(MIGRATION.read_text())
    assert "create or replace function public.get_material_supplier_suggestions" in sql
    assert "payment_history_name_contains" in sql
    assert "like m.normalized_name || ' %'" in sql
    assert "null::uuid as product_sku_id" in sql
    suggestion_body = sql.split("function public.get_material_supplier_suggestions", 1)[1].split("$$;", 1)[0]
    assert not re.search(r"\b(insert into|update|delete from|truncate)\b", suggestion_body)
    assert "public.can_view_material_master()" in suggestion_body
    assert "has_module_permission((select auth.uid()), 'payment_requests', 'view')" in suggestion_body


def test_authorized_manual_supplier_confirmation_is_audited_not_automatic():
    sql = compact(MIGRATION.read_text())
    assert "create or replace function public.confirm_material_supplier_product" in sql
    assert "manual_supplier_selection" in sql
    assert "explicit_user_confirmation" in sql
    assert "public.can_edit_material_master()" in sql
    assert "has_module_permission((select auth.uid()), 'payment_requests', 'edit')" in sql
    assert "public.material_master_audit_append" in sql
    assert "reason required" in sql
    assert "supplier product is not linked to selected cogs material" in sql
    assert "payment request product evidence required" not in sql


def test_ui_always_offers_supplier_dropdown_and_manual_product_fields():
    page = PAGE.read_text()
    hook = HOOK.read_text()
    for text in [
        "Gợi ý để tham khảo — chưa tự liên kết",
        "Chọn nhà cung cấp",
        "Tên hàng tại NCC",
        "Đơn vị mua",
        "Xác nhận và lưu",
    ]:
        assert text in page
    assert "suppliers={data?.suppliers || []}" in page
    assert "manualSupplierId" in page
    assert "manualProductName" in page
    assert "manualPurchaseUnit" in page
    assert '"payment_history_name_contains"' in hook
    assert "useEffect" not in page
    assert "useConfirmMaterialSupplierProduct" in page
