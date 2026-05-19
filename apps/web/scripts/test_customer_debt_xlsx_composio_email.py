#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / "supabase/functions/export-npp-debt-sheet/index.ts"
UI = ROOT / "src/pages/NppDebtManagement.tsx"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_edge_function_uses_xlsx_attachment_and_composio_gmail():
    source = read(EDGE)
    assert 'npm:xlsx@0.18.5' in source
    assert 'GMAIL_SEND_EMAIL' in source
    assert 'COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID' in source
    assert 'no-reply@bmq.vn' in source
    assert 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' in source
    assert 'Link Google Sheet' not in source
    assert 'api.resend.com/emails' not in source


def test_send_email_branch_does_not_share_google_sheet():
    source = read(EDGE)
    send_start = source.rindex('if (shouldSendEmail)')
    send_branch = source[send_start: source.index('return jsonResponse', send_start)]
    assert 'shareSheetWithRecipients' not in send_branch
    assert 'sendDebtEmail' in send_branch
    assert 'attachmentName' in source


def test_ui_reports_excel_attachment_for_send_debt():
    source = read(UI)
    assert 'file Excel đính kèm' in source
    assert 'attachmentName' in source
    assert 'window.open(data.webViewLink' in source


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
    print(f"ok - {len(tests)} tests passed")
