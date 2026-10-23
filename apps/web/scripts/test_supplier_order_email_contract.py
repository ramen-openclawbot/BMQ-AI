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

print("== supplier order VAT migration ==")
VAT_MIGRATIONS = sorted(ROOT.glob("supabase/migrations/*_supplier_order_vat.sql"))
assert len(VAT_MIGRATIONS) == 1, (
    f"expected exactly one supplier_order_vat migration, found {VAT_MIGRATIONS}"
)
VAT_MIGRATION = VAT_MIGRATIONS[0].read_text(encoding="utf-8")
VAT_LOWER = VAT_MIGRATION.lower()


def vat_block(name: str) -> str:
    match = re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
        VAT_MIGRATION,
        re.IGNORECASE,
    )
    assert match, f"missing VAT function public.{name}"
    tail = VAT_MIGRATION[match.start():]
    end = tail.find("\n$$;")
    assert end != -1, f"unterminated VAT function public.{name}"
    return tail[:end]


print("== VAT columns and seeded rates ==")
assert re.search(
    r"add\s+column\s+if\s+not\s+exists\s+vat_rate\s+numeric\(5,\s*2\)\s+not\s+null\s+default\s+0",
    VAT_LOWER,
), "catalog vat_rate column missing"
assert "supplier_order_catalog_items_vat_rate_check" in VAT_MIGRATION
assert re.search(
    r"check\s*\(\s*vat_rate\s*>=\s*0\s+and\s+vat_rate\s*<=\s*100\s*\)", VAT_LOWER
)
assert re.search(
    r"add\s+column\s+if\s+not\s+exists\s+vat_rate\s+numeric\s*\(\s*5\s*,\s*2\s*\)",
    VAT_LOWER,
), "request line vat_rate column missing"
assert re.search(
    r"add\s+column\s+if\s+not\s+exists\s+vat_amount\s+numeric", VAT_LOWER
), "request line vat_amount column missing"
assert re.search(
    r"add\s+column\s+if\s+not\s+exists\s+subtotal_amount\s+numeric", VAT_LOWER
), "request subtotal_amount column missing"
assert "bc39ded3-755c-4b31-9e4c-d7729e009608" in VAT_MIGRATION
assert "9546bd80-18d7-4ec7-b0e5-de50798ea718" in VAT_MIGRATION
assert re.search(r"set\s+vat_rate\s*=\s*8", VAT_LOWER)
assert re.search(r"set\s+vat_rate\s*=\s*0", VAT_LOWER)

print("== VAT functions: security definer + pinned search_path + same grants ==")
VAT_FUNCTIONS = [
    "supplier_order_line_price",
    "supplier_order_catalog",
    "supplier_order_catalog_set",
    "create_supplier_order_multi",
    "supplier_order_history_by_supplier",
]
for name in VAT_FUNCTIONS:
    block = vat_block(name).lower()
    assert "security definer" in block, f"{name} must be security definer"
    assert "set search_path = public, pg_temp" in block, (
        f"{name} must pin search_path to public, pg_temp"
    )

for name in (
    "supplier_order_catalog",
    "supplier_order_catalog_set",
    "supplier_order_history_by_supplier",
):
    assert re.search(
        rf"grant\s+execute\s+on\s+function\s+public\.{name}\([^)]*\)\s+to\s+authenticated\s*,\s*service_role",
        VAT_LOWER,
        re.DOTALL,
    ), f"{name} must stay callable by authenticated + service_role"

for name in ("supplier_order_line_price", "create_supplier_order_multi"):
    assert re.search(
        rf"revoke\s+all\s+on\s+function\s+public\.{name}\([^;]*?\)\s*from\s+public\s*,\s*anon",
        VAT_LOWER,
        re.DOTALL,
    ), f"{name} must revoke public/anon"
    assert re.search(
        rf"grant\s+execute\s+on\s+function\s+public\.{name}\([^;]*?\)\s*to\s+service_role",
        VAT_LOWER,
        re.DOTALL,
    ), f"{name} must stay service_role only"

