#!/usr/bin/env python3
"""Static contract for the 2026-11-02 Q7 purchase-vs-usage report.

Read-only checks:
  * both RPCs exist and are stable security definers with a pinned search_path;
  * both gate on service_role / owner / inventory view / q7_material_inventory view;
  * grants match the read-only contract and the internal helper is not executable
    by authenticated;
  * purchase lines use the same alias, non-stock, effective-quantity and unit
    conversion helpers as the stock ledger;
  * direct purchases require an approved request with no receipt and no PO;
  * usage uses the same approved-mapping / decision-exclusion rules as
    public.post_material_issue_usage;
  * every status and the 3 / (1/3) thresholds are present;
  * the migration creates only functions (no writes, tables, triggers or views).
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_PATH = ROOT / "supabase/migrations/20261102230000_q7_purchase_usage_report.sql"
MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
LOWER = MIGRATION.lower()

FUNCTION_RE = re.compile(
    r"create\s+or\s+replace\s+function\s+public\.(?P<name>[a-z0-9_]+)\s*\(",
    re.IGNORECASE,
)

REPORT = "get_q7_purchase_usage_report"
DETAIL = "get_q7_purchase_usage_item_detail"
HELPER = "q7_purchase_usage_purchase_lines"


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


print("== functions are stable security definers with pinned search_path ==")
for name in (REPORT, DETAIL):
    block = function_block(name)
    lowered = block.lower()
    assert "language plpgsql" in lowered, f"{name} must be plpgsql"
    assert "stable" in lowered, f"{name} must be stable"
    assert "security definer" in lowered, f"{name} must be security definer"
    assert re.search(
        rf"set\s+search_path\s*=\s*public\s*,\s*pg_temp", lowered
    ), f"{name} must pin search_path = public, pg_temp"
    occurrences = len(
        re.findall(
            rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
            MIGRATION,
            re.IGNORECASE,
        )
    )
    assert occurrences == 1, f"{name} is defined {occurrences} times"

helper_block = function_block(HELPER)
assert "stable" in helper_block.lower()
assert "security definer" in helper_block.lower()
assert re.search(
    r"set\s+search_path\s*=\s*public\s*,\s*pg_temp", helper_block.lower()
)

print("== permission gate ==")
for name in (REPORT, DETAIL):
    block = function_block(name)
    assert "insufficient_privilege" in block
    assert "42501" in block
    assert "coalesce(auth.role(), '')" in block
    assert "'service_role'" in block
    assert "auth.uid() is not null" in block
    assert "public.has_role(auth.uid(), 'owner'::app_role)" in block
    assert re.search(
        r"public\.has_module_permission\(auth\.uid\(\),\s*'inventory',\s*'view'\)",
        block,
    ), f"{name} must allow inventory view"
    assert re.search(
        r"public\.has_module_permission\(auth\.uid\(\),\s*'q7_material_inventory',\s*'view'\)",
        block,
    ), f"{name} must allow q7_material_inventory view"

print("== date defaults and range guard ==")
for name in (REPORT, DETAIL):
    block = function_block(name)
    assert re.search(r"p_from\s+date\s+default\s+null", block)
    assert re.search(r"p_to\s+date\s+default\s+null", block)
    assert "Asia/Ho_Chi_Minh" in block
    assert "invalid_range" in block
    assert "22023" in block
    assert "366" in block
    assert "date_trunc('month'" in block
    assert "interval '2 months'" in block

detail_block = function_block(DETAIL)
assert "item_not_found" in detail_block
assert "P0002" in detail_block

print("== grants ==")
assert re.search(
    r"revoke\s+all\s+on\s+function\s+public\.get_q7_purchase_usage_report"
    r"\s*\(\s*date\s*,\s*date\s*\)\s+from\s+public\s*,\s*anon\s*;",
    MIGRATION,
    re.IGNORECASE,
), "report must be revoked from public, anon"
assert re.search(
    r"grant\s+execute\s+on\s+function\s+public\.get_q7_purchase_usage_report"
    r"\s*\(\s*date\s*,\s*date\s*\)\s+to\s+authenticated\s*,\s*service_role\s*;",
    MIGRATION,
    re.IGNORECASE,
), "report must be granted to authenticated, service_role"
assert re.search(
    r"revoke\s+all\s+on\s+function\s+public\.get_q7_purchase_usage_item_detail"
    r"\s*\(\s*uuid\s*,\s*date\s*,\s*date\s*\)\s+from\s+public\s*,\s*anon\s*;",
    MIGRATION,
    re.IGNORECASE,
), "detail must be revoked from public, anon"
assert re.search(
    r"grant\s+execute\s+on\s+function\s+public\.get_q7_purchase_usage_item_detail"
    r"\s*\(\s*uuid\s*,\s*date\s*,\s*date\s*\)\s+to\s+authenticated\s*,\s*service_role\s*;",
    MIGRATION,
    re.IGNORECASE,
), "detail must be granted to authenticated, service_role"

assert re.search(
    r"revoke\s+all\s+on\s+function\s+public\.q7_purchase_usage_purchase_lines"
    r"\s*\(\s*date\s*,\s*date\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;",
    MIGRATION,
    re.IGNORECASE,
), "helper must be revoked from public, anon and authenticated"
helper_grants = re.findall(
    r"grant\s+execute\s+on\s+function\s+public\.q7_purchase_usage_purchase_lines[^;]*;",
    MIGRATION,
    re.IGNORECASE,
)
assert helper_grants, "helper must be granted to service_role"
for grant in helper_grants:
    assert "service_role" in grant.lower(), "helper grant must include service_role"
    assert "authenticated" not in grant.lower(), "helper must not reach authenticated"

print("== purchase lines use the stock ledger helpers ==")
for helper in (
    "resolve_stock_material_alias",
    "stock_line_auto_non_stock",
    "goods_receipt_effective_quantity",
    "stock_unit_line_factor",
    "stock_unit_pack_factor",
    "normalize_stock_item_name",
):
    assert helper in helper_block, f"purchase lines must use {helper}"

helper_lower = helper_block.lower()
assert "'confirmed', 'received'" in helper_lower
assert "'non_stock'" in helper_lower
assert "conversion_factor" in helper_lower
assert "greatest(" in helper_lower and "round(" in helper_lower
assert "'goods_receipt'::text" in helper_lower
assert "'payment_request'::text" in helper_lower

print("== direct purchases are approved, receipt-less and PO-less ==")
assert re.search(r"status::text\s*=\s*'approved'", helper_lower)
assert "goods_receipt_id is null" in helper_lower
assert "purchase_order_id is null" in helper_lower
assert re.search(
    r"created_at at time zone 'asia/ho_chi_minh'\)::date", helper_lower
)
assert re.search(r"resolve_stock_material_alias\([^)]*'q7'\)", helper_lower)
assert re.search(r"resolve_stock_material_alias\([^)]*'tan_tao'\)", helper_lower)

print("== usage mirrors post_material_issue_usage ==")
for name in (REPORT, DETAIL):
    block = function_block(name).lower()
    assert "location_code = 'q7'" in block
    assert "is_current is true" in block
    assert "status in ('pdf_ready', 'posted')" in block
    assert "q7_material_issue_material_mappings" in block
    assert "approval_status = 'approved'" in block
    assert "q7_bom_line_decisions" in block
    assert "'not_tracked', 'bom_error'" in block
    assert "lower(btrim(d.source_unit))" in block
    assert "coalesce(i.source_unit, '')" in block
    assert "coalesce(kii.item_class, '') <> 'non_stock'" in block
    assert "required_qty::text not in ('nan', 'infinity', '-infinity')" in block

print("== statuses and thresholds ==")
report_block = function_block(REPORT).lower()
for status in ("big_gap", "needs_conversion", "no_purchase_link", "ok", "not_in_recipe"):
    assert f"'{status}'" in report_block, f"missing status {status}"
assert re.search(r">\s*3", report_block), "big_gap upper threshold 3 is missing"
assert "1.0 / 3.0" in report_block or "1/3" in report_block, "big_gap lower threshold is missing"
assert "round(" in report_block and ", 2)" in report_block, "ratio must round to 2"

print("== migration only defines functions ==")
defined = {match.group("name").lower() for match in FUNCTION_RE.finditer(MIGRATION)}
assert defined == {REPORT, DETAIL, HELPER}, f"unexpected functions: {sorted(defined)}"

FORBIDDEN = (
    (r"\binsert\s+into\b", "insert"),
    (r"\bupdate\s+[a-z_][a-z0-9_]*\s+set\b", "update"),
    (r"\bdelete\s+from\b", "delete"),
    (r"\bcreate\s+table\b", "create table"),
    (r"\bcreate\s+trigger\b", "create trigger"),
    (r"\balter\s+table\b", "alter table"),
    (r"\bcreate\s+(?:or\s+replace\s+)?view\b", "create view"),
)
for pattern, label in FORBIDDEN:
    assert not re.search(pattern, LOWER), f"migration must not contain {label}"

print("q7 purchase usage contract passed")
