#!/usr/bin/env python3
"""Contracts for pre-generating Q7 Phiếu NVL after order writes."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
UI = ROOT / "apps/web/src/pages/ProductionPlanning.tsx"


def test_q7_material_issue_pdf_is_prepared_after_create_and_update() -> None:
    source = UI.read_text(encoding="utf-8")

    assert "prepareQ7MaterialIssuePdf" in source
    assert "production-material-issue-pdf" in source
    assert "production_order_id: orderId" in source
    assert "void prepareQ7MaterialIssuePdf(order.id)" in source
    assert "return orderId" in source
    assert "onSuccess: (orderId)" in source
    assert "void prepareQ7MaterialIssuePdf(orderId)" in source


def test_background_prepare_never_opens_a_window_or_blocks_order_success() -> None:
    source = UI.read_text(encoding="utf-8")
    start = source.index("const prepareQ7MaterialIssuePdf")
    end = source.index("const createProductionOrderMutation", start)
    helper = source[start:end]

    assert "window.open" not in helper
    assert "throw new Error" not in helper
    assert "console.warn" in helper
