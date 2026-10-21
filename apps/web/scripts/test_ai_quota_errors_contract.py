#!/usr/bin/env python3
"""Static contract: every AI-reading edge function reports quota exhaustion.

Checks (no network, no deploy):
  1. Every direct OpenAI caller imports/uses classifyOpenAIError + aiErrorJson.
  2. Every caller that goes through _shared/bank-slip-ocr.ts (or cash-receipt-ocr)
     recovers the classified code through getAiErrorInfo and returns 503 for quota.
  3. The shared OCR modules use the classifier.
  4. No edge function still returns the bare "Rate limit exceeded" OpenAI text.
  5. The internal ai_function_rate_limits daily limiter is untouched.
  6. lib/fetch-with-timeout.ts recognizes the quota code via notifyAiQuotaExhausted.
  7. AddPurchaseOrderDialog reads event.currentTarget before any await.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

FUNCTIONS = ROOT / "supabase/functions"

TARGET_FUNCTIONS = {
    "scan-purchase-order": FUNCTIONS / "scan-purchase-order/index.ts",
    "scan-invoice": FUNCTIONS / "scan-invoice/index.ts",
    "scan-bank-slip": FUNCTIONS / "scan-bank-slip/index.ts",
    "scan-product-label": FUNCTIONS / "scan-product-label/index.ts",
    "scan-sku-cost-sheet": FUNCTIONS / "scan-sku-cost-sheet/index.ts",
    "match-delivery-note": FUNCTIONS / "match-delivery-note/index.ts",
    "finance-extract-slip-amount": FUNCTIONS / "finance-extract-slip-amount/index.ts",
    "production-material-issue-check": FUNCTIONS / "production-material-issue-check/index.ts",
    "kb-suggest-po-rules": FUNCTIONS / "kb-suggest-po-rules/index.ts",
    "payment-cash-settle": FUNCTIONS / "payment-cash-settle/index.ts",
    "payment-unc-approve": FUNCTIONS / "payment-unc-approve/index.ts",
    "salary-payout": FUNCTIONS / "salary-payout/index.ts",
}

# Functions with their own provider HTTP call. production-material-issue-check stays
# on OpenAI until its signed PDF is sent to DeepSeek as page images.
DIRECT_OPENAI = [
    "scan-purchase-order",
    "scan-invoice",
    "scan-bank-slip",
    "scan-product-label",
    "scan-sku-cost-sheet",
    "match-delivery-note",
    "kb-suggest-po-rules",
    "production-material-issue-check",
]

# Functions that read images through the shared OCR helpers.
SHARED_OCR = [
    "finance-extract-slip-amount",
    "payment-cash-settle",
    "payment-unc-approve",
    "salary-payout",
]

# Functions that still enforce the internal per-user daily limiter.
INTERNAL_RATE_LIMITED = [
    "scan-purchase-order",
    "scan-invoice",
    "scan-bank-slip",
    "scan-sku-cost-sheet",
    "match-delivery-note",
    "kb-suggest-po-rules",
    "finance-extract-slip-amount",
]

QUOTA_CODE = "ai_quota_exhausted"
QUOTA_MESSAGE = (
    "Dịch vụ đọc ảnh AI đã hết hạn mức. Báo quản trị nạp thêm — vẫn có thể nhập tay."
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    texts = {name: read(path) for name, path in TARGET_FUNCTIONS.items()}

    # 1. Direct OpenAI callers classify the body before returning.
    for name in DIRECT_OPENAI:
        text = texts[name]
        assert_true("classifyOpenAIError" in text, f"{name} must import/use classifyOpenAIError")
        assert_true("aiErrorJson" in text, f"{name} must return aiErrorJson(error body)")
        assert_true("slice(0, 300)" in text, f"{name} must log at most 300 body chars")

    # 2. Shared-OCR callers recover the classified code.
    for name in SHARED_OCR:
        text = texts[name]
        assert_true(
            "/bank-slip-ocr" in text or "/cash-receipt-ocr" in text,
            f"{name} must read images through the shared OCR helpers",
        )
        assert_true("getAiErrorInfo" in text, f"{name} must recover the classified AI error code")
        assert_true("aiErrorJson" in text, f"{name} must return the classified error body")
    # The OCR-credential flows must surface quota as its own 503 branch.
    for name in ("payment-cash-settle", "payment-unc-approve", "salary-payout"):
        assert_true(QUOTA_CODE in texts[name], f"{name} must branch on {QUOTA_CODE}")

    # 3. Shared OCR helpers use the classifier.
    bank_slip = read(FUNCTIONS / "_shared/bank-slip-ocr.ts")
    cash_receipt = read(FUNCTIONS / "_shared/cash-receipt-ocr.ts")
    assert_true("classifyOpenAIError" in bank_slip, "bank-slip-ocr.ts must use classifyOpenAIError")
    assert_true("AiOpenAIError" in bank_slip, "bank-slip-ocr.ts must throw the classified error")
    assert_true("classifyOpenAIError" in cash_receipt, "cash-receipt-ocr.ts must use classifyOpenAIError")

    helper = read(FUNCTIONS / "_shared/openai-errors.ts")
    assert_true("classifyOpenAIError" in helper, "openai-errors.ts must export classifyOpenAIError")
    assert_true("export function aiErrorJson" in helper, "openai-errors.ts must export aiErrorJson")
    assert_true(QUOTA_CODE in helper, "openai-errors.ts must define the quota code")
    assert_true("insufficient_quota" in helper, "openai-errors.ts must detect insufficient_quota")
    assert_true("billing_hard_limit" in helper, "openai-errors.ts must detect billing_hard_limit")
    assert_true(QUOTA_MESSAGE in helper, "openai-errors.ts must use the agreed Vietnamese quota message")

    # 4. No bare OpenAI "Rate limit exceeded" response left in the target functions.
    for name, text in texts.items():
        assert_true(
            "Rate limit exceeded. Please try again later." not in text,
            f"{name} must not return the bare 'Rate limit exceeded' message for OpenAI errors",
        )

    # 5. Internal ai_function_rate_limits limiter is preserved.
    limiter = read(FUNCTIONS / "_shared/rate-limiter.ts")
    assert_true("ai_function_rate_limits" in limiter, "internal ai_function_rate_limits limiter must remain")
    for name in INTERNAL_RATE_LIMITED:
        assert_true(
            "checkAndRecordRateLimit" in texts[name],
            f"{name} must keep the internal ai_function_rate_limits limiter",
        )

    # 6. The shared client caller surfaces the quota toast.
    fetch_timeout = read(ROOT / "src/lib/fetch-with-timeout.ts")
    assert_true("notifyAiQuotaExhausted" in fetch_timeout, "fetch-with-timeout.ts must notify on quota")
    assert_true("isAiQuotaError" in fetch_timeout, "fetch-with-timeout.ts must detect quota errors")
    assert_true("code?" in fetch_timeout, "EdgeFunctionResponse must expose a code field")

    ai_errors = read(ROOT / "src/lib/ai-errors.ts")
    assert_true(QUOTA_CODE in ai_errors, "ai-errors.ts must define the quota code")
    assert_true("id: \"ai-quota\"" in ai_errors, "ai-errors.ts must use the single ai-quota toast id")
    assert_true("duration: Infinity" in ai_errors, "quota toast must never auto-hide")
    assert_true("closeButton: true" in ai_errors, "quota toast must be closable")
    assert_true("position: \"top-center\"" in ai_errors, "quota toast must be top-center")

    # 7. AddPurchaseOrderDialog must capture the input before any await.
    dialog = read(ROOT / "src/components/dialogs/AddPurchaseOrderDialog.tsx")
    start = dialog.index("const handleImageUpload = async")
    end = dialog.index("const handleRemoveImage")
    body = dialog[start:end]
    first_await = body.index("await")
    assert_true(
        "const input = event.currentTarget" in body[:first_await],
        "AddPurchaseOrderDialog must capture event.currentTarget before await",
    )
    assert_true(
        body[first_await:].count("event.currentTarget") == 0,
        "AddPurchaseOrderDialog must not read event.currentTarget after await",
    )
    assert_true('input.value = ""' in body, "AddPurchaseOrderDialog must reset the captured input")

    print("PASS: every OpenAI scan edge function classifies quota exhaustion and the client shows one ai-quota toast")


if __name__ == "__main__":
    main()
