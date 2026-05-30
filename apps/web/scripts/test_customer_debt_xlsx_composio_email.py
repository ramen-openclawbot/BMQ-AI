#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / "supabase/functions/export-npp-debt-sheet/index.ts"
UI = ROOT / "src/pages/NppDebtManagement.tsx"
CRM = ROOT / "src/pages/MiniCrm.tsx"
MIGRATION = ROOT / "supabase/migrations/20260519130000_customer_debt_emails.sql"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_edge_function_uses_xlsx_attachment_and_google_gmail_oauth():
    source = read(EDGE)
    assert 'npm:xlsx@0.18.5' in source
    assert 'gmail/v1/users/me/messages/send' in source
    assert 'debt_gmail_refresh_token' in source
    assert 'debt_gmail_connected_email' in source
    assert 'google_gmail_oauth' in source
    assert 'COMPOSIO_' not in source
    assert 'GMAIL_SEND_EMAIL' not in source
    assert 'no-reply@bmq.vn' in source
    assert 'ketoantruong@bmq.vn' in source
    assert 'CÔNG TY CỔ PHẦN THỰC PHẨM BMQ MST: 0311840107' in source
    assert 'Tầng 2, 68 Nguyễn Huệ, phường Sài Gòn, Thành phố Hồ Chí Minh' in source
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


def test_google_sheet_export_prompts_before_overwrite():
    edge = read(EDGE)
    ui = read(UI)
    assert 'overwrite' in edge
    assert 'debt_sheet_exists' in edge
    assert 'File công nợ này đã tồn tại. Anh muốn ghi đè hay huỷ?' in edge
    assert 'https://www.googleapis.com/drive/v3/files?q=' in edge
    assert 'prepareSpreadsheetForOverwrite' in edge
    assert 'values:batchClear' in edge
    assert 'deleteSheet' in edge
    assert 'File công nợ này đã tồn tại' in ui
    assert 'Ghi đè' in ui
    assert 'Huỷ' in ui
    assert 'exportMutation.mutate({ overwrite: true })' in ui


def test_npp_debt_page_uses_shared_light_semantic_theme():
    ui = read(UI)
    assert 'data-stitch-npp-debt-theme="pantone-2026-light"' in ui

    required_tokens = [
        "bg-background",
        "bg-card/70",
        "bg-card/80",
        "text-foreground",
        "text-muted-foreground",
        "border-border/70",
        "bg-primary/10",
        "text-primary",
        "shadow-card",
        "[color-scheme:light]",
    ]
    for token in required_tokens:
        assert token in ui, f"NPP debt page missing shared light theme token {token!r}"

    forbidden_old_theme_tokens = [
        "#0b0908",
        "#17100c",
        "#070605",
        "#14100d",
        "#211915",
        "#120e0b",
        "#1b1004",
        "#f59e0b",
        "text-white",
        "border-white",
        "bg-white/",
        "amber-",
        "orange-",
        "text-slate-",
        "bg-slate-",
        "border-slate-",
        "[color-scheme:dark]",
        "rgba(255",
        "rgba(245",
    ]
    for token in forbidden_old_theme_tokens:
        assert token not in ui, f"NPP debt page still contains old dark/amber theme token {token!r}"


def test_customer_debt_email_recipients_are_separate_from_recognition_emails():
    edge = read(EDGE)
    crm = read(CRM)
    migration = read(MIGRATION)
    assert 'debt_emails text[]' in migration
    assert 'FROM public.mini_crm_customer_emails' in migration
    assert 'COALESCE(array_length(c.debt_emails, 1), 0) = 0' in migration
    assert 'debt_emails' in edge
    assert '.from("mini_crm_customer_emails")' not in edge
    assert 'customer_debt_email_missing' in edge
    assert 'Email nhận công nợ' in edge
    assert 'Email nhận công nợ' in crm
    assert 'setEditDebtEmailsInput(formatEmailList(c.debt_emails) || emails)' in crm
    assert 'const debtEmails = normalizeEmailList(debtEmailsInput || emailsInput)' in crm
    assert 'debt_emails: normalizeEmailList(editDebtEmailsInput || editEmailsInput)' in crm


def test_debt_product_column_prefers_crm_customer_price_list_label():
    edge = read(EDGE)
    assert '.from("mini_crm_customer_price_list")' in edge
    assert '.select("customer_id,price_vnd_per_unit,is_active,product_skus(sku_code,product_name)")' in edge
    assert 'pickCustomerProductLabel' in edge
    assert 'crmProductNameForLine(line, [group.id, line.customer_id, line.parent_customer_id, customerId], productLabelsByCustomerId)' in edge
    assert 'crmProductNameForLine(line, [line.customer_id, line.parent_customer_id, customerId], productLabelsByCustomerId)' in edge
    assert 'line.product_name || line.item_note || line.customer_name || "Doanh thu"' in edge


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
    print(f"ok - {len(tests)} tests passed")
