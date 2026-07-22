#!/usr/bin/env python3
"""Regression guard for the approved responsive dealer home redesign."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
PORTAL = ROOT / "src/pages/DealerPortal.tsx"


class DealerHomeResponsiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = PORTAL.read_text(encoding="utf-8")

    def test_home_uses_bounded_responsive_grid(self) -> None:
        self.assertIn('data-stitch-dealer-home="responsive-grid-v1"', self.source)
        self.assertIn('data-stitch-dealer-product-grid="responsive-2-3-4"', self.source)
        self.assertIn("grid-cols-2 md:grid-cols-3 lg:grid-cols-4", self.source)
        self.assertIn("overflow-x-clip", self.source)
        self.assertNotIn("dealer-product-marquee", self.source)

    def test_promotion_banner_has_visual_extension_without_letterboxing(self) -> None:
        self.assertIn('data-stitch-dealer-banner="responsive-cover-v1"', self.source)
        self.assertIn("scale-110 object-cover blur-2xl", self.source)
        self.assertIn("object-contain", self.source)

    def test_home_has_product_discovery_controls(self) -> None:
        self.assertIn('placeholder="Tìm sản phẩm"', self.source)
        self.assertIn('["Tất cả", "Bánh mì", "Bánh ngọt", "Bán chạy"]', self.source)
        self.assertNotIn("Promotion & sản phẩm BMQ", self.source)

    def test_mobile_uses_order_bar_not_bottom_navigation(self) -> None:
        self.assertIn('data-stitch-dealer-home-order-bar="mobile"', self.source)
        self.assertIn('data-stitch-dealer-home-order-cta="desktop"', self.source)
        self.assertNotIn('<nav\n          className="fixed inset-x-0 bottom-0', self.source)


if __name__ == "__main__":
    unittest.main()
