#!/usr/bin/env python3
"""Static contract checks for the "Trình chi gấp" bulk-UNC flow.

These checks never connect to a database or Supabase. They guard that:
  * the new migration only adds the two nullable OCR text columns,
  * payment-unc-approve extract stores + returns beneficiary name / content while
    confirm still goes through approve_payment_requests_with_unc,
  * the default bank-slip-ocr prompt/schema (finance-extract-slip-amount) is
    untouched,
  * the pure matcher and the bulk hook stay UI-free and use the `unc:<sha>`
    idempotency key.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
FUNCTIONS = ROOT / "supabase" / "functions"
LIB = ROOT / "src" / "lib"
HOOKS = ROOT / "src" / "hooks"
TYPES = ROOT / "src" / "integrations" / "supabase" / "types.ts"

MIGRATION = MIGRATIONS / "20261010130000_payment_unc_bulk_match.sql"
APPROVE_RPC = FUNCTIONS / "payment-unc-approve" / "index.ts"
OCR_SHARED = FUNCTIONS / "_shared" / "bank-slip-ocr.ts"
EXTRACT_FN = FUNCTIONS / "finance-extract-slip-amount" / "index.ts"
MATCHER = LIB / "payment-unc-bulk-match.ts"
MATCHER_TEST = LIB / "payment-unc-bulk-match.test.ts"
BULK_HOOK = HOOKS / "usePaymentUncBulk.ts"
UNC_HOOK = HOOKS / "usePaymentUncApproval.ts"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    migration = read(MIGRATION)
    approve_rpc = read(APPROVE_RPC)
    ocr_shared = read(OCR_SHARED)
    extract_fn = read(EXTRACT_FN)
    matcher = read(MATCHER)
    matcher_test = read(MATCHER_TEST)
    bulk_hook = read(BULK_HOOK)
    unc_hook = read(UNC_HOOK)
    types = read(TYPES)

    # --- Migration: additive nullable columns only ---------------------------
    assert_true(
        MIGRATION.name > "20261010120000_bhn_window_mean_std_order_policy.sql",
        "migration timestamp must be after 20261010120000",
    )
    assert_true(
        "alter table public.payment_unc_ocr_drafts" in migration,
        "migration must alter public.payment_unc_ocr_drafts",
    )
    assert_true(
        "add column if not exists ocr_beneficiary_name text" in migration,
        "migration must add ocr_beneficiary_name text",
    )
    assert_true(
        "add column if not exists ocr_transfer_content text" in migration,
        "migration must add ocr_transfer_content text",
    )
    assert_true(
        "not null" not in migration.split("alter table")[1].split(";")[0],
        "the two new OCR columns must stay nullable",
    )
    for forbidden in (
        "enable row level security",
        "create policy",
        "drop policy",
        "revoke ",
        "grant ",
        "create or replace function",
        "cron.schedule",
        "pg_cron",
    ):
        assert_true(
            forbidden not in migration.lower(),
            f"migration must not touch RLS/grants/functions/cron ({forbidden})",
        )

    # --- types.ts mirrors the new nullable columns ---------------------------
    for column in ("ocr_beneficiary_name: string | null", "ocr_transfer_content: string | null"):
        assert_true(column in types, f"types.ts must declare {column}")
    assert_true(
        types.count("ocr_beneficiary_name?: string | null") >= 2
        and types.count("ocr_transfer_content?: string | null") >= 2,
        "types.ts Insert/Update must accept both new columns",
    )

    # --- Edge extract: reads, stores and returns the two new fields ----------
    assert_true(
        "callOpenAiVision(imageBase64, mimeType, slipType, { readBeneficiary: true })" in approve_rpc,
        "extract mode must ask the OCR for the beneficiary name and transfer content",
    )
    assert_true(
        "ocr_beneficiary_name: extracted.beneficiary_name" in approve_rpc
        and "ocr_transfer_content: extracted.transfer_content" in approve_rpc,
        "extract mode must persist the two new OCR fields on the draft",
    )
    assert_true(
        "beneficiary_name: extracted.beneficiary_name" in approve_rpc
        and "transfer_content: extracted.transfer_content" in approve_rpc,
        "extract response must return the two new OCR fields",
    )
    assert_true(
        "suggested_idempotency_key: `unc:${fileSha256}`" in approve_rpc,
        "extract must keep suggesting the unc:<sha> idempotency key",
    )

    # --- Edge confirm: unchanged and still through the atomic RPC ------------
    assert_true(
        "approve_payment_requests_with_unc" in approve_rpc,
        "confirm must keep calling approve_payment_requests_with_unc",
    )
    assert_true(
        'mode === "confirm"' in approve_rpc and 'mode === "record"' in approve_rpc,
        "confirm and record modes must stay",
    )
    assert_true(
        "callOpenAiVision" not in approve_rpc.split("const handleConfirm")[1],
        "confirm mode must not re-run OCR",
    )

    # --- bank-slip-ocr: default prompt/schema byte-for-byte unchanged --------
    assert_true(
        '`Slip type: ${slipType || "unknown"}. Trích xuất số tiền thực chuyển/thực chi từ ảnh UNC/QTM/bank slip này. Trả về đúng schema JSON.`'
        in ocr_shared,
        "the default slipUserPrompt must stay unchanged",
    )
    assert_true(
        "Bạn là chuyên gia trích xuất số tiền từ ảnh UNC/QTM/bank slip tiếng Việt."
        in ocr_shared
        and "Trả về JSON." in ocr_shared,
        "the default system prompt must stay present",
    )
    assert_true(
        'required: ["amount", "amount_in_words", "confidence"]' in ocr_shared,
        "the default tool schema required list must stay unchanged",
    )
    assert_true(
        "options?.readBeneficiary === true" in ocr_shared
        and "SLIP_BENEFICIARY_SYSTEM_PROMPT" in ocr_shared
        and "slipBeneficiaryUserPrompt" in ocr_shared,
        "the extra reading must be gated behind the optional readBeneficiary flag",
    )
    assert_true(
        ": SLIP_EXTRACTION_SYSTEM_PROMPT" in ocr_shared
        and ": slipUserPrompt(slipType)" in ocr_shared,
        "the default branch must use the original prompt helpers",
    )
    assert_true(
        "callOpenAiVision(imageBase64, mimeType || \"image/jpeg\", slipType)" in extract_fn
        and "readBeneficiary" not in extract_fn,
        "finance-extract-slip-amount must keep the 3-arg call (output unchanged)",
    )

    # --- Pure matcher: no I/O, allocation invariant, duplicate/conflict ------
    for forbidden in ("supabase", "react", "@tanstack", "fetch(", "await "):
        assert_true(forbidden not in matcher, f"matcher must stay pure (found {forbidden})")
    assert_true(
        "export function matchUncBulk(" in matcher
        and '"matched"' in matcher
        and '"ambiguous"' in matcher
        and '"unmatched"' in matcher
        and '"duplicate"' in matcher,
        "matcher must expose the matched/ambiguous/unmatched/duplicate statuses",
    )
    assert_true(
        "paymentRequestId: string" in matcher and "amount: number" in matcher,
        "matcher must return allocations {paymentRequestId, amount}",
    )
    assert_true(
        "normalizeUncReference" in matcher,
        "matcher must reuse the canonical reference normalization for duplicates",
    )
    assert_true(
        "matchUncBulk" in matcher_test and matcher_test.count("test(") >= 15,
        "the matcher test must cover at least 15 cases",
    )
    for marker in (
        "PR-AAAABBBB",
        "beneficiary name without accents",
        "several phiếu",
        "three UNCs",
        "ambiguous",
        "unmatched",
        "duplicate",
        "fully paid",
    ):
        assert_true(
            marker in matcher_test or marker.lower() in matcher_test.lower(),
            f"matcher tests must cover {marker}",
        )

    # --- Bulk hook: parallel read, sequential confirm, unc:<sha> key ---------
    assert_true(
        "MAX_PARALLEL_UNC_READS = 2" in bulk_hook,
        "bulk hook must cap OCR concurrency at two",
    )
    assert_true(
        "matchUncBulk" in bulk_hook,
        "bulk hook must call the pure matcher",
    )
    assert_true(
        "idempotency_key: `unc:${reading.fileSha256}`" in bulk_hook,
        "bulk hook must use the unc:<sha> idempotency key",
    )
    assert_true(
        "confirm.mutateAsync" in bulk_hook and "allocations:" in bulk_hook,
        "bulk hook must confirm sequentially through the existing confirm mutation with allocations",
    )
    run_body = bulk_hook.split("const run = useCallback")[1].split("const confirmItems = useCallback")[0]
    assert_true(
        "confirm.mutateAsync" not in run_body,
        "reading and matching must never pay: confirm only after the CEO reviews",
    )
    assert_true(
        "const confirmItems = useCallback" in bulk_hook
        and "for (const choice of choices)" in bulk_hook
        and 'patch(choice.index, { status: "confirming"' in bulk_hook,
        "reviewed UNCs must be confirmed one after another through confirmItems",
    )
    assert_true(
        '"error"' in bulk_hook and "errorCodeOf" in bulk_hook,
        "per-UNC failures must surface an error code",
    )
    assert_true(
        "used.has(allocation.paymentRequestId)" in bulk_hook,
        "one phiếu must not be paid by two UNCs in the same confirm batch",
    )
    assert_true(
        'queryClient.invalidateQueries({ queryKey: ["payment-submission"] })' in bulk_hook,
        "bulk hook must refresh the đợt trình when done",
    )
    assert_true(
        "beneficiary_name?: string | null" in unc_hook
        and "transfer_content?: string | null" in unc_hook,
        "UncOcrResult must expose the two new optional OCR fields",
    )

    print("PASS: bulk UNC matching backend contracts hold")


if __name__ == "__main__":
    main()
