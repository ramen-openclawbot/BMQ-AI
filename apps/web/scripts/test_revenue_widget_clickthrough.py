from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD = ROOT / "src/pages/RevenueManagementDashboard.tsx"
DETAIL = ROOT / "src/pages/RevenueSourceDetail.tsx"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_metric_cards_are_clickable_and_keyboard_accessible():
    src = read(DASHBOARD)
    assert "role=\"button\"" in src
    assert "tabIndex={0}" in src
    assert "handleCardKeyDown" in src
    assert 'event.key !== "Enter" && event.key !== " "' in src
    assert "Chạm để xem chi tiết" in src


def test_metric_cards_open_controlled_ledger_detail_scopes():
    src = read(DASHBOARD)
    assert 'params: { scope: "controlled_ledger" }' in src
    assert 'params: { scope: "controlled_ledger", focus: "quantity" }' in src
    assert 'params: { scope: "controlled_ledger", focus: "customers" }' in src
    assert "navigate(`/finance-control/revenue/sources?${sp.toString()}`)" in src


def test_source_detail_preserves_legacy_behavior_but_supports_controlled_scope():
    src = read(DETAIL)
    assert 'scope === "controlled_ledger"' in src
    assert 'next = next.in("source_document.status", ["controlled", "trusted"]).eq("approval_status", "approved") as T' in src
    assert 'next = next.eq("source_document.status", "trusted") as T' in src
    assert "Controlled ledger: Số vận hành đã kiểm soát, chưa phải final audit." in src


def test_revenue_dashboard_uses_global_stitch_light_theme_tokens():
    src = read(DASHBOARD)
    assert 'data-stitch-revenue-theme="pantone-2026-glass"' in src
    assert "bg-card/70" in src
    assert "shadow-card" in src
    assert "backdrop-blur-xl" in src
    assert "text-foreground" in src
    assert "text-muted-foreground" in src
    assert "border-border/55" in src
    forbidden = [
        "bg-stone-950",
        "from-stone-900",
        "via-stone-950",
        "to-amber-950",
        "text-amber-50",
        "text-stone-100",
        "border-amber-100",
    ]
    for token in forbidden:
        assert token not in src, f"old dark revenue theme token still present: {token}"


def test_source_detail_focus_and_review_labels_are_user_friendly():
    src = read(DETAIL)
    assert 'focusLabel = isQuantityFocus ? "Sản lượng" : isCustomersFocus ? "Customer/NPP" : focus' in src
    assert 'reviewLabel = review === "review_queue" ? "Cần kiểm tra" : review' in src
    assert "Search product/customer/source..." in src
    assert "Search customer/NPP/source..." in src
