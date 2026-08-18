from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260818170000_material_master_business_controller.sql"
HOOK = ROOT / "src/hooks/useMaterialMaster.ts"
PAGE = ROOT / "src/pages/material-master/MaterialMasterAdmin.tsx"


def read(path: Path) -> str:
    assert path.exists(), f"missing expected file: {path}"
    return path.read_text(encoding="utf-8")


def compact_sql() -> str:
    sql = read(MIGRATION).lower()
    return re.sub(r"\s+", " ", sql)


def test_legacy_material_versions_are_bootstrapped_and_required():
    sql = compact_sql()
    assert "update public.sku_cogs_materials set version = 1 where version is null" in sql
    assert "alter column version set default 1" in sql
    assert "alter column version set not null" in sql


def test_supplier_link_rpc_is_permissioned_versioned_idempotent_and_audited():
    sql = compact_sql()
    assert "function public.link_material_supplier(" in sql
    assert "public.can_edit_material_master()" in sql
    assert "for update" in sql
    assert "material version conflict" in sql
    assert "insert into public.material_supplier_products" in sql
    assert "approved_by" in sql and "approved_at" in sql
    assert "supplier_link_unchanged" in sql
    assert "and approved = true" in sql
    assert "normalized_supplier_product_name = public.material_master_normalize(v_old.canonical_name)" in sql
    assert "and base_quantity = 1" in sql
    assert sql.index("'status', 'supplier_link_unchanged'") < sql.index("material version conflict")
    assert "existing supplier product requires reconciliation before canonical linking" in sql
    assert "exception when unique_violation then" in sql
    assert "supplier product identity conflict after concurrent insert" in sql
    assert re.search(r"public\.material_master_audit_append\(\s*'link_material_supplier'", sql)
    assert "grant execute on function public.link_material_supplier(uuid, integer, uuid, text) to authenticated" in sql
    assert "revoke all on function public.link_material_supplier(uuid, integer, uuid, text) from public, anon" in sql


def test_cogs_link_rpc_appends_exact_material_and_publishes_version_snapshot():
    sql = compact_sql()
    assert "function public.link_material_to_sku_cogs(" in sql
    assert "public.can_edit_material_master()" in sql
    assert "sku_type::text = 'finished_good'" in sql
    assert "cogs link dosage must be positive" in sql
    assert "standard cost required" in sql
    assert "insert into public.material_price_history" in sql
    assert "insert into public.sku_formulations" in sql
    assert "insert into public.sku_cogs_versions" in sql
    assert "insert into public.sku_cogs_version_formulations" in sql
    assert "cogs_link_unchanged" in sql
    cogs_sql = sql[sql.index("function public.link_material_to_sku_cogs("):]
    assert cogs_sql.index("'status', 'cogs_link_unchanged'") < cogs_sql.index("material version conflict")
    assert "existing cogs formulation contains unresolved or inactive canonical material" in cogs_sql
    assert "source_formulation_id = v_existing.id" in cogs_sql
    assert "canonical_material_snapshot->>'standard_price_id'" in cogs_sql
    assert "cogs version snapshot row count mismatch" in cogs_sql
    assert re.search(r"public\.material_master_audit_append\(\s*'link_material_to_sku_cogs'", sql)
    assert "grant execute on function public.link_material_to_sku_cogs(uuid, integer, uuid, numeric, numeric, numeric, date, text) to authenticated" in sql
    assert "revoke all on function public.link_material_to_sku_cogs(uuid, integer, uuid, numeric, numeric, numeric, date, text) from public, anon" in sql


def test_browser_hook_reads_real_supplier_and_cogs_links_and_uses_only_rpcs_for_writes():
    hook = read(HOOK)
    assert "readAllTable<FinishedSkuLite>" in hook
    assert "readAllTable<SupplierProduct>" in hook
    assert "readAllTable<SupplierLite>" in hook
    assert "readAllTable<CogsMaterialLink>" in hook
    assert "product_skus!sku_formulations_sku_id_fkey(sku_code, product_name, sku_type)" in hook
    assert '{ column: "sku_type", value: "finished_good" }' in hook
    assert '{ column: "product_skus.sku_type", value: "finished_good" }' in hook
    assert ".range(from, from + pageSize - 1)" in hook
    assert 'db.rpc("link_material_supplier"' in hook
    assert 'db.rpc("link_material_to_sku_cogs"' in hook
    assert '.from("material_supplier_products").insert' not in hook
    assert '.from("sku_formulations").insert' not in hook
    assert 'invalidateQueries({ queryKey: ["material-master"] })' in hook


def test_supplier_review_replaces_reverse_flow_controller_and_keeps_compact_mobile_ui():
    page = read(PAGE)
    for text in [
        "NVL từ Giá vốn",
        "Sản phẩm sử dụng",
        "Hệ thống gợi ý NCC",
        "Chọn NCC khác",
        "Xác nhận và lưu",
        "NCC & Duyệt chi",
        "Xác nhận và đồng bộ",
    ]:
        assert text in page
    assert "MaterialBusinessController" not in page
    assert "useLinkMaterialSupplier" not in page
    assert "useLinkMaterialToSkuCogs" not in page
    assert "canMutate={canMutate}" in page
    assert "data-bmq-cogs-rooted-material-list" in page
    assert "data-bmq-material-supplier-review" in page
    assert "data-bmq-payment-request-bulk-sync" in page
    assert "max-h-[90dvh]" in page


def test_supplier_confirmation_actions_require_reason_and_positive_material_version():
    hook = read(HOOK)
    page = read(PAGE)
    assert "expectedVersion" in hook
    assert "nonEmptyReason(payload.reason)" in hook
    assert "selected.version" in page
    assert "Lý do xác nhận" in page
    assert "Lý do đồng bộ" in page
    assert "validReason" in page
    assert "Cần tải lại dữ liệu" not in page
