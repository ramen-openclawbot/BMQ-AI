#!/usr/bin/env python3
"""Contract guard for persisting canonical matched SKU ids on production order items.

The production-confirmation dialog is populated only from strictly resolved,
location-enabled PO items. The insert payload must carry that canonical SKU id
through to production_order_items.sku_id without adding any fallback matching at
insert time.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src/pages/ProductionPlanning.tsx"


def read_source() -> str:
    return SOURCE.read_text(encoding="utf-8")


def extract_balanced_block(source: str, marker: str) -> str:
    start = source.index(marker)
    brace_start = source.index("{", start)
    depth = 0
    for index in range(brace_start, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[brace_start : index + 1]
    raise AssertionError(f"could not extract block for {marker!r}")


def test_confirmed_production_order_items_persist_matched_sku_id():
    src = read_source()

    assert re.search(r"interface\s+ResolvedProductionItem\s+extends\s+ProductionItem\s*{[^}]*matched_sku\s*:", src, re.S), (
        "PO lines must keep the strict resolver's matched_sku on ResolvedProductionItem"
    )
    assert "return { ...item, matched_sku: matchedSku };" in src, (
        "resolveEnabledProductionItem must be the only source of canonical matched_sku"
    )

    create_input = extract_balanced_block(src, "interface CreateProductionOrderInput")
    assert re.search(r"items\s*:\s*Array<\s*{[^}]*sku_id\s*:\s*string\s*;", create_input, re.S), (
        "CreateProductionOrderInput.items must carry canonical sku_id into the mutation"
    )

    handle_create = extract_balanced_block(src, "const handleCreateClick")
    assert ".map(resolveEnabledProductionItem)" in handle_create, (
        "confirmation items must still be built from the strict enabled-SKU resolver"
    )
    assert "item is ResolvedProductionItem" in handle_create, (
        "confirmation items must still narrow to strictly resolved production items"
    )
    assert re.search(r"sku_id\s*:\s*item\.matched_sku\.id", handle_create), (
        "confirmation form payload must preserve the canonical matched_sku.id"
    )

    mutation = extract_balanced_block(src, "const createProductionOrderMutation")
    assert re.search(r"const\s+itemsToInsert\s*=\s*input\.items\.map\(\(item\)\s*=>\s*\({[^}]*sku_id\s*:\s*item\.sku_id", mutation, re.S), (
        "production_order_items insert payload must persist sku_id from the confirmed item"
    )
    assert not re.search(r"itemsToInsert[\s\S]*resolveSkuMatch|itemsToInsert[\s\S]*resolveEnabledProductionItem", mutation), (
        "insert payload must not perform fallback/rematching; it must use the confirmed sku_id"
    )


if __name__ == "__main__":
    test_confirmed_production_order_items_persist_matched_sku_id()
    print("production SKU persistence contract passed")
