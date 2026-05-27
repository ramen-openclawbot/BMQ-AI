#!/usr/bin/env python3
import unittest

from import_ocr_cost_mapping_sheet import (
    COL_CATEGORY,
    COL_RECOMMENDATION,
    COL_REVIEW,
    COL_SKUS,
    COL_SOURCE_NAME,
    build_material_code,
    decide_row,
    normalize_key,
)


SHEET_URL = "https://example.test/sheet"


class OcrCostMappingImportTest(unittest.TestCase):
    def test_material_code_matches_app_slug_style(self):
        self.assertEqual(build_material_code("Đường cát trắng"), "NVL-DUONG-CAT-TRANG")
        self.assertEqual(build_material_code(""), "NVL-CHUA-DAT-TEN")

    def test_normalize_key_keeps_supplier_alias_comparable(self):
        self.assertEqual(normalize_key("Dầu hướng dương  "), "dau huong duong")

    def test_approved_nvl_recommendation(self):
        decisions = decide_row(
            {
                COL_CATEGORY: "Chi phí bếp bánh ngọt",
                COL_SOURCE_NAME: "Bơ lạt Anchor",
                COL_RECOMMENDATION: "Bơ lạt (AI RULE: Bơ)",
                COL_SKUS: "Croissant; Bánh ngọt",
                COL_REVIEW: "",
            },
            2,
            SHEET_URL,
        )
        self.assertEqual(len(decisions), 1)
        decision = decisions[0]
        self.assertEqual(decision.mapping_status, "approved")
        self.assertEqual(decision.standard_cost_code_type, "NVL")
        self.assertEqual(decision.standard_cost_code, "NVL-BO-LAT")
        self.assertEqual(decision.category_code, "COGS_SWEET_KITCHEN")
        self.assertEqual(decision.product_line, "sweet_kitchen")

    def test_reviewed_non_cogs_becomes_standard_expense_code(self):
        decisions = decide_row(
            {
                COL_CATEGORY: "Chi phí vận hành chung",
                COL_SOURCE_NAME: "Tiền điện tháng 5",
                COL_RECOMMENDATION: "KHÔNG LIÊN QUAN COGS",
                COL_SKUS: "",
                COL_REVIEW: "Tên NVL là tiền điện. Không có trong COGS / không dùng để update COGS.",
            },
            3,
            SHEET_URL,
        )
        decision = decisions[0]
        self.assertEqual(decision.mapping_status, "approved")
        self.assertEqual(decision.standard_cost_code_type, "OPEX")
        self.assertEqual(decision.standard_cost_code, "OPEX-TIEN-DIEN")
        self.assertEqual(decision.canonical_cost_item_name, "tiền điện")

    def test_unresolved_review_does_not_create_standard_code(self):
        decisions = decide_row(
            {
                COL_CATEGORY: "Chi phí bánh mì que / bánh mì lớn",
                COL_SOURCE_NAME: "Nguyên liệu lạ",
                COL_RECOMMENDATION: "CẦN REVIEW / chưa match COGS",
                COL_SKUS: "",
                COL_REVIEW: "Kế toán check lại",
            },
            4,
            SHEET_URL,
        )
        decision = decisions[0]
        self.assertEqual(decision.mapping_status, "needs_review")
        self.assertIsNone(decision.standard_cost_code)
        self.assertEqual(decision.category_code, "UNMAPPED_REVIEW")

    def test_accounting_check_comment_blocks_automation(self):
        decisions = decide_row(
            {
                COL_CATEGORY: "Chi phí bánh mì que / bánh mì lớn",
                COL_SOURCE_NAME: "Bánh mì nhân Pate",
                COL_RECOMMENDATION: "Bánh mì nhân Pate (AI FUZZY 0.90)",
                COL_SKUS: "",
                COL_REVIEW: "Kế toán check lại",
            },
            5,
            SHEET_URL,
        )
        decision = decisions[0]
        self.assertEqual(decision.mapping_status, "needs_review")
        self.assertIsNone(decision.standard_cost_code)

    def test_no_cogs_comment_can_create_opex_code(self):
        decisions = decide_row(
            {
                COL_CATEGORY: "Chi phí vận hành chung",
                COL_SOURCE_NAME: "Khung giờ trung bình",
                COL_RECOMMENDATION: "Trứng gà (AI RULE: Trứng gà)",
                COL_SKUS: "Bánh",
                COL_REVIEW: "Tên NVL là tiền điện. Không có trong COGS",
            },
            6,
            SHEET_URL,
        )
        decision = decisions[0]
        self.assertEqual(decision.mapping_status, "approved")
        self.assertEqual(decision.standard_cost_code_type, "OPEX")
        self.assertEqual(decision.standard_cost_code, "OPEX-TIEN-DIEN")


if __name__ == "__main__":
    unittest.main()