assert re.search(
    r"supplier_order_catalog_set\(\s*uuid\s*,\s*uuid\s*,\s*boolean\s*,\s*text\s*,\s*numeric\s*,\s*text\s*,\s*numeric\s*\)\s+to\s+authenticated\s*,\s*service_role",
    VAT_LOWER,
    re.DOTALL,
), "catalog_set must be granted with its new 7-argument signature"
assert re.search(
    r"drop\s+function\s+if\s+exists\s+public\.supplier_order_catalog_set\(\s*uuid\s*,\s*uuid\s*,\s*boolean\s*,\s*text\s*,\s*numeric\s*,\s*text\s*\)",
    VAT_LOWER,
    re.DOTALL,
), "the old 6-argument catalog_set must be dropped"

print("== price helper uses the median of the 6 newest plausible lines ==")
price = vat_block("supplier_order_line_price").lower()
assert "stock_unit_line_factor" in price
assert "stock_unit_pack_factor" in price
assert "conversion_factor" in price
assert "limit 6" in price
assert "median" in price
assert " / 3" in price and " * 3" in price
assert "poi.unit_price > 0" in price

print("== catalog carries vat_rate and defaults a new item from the newest PO ==")
catalog = vat_block("supplier_order_catalog")
assert re.search(r"'vat_rate',\s*v_item\.vat_rate", catalog), (
    "supplier_order_catalog must return vat_rate per item"
)
catalog_set = vat_block("supplier_order_catalog_set").lower()
assert "invalid_vat_rate" in catalog_set
assert "p_vat_rate" in catalog_set
assert "values (0::numeric), (5::numeric), (8::numeric), (10::numeric)" in catalog_set
assert "supplier_order_catalog_items.vat_rate" in catalog_set

print("== create computes VAT server-side and caps the payable total ==")
create_multi = vat_block("create_supplier_order_multi").lower()
assert "v_vat_rate := coalesce(v_catalog.vat_rate, 0)" in create_multi
assert "v_line_vat := v_line_total * v_vat_rate / 100" in create_multi
assert "v_vat_amount := round(v_vat_total, 0)" in create_multi
assert "v_total := v_subtotal + v_vat_amount" in create_multi
assert "if v_total > v_max_amount then" in create_multi
assert "order_email_max_amount" in create_multi
assert "vat_amount" in create_multi
assert "subtotal_amount" in create_multi
assert "'vat_rate', v_vat_rate" in create_multi

print("== supplier history exposes subtotal / VAT / line rate ==")
history = vat_block("supplier_order_history_by_supplier").lower()
assert "'subtotal', r.subtotal_amount" in history
assert "'vat_amount', r.vat_amount" in history
assert "'vat_rate', l.vat_rate" in history

print("== VAT smoke is rollback-only and checks the new numbers ==")
for token in (
    "1032000",
    "955555",
    "76445",
    "18925.93",
    "vat_amount",
    "subtotal_amount",
    "20261102920000",
):
    assert token in PAGE_SMOKE, f"VAT smoke is missing {token}"
assert "supplier_order_catalog_set" in PAGE_SMOKE
assert "vat_rate" in PAGE_SMOKE

print("== supplier order list price migration ==")
LIST_MIGRATIONS = sorted(
    ROOT.glob("supabase/migrations/*_supplier_order_list_price.sql")
)
assert len(LIST_MIGRATIONS) == 1, (
    f"expected exactly one supplier_order_list_price migration, found {LIST_MIGRATIONS}"
)
LIST_MIGRATION = LIST_MIGRATIONS[0].read_text(encoding="utf-8")
LIST_LOWER = LIST_MIGRATION.lower()


def list_block(name: str) -> str:
    match = re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
        LIST_MIGRATION,
        re.IGNORECASE,
    )
    assert match, f"missing list-price function public.{name}"
    tail = LIST_MIGRATION[match.start():]
    end = tail.find("\n$$;")
    assert end != -1, f"unterminated list-price function public.{name}"
    return tail[:end]


