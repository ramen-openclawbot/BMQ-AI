#!/usr/bin/env python3
"""Regression checks for bounded dealer catalog label lookups."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
CATALOG_FUNCTION = ROOT / "supabase/functions/dealer-catalog/index.ts"


class DealerCatalogQueryScopeTest(unittest.TestCase):
    def test_label_lookup_uses_only_catalog_eligible_skus(self) -> None:
        source = CATALOG_FUNCTION.read_text(encoding="utf-8")

        eligible_match = re.search(
            r"const\s+eligibleSkus\s*=\s*\(\(skus\s*\|\|\s*\[\]\)\s+as\s+ProductSku\[\]\)"
            r"\s*\.filter\(\(sku\)\s*=>\s*isFinishedSku\(sku\)\s*&&\s*!sku\.hide_from_dealer_portal\);",
            source,
        )
        self.assertIsNotNone(
            eligible_match,
            "dealer-catalog must filter finished, visible SKUs before building the label lookup",
        )

        sku_ids_match = re.search(r"const\s+skuIds\s*=\s*eligibleSkus\.map\(", source)
        self.assertIsNotNone(
            sku_ids_match,
            "product_label_specs lookup must use only eligible dealer SKU IDs",
        )

        products_match = re.search(r"const\s+products\s*=\s*eligibleSkus\.flatMap\(", source)
        self.assertIsNotNone(
            products_match,
            "catalog response must be built from the same eligible SKU set",
        )

        assert eligible_match is not None
        assert sku_ids_match is not None
        assert products_match is not None
        self.assertLess(eligible_match.start(), sku_ids_match.start())
        self.assertLess(sku_ids_match.start(), products_match.start())


if __name__ == "__main__":
    unittest.main()
