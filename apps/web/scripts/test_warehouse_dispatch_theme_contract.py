from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "src/pages/WarehouseDispatch.tsx"


def source() -> str:
    return PAGE.read_text(encoding="utf-8")


def render_source() -> str:
    text = source()
    return text[text.index("// ── Render") :]


def test_dispatch_page_uses_shared_light_app_theme() -> None:
    render = render_source()

    required = [
        'data-bmq-warehouse-dispatch-theme="app-light"',
        "bg-background",
        "text-foreground",
        "bg-card",
        "border-border",
        "text-muted-foreground",
        "shadow-card",
    ]
    for marker in required:
        assert marker in render, f"missing shared app-theme marker: {marker}"

    forbidden = [
        "bg-[#1b120e]",
        "text-white/",
        "border-white/",
        "bg-white/[0.04]",
        "shadow-black/",
        "radial-gradient(circle_at_top_left",
        "linear-gradient(135deg,#120d0a",
        "Trang xuất kho mới · giữ nguyên header và sidebar",
    ]
    for marker in forbidden:
        assert marker not in render, f"legacy dark dispatch theme remains: {marker}"


def test_dispatch_keeps_all_three_workflows_and_responsive_surfaces() -> None:
    text = source()

    required = [
        'setActiveWorkflow("finished")',
        'setActiveWorkflow("materials")',
        'setActiveWorkflow("auto")',
        "Phiếu xuất thành phẩm",
        "Phiếu xuất nguyên vật liệu",
        "PXK tự động từ phiếu nhập",
        'data-testid="auto-issue-mobile-list"',
        'data-testid="auto-issue-desktop-table"',
        "md:hidden",
        "hidden overflow-x-auto",
    ]
    for marker in required:
        assert marker in text, f"missing workflow/responsive contract marker: {marker}"