print("== list price columns, gross amount and the ĐH19993 seed ==")
assert re.search(
    r"add\s+column\s+if\s+not\s+exists\s+list_price\s+numeric\s*\(\s*18\s*,\s*2\s*\)",
    LIST_LOWER,
), "catalog list_price column missing"
assert re.search(
    r"add\s+column\s+if\s+not\s+exists\s+list_price_includes_vat\s+boolean\s+not\s+null\s+default\s+false",
    LIST_LOWER,
), "catalog list_price_includes_vat column missing"
assert re.search(r"add\s+column\s+if\s+not\s+exists\s+list_price_source\s+text", LIST_LOWER)
assert re.search(
    r"add\s+column\s+if\s+not\s+exists\s+list_price_updated_at\s+timestamptz", LIST_LOWER
)
assert re.search(
    r"add\s+column\s+if\s+not\s+exists\s+list_price_updated_by\s+uuid", LIST_LOWER
)
assert "supplier_order_catalog_items_list_price_check" in LIST_MIGRATION
assert re.search(r"add\s+column\s+if\s+not\s+exists\s+gross_amount\s+numeric", LIST_LOWER)

for item_id in (
    "1039f461-8f9f-45a1-b05c-b96cb736812e",
    "64952d75-2351-43f8-886f-de5282c96ed2",
    "6ba549f7-d3b6-4971-a742-2fb4091800bb",
):
    assert item_id in LIST_MIGRATION, f"missing seeded item {item_id}"
for price in ("20840", "20440", "152000"):
    assert re.search(rf"set\s+list_price\s*=\s*{price}", LIST_LOWER), (
        f"missing seeded list price {price}"
    )
assert LIST_MIGRATION.count("list_price_includes_vat = true") >= 3
assert "Phiếu xuất kho Phúc Thịnh ĐH19993 ngày 22/10/2026" in LIST_MIGRATION
assert "9546bd80-18d7-4ec7-b0e5-de50798ea718" not in LIST_MIGRATION, (
    "TV Food must not be seeded with a list price"
)

print("== quote function: security definer, pinned search_path and grants ==")
quote = list_block("supplier_order_quote").lower()
assert "security definer" in quote
assert "set search_path = public, pg_temp" in quote
assert "has_module_permission" in quote and "'purchase_orders', 'edit'" in quote
assert "supplier_order_line_price" in quote
assert "over_quantity_limit" in quote
assert "no_price" in quote
assert "over_amount_limit" in quote
assert "order_email_max_amount" in quote
assert "'list_price', v_list_price" in quote
assert "'list_price_includes_vat', v_list_price_includes_vat" in quote
assert "'gross_amount', v_gross_amount" in quote
assert re.search(
    r"grant\s+execute\s+on\s+function\s+public\.supplier_order_quote\(\s*uuid\s*,\s*jsonb\s*\)\s+to\s+authenticated\s*,\s*service_role",
    LIST_LOWER,
    re.DOTALL,
), "supplier_order_quote must be callable by authenticated + service_role"

print("== create and catalog use the quote / expose the list price ==")
create_multi = list_block("create_supplier_order_multi").lower()
assert "supplier_order_quote(p_supplier_id, p_lines)" in create_multi
assert "v_quote -> 'lines'" in create_multi
assert "supplier_order_request_lines" in create_multi
assert "'gross_amount'" in create_multi
assert "'vat_amount'" in create_multi
assert "over_amount_limit" in quote

catalog = list_block("supplier_order_catalog")
for field in (
    "'list_price', v_item.list_price",
    "'list_price_includes_vat', coalesce(v_item.list_price_includes_vat, false)",
    "'list_price_source', v_item.list_price_source",
    "'list_price_updated_at', v_item.list_price_updated_at",
    "'history_price', v_history_price",
    "'unit_price', v_unit_price",
    "'unit_price_gross', v_unit_price_gross",
):
    assert field in catalog, f"supplier_order_catalog is missing {field}"

