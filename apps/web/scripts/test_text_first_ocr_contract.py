#!/usr/bin/env python3
"""Static contract for the text-first scan pipeline (Indra OCR + DeepSeek text).

Checks (no network, no deploy):
  1. text-first-extract.ts gets its DeepSeek config from getScanAiConfig and
     rethrows quota errors instead of falling back to the image.
  2. indra-ocr.ts enables Indra only when SCAN_OCR_ENGINE is exactly "indra"
     after trim/lowercase.
  3. No console.log in the two new shared files prints document text, markdown
     or the token.
  4. scan-product-label does not import text-first-extract.ts.
  5. Each of the six text-document scan entry points imports runTextFirst
     (directly or through its extract.ts model layer).
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS = ROOT / "supabase/functions"
SHARED = FUNCTIONS / "_shared"

TEXT_FIRST = SHARED / "text-first-extract.ts"
INDRA_CLIENT = SHARED / "indra-ocr.ts"
PRODUCT_LABEL = FUNCTIONS / "scan-product-label/index.ts"

# Six text-document scan entry points. The model layer may live in extract.ts.
ENTRY_POINTS = {
    "bank/UNC/cash/salary slips": SHARED / "bank-slip-ocr.ts",
    "scan-purchase-order": FUNCTIONS / "scan-purchase-order/index.ts",
    "scan-invoice": FUNCTIONS / "scan-invoice/index.ts",
    "scan-bank-slip": FUNCTIONS / "scan-bank-slip/index.ts",
    "match-delivery-note": FUNCTIONS / "match-delivery-note/index.ts",
    "suggest-stock-item-name": FUNCTIONS / "suggest-stock-item-name/index.ts",
}

FORBIDDEN_LOG_CONTENT = ("markdown", "token", "ocr.text", "page.text", "usercontent", "document text")


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def source_with_extract(path: Path) -> str:
    text = read(path)
    moved = path.parent / "extract.ts"
    if moved.exists():
        text += "\n" + read(moved)
    return text


def main() -> None:
    text_first = read(TEXT_FIRST)
    assert_true("getScanAiConfig" in text_first, "text-first-extract.ts must use getScanAiConfig")
    assert_true("classifyOpenAIError" in text_first, "text-first-extract.ts must classify provider errors")
    assert_true("isQuotaError" in text_first, "text-first-extract.ts must detect quota errors")
    assert_true("if (isQuotaError(error)) throw error;" in text_first, "quota errors must be rethrown, not retried on the image")
    assert_true("temperature: 0" in text_first, "the text model request must use temperature 0")
    assert_true("tool_choice" in text_first, "the text model request must force a tool call")

    indra = read(INDRA_CLIENT)
    assert_true('rawEngine === "indra"' in indra, "indra-ocr.ts must compare the normalized engine to exactly indra")
    assert_true('.trim().toLowerCase()' in indra, "indra-ocr.ts must trim/lowercase SCAN_OCR_ENGINE")
    assert_true('"https:"' in indra and "127.0.0.1" in indra and "localhost" in indra, "indra-ocr.ts must require https or local http")
    assert_true("AbortSignal.timeout" in indra, "indra-ocr.ts must cap requests with AbortSignal.timeout")

    for path in (TEXT_FIRST, INDRA_CLIENT):
        for line_number, line in enumerate(read(path).splitlines(), start=1):
            if "console.log" not in line:
                continue
            lowered = line.lower()
            for forbidden in FORBIDDEN_LOG_CONTENT:
                assert_true(
                    forbidden not in lowered,
                    f"{path.name}:{line_number} console.log must not print {forbidden}",
                )

    label = read(PRODUCT_LABEL)
    assert_true(
        "text-first-extract" not in label and "runTextFirst" not in label,
        "scan-product-label must not use the text-first layer (it needs the image)",
    )

    for name, path in ENTRY_POINTS.items():
        source = source_with_extract(path)
        assert_true("runTextFirst" in source, f"{name} must route through runTextFirst")

    print("PASS: text-first Indra OCR layer is wired behind SCAN_OCR_ENGINE=indra only")


if __name__ == "__main__":
    main()
