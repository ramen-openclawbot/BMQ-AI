#!/usr/bin/env python3
"""Static contract: every OpenAI image-scan function reads one shared model.

Checks (no network, no deploy):
  1. _shared/openai-models.ts exports OPENAI_SCAN_MODEL and defaults to gpt-4.1-mini.
  2. No scan function or _shared/bank-slip-ocr.ts still hardcodes gpt-4o / gpt-4o-mini.
  3. Each scan function imports the shared model (directly or via bank-slip-ocr.ts)
     and uses OPENAI_SCAN_MODEL.
  4. kb-suggest-po-rules no longer reads OPENAI_MODEL.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

FUNCTIONS = ROOT / "supabase/functions"

SCAN_FUNCTIONS = {
    "scan-purchase-order": FUNCTIONS / "scan-purchase-order/index.ts",
    "scan-invoice": FUNCTIONS / "scan-invoice/index.ts",
    "scan-bank-slip": FUNCTIONS / "scan-bank-slip/index.ts",
    "scan-product-label": FUNCTIONS / "scan-product-label/index.ts",
    "scan-sku-cost-sheet": FUNCTIONS / "scan-sku-cost-sheet/index.ts",
    "match-delivery-note": FUNCTIONS / "match-delivery-note/index.ts",
    "kb-suggest-po-rules": FUNCTIONS / "kb-suggest-po-rules/index.ts",
    "production-material-issue-check": FUNCTIONS / "production-material-issue-check/index.ts",
}

SHARED_MODEL_FILE = FUNCTIONS / "_shared/openai-models.ts"
BANK_SLIP_OCR = FUNCTIONS / "_shared/bank-slip-ocr.ts"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    # 1. The shared model file defines the default and the env override.
    model_text = read(SHARED_MODEL_FILE)
    assert_true("OPENAI_SCAN_MODEL" in model_text, "openai-models.ts must export OPENAI_SCAN_MODEL")
    assert_true("gpt-4.1-mini" in model_text, "openai-models.ts must default to gpt-4.1-mini")
    assert_true(
        'Deno.env.get("OPENAI_SCAN_MODEL")' in model_text,
        "openai-models.ts must read the OPENAI_SCAN_MODEL secret",
    )

    # 2./3. Every scan file uses the shared model and keeps no hardcoded gpt-4o.
    bank_slip_text = read(BANK_SLIP_OCR)
    all_files = dict(SCAN_FUNCTIONS)
    all_files["_shared/bank-slip-ocr"] = BANK_SLIP_OCR

    for name, path in all_files.items():
        text = read(path)
        imports_directly = "openai-models" in text
        imports_via_bank_slip = "bank-slip-ocr" in text and "openai-models" in bank_slip_text
        assert_true(
            imports_directly or imports_via_bank_slip,
            f"{name} must import _shared/openai-models.ts (directly or via bank-slip-ocr.ts)",
        )
        assert_true("OPENAI_SCAN_MODEL" in text, f"{name} must use OPENAI_SCAN_MODEL")
        assert_true("gpt-4o" not in text, f"{name} must not hardcode gpt-4o")
        assert_true("gpt-4o-mini" not in text, f"{name} must not hardcode gpt-4o-mini")

    # 4. kb-suggest-po-rules stopped reading its own OPENAI_MODEL secret.
    kb_text = read(SCAN_FUNCTIONS["kb-suggest-po-rules"])
    assert_true("OPENAI_MODEL" not in kb_text, "kb-suggest-po-rules must not read OPENAI_MODEL")

    print("PASS: all OpenAI image scans use the shared OPENAI_SCAN_MODEL (default gpt-4.1-mini)")


if __name__ == "__main__":
    main()
