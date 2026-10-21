#!/usr/bin/env python3
"""Static contract: the Kho pages use the app theme; the game screen is gone (owner 21–22/10/2026).

Never connects to anything. The owner removed the old Kho 2D/3D game, Kho văn phòng and the in-game
missions (21/10), then asked to move the remaining Game kho screen back into the app theme with every
feature kept and the game look removed (22/10: "thay toàn bộ trang kho từ game quay lại trang theo theme
của app ... Giao diện game sau đó gỡ bỏ luôn"). It guards that:
  * src/game and every old game page stay deleted, and nothing imports them;
  * Danh mục kho, Kiểm kê and Phiếu kho render inside the app shell, and old game links redirect;
  * the Kho menu names the three pages, not "Game kho";
  * no game font, zoom guard, emoji or robot text comes back on the Kho pages;
  * three.js stays out of the sources and package.json.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
ROUTES = SRC / "components" / "AppRoutes.tsx"
SIDEBAR = SRC / "components" / "layout" / "Sidebar.tsx"
NAVIGATION = SRC / "components" / "layout" / "navigation.ts"
PAGES = {
    "KhoCatalog": SRC / "pages" / "KhoCatalog.tsx",
    "KhoCount": SRC / "pages" / "KhoCount.tsx",
    "WarehouseSlips": SRC / "pages" / "WarehouseSlips.tsx",
}
KHO_PARTS = SRC / "components" / "kho"
KHO_CSS = SRC / "styles" / "bmq-kho.css"

REMOVED = (
    SRC / "game",
    SRC / "pages" / "KhoGame.tsx",
    SRC / "pages" / "WarehouseGame.tsx",
    SRC / "pages" / "WarehouseOffice.tsx",
    SRC / "hooks" / "useMissions.ts",
    SRC / "hooks" / "useManualMissions.ts",
    SRC / "hooks" / "useRobotOrder.ts",
    SRC / "hooks" / "useRobotActions.ts",
    SRC / "lib" / "missions.ts",
    SRC / "lib" / "manual-missions.ts",
    SRC / "lib" / "robot-actions.ts",
)
THREE_DEPS = ("three", "@react-three/fiber", "@react-three/drei", "@types/three")
THREE_IMPORT = re.compile(r"""from\s+["'](three|@react-three/[^"']+)["']|import\(\s*["'](three|@react-three/[^"']+)["']""")
GAME_IMPORT = re.compile(r"""["']@/game/|["']\.\./game/|pages/KhoGame|GamePicker|usePageZoomGuard|askGame|GameLoading""")
EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿⭐️]")
KHO_FORBIDDEN = ("Sushi", "Game kho", "Baloo", "Nunito", "kg-fonts", "data-bmq-warehouse-game", "className=\"kg", "k2-")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def route_line(routes: str, path: str) -> str:
    return next((line for line in routes.splitlines() if f'path="{path}"' in line), "")


def main() -> None:
    for path in REMOVED:
        assert_true(not path.exists(), f"{path.relative_to(ROOT)} must stay deleted")

    for path in [*SRC.rglob("*.ts"), *SRC.rglob("*.tsx")]:
        text = path.read_text(encoding="utf-8")
        assert_true(THREE_IMPORT.search(text) is None, f"{path.relative_to(ROOT)} still imports three.js")
        assert_true(GAME_IMPORT.search(text) is None, f"{path.relative_to(ROOT)} still uses the game code")

    routes = ROUTES.read_text(encoding="utf-8")
    for name in PAGES:
        assert_true(f'lazy(() => import("@/pages/{name}"))' in routes, f"AppRoutes must lazy-load {name}")
    for path, name in (("/warehouse/danh-muc", "KhoCatalog"), ("/warehouse/kiem-ke", "KhoCount"), ("/warehouse/phieu", "WarehouseSlips")):
        line = route_line(routes, path)
        assert_true(f"<{name} />" in line and 'moduleKey="inventory"' in line, f"{path} must render {name} behind the inventory module")
        assert_true("<ProtectedRoute>" not in line, f"{path} must sit inside the app shell (AppLayout), not full screen")
    for path in ("/warehouse/game", "/warehouse/office"):
        assert_true('<Navigate to="/warehouse/danh-muc" replace />' in route_line(routes, path), f"{path} must redirect to Danh mục kho")

    sidebar = SIDEBAR.read_text(encoding="utf-8")
    assert_true('labelKey: "khoCatalog", path: "/warehouse/danh-muc"' in sidebar, "menu has Danh mục kho")
    assert_true('labelKey: "khoCount", path: "/warehouse/kiem-ke"' in sidebar, "menu has Kiểm kê")
    assert_true("warehouseGame" not in sidebar and "/warehouse/game" not in sidebar, "menu has no Game kho")
    navigation = NAVIGATION.read_text(encoding="utf-8")
    for path in ("/warehouse/danh-muc", "/warehouse/kiem-ke", "/warehouse/phieu"):
        assert_true(f'"{path}"' in navigation, f"Kho zone lists {path}")
    assert_true('"/warehouse/game"' not in navigation, "Kho zone does not list the game")
    language = (SRC / "contexts" / "LanguageContext.tsx").read_text(encoding="utf-8")
    assert_true('khoCatalog: "Danh mục kho"' in language and 'khoCount: "Kiểm kê"' in language, "Vietnamese menu labels")
    assert_true("Game kho" not in language, "no Game kho label")

    kho_sources = [*PAGES.values(), *KHO_PARTS.glob("*.ts*"), KHO_CSS]
    for path in kho_sources:
        text = path.read_text(encoding="utf-8")
        for token in KHO_FORBIDDEN:
            assert_true(token not in text, f"{path.relative_to(ROOT)} still contains {token!r}")
        if path.suffix == ".tsx":
            found = EMOJI.search(text)
            assert_true(found is None, f"{path.relative_to(ROOT)} has an emoji {found.group(0) if found else ''!r}")
    for name, path in PAGES.items():
        text = path.read_text(encoding="utf-8")
        assert_true('import "@/styles/bmq-kho.css";' in text, f"{name} loads the Kho app styles")
        assert_true('className="d3-wh d3-kho' in text, f"{name} uses the warehouse page kit")
    css = KHO_CSS.read_text(encoding="utf-8")
    assert_true("@media (prefers-reduced-motion: reduce)" in css, "Kho motion has a reduced-motion fallback")
    assert_true("font-size: 16px" in css, "phone fields are 16px so iOS does not zoom")

    for path in (
        SRC / "components" / "stock-routing" / "StockRoutingCards.tsx",
        SRC / "components" / "material-alias" / "NewItemSuggestions.tsx",
        SRC / "components" / "material-alias" / "AliasBacklogReview.tsx",
        SRC / "pages" / "StockCatalogCleanup.tsx",
    ):
        assert_true('import { OptionPicker } from "@/components/OptionPicker";' in path.read_text(encoding="utf-8"), f"{path.name} uses the app OptionPicker")

    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    for section in ("dependencies", "devDependencies"):
        for dep in THREE_DEPS:
            assert_true(dep not in package.get(section, {}), f"package.json {section} still has {dep}")

    print("PASS: Kho pages use the app theme; the game screen is gone")


if __name__ == "__main__":
    main()
