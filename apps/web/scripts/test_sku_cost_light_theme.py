from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD = ROOT / "src/pages/SkuCostsDjango.tsx"
ANALYSIS = ROOT / "src/pages/SkuCostsAnalysis.tsx"

FORBIDDEN_OLD_THEME_TOKENS = [
    "#0b0908",
    "#17100c",
    "#070605",
    "#14100d",
    "#211915",
    "#120e0b",
    "#1b1004",
    "#f59e0b",
    "text-white",
    "border-white",
    "bg-white/",
    "amber-",
    "orange-",
    "emerald-",
    "rose-",
    "slate-",
    "[color-scheme:dark]",
    "rgba(255",
    "rgba(245",
]


HEADER = ROOT / "src/components/sku-costs/SkuCostMenuBar.tsx"
STYLES = ROOT / "src/styles/bmq-sku-costs.css"


def assert_shared_light_theme(path: Path, marker: str) -> None:
    src = path.read_text()
    assert marker in src
    # The giá vốn pages share one light stylesheet (.gv, Demo 3 shell tokens) through SkuCostHeader.
    assert 'className="gv"' in src, f"{path.name} must render inside the shared .gv page"
    assert "SkuCostHeader" in src, f"{path.name} must use the shared giá vốn header"
    assert '@/styles/bmq-sku-costs.css' in HEADER.read_text()
    styles = STYLES.read_text()
    assert "var(--d3-card" in styles and "var(--d3-ink" in styles
    for token in FORBIDDEN_OLD_THEME_TOKENS:
        assert token not in styles, f"bmq-sku-costs.css contains old SKU cost theme token {token!r}"
    for token in FORBIDDEN_OLD_THEME_TOKENS:
        assert token not in src, f"{path.name} still contains old SKU cost theme token {token!r}"


def test_sku_cost_dashboard_uses_shared_light_theme_tokens() -> None:
    assert_shared_light_theme(DASHBOARD, 'data-stitch-sku-cost-dashboard-theme="pantone-2026-light"')


def test_sku_cost_analysis_uses_shared_light_theme_tokens() -> None:
    assert_shared_light_theme(ANALYSIS, 'data-stitch-sku-cost-analysis-theme="pantone-2026-light"')


if __name__ == "__main__":
    test_sku_cost_dashboard_uses_shared_light_theme_tokens()
    test_sku_cost_analysis_uses_shared_light_theme_tokens()
    print("sku cost light theme guards passed")
