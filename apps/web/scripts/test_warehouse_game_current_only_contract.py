#!/usr/bin/env python3
"""Static contract: only the current warehouse game remains (owner 21/10/2026).

Never connects to anything. The owner removed the old Kho 2D game, the 3D game,
Kho văn phòng and the in-game missions ("Xoá hết, kể cả Nhiệm vụ"), keeping only
KhoGame (/warehouse/game: Danh mục + Kiểm kê) and WarehouseSlips (/warehouse/phieu).
It guards that:
  * the old game, office, 3D and mission sources stay deleted;
  * /warehouse/game renders KhoGame directly (no ?ban=cu switch) and
    /warehouse/office only redirects to it;
  * no source imports three.js and package.json has no three.js dependency;
  * the remaining game sources keep the robot Sushi out (owner 21/10).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
GAME = SRC / "game"
ROUTES = SRC / "components" / "AppRoutes.tsx"
SIDEBAR = SRC / "components" / "layout" / "Sidebar.tsx"
NAVIGATION = SRC / "components" / "layout" / "navigation.ts"
KHO_GAME = SRC / "pages" / "KhoGame.tsx"
SLIPS = SRC / "pages" / "WarehouseSlips.tsx"

REMOVED_FILES = (
    SRC / "pages" / "WarehouseGame.tsx",
    SRC / "pages" / "WarehouseOffice.tsx",
    GAME / "three",
    GAME / "office",
    GAME / "Warehouse.tsx",
    GAME / "Workshop.tsx",
    GAME / "Stations.tsx",
    GAME / "CrateYard.tsx",
    GAME / "Missions.tsx",
    GAME / "ManualMissions.tsx",
    GAME / "LinkQuest.tsx",
    GAME / "StockCount.tsx",
    GAME / "DeliveryGate.tsx",
    SRC / "hooks" / "useMissions.ts",
    SRC / "hooks" / "useManualMissions.ts",
    SRC / "hooks" / "useRobotOrder.ts",
    SRC / "lib" / "missions.ts",
    SRC / "lib" / "manual-missions.ts",
    GAME / "RobotAutoPanel.tsx",
    GAME / "LowStock.tsx",
    SRC / "hooks" / "useRobotActions.ts",
    SRC / "lib" / "robot-actions.ts",
)
THREE_DEPS = ("three", "@react-three/fiber", "@react-three/drei", "@types/three")
THREE_IMPORT = re.compile(r"""from\s+["'](three|@react-three/[^"']+)["']|import\(\s*["'](three|@react-three/[^"']+)["']""")
OLD_NAMES = ("WarehouseGameEntry", "pages/WarehouseGame", "pages/WarehouseOffice", "game/three", "game/office", "ban=cu")
FORBIDDEN = (
    "Sushi",
    "JevBot",
    "StockBot",
    "SushiMachine",
    "RobotAutoPanel",
    "LowStockSheet",
    "data-bmq-stock-bot",
    "data-bmq-jev-run",
    "data-bmq-sushi-machine",
    "jev-stage",
    "jev-bot",
    "robot-auto",
)


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    for path in REMOVED_FILES:
        assert_true(not path.exists(), f"{path.relative_to(ROOT)} must stay deleted")

    routes = ROUTES.read_text(encoding="utf-8")
    assert_true('lazy(() => import("@/pages/KhoGame"))' in routes, "AppRoutes must lazy-load KhoGame")
    game_route = next((line for line in routes.splitlines() if 'path="/warehouse/game"' in line), "")
    assert_true("<KhoGame />" in game_route, "/warehouse/game must render KhoGame directly")
    office_route = next((line for line in routes.splitlines() if 'path="/warehouse/office"' in line), "")
    assert_true('<Navigate to="/warehouse/game" replace />' in office_route, "/warehouse/office must redirect to the game")

    for path in [*SRC.rglob("*.ts"), *SRC.rglob("*.tsx")]:
        text = path.read_text(encoding="utf-8")
        assert_true(THREE_IMPORT.search(text) is None, f"{path.relative_to(ROOT)} still imports three.js")
        for name in OLD_NAMES:
            assert_true(name not in text, f"{path.relative_to(ROOT)} still references {name!r}")

    for path in (SIDEBAR, NAVIGATION):
        assert_true("/warehouse/office" not in path.read_text(encoding="utf-8"), f"{path.name} must not list /warehouse/office")

    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    for section in ("dependencies", "devDependencies"):
        for dep in THREE_DEPS:
            assert_true(dep not in package.get(section, {}), f"package.json {section} still has {dep}")
    lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    for dep in THREE_DEPS:
        assert_true(f"node_modules/{dep}" not in lock.get("packages", {}), f"package-lock.json still has {dep}")

    kho = KHO_GAME.read_text(encoding="utf-8")
    assert_true('from "@/game/CrateSheet"' in kho and 'from "@/game/crate"' in kho, "KhoGame uses the moved CrateSheet + crateKey")

    sources = [p for p in GAME.rglob("*") if p.suffix in {".ts", ".tsx", ".css"}] + [KHO_GAME, SLIPS]
    for path in sources:
        text = path.read_text(encoding="utf-8")
        for token in FORBIDDEN:
            assert_true(token not in text, f"{path.relative_to(ROOT)} still contains {token!r}")
    sheet = (GAME / "CrateSheet.tsx").read_text(encoding="utf-8")
    assert_true("crate.jev_" not in sheet, "label sheet must not offer Jev picks")

    print("PASS: only the current warehouse game remains")


if __name__ == "__main__":
    main()
