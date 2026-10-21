#!/usr/bin/env python3
"""Static contract: every image-scan function takes endpoint/key/model from one provider module.

Checks (no network, no deploy):
  1. _shared/ai-vision-provider.ts defines SCAN_AI_PROVIDER plus the DeepSeek
     endpoint/key/model (deepseek-flash, api.deepseek.com, DEEPSEEK_API_KEY).
  2. Every target scan function, _shared/bank-slip-ocr.ts and
     production-material-issue-check use the shared DeepSeek configuration; no
     function hardcodes api.openai.com.
  3. Every target imports ai-vision-provider.ts (directly or via bank-slip-ocr.ts)
     and reads its config through getScanAiConfig().
  4. production-material-issue-check uses callDeepSeekJson through the shared
     getScanAiConfig("deepseek") provider.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

FUNCTIONS = ROOT / "supabase/functions"

SHARED_PROVIDER = FUNCTIONS / "_shared/ai-vision-provider.ts"
BANK_SLIP_OCR = FUNCTIONS / "_shared/bank-slip-ocr.ts"
PRODUCTION_MATERIAL_ISSUE_CHECK = FUNCTIONS / "production-material-issue-check/index.ts"

SCAN_FUNCTIONS = {
    "scan-purchase-order": FUNCTIONS / "scan-purchase-order/index.ts",
    "scan-invoice": FUNCTIONS / "scan-invoice/index.ts",
    "scan-bank-slip": FUNCTIONS / "scan-bank-slip/index.ts",
    "scan-product-label": FUNCTIONS / "scan-product-label/index.ts",
    "scan-sku-cost-sheet": FUNCTIONS / "scan-sku-cost-sheet/index.ts",
    "match-delivery-note": FUNCTIONS / "match-delivery-note/index.ts",
    "kb-suggest-po-rules": FUNCTIONS / "kb-suggest-po-rules/index.ts",
}


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    # 1. The shared provider module defines the DeepSeek switch and defaults.
    provider_text = read(SHARED_PROVIDER)
    for marker in ("SCAN_AI_PROVIDER", "deepseek-flash", "api.deepseek.com", "DEEPSEEK_API_KEY"):
        assert_true(marker in provider_text, f"ai-vision-provider.ts must mention {marker}")
    assert_true("getScanAiConfig" in provider_text, "ai-vision-provider.ts must export getScanAiConfig")
    assert_true("api.openai.com" not in provider_text, "ai-vision-provider.ts must not expose an OpenAI endpoint")
    assert_true("OPENAI_API_KEY" not in provider_text, "ai-vision-provider.ts must not read OPENAI_API_KEY")

    # 2./3. Every scan file goes through the provider module and drops the hardcoded URL.
    bank_slip_text = read(BANK_SLIP_OCR)
    assert_true("api.openai.com" not in bank_slip_text, "bank-slip-ocr.ts must not hardcode api.openai.com")
    assert_true("getScanAiConfig" in bank_slip_text, "bank-slip-ocr.ts must use getScanAiConfig")
    assert_true("ai-vision-provider" in bank_slip_text, "bank-slip-ocr.ts must import ai-vision-provider.ts")
    assert_true("scanAi.extraBody" in bank_slip_text, "bank-slip-ocr.ts must spread scanAi.extraBody")
    assert_true('thinking: { type: "disabled" }' in provider_text, "DeepSeek requests must disable thinking")

    for name, path in SCAN_FUNCTIONS.items():
        text = read(path)
        assert_true("api.openai.com" not in text, f"{name} must not hardcode api.openai.com")
        if "ai-vision-provider" in text:
            assert_true("scanAi.extraBody" in text, f"{name} must spread scanAi.extraBody (DeepSeek thinking off)")
        imports_directly = "ai-vision-provider" in text and "getScanAiConfig" in text
        imports_via_bank_slip = "bank-slip-ocr" in text and "getScanAiConfig" in bank_slip_text
        assert_true(
            imports_directly or imports_via_bank_slip,
            f"{name} must import ai-vision-provider.ts (directly or via bank-slip-ocr.ts)",
        )

    # 4. The signed-PDF material-issue check stays on OpenAI until it sends page images
    #    (DeepSeek rejects application/pdf, live probe 21/10).
    pmic_text = read(PRODUCTION_MATERIAL_ISSUE_CHECK)
    assert_true("api.openai.com" in pmic_text, "production-material-issue-check keeps the OpenAI endpoint for now")
    assert_true("OPENAI_SCAN_MODEL" in pmic_text, "production-material-issue-check keeps OPENAI_SCAN_MODEL for now")

    print("PASS: every scan function reads endpoint/key/model from _shared/ai-vision-provider.ts (DeepSeek by default)")


if __name__ == "__main__":
    main()
