#!/usr/bin/env python3
"""Regression checks for CEO daily bank slip extraction.

These checks are intentionally static and do not call OpenAI/Supabase. They guard
that CEO-uploaded UNC/QTM slips use the same OpenAI Vision edge function as the
Drive UNC flow, and that the old PaddleOCR path is not reintroduced.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FINANCE_PAGE = ROOT / "src/pages/FinanceControl.tsx"
FOLDER_SCAN = ROOT / "src/hooks/useFolderScan.ts"
EXTRACT_FN = ROOT / "supabase/functions/finance-extract-slip-amount/index.ts"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    finance_page = read(FINANCE_PAGE)
    folder_scan = read(FOLDER_SCAN)
    extract_fn = read(EXTRACT_FN)
    combined = "\n".join([finance_page, folder_scan, extract_fn]).lower()

    assert_true("paddle" not in combined, "PaddleOCR/Paddle backend must not appear in CEO/UNC slip flow")
    assert_true("https://api.openai.com/v1/chat/completions" in extract_fn, "edge function must call OpenAI Vision")
    assert_true("provider: \"openai\"" in extract_fn, "edge function must tag extraction provider as openai")
    assert_true("finance-extract-slip-amount" in finance_page, "CEO upload must call finance-extract-slip-amount")
    assert_true("finance-extract-slip-amount" in folder_scan, "Drive UNC/QTM flow must call finance-extract-slip-amount")
    assert_true("scan-bank-slip" not in finance_page, "CEO upload must not call legacy scan-bank-slip endpoint")
    assert_true("slipType" in finance_page and "slipType" in folder_scan, "both CEO and Drive flows must pass slipType")
    assert_true("OpenAI Vision" in finance_page, "CEO upload UI/errors should identify OpenAI Vision provider")
    assert_true("insufficient_quota" in extract_fn, "edge function must preserve explicit OpenAI insufficient_quota errors")
    assert_true("OpenAI rate limit" in extract_fn, "edge function must distinguish generic OpenAI 429 rate limits from insufficient_quota")

    print("PASS: CEO bank slip upload and UNC Drive slip flow use OpenAI Vision only")


if __name__ == "__main__":
    main()
