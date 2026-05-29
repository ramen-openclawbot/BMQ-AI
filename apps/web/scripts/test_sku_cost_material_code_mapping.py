from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "src/pages/SkuCostsAnalysis.tsx"
LIB = ROOT / "src/lib/sku-cost-analysis.ts"
BRIDGE = ROOT / "src/hooks/useSkuCostBridge.ts"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path}"
    return path.read_text(encoding="utf-8")


def test_analysis_logic_is_extracted_from_page_and_not_hard_coded_alias_tables():
    page = read(PAGE)
    assert 'from "@/lib/sku-cost-analysis"' in page
    assert "const aiActualCostMappings" not in page
    assert "const mappedPurchaseAliases" not in page
    assert "inferPurchaseUnitDivisor" not in page


def test_material_code_is_primary_match_key_for_formula_to_purchase_mapping():
    lib = read(LIB)
    assert "material_code" in lib
    assert "buildMaterialContexts" in lib
    assert "standard_cost_code" in lib
    assert "confirmed_standard_cost_code" in lib
    assert "suggested_standard_cost_code" in lib
    assert "purchaseMatchesFormulaRow" in lib
    assert "row.material_code" in lib
    assert "materialContext" in lib


def test_bridge_loads_unlinked_purchase_lines_and_classification_fields_for_mapping():
    bridge = read(BRIDGE)
    assert "confirmed_standard_cost_code" in bridge
    assert "suggested_standard_cost_code" in bridge
    assert "canonical_cost_item_name" in bridge
    pr_po_section = bridge.split('fetchAllRows(() =>', 1)[1].split('sb\n          .from("inventory_batches")', 1)[0]
    assert 'not("sku_id", "is", null)' not in pr_po_section


def test_material_code_name_fallback_ignores_generic_single_token_aliases():
    lib = read(LIB)
    assert "isSafeMaterialAlias" in lib
    assert "tokenCount(alias) < 2" in lib
    assert "hasPurchaseStandardCostCode(purchase)" in lib
    assert "isSafeMaterialAlias(alias) && purchaseName.includes(alias)" in lib
    # Unit "cái" is generic and must not imply egg-style 60g conversion for unrelated items
    # such as "Vòi nước" or "Nước thủy cục".
    assert 'unit.includes("cai")' not in lib


if __name__ == "__main__":
    test_analysis_logic_is_extracted_from_page_and_not_hard_coded_alias_tables()
    test_material_code_is_primary_match_key_for_formula_to_purchase_mapping()
    test_bridge_loads_unlinked_purchase_lines_and_classification_fields_for_mapping()
    test_material_code_name_fallback_ignores_generic_single_token_aliases()
    print("ok - 4 tests passed")
