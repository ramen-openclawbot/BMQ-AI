from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase/migrations"


def latest_db_mapping_seed() -> str:
    candidates = sorted(MIGRATIONS.glob("*_seed_sku_cost_material_alias_mappings.sql"))
    assert candidates, "Missing migration that seeds reviewed SKU-cost material alias mappings into DB"
    return candidates[-1].read_text(encoding="utf-8")


def test_reviewed_hardcoded_material_aliases_are_seeded_in_db_migration():
    sql = latest_db_mapping_seed()
    for expected in [
        "Bột mì 888 Cam (25kg)",
        "CHẤT LÀM MỀM BÁNH BICO-1KG",
        "Đường RE An Khuê",
        "Men Khô Meizan - Nhãn Vàng",
        "Kem Sữa Whipping Cream Tatuta",
        "[Thùng] Dầu Hướng Dương Simply 2L x 6 Chai",
        "Giấm Gạo Ajinomoto 400ml",
        "BƠ BUTTERY SPREAD IMPERIAL",
    ]:
        assert expected in sql


def test_seed_is_idempotent_and_backfills_formula_and_purchase_codes():
    sql = latest_db_mapping_seed().lower()
    assert "public.cost_item_alias_mappings" in sql
    assert "where not exists" in sql
    assert "update public.cost_item_alias_mappings existing" in sql
    assert "update public.sku_formulations" in sql
    assert "update public.payment_request_items" in sql
    assert "update public.invoice_items" in sql
    assert "confirmed_standard_cost_code" in sql
    assert "public.normalize_ocr_cost_key" in sql
    assert "from reviewed_sku_cost_material_mappings\n    group by public.normalize_ocr_cost_key(source_name)" in sql
    assert "from reviewed_sku_cost_material_seed seed\nwhere existing.source_name_key = seed.source_name_key\n  and existing.active" in sql
    assert "payment_request_item_candidates" in sql
    assert "unambiguous_payment_request_items" in sql
    assert "unambiguous_invoice_items" in sql
    assert "having count(distinct standard_cost_code) = 1" in sql
    assert ") is distinct from (" in sql


if __name__ == "__main__":
    test_reviewed_hardcoded_material_aliases_are_seeded_in_db_migration()
    test_seed_is_idempotent_and_backfills_formula_and_purchase_codes()
    print("ok - DB mapping seed tests passed")
