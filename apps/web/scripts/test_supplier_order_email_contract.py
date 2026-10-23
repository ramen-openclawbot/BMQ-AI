#!/usr/bin/env python3
"""Static contract for the supplier-order email backend (phase 1).

Checks the new migration objects, RLS/grant shape, security-definer functions,
the private storage bucket, both Edge Functions and their config entries, the
Gmail OAuth mode, and the rollback-only smoke.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = sorted(ROOT.glob("supabase/migrations/*_supplier_order_email.sql"))
assert len(MIGRATIONS) == 1, (
    f"expected exactly one supplier_order_email migration, found {MIGRATIONS}"
)
MIGRATION_PATH = MIGRATIONS[0]
MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
LOWER = MIGRATION.lower()

FUNCTIONS = [
    "prepare_supplier_order",
    "supplier_order_history",
    "create_supplier_order_po",
    "mark_supplier_order_sent",
    "mark_supplier_order_failed",
    "resolve_supplier_order_upload_token",
    "record_supplier_order_upload",
]
INTERNAL_FUNCTIONS = [
    "create_supplier_order_po",
    "mark_supplier_order_sent",
    "mark_supplier_order_failed",
    "resolve_supplier_order_upload_token",
    "record_supplier_order_upload",
]


def function_block(name: str) -> str:
    match = re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
        MIGRATION,
        re.IGNORECASE,
    )
    assert match, f"missing function public.{name}"
    tail = MIGRATION[match.start():]
    end = tail.find("\n$$;")
    assert end != -1, f"unterminated function public.{name}"
    return tail[:end]


print("== new migration and PO-unit columns ==")
assert "q7_purchase_item_settings" in LOWER
assert re.search(r"add\s+column\s+if\s+not\s+exists\s+po_unit\s+text", LOWER)
assert re.search(r"add\s+column\s+if\s+not\s+exists\s+po_unit_factor\s+numeric", LOWER)
assert "q7_purchase_item_settings_po_unit_check" in MIGRATION
assert "po_unit is null and po_unit_factor is null" in LOWER
assert "po_unit_factor > 0" in LOWER
assert "'nan', 'infinity', '-infinity'" in LOWER

print("== new tables ==")
for table in ("supplier_order_requests", "supplier_order_uploads"):
    assert re.search(rf"create\s+table\s+if\s+not\s+exists\s+public\.{table}", LOWER), (
        f"missing table {table}"
    )
    assert re.search(
        rf"alter\s+table\s+public\.{table}\s+enable\s+row\s+level\s+security", LOWER
    ), f"RLS must be enabled on {table}"
    assert re.search(
        rf"grant\s+select\s+on\s+table\s+public\.{table}\s+to\s+authenticated", LOWER
    ), f"authenticated SELECT grant missing for {table}"
    assert re.search(
        rf"grant\s+all\s+on\s+table\s+public\.{table}\s+to\s+service_role", LOWER
    ), f"service_role grant missing for {table}"

assert re.search(r"request_id\s+uuid\s+not\s+null\s+unique", LOWER)
assert re.search(r"upload_token_hash\s+text\s+unique", LOWER)
assert re.search(r"unique\s*\(\s*order_request_id\s*,\s*sha256\s*\)", LOWER)
assert re.search(
    r"status\s+text\s+not\s+null\s+check\s*\(\s*status\s+in\s*\(\s*'preparing'\s*,\s*'sent'\s*,\s*'failed'\s*\)",
    LOWER,
)
assert "on delete restrict" in LOWER

print("== RLS read gate and no client writes ==")
assert "has_role((select auth.uid()), 'owner')" in LOWER
assert "has_module_permission((select auth.uid()), 'purchase_orders', 'edit')" in LOWER
assert not re.search(
    r"create\s+policy[\s\S]{0,260}?for\s+(insert|update|delete)\s+to\s+authenticated",
    LOWER,
), "new tables must not have client write policies"
for table in ("supplier_order_requests", "supplier_order_uploads"):
    assert not re.search(
        rf"grant\s+(insert|update|delete|all)[^;]*on\s+table\s+public\.{table}[^;]*to\s+authenticated",
        LOWER,
    ), f"authenticated must not write {table} directly"

print("== private storage bucket ==")
assert "'supplier-delivery-docs'" in MIGRATION
assert re.search(r"insert\s+into\s+storage\.buckets", LOWER)
assert re.search(r"\bfalse\b\s*,\s*10485760", LOWER)
for mime in (
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
):
    assert mime in MIGRATION
# Owners / purchase editors may read the supplier files (signed URLs); no client
# insert/update/delete policy exists on storage.objects for this bucket.
object_policies = re.findall(
    r"create\s+policy\s+(\w+)\s+on\s+storage\.objects\s+for\s+(\w+)", LOWER
)
assert object_policies == [("supplier_delivery_docs_read", "select")], object_policies
read_policy = LOWER.split("create policy supplier_delivery_docs_read", 1)[1].split(";", 1)[0]
assert "bucket_id = 'supplier-delivery-docs'" in read_policy
assert "'purchase_orders', 'edit'" in read_policy

print("== security definer + pinned search_path ==")
for name in FUNCTIONS:
    block = function_block(name)
    lowered = block.lower()
    assert "security definer" in lowered, f"{name} must be security definer"
    assert "set search_path = public, pg_temp" in lowered, (
        f"{name} must pin search_path to public, pg_temp"
    )
    occurrences = len(
        re.findall(
            rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
            MIGRATION,
            re.IGNORECASE,
        )
    )
    assert occurrences == 1, f"{name} is defined {occurrences} times"

print("== function grants ==")
for name in ("prepare_supplier_order", "supplier_order_history"):
    assert re.search(
        rf"grant\s+execute\s+on\s+function\s+public\.{name}\([^)]*\)\s+to\s+authenticated\s*,\s*service_role",
        LOWER,
    ), f"{name} must be callable by authenticated + service_role"

for name in INTERNAL_FUNCTIONS:
    revoke = re.search(
        rf"revoke\s+all\s+on\s+function\s+public\.{name}\([^;]*?\)\s*from\s+public\s*,\s*anon\s*,\s*authenticated",
        LOWER,
        re.DOTALL,
    )
    assert revoke, f"{name} must revoke public/anon/authenticated"
    grant = re.search(
        rf"grant\s+execute\s+on\s+function\s+public\.{name}\([^;]*?\)\s*to\s+service_role",
        LOWER,
        re.DOTALL,
    )
    assert grant, f"{name} must grant execute to service_role only"

print("== business rules present ==")
prepare = function_block("prepare_supplier_order").lower()
for code in (
    "no_supplier",
    "no_supplier_email",
    "no_price",
    "no_po_unit",
    "mailbox_not_connected",
):
    assert f"'{code}'" in prepare, f"prepare must emit blocker {code}"
assert "get_q7_purchase_forecast" in prepare
assert "order_email_delivery_address" in prepare
assert "order_email_contact_name" in prepare
assert "order_email_contact_phone" in prepare
assert "order_email_note" in prepare
assert "order_gmail_connected_email" in prepare
assert "stock_material_aliases" in prepare
assert "po_unit_factor" in prepare

create = function_block("create_supplier_order_po").lower()
assert "prepare_supplier_order" in create
assert "over_quantity_limit" in create
assert "order_email_max_amount" in create
assert "30000000" in create
assert "generate_po_number()" in create
assert "đặt hàng qua email order@bmq.vn" in create
assert "purchase_order_items" in create
assert "'preparing'" in create

mark_sent = function_block("mark_supplier_order_sent").lower()
assert "update_purchase_order_status_with_material_controller" in mark_sent
assert "'sent'" in mark_sent

resolve = function_block("resolve_supplier_order_upload_token").lower()
assert "upload_expires_at > now()" in resolve
assert "upload_token_hash = p_token_hash" in resolve
assert "storage_path" not in resolve, "resolve must not expose storage paths"

record = function_block("record_supplier_order_upload").lower()
assert "upload_limit_reached" in record
assert "on conflict (order_request_id, sha256) do nothing" in record
assert "update public.purchase_orders" not in record, "uploads must not overwrite PO image_url"
assert "'in_progress'" in function_block("create_supplier_order_po").lower()
assert "<= 10485760" in record or "> 10485760" in record

history = function_block("supplier_order_history").lower()
assert "limit 10" in history
assert "supplier_order_uploads" in history

print("== no cron / no auto purchase enablement ==")
assert "cron.schedule" not in LOWER
assert "cron.unschedule" not in LOWER
assert not re.search(r"update\s+public\.q7_auto_purchase_settings[\s\S]{0,120}enabled\s*=\s*true", LOWER)

print("== Edge Functions + config ==")
SEND = ROOT / "supabase/functions/supplier-order-send/index.ts"
UPLOAD = ROOT / "supabase/functions/supplier-order-upload/index.ts"
CONFIG = (ROOT / "supabase/config.toml").read_text(encoding="utf-8")
assert SEND.exists(), "supplier-order-send/index.ts missing"
assert UPLOAD.exists(), "supplier-order-upload/index.ts missing"
for name in ("supplier-order-send", "supplier-order-upload"):
    match = re.search(
        rf"\[functions\.{re.escape(name)}\]\s*(?:#[^\n]*\n)*\s*verify_jwt\s*=\s*false",
        CONFIG,
    )
    assert match, f"{name} must be configured with verify_jwt = false"

send_source = SEND.read_text(encoding="utf-8")
assert "requireAuth" in send_source
assert "prepare_supplier_order" in send_source
assert "create_supplier_order_po" in send_source
assert "mark_supplier_order_sent" in send_source
assert "mark_supplier_order_failed" in send_source
assert "order_gmail_connected_email" in send_source
assert "order@bmq.vn" in send_source
assert "ORDER_MAILBOX" in send_source
assert "gmail.send" not in send_source  # scope lives in the OAuth function
assert "checkAndRecordRateLimit" in send_source
assert "30" in send_source

upload_source = UPLOAD.read_text(encoding="utf-8")
assert "resolve_supplier_order_upload_token" in upload_source
assert "record_supplier_order_upload" in upload_source
assert "supplier-delivery-docs" in upload_source
assert "10 * 1024 * 1024" in upload_source
for mime in ("image/jpeg", "image/png", "image/webp", "application/pdf"):
    assert mime in upload_source
get_branch = upload_source.split('if (req.method === "GET")', 1)[-1].split(
    'if (req.method !== "POST")', 1
)[0]
assert "storage_path" not in get_branch.lower(), "GET must not return storage paths"
assert "upload_token_hash" not in get_branch.lower(), "GET must not return token hashes"
assert "po_number" in get_branch and "upload_count" in get_branch

print("== Gmail OAuth order_gmail mode ==")
OAUTH = (ROOT / "supabase/functions/google-drive-auth/index.ts").read_text(encoding="utf-8")
assert "'order_gmail'" in OAUTH
assert "order_gmail_refresh_token" in OAUTH
assert "order_gmail_connected_email" in OAUTH
assert "order_gmail_success" in OAUTH
assert "order_gmail_error" in OAUTH
assert "order_gmail_email" in OAUTH
assert "https://www.googleapis.com/auth/gmail.send email profile" in OAUTH

print("== smoke is rollback-only ==")
SMOKE = (ROOT / "scripts/smoke_supplier_order_email.sql").read_text(encoding="utf-8")
assert re.search(r"^\s*begin\s*;", SMOKE, re.IGNORECASE | re.MULTILINE)
assert re.search(r"^\s*rollback\s*;\s*$", SMOKE, re.IGNORECASE | re.MULTILINE)
non_comment = [
    line.strip()
    for line in SMOKE.splitlines()
    if line.strip() and not line.strip().startswith("--")
]
assert non_comment[-1].lower() == "rollback;"
assert "prepare_supplier_order" in SMOKE
assert "no_supplier_email" in SMOKE
assert "mailbox_not_connected" in SMOKE
assert "over_quantity_limit" in SMOKE
assert "upload_limit_reached" in SMOKE
assert "insufficient_privilege" in SMOKE

print("supplier order email contract passed")

print("== supplier order page migration ==")
PAGE_MIGRATIONS = sorted(ROOT.glob("supabase/migrations/*_supplier_order_page.sql"))
assert len(PAGE_MIGRATIONS) == 1, (
    f"expected exactly one supplier_order_page migration, found {PAGE_MIGRATIONS}"
)
PAGE_MIGRATION = PAGE_MIGRATIONS[0].read_text(encoding="utf-8")
PAGE_LOWER = PAGE_MIGRATION.lower()


def page_block(name: str) -> str:
    match = re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
        PAGE_MIGRATION,
        re.IGNORECASE,
    )
    assert match, f"missing page function public.{name}"
    tail = PAGE_MIGRATION[match.start():]
    end = tail.find("\n$$;")
    assert end != -1, f"unterminated page function public.{name}"
    return tail[:end]


for table in ("supplier_order_catalog_items", "supplier_order_request_lines"):
    assert re.search(
        rf"create\s+table\s+if\s+not\s+exists\s+public\.{table}", PAGE_LOWER
    ), f"missing table {table}"
    assert re.search(
        rf"alter\s+table\s+public\.{table}\s+enable\s+row\s+level\s+security",
        PAGE_LOWER,
    ), f"RLS must be enabled on {table}"
    assert re.search(
        rf"revoke\s+all\s+on\s+table\s+public\.{table}\s+from\s+public\s*,\s*anon\s*,\s*authenticated",
        PAGE_LOWER,
    ), f"public/anon/authenticated must not read {table} directly"
    assert re.search(
        rf"grant\s+all\s+on\s+table\s+public\.{table}\s+to\s+service_role",
        PAGE_LOWER,
    ), f"service_role grant missing for {table}"

assert "supplier_order_requests_prepay_status_check" in PAGE_LOWER
assert "drop not null" in PAGE_LOWER
assert re.search(r"prepay_status\s+text", PAGE_LOWER)
for value in ("created", "skipped_none", "skipped_recent", "declined", "forbidden", "failed"):
    assert f"'{value}'" in PAGE_LOWER

print("== supplier order page functions: security definer + pinned search_path ==")
PAGE_FUNCTIONS = [
    "supplier_order_line_price",
    "prepare_supplier_order",
    "supplier_order_suppliers",
    "supplier_order_catalog",
    "supplier_order_catalog_candidates",
    "supplier_order_catalog_set",
    "create_supplier_order_multi",
    "record_supplier_order_prepay",
    "supplier_order_history",
    "supplier_order_history_by_supplier",
]
for name in PAGE_FUNCTIONS:
    block = page_block(name).lower()
    assert "security definer" in block, f"{name} must be security definer"
    assert "set search_path = public, pg_temp" in block, (
        f"{name} must pin search_path to public, pg_temp"
    )

print("== supplier order page grants ==")
for name in (
    "supplier_order_suppliers",
    "supplier_order_catalog",
    "supplier_order_catalog_candidates",
    "supplier_order_catalog_set",
    "supplier_order_history",
    "supplier_order_history_by_supplier",
    "prepare_supplier_order",
):
    assert re.search(
        rf"grant\s+execute\s+on\s+function\s+public\.{name}\([^)]*\)\s+to\s+authenticated\s*,\s*service_role",
        PAGE_LOWER,
        re.DOTALL,
    ), f"{name} must be callable by authenticated + service_role"

for name in ("create_supplier_order_multi", "record_supplier_order_prepay"):
    assert re.search(
        rf"revoke\s+all\s+on\s+function\s+public\.{name}\([^;]*?\)\s*from\s+public\s*,\s*anon\s*,\s*authenticated",
        PAGE_LOWER,
        re.DOTALL,
    ), f"{name} must revoke public/anon/authenticated"
    assert re.search(
        rf"grant\s+execute\s+on\s+function\s+public\.{name}\([^;]*?\)\s*to\s+service_role\s*;",
        PAGE_LOWER,
        re.DOTALL,
    ), f"{name} must grant execute to service_role only"

print("== multi create computes prices server-side ==")
create_multi = page_block("create_supplier_order_multi").lower()
assert "supplier_order_line_price(" in create_multi
assert "supplier_order_catalog_items" in create_multi
assert "over_quantity_limit" in create_multi
assert "over_amount_limit" in create_multi
assert "order_email_max_amount" in create_multi
assert "purchase_order_items" in create_multi
assert "supplier_order_request_lines" in create_multi
assert re.search(r"from\s+jsonb_array_elements\(p_lines\)", create_multi)

print("== edge orders create, then mail, then prepay ==")
assert "create_supplier_order_multi" in send_source
assert send_source.index('admin.rpc("create_supplier_order_multi"') < send_source.index(
    "await sendGmail("
)
assert send_source.index('admin.rpc("mark_supplier_order_sent"') < send_source.index(
    'userDb.rpc("create_payment_submission"'
)
assert "supplier_order_catalog" in send_source
assert "buildSupplierOrderEmailLines" in send_source
assert "in_progress" in send_source
assert "prepay" in send_source

print("== supplier order page smoke is rollback-only ==")
PAGE_SMOKE = (ROOT / "scripts/smoke_supplier_order_page.sql").read_text(encoding="utf-8")
assert re.search(r"^\s*begin\s*;", PAGE_SMOKE, re.IGNORECASE | re.MULTILINE)
assert re.search(r"^\s*rollback\s*;\s*$", PAGE_SMOKE, re.IGNORECASE | re.MULTILINE)
assert not re.search(r"^\s*commit\s*;", PAGE_SMOKE, re.IGNORECASE | re.MULTILINE)
non_comment = [
    line.strip()
    for line in PAGE_SMOKE.splitlines()
    if line.strip() and not line.strip().startswith("--")
]
assert non_comment[-1].lower() == "rollback;"
assert "27dbc34e-75ee-4973-8f9a-d1b125c90483" in PAGE_SMOKE
assert "set local role authenticated" in PAGE_SMOKE.lower()
assert "supplier_order_suppliers" in PAGE_SMOKE
assert "supplier_order_catalog" in PAGE_SMOKE
assert "supplier_order_catalog_candidates" in PAGE_SMOKE
assert "supplier_order_catalog_set" in PAGE_SMOKE
assert "create_supplier_order_multi" in PAGE_SMOKE
assert "replayed" in PAGE_SMOKE
assert "over_quantity_limit" in PAGE_SMOKE
assert "supplier_order_history_by_supplier" in PAGE_SMOKE
assert "supplier_order_history" in PAGE_SMOKE

print("supplier order page contract passed")
