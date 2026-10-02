"""Demo 3 app drawer (the former sidebar): readable, touch-sized, keeps its scroll position."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SIDEBAR = (ROOT / "src/components/layout/Sidebar.tsx").read_text(encoding="utf-8")
CSS = (ROOT / "src/styles/bmq-shell.css").read_text(encoding="utf-8")


def css_block(selector: str) -> str:
    return CSS.split(selector + " {", 1)[1].split("}", 1)[0]


required_tokens = [
    'data-bmq-app-drawer="demo3-v1"',
    'SIDEBAR_SCROLL_STORAGE_KEY = "bmq-sidebar-scroll-top"',
    'restoreSidebarScroll',
    '[data-sidebar-active="true"], [aria-current="page"]',
    'onScroll={rememberSidebarScroll}',
    'data-sidebar-active={childActive ? "true" : undefined}',
    'window.addEventListener("bmq:open-sidebar", openSidebar);',
    'onCloseAutoFocus=',
]
missing = [token for token in required_tokens if token not in SIDEBAR]
assert not missing, f"Missing app drawer markers: {missing}"

# Touch targets and readable text: links >= 42px, 14px, dark ink on the light panel.
link = css_block(".d3-drawer-link")
assert "min-height: 42px;" in link
assert "font-size: 14px;" in link
assert "color: var(--d3-ink-2);" in link
assert "width: min(360px, calc(100vw - 16px));" in css_block(".d3-drawer")

# The retired white-on-glass mobile rail must not come back.
forbidden = ["drop-shadow-[0_1px_1px_rgba(0,0,0,0.55)]", "text-[13px] font-bold text-white", "bg-sidebar/70"]
present = [token for token in forbidden if token in SIDEBAR]
assert not present, f"Old sidebar rail classes came back: {present}"

print("app drawer readable/touch-size/scroll-memory guard passed")