print("== catalog_set 9-arg signature and list price behaviour ==")
assert re.search(
    r"drop\s+function\s+if\s+exists\s+public\.supplier_order_catalog_set\(\s*uuid\s*,\s*uuid\s*,\s*boolean\s*,\s*text\s*,\s*numeric\s*,\s*text\s*,\s*numeric\s*\)",
    LIST_LOWER,
    re.DOTALL,
), "the old 7-argument catalog_set must be dropped"
catalog_set = list_block("supplier_order_catalog_set").lower()
assert "p_list_price numeric default null" in catalog_set
assert "p_list_price_includes_vat boolean default null" in catalog_set
assert "invalid_list_price" in catalog_set
assert "'sửa trong trang đặt hàng'" in catalog_set
assert "list_price_updated_by" in catalog_set
assert re.search(
    r"grant\s+execute\s+on\s+function\s+public\.supplier_order_catalog_set\(\s*uuid\s*,\s*uuid\s*,\s*boolean\s*,\s*text\s*,\s*numeric\s*,\s*text\s*,\s*numeric\s*,\s*numeric\s*,\s*boolean\s*\)\s+to\s+authenticated\s*,\s*service_role",
    LIST_LOWER,
    re.DOTALL,
), "catalog_set must be granted with its 9-argument signature"

print("== history exposes gross_amount ==")
history = list_block("supplier_order_history_by_supplier").lower()
assert "'gross_amount', l.gross_amount" in history

print("== list price smoke checks the ĐH19993 numbers and rollback ==")
for token in (
    "12109259",
    "968741",
    "13078000",
    "20840",
    "20440",
    "152000",
    "supplier_order_quote",
    "gross_amount",
):
    assert token in PAGE_SMOKE, f"list price smoke is missing {token}"
assert re.search(r"^\s*begin\s*;", PAGE_SMOKE, re.IGNORECASE | re.MULTILINE)
assert re.search(r"^\s*rollback\s*;\s*$", PAGE_SMOKE, re.IGNORECASE | re.MULTILINE)
assert not re.search(r"^\s*commit\s*;", PAGE_SMOKE, re.IGNORECASE | re.MULTILINE)

print("== email unit price formatter ==")
EMAIL = (ROOT / "supabase/functions/_shared/supplier-order-email.ts").read_text(
    encoding="utf-8"
)
assert "export function formatUnitPrice" in EMAIL
assert "formatUnitPrice(line.unitPrice)" in EMAIL

print("supplier order page contract passed")

# ---------------------------------------------------------------------------
# Supplier ordering closed loop (20261102970000_supplier_order_loop.sql)
# ---------------------------------------------------------------------------

print("== supplier order loop migration ==")
LOOP_MIGRATIONS = sorted(
    ROOT.glob("supabase/migrations/*_supplier_order_loop.sql")
)
assert len(LOOP_MIGRATIONS) == 1, (
    f"expected exactly one supplier_order_loop migration, found {LOOP_MIGRATIONS}"
)
assert LOOP_MIGRATIONS[0].name.startswith("20261102970000"), LOOP_MIGRATIONS[0].name
LOOP_MIGRATION = LOOP_MIGRATIONS[0].read_text(encoding="utf-8")
LOOP_LOWER = LOOP_MIGRATION.lower()


def loop_block(name: str) -> str:
    match = re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
        LOOP_MIGRATION,
        re.IGNORECASE,
    )
    assert match, f"missing loop function public.{name}"
    tail = LOOP_MIGRATION[match.start():]
    end = tail.find("\n$$;")
    assert end != -1, f"unterminated loop function public.{name}"
    return tail[:end]


print("== permission backfill from purchase_orders editors ==")
assert re.search(
    r"insert\s+into\s+public\.user_module_permissions[\s\S]{0,200}?'supplier_orders'",
    LOOP_LOWER,
), "supplier_orders permission backfill is missing"
assert re.search(
    r"from\s+public\.user_module_permissions\s+p[\s\S]{0,200}?module_key\s*=\s*'purchase_orders'",
    LOOP_LOWER,
), "backfill must copy purchase_orders editors"
assert re.search(r"p\.can_edit\s*=\s*true", LOOP_LOWER)
assert "on conflict (user_id, module_key) do nothing" in LOOP_LOWER

print("== loop functions: security definer + pinned search_path ==")
loop_defs = re.findall(
    r"create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(",
    LOOP_MIGRATION,
    re.IGNORECASE,
)
assert loop_defs, "loop migration defines no functions"
for name in loop_defs:
    block = loop_block(name).lower()
    assert "security definer" in block, f"{name} must be security definer"
    assert "set search_path = public, pg_temp" in block, (
        f"{name} must pin search_path to public, pg_temp"
    )

