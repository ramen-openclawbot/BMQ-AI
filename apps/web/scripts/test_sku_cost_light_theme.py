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


def assert_shared_light_theme(path: Path, marker: str) -> None:
    src = path.read_text()
    assert marker in src
    required_tokens = [
        "bg-background",
        "bg-card/70",
        "bg-card/80",
        "text-foreground",
        "text-muted-foreground",
        "border-border/70",
        "bg-primary",
        "text-primary",
        "text-success",
        "text-destructive",
        "shadow-card",
    ]
    for token in required_tokens:
        assert token in src, f"{path.name} missing shared light token {token!r}"
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
