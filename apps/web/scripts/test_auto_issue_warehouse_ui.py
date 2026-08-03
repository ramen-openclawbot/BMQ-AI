#!/usr/bin/env python3
"""UI contract for the read-only automatic goods-receipt issue workflow."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "src/pages/WarehouseDispatch.tsx"


class AutoIssueWarehouseUiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = PAGE.read_text(encoding="utf-8")
        cls.compact = re.sub(r"\s+", " ", cls.source)

    def test_exposes_a_separate_auto_issue_workflow(self) -> None:
        self.assertIn('"finished" | "materials" | "auto"', self.source)
        self.assertIn('setActiveWorkflow("auto")', self.source)
        self.assertIn("PXK tự động", self.source)
        self.assertIn('activeWorkflow === "auto"', self.source)

    def test_reads_auto_issue_headers_lines_and_source_receipts(self) -> None:
        self.assertIn('.from("goods_receipt_auto_issues")', self.source)
        self.assertIn('.from("goods_receipt_auto_issue_items")', self.source)
        self.assertIn('.from("goods_receipts")', self.source)
        self.assertIn('.from("suppliers")', self.source)
        self.assertIn('enabled: activeWorkflow === "auto"', self.compact)

    def test_shows_business_audit_columns_and_system_status(self) -> None:
        for label in (
            "Mã PXK",
            "Phiếu nhập nguồn",
            "Nhà cung cấp",
            "Ngày giờ tạo",
            "Số dòng",
            "Tổng số lượng",
            "Hệ thống tự động",
        ):
            self.assertIn(label, self.source)

    def test_detail_is_read_only_and_lists_each_product(self) -> None:
        self.assertIn("Chi tiết PXK tự động", self.source)
        self.assertIn("selectedAutoIssueItems", self.source)
        self.assertIn("product_name", self.source)
        self.assertIn("quantity", self.source)
        self.assertIn("unit", self.source)
        self.assertIn("Chứng từ chỉ đọc", self.source)
        auto_section = self.source.split("Chi tiết PXK tự động", 1)[1]
        self.assertNotIn("Xóa phiếu", auto_section)
        self.assertNotIn("Sửa phiếu", auto_section)

    def test_has_mobile_cards_and_desktop_table(self) -> None:
        self.assertIn('data-testid="auto-issue-mobile-list"', self.source)
        self.assertIn('data-testid="auto-issue-desktop-table"', self.source)
        self.assertIn("md:hidden", self.source)
        self.assertIn("hidden overflow-x-auto", self.source)


if __name__ == "__main__":
    unittest.main()
