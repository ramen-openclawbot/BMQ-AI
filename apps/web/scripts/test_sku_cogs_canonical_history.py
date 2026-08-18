from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260803024055_sku_cogs_canonical_history_peerless.sql"
PAGE = ROOT / "src/pages/SkuCostsManagement.tsx"
SCAN = ROOT / "supabase/functions/scan-sku-cost-sheet/index.ts"
SHARED_CONTROLLER = ROOT / "supabase/functions/_shared/material-controller.ts"


def test_migration_creates_canonical_material_registry_and_cogs_history():
    sql = MIGRATION.read_text(encoding="utf-8").lower()

    assert "create table if not exists public.sku_cogs_materials" in sql
    assert "create table if not exists public.sku_cogs_material_aliases" in sql
    assert "create table if not exists public.sku_cogs_versions" in sql
    assert "create table if not exists public.sku_cogs_version_formulations" in sql
    assert "canonical_material_id" in sql
    assert "effective_from" in sql
    assert "effective_to" in sql
    assert "raw_ocr_name" in sql
    assert "p_effective_from - 1" in sql
    assert "sku_cogs_effective_date_not_forward" in sql
    assert "insert into public.product_skus" in sql
    assert "target_sku_id" in sql


def test_migration_versions_before_replacing_imperial_with_peerless():
    sql = MIGRATION.read_text(encoding="utf-8").lower()

    archive_pos = sql.index("insert into public.sku_cogs_versions")
    replace_pos = sql.index("-- current cogs uses the already-declared peerless")
    assert archive_pos < replace_pos
    assert "date '2026-06-12'" in sql
    assert "nvl-peerless-uc-25kg" in sql
    assert "peerless úc 25kg" in sql
    assert "83.33" in sql


def test_migration_preserves_old_imperial_snapshot_after_manual_peerless_edit():
    sql = MIGRATION.read_text(encoding="utf-8").lower()

    assert "-- include rows already changed manually to peerless before deployment" in sql
    assert "like '%imperial%'\n     or public.normalize_ocr_cost_key(ingredient_name) like '%peerless%'" in sql
    assert "else 'bơ imperial'" in sql
    assert "then 'nvl-bo-imperial'" in sql
    assert "then 97::numeric" in sql


def test_migration_enforces_canonical_formulation_identity_in_database():
    sql = MIGRATION.read_text(encoding="utf-8").lower()

    assert "validate_sku_formulation_canonical_material" in sql
    assert "trg_validate_sku_formulation_canonical_material" in sql
    assert "raise exception" in sql
    assert "liên hệ bộ phận quản trị" in sql


def test_sku_cost_editor_uses_closed_material_picker_and_atomic_rpc():
    source = PAGE.read_text(encoding="utf-8")

    assert 'from "@/components/ui/select"' in source
    assert 'SelectValue placeholder="Chọn NVL đã khai báo"' in source
    assert 'sb.rpc("save_sku_cogs"' in source
    assert 'sb.from("product_skus").insert' not in source
    assert "NVL phải được chuẩn hóa bằng danh mục NVL chuẩn trước khi lưu." in source
    assert "<datalist" not in source


def test_sku_cost_ocr_blocks_unknown_materials_and_returns_canonical_identity():
    source = SCAN.read_text(encoding="utf-8")
    shared = SHARED_CONTROLLER.read_text(encoding="utf-8")

    assert "resolveCanonicalMaterialForLine" in source
    assert 'source_type: "sku_cogs"' in source
    assert 'source_table: "sku_formulations"' in source
    assert 'input.source_type === "sku_cogs" ? ["unit", "standard_cost"]' in shared
    assert 'input.source_line_id || input.source_type === "sku_cogs"' in shared
    assert "SKU_COGS_MATERIAL_NOT_FOUND" not in source
    assert "material_resolution_request_id" in source
    assert "material_resolution_status" in source
    assert "canonical_material_id" in source
    assert "canonical_material_name" in source
