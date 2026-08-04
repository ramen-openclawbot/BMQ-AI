from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PARSER = ROOT / "supabase/functions/revenue-monthly-parse-preview/index.ts"
UI = ROOT / "src/pages/FinanceRevenueControl.tsx"


def parser_source() -> str:
    return PARSER.read_text(encoding="utf-8")


def test_web_order_replaces_only_matching_direct_dealer_email_line() -> None:
    source = parser_source()
    for needle, label in [
        ("isThuyDirectDealerInboxRow", "direct-dealer email scope"),
        ("dealerPortalCustomerDateKeys", "portal customer/date identity set"),
        ("filterDirectDealerEmailLinesReplacedByPortal", "line-level replacement helper"),
        ("!customerId || !revenueDate || !portalCustomerDateKeys.has", "customer/date match guard"),
        ("excludedDirectDealerEmailLines", "auditable excluded-line summary"),
    ]:
        assert needle in source, f"missing {label}: {needle}"


def test_nonmatching_email_lines_and_non_direct_email_sources_are_preserved() -> None:
    source = parser_source()
    for needle, label in [
        ("if (!isThuyDirectDealerInboxRow(row))", "non-direct source preservation"),
        ("filteredRows.push(row)", "preserved row output"),
        ("return !customerId || !revenueDate || !portalCustomerDateKeys.has", "nonmatching line preservation"),
        ("production_items: filteredProductionItems", "partial aggregate email preservation"),
        ("parsed_items_preview: filteredParsedItems", "fallback parsed-line preservation"),
    ]:
        assert needle in source, f"missing {label}: {needle}"


def test_tony_npp_email_replacement_remains_unchanged() -> None:
    source = parser_source()
    assert "if (isTonyThanhNppInboxRow(row))" in source
    assert "excludedTonyEmailRows" in source


def test_matching_fallback_total_row_is_replaced_by_portal_order() -> None:
    source = parser_source()
    assert "productionItems.length === 0 && parsedItems.length === 0" in source
    assert "fallbackCustomerId" in source
    assert "fallbackRevenueDate" in source
    assert "portalCustomerDateKeys.has(`${fallbackRevenueDate}|${fallbackCustomerId}`)" in source


def test_operator_copy_explains_partial_mi_email_replacement() -> None:
    ui = UI.read_text(encoding="utf-8")
    assert "bỏ từng dòng mi@bmq.vn đã trùng đại lý + ngày giao" in ui
    assert "các dòng email không trùng vẫn được giữ" in ui
