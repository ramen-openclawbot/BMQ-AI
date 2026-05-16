#!/usr/bin/env python3
"""Regression checks for Bank slip Google Drive date picker.

These checks are intentionally static: they do not call Google Drive, Supabase, or
OpenAI. They guard the bug where the Bank slip picker treated a top-level year
folder such as "2026" as a date and showed "Ngày 2026" / "Cập nhật 0 ngày".
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIALOG = ROOT / "src/components/payment-requests/DriveImportProgressDialog.tsx"
SCAN_FN = ROOT / "supabase/functions/scan-drive-folder/index.ts"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    dialog = read(DIALOG)
    scan_fn = read(SCAN_FN)

    assert_true("formatReceiptFolderDate" in dialog, "UI must format nested yyyy/MM/dd/UNC receipt paths")
    assert_true("google_drive_receipts_unc_pattern" in scan_fn, "scan-drive-folder must read the UNC Drive pattern setting")
    assert_true("listReceiptDateFoldersFromPattern" in scan_fn, "list_all_dates must walk nested yyyy/MM/dd/UNC folders")
    assert_true("/^20\\d{2}$/" in scan_fn, "list_all_dates must recognize top-level year folders as containers, not dates")
    assert_true("leafPath" in scan_fn and "yyyy/MM/dd" in scan_fn, "nested date results must return canonical yyyy/MM/dd/UNC paths")
    assert_true("folderType: 'bank_slip'" in dialog, "Bank slip list/scan calls must explicitly use bank_slip folder type")
    assert_true("folderType: 'po'" in dialog, "PO list/scan calls must explicitly avoid UNC receipt folder pattern")
    assert_true("setSelectionMode('all')" in dialog, "date picker should reset to all-mode when new available dates load")
    assert_true("selectionMode === 'select' && selectedDates.length === 0" in dialog, "select-mode with zero checked dates must remain guarded")
    assert_true("Chọn ít nhất 1 ngày" in dialog, "zero-date select mode must show an actionable disabled label")
    assert_true("Cập nhật 0 ngày" not in dialog, "UI must not render the confusing 'Cập nhật 0 ngày' label")

    print("PASS: Bank slip picker handles nested yyyy/MM/dd/UNC folders and zero-date selection clearly")


if __name__ == "__main__":
    main()