print("== gates use supplier_orders ==")
for name in (
    "supplier_order_suppliers",
    "supplier_order_catalog",
    "supplier_order_catalog_candidates",
    "supplier_order_history",
    "supplier_order_history_by_supplier",
    "supplier_order_quote",
    "supplier_order_setting",
):
    block = loop_block(name).lower()
    assert "public.has_role(v_actor, 'owner')" in block, f"{name} must keep the owner gate"
    assert "public.has_module_permission(v_actor, 'supplier_orders', 'view')" in block, (
        f"{name} must allow supplier_orders view"
    )
    assert "public.has_module_permission(v_actor, 'supplier_orders', 'edit')" in block, (
        f"{name} must allow supplier_orders edit"
    )
    assert "'purchase_orders', 'edit'" not in block, (
        f"{name} must no longer gate on purchase_orders edit"
    )

for name in ("supplier_order_catalog_set", "prepare_supplier_order"):
    block = loop_block(name).lower()
    assert "public.has_role(v_actor, 'owner')" in block, f"{name} must keep the owner gate"
    assert "public.has_module_permission(v_actor, 'supplier_orders', 'edit')" in block, (
        f"{name} must require supplier_orders edit"
    )
    assert "public.has_module_permission(v_actor, 'supplier_orders', 'view')" not in block, (
        f"{name} must not accept view permission"
    )
    assert "'purchase_orders', 'edit'" not in block, (
        f"{name} must no longer gate on purchase_orders edit"
    )

print("== queue/evidence columns and policies ==")
for column in (
    "goods_receipt_id uuid",
    "payment_request_id uuid",
    "receipt_queue_error text",
):
    assert re.search(
        r"add\s+column\s+if\s+not\s+exists\s+" + column.replace(" ", r"\s+"),
        LOOP_LOWER,
    ), f"missing supplier_order_requests column {column}"
assert re.search(
    r"drop\s+policy\s+if\s+exists\s+supplier_delivery_docs_read\s+on\s+storage\.objects",
    LOOP_LOWER,
)
assert re.search(
    r"create\s+policy\s+supplier_delivery_docs_read\s+on\s+storage\.objects"
    r"[\s\S]{0,500}?'supplier_orders', 'view'",
    LOOP_LOWER,
)
for policy in (
    "supplier_order_requests_select",
    "supplier_order_request_lines_select",
    "supplier_order_uploads_select",
):
    assert re.search(
        rf"create\s+policy\s+{policy}\s+on\s+public\.\w+[\s\S]{{0,500}}?'supplier_orders', 'view'",
        LOOP_LOWER,
    ), f"{policy} must allow supplier_orders view"

print("== receipt queue opener ==")
queue = loop_block("supplier_order_open_receipt_queue").lower()
assert "ensure_purchase_order_receipt_queue" in queue
assert "p_request_id or r.id = p_request_id" in queue
assert "r.status = 'sent'" in queue
assert "request.jwt.claim.sub" in queue
assert "request.jwt.claims" in queue
assert "receipt_queue_error = left(sqlerrm, 2000)" in queue
assert "'goods_receipt_id', v_receipt.id" in queue
assert "'payment_request_id', v_payment.id" in queue
assert "'receipt_number', v_receipt.receipt_number" in queue
assert "'request_number', v_payment.request_number" in queue

print("== attach evidence only fills empty images ==")
evidence = loop_block("supplier_order_attach_evidence").lower()
assert "update public.purchase_orders" in evidence
assert "update public.goods_receipts" in evidence
assert "update public.payment_requests" in evidence
assert evidence.count("btrim(image_url) = ''") >= 3, (
    "attach_evidence must only overwrite null/empty images"
)
assert "'purchase_order_image_set'" in evidence
assert "'goods_receipt_image_set'" in evidence
assert "'payment_request_image_set'" in evidence

