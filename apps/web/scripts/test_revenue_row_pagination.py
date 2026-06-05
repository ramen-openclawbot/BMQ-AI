from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NPP_DEBT = ROOT / "src/pages/NppDebtManagement.tsx"
SOURCE_DETAIL = ROOT / "src/pages/RevenueSourceDetail.tsx"
DAILY_REVIEW = ROOT / "src/pages/RevenueDailyReview.tsx"


def test_npp_debt_revenue_rows_paginate_at_20_per_page():
    src = NPP_DEBT.read_text()
    assert "const REVENUE_ROWS_PAGE_SIZE = 20" in src
    assert "directRevenuePage" in src
    assert "paginatedDirectLines" in src
    assert "expandedAgencyRevenuePage" in src
    assert "paginatedExpandedAgencyLines" in src
    assert "Trang doanh thu" in src
    assert "Mỗi trang tối đa 20 dòng doanh thu" in src
    assert "{paginatedDirectLines.map((line)" in src
    assert "{paginatedExpandedAgencyLines.map((line)" in src


def test_revenue_source_detail_rows_paginate_at_20_per_page():
    src = SOURCE_DETAIL.read_text()
    assert "const REVENUE_ROWS_PAGE_SIZE = 20" in src
    assert "ledgerRowsPage" in src
    assert "paginatedLedgerRows" in src
    assert "Mỗi trang tối đa 20 dòng doanh thu" in src
    assert "Trang doanh thu" in src
    assert "{paginatedLedgerRows.map((row)" in src


def test_revenue_daily_review_rows_paginate_at_20_per_page():
    src = DAILY_REVIEW.read_text()
    assert "const REVENUE_ROWS_PAGE_SIZE = 20" in src
    assert "reviewRowsPage" in src
    assert "paginatedDrafts" in src
    assert "Mỗi trang tối đa 20 dòng doanh thu" in src
    assert "Trang doanh thu" in src
    assert "{paginatedDrafts.map((draft)" in src
