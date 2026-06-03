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
    assert_true("amount_in_words" in extract_fn, "edge function must request/read amount words to guard OCR digit-scaling mistakes")
    assert_true("required: [\"amount\", \"amount_in_words\", \"confidence\"]" in extract_fn, "OpenAI schema must require amount_in_words so OCR can be cross-checked")
    assert_true("parseVietnameseAmountWords" in extract_fn, "edge function must parse Vietnamese amount words for mismatch correction")
    assert_true("parseEnglishAmountWords" in extract_fn, "edge function must parse English In Words amount lines for VCB/DigiBiz UNC")
    assert_true("Twenty eight million four hundred eighty thousand" in extract_fn and "28480000" in extract_fn, "edge function must guard the 28,480,000 VND UNC OCR regression")
    assert_true("Math.max(parsedAmount, wordAmount) / Math.min(parsedAmount, wordAmount)" in extract_fn, "edge function must compare numeric OCR amount against amount-in-words in both scale directions")
    assert_true("amount_digit_value" in extract_fn and "amount_word_value" in extract_fn, "corrected OCR/word mismatches must keep digit and word audit values")
    assert_true("Math.min(Number(data.confidence" in extract_fn, "corrected OCR/word mismatches must lower confidence for review")
    assert_true("OCR_CACHE_MIN_PROCESSED_AT" in finance_page, "Drive reconciliation must invalidate stale cached OCR rows after parser hardening")
    assert_true("processed_at" in finance_page and "cacheProcessedAt" in finance_page, "OCR cache lookup must read and validate processed_at before reuse")
    assert_true("!isOcrCacheFresh" in finance_page, "stale OCR cache rows must be reprocessed instead of reused")
    assert_true("enableDeclarationImages" in finance_page, "saved slip images must load without relying on desktop hover")
    assert_true("setImagesRequested(true)" in finance_page, "CEO slip UI must expose an explicit action to load saved slip previews")
    assert_true("deleteDeclaredSlip(\"qtm\", idx)" in finance_page, "QTM previews must expose the declared slip delete action")
    assert_true('data-bmq-mobile-ceo-slip-delete="unc"' in finance_page, "UNC preview delete control must be visible on mobile, not desktop-only")
    assert_true('data-bmq-mobile-ceo-slip-delete="qtm"' in finance_page, "QTM preview delete control must be visible on mobile, not desktop-only")
    assert_true("hidden rounded bg-destructive p-1 text-destructive-foreground shadow-sm md:block" not in finance_page, "CEO slip delete overlay must not be hidden on mobile")
    assert_true("uncOcrPartialFailedHard" in finance_page, "Drive UNC reconciliation must block partial OCR failures, not only total failures")
    assert_true("qtmOcrPartialFailedHard" in finance_page, "Drive QTM reconciliation must block partial OCR failures, not only total failures")
    assert_true("OCR đọc được" in finance_page and "chưa đọc được" in finance_page, "partial OCR failure error must show extracted/failed counts in Vietnamese")
    assert_true("successfulOcrFileIds" in finance_page, "processed markers must distinguish files with successful OCR from failed files")
    assert_true("processed: successfulOcrFileIds.has" in finance_page, "failed OCR files must not be persisted as processed=true")
    assert_true("missingRequiredPreview = hasDeclaredUnc && previewUncFiles === 0" in finance_page, "close preview should treat only missing UNC files as required runtime validation")
    assert_true("qtmCarryForwardPreview = hasDeclaredQtm && previewQtmFiles === 0" in finance_page, "QTM zero-file preview should be informational carry-forward, not a blocking missing-file warning")
    assert_true("shouldRunFolderReconciliation = hasDeclaredUnc || hasDeclaredQtm || previewUncFiles > 0 || previewQtmFiles > 0" in finance_page, "preview-detected UNC/QTM files must force runtime Drive OCR even when CEO declared 0")
    assert_true("const folderScanResult = shouldRunFolderReconciliation" in finance_page, "close-day execution must not skip folder reconciliation when preview found files")
    assert_true("disabled={previewLoading || closeActing || (!!reconcileError && !canCloseWithoutBankSlips)}" in finance_page, "Execute button must remain clickable after quick scan so runtime validation can show the exact missing UNC/QTM error")
    assert_true("Số tiền này sẽ cộng vào quỹ QTM" in finance_page, "QTM zero-file preview must tell users the declared amount carries forward into QTM fund")
    assert_true("QTM declared by CEO is cash added to the QTM fund" in finance_page, "declared QTM must carry forward into QTM balance even when Drive QTM has no same-day files")
    assert_true("!targetUncFiles.length && !targetQtmFiles.length && (hasDeclaredUnc || !hasDeclaredQtm)" in finance_page, "QTM-only declarations with no Drive files must not be rejected by the empty-folder guard")
    assert_true("QTM đã khai báo ${vnd(Number(cashFundTopupAmount || 0))}" not in finance_page, "declared QTM with zero Drive files must not block close-day approval")
    assert_true("hasDeclaredQtm && Number(folderScanResult.qtmFolderTotal || 0) === 0" not in finance_page, "declared QTM with zero scanned total must be treated as no same-day spend, not a hard error")

    assert_true("activeSlipScan" in finance_page, "CEO slip upload must track which input is actively scanning")
    assert_true("activeSlipScanLabel" in finance_page, "CEO slip upload must render an explicit scanning status label")
    assert_true("Đang upload & scan" in finance_page, "CEO slip upload must show visible upload+scan progress copy")
    assert_true("sticky top-2" in finance_page, "CEO declaration card must show one mobile-visible sticky scan banner")
    assert_true("<span>{activeSlipScanLabel}</span>" in finance_page, "the sticky scan banner must render the active scan label")
    assert_true(finance_page.count("<span>{activeSlipScanLabel}</span>") == 1, "active scan label must not be duplicated inline under UNC/QTM inputs")
    assert_true("activeSlipScan?.type === \"unc\"" not in finance_page, "UNC input must not repeat the full sticky scan notification inline")
    assert_true("activeSlipScan?.type === \"qtm\"" not in finance_page, "QTM input must not repeat the full sticky scan notification inline")
    assert_true("disabled={extracting || ceoDeclarationLocked || closeApprovalLocked}" in finance_page, "slip file inputs must be disabled while a scan is running")

    print("PASS: CEO bank slip upload and UNC/QTM close-day flow use OpenAI Vision with visible scan progress")


if __name__ == "__main__":
    main()