record_loop = loop_block("record_supplier_order_upload").lower()
assert "'purchase_order_id', v_request.purchase_order_id" in record_loop

print("== service-role-only grants on the new functions ==")
for name in ("supplier_order_open_receipt_queue", "supplier_order_attach_evidence"):
    assert re.search(
        rf"revoke\s+all\s+on\s+function\s+public\.{name}\([^;]*?\)\s*from\s+public\s*,\s*anon\s*,\s*authenticated",
        LOOP_LOWER,
        re.DOTALL,
    ), f"{name} must revoke public/anon/authenticated"
    assert re.search(
        rf"grant\s+execute\s+on\s+function\s+public\.{name}\([^;]*?\)\s*to\s+service_role\s*;",
        LOOP_LOWER,
        re.DOTALL,
    ), f"{name} must be service_role only"

print("== history chain columns ==")
history_loop = loop_block("supplier_order_history_by_supplier").lower()
assert "'po_status', r.po_status" in history_loop
assert "'receipt', case" in history_loop
assert "'receipt_number', gr.receipt_number" in history_loop
assert "'finalized_at', gr.finalized_at" in history_loop
assert "'payment', case" in history_loop
assert "'payment_status', pay.payment_status" in history_loop
assert "'total_amount', pay.total_amount" in history_loop

print("== PO-000865 backfill ==")
assert "PO-000865" in LOOP_MIGRATION
assert "supplier_order_open_receipt_queue" in LOOP_MIGRATION
backfill = LOOP_LOWER.split("po-000865", 1)[1]
assert "exists" in backfill and "goods_receipts" in backfill
assert "payment_requests" in backfill
assert "13078000" in LOOP_MIGRATION or "13.078.000" in LOOP_MIGRATION
assert "968741" in LOOP_MIGRATION or "968.741" in LOOP_MIGRATION

print("== loop smoke is rollback-only and covers the acceptance paths ==")
LOOP_SMOKE = (ROOT / "scripts/smoke_supplier_order_loop.sql").read_text(encoding="utf-8")
assert re.search(r"^\s*begin\s*;", LOOP_SMOKE, re.IGNORECASE | re.MULTILINE)
assert re.search(r"^\s*rollback\s*;\s*$", LOOP_SMOKE, re.IGNORECASE | re.MULTILINE)
assert not re.search(r"^\s*commit\s*;", LOOP_SMOKE, re.IGNORECASE | re.MULTILINE)
loop_non_comment = [
    line.strip()
    for line in LOOP_SMOKE.splitlines()
    if line.strip() and not line.strip().startswith("--")
]
assert loop_non_comment[-1].lower() == "rollback;"
for token in (
    "create_supplier_order_multi",
    "mark_supplier_order_sent",
    "supplier_order_open_receipt_queue",
    "supplier_order_attach_evidence",
    "PO-000865",
    "13078000",
    "968741",
    "insufficient_privilege",
    "supplier_order_catalog_set",
    "supplier_order_history",
):
    assert token in LOOP_SMOKE, f"loop smoke is missing {token}"

print("== send edge opens the queue after mark_sent and before gối đầu ==")
assert "supplier_order_open_receipt_queue" in send_source
assert send_source.index('admin.rpc("mark_supplier_order_sent"') < send_source.index(
    'admin.rpc("supplier_order_open_receipt_queue"'
)
assert send_source.index('admin.rpc("supplier_order_open_receipt_queue"') < send_source.index(
    'userDb.rpc("create_payment_submission"'
)
assert "receipt_number" in send_source
assert "request_number" in send_source

print("== upload edge copies evidence into purchase-orders and attaches it ==")
assert "supplier_order_attach_evidence" in upload_source
assert "supplier_order_open_receipt_queue" in upload_source
assert re.search(r'\.from\("purchase-orders"\)', upload_source), (
    "upload edge must copy into the purchase-orders bucket"
)
assert re.search(r"-\$\{Date\.now\(\)\}\.\$\{extension\}", upload_source), (
    "upload edge must use the PO-number-supplier-timestamp naming"
)
assert "receipt_queue_failed" in upload_source
assert "evidence_attach_failed" in upload_source

print("supplier order loop contract passed")
