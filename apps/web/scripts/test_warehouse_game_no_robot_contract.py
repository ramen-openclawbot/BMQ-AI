#!/usr/bin/env python3
"""Static contract: the warehouse game (Kho 2D/3D) has no robot Sushi (owner 21/10).

Never connects to anything. It guards that the game sources keep the robot out:
no JevBot / StockBot / SushiMachine / RobotAutoPanel / LowStockSheet, no "Sushi"
text, no crate-yard classify run and no "Sushi rà soát" station, while the
ordering machine ("Máy đặt hàng tự động") and the manual crate labelling stay.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
GAME = SRC / "game"
PAGES = (SRC / "pages" / "WarehouseGame.tsx", SRC / "pages" / "WarehouseOffice.tsx")

REMOVED_FILES = (
    GAME / "RobotAutoPanel.tsx",
    GAME / "LowStock.tsx",
    SRC / "hooks" / "useRobotActions.ts",
    SRC / "lib" / "robot-actions.ts",
)
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

    sources = [p for p in GAME.rglob("*") if p.suffix in {".ts", ".tsx", ".css"}] + list(PAGES)
    for path in sources:
        text = path.read_text(encoding="utf-8")
        for token in FORBIDDEN:
            assert_true(token not in text, f"{path.relative_to(ROOT)} still contains {token!r}")

    workshop = (GAME / "Workshop.tsx").read_text(encoding="utf-8")
    assert_true('"jev"' not in workshop and "jev:" not in workshop, "Workshop must not keep the jev station")

    crate_yard = (GAME / "CrateYard.tsx").read_text(encoding="utf-8")
    assert_true("jev_item_id" not in crate_yard and "onRunJev" not in crate_yard, "crate yard must not show or run Jev picks")
    assert_true("strongCandidate" in crate_yard and "data-bmq-crate=" in crate_yard, "crate yard keeps manual labelling")

    game_page = PAGES[0].read_text(encoding="utf-8")
    assert_true("low-stock" not in game_page and "useRunAliasBacklog" not in game_page, "game page must not wire the robots")
    assert_true("crate.jev_" not in game_page, "label sheet must not offer Jev picks")

    for path in (GAME / "Warehouse.tsx", GAME / "three" / "Warehouse3D.tsx"):
        text = path.read_text(encoding="utf-8")
        assert_true("Máy đặt hàng tự động" in text and "data-bmq-order-machine" in text, f"{path.name} keeps the ordering machine")

    office = PAGES[1].read_text(encoding="utf-8")
    assert_true("data-office-jev" in office and "AI rà phiếu cũ" in office, "office keeps the supplier review, labelled AI")

    print("PASS: warehouse game has no robot Sushi")


if __name__ == "__main__":
    main()
