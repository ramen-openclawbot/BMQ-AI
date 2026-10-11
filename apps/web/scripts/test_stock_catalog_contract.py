#!/usr/bin/env python3
"""Static contract for the 2026-10-15 stock catalog cleanup migration.

The Q7 ledger is append-only, so a merge may never UPDATE or DELETE
q7_inventory_movements / q7_inventory_openings / q7_inventory_opening_audit_logs.
It moves stock with new signed adjustment movements instead. This contract pins
that design: every new function pins its search_path (and the RPCs are security
definer), the new tables carry RLS plus explicit grants, no payable / receipt /
PO / allocation table is written, apply_stock_item_merge only moves and converts
the four allowed reference tables, the forward trigger skips its own item_merge
rows, and the edge function keeps its kill switch and daily quota.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_PATH = ROOT / "supabase/migrations/20261015100000_stock_catalog_cleanup.sql"
MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
LOWER = MIGRATION.lower()

EDGE_DIR = ROOT / "supabase/functions/stock-catalog-jev"
EDGE_INDEX = (EDGE_DIR / "index.ts").read_text(encoding="utf-8")
EDGE_HANDLER = (EDGE_DIR / "handler.ts").read_text(encoding="utf-8")
EDGE_STORE = (EDGE_DIR / "store.ts").read_text(encoding="utf-8")
EDGE_JEV = (EDGE_DIR / "jev.ts").read_text(encoding="utf-8")

CONFIG = (ROOT / "supabase/config.toml").read_text(encoding="utf-8")

FUNCTION_RE = re.compile(
    r"create\s+or\s+replace\s+function\s+public\.(?P<name>[a-z0-9_]+)\s*\(",
    re.IGNORECASE,
)

SECURITY_DEFINER_FUNCTIONS = [
    "get_stock_catalog_candidates",
    "stock_item_merge_resolve",
    "stock_item_merge_forward",
    "apply_stock_item_merge",
    "decide_stock_catalog_suggestion",
    "revert_stock_item_merge",
    "link_kitchen_items_to_canonical_materials",
    "get_stock_catalog_review",
]

IMMUTABLE_FUNCTIONS = [
    "stock_catalog_normalize_unit",
    "stock_unit_factor",
    "stock_catalog_item_tokens",
    "stock_catalog_token_jaccard",
]

ALL_NEW_FUNCTIONS = SECURITY_DEFINER_FUNCTIONS + IMMUTABLE_FUNCTIONS

# The eight reference tables that keep their historical link to the retired
# source item and must never be rewritten by the merge engine.
FORBIDDEN_REFERENCE_TABLES = [
    "kitchen_inventory_import_rows",
    "kitchen_inventory_item_audit_logs",
    "kitchen_inventory_monthly_closings",
    "kitchen_inventory_movements",
    "q7_auto_purchase_decisions",
    "q7_inventory_movements",
    "q7_inventory_opening_audit_logs",
    "q7_inventory_openings",
]

# The four reference tables apply/revert are still allowed to move and convert.
ALLOWED_REFERENCE_TABLES = [
    "production_material_issue_items",
    "q7_material_issue_material_mappings",
    "stock_material_aliases",
    "q7_purchase_item_settings",
]

OLD_SOURCES = [
    "manual_receipt",
    "signed_q7_issue",
    "manual_adjustment",
    "goods_receipt",
    "production_material_issue",
    "production_material_issue_reversal",
]

UPDATE_RE = re.compile(r"\bupdate\s+public\.([a-z0-9_]+)", re.IGNORECASE)
DELETE_RE = re.compile(r"\bdelete\s+from\s+public\.([a-z0-9_]+)", re.IGNORECASE)


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


def write_targets(block: str) -> set:
    names = {m.group(1).lower() for m in UPDATE_RE.finditer(block)}
    names |= {m.group(1).lower() for m in DELETE_RE.finditer(block)}
    return names


print("== security definer + pinned search_path ==")
for name in ALL_NEW_FUNCTIONS:
    block = function_block(name).lower()
    assert "set search_path" in block, f"{name} must pin search_path"
    occurrences = len(
        re.findall(
            rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
            MIGRATION,
            re.IGNORECASE,
        )
    )
    assert occurrences == 1, f"{name} is defined {occurrences} times"

for name in SECURITY_DEFINER_FUNCTIONS:
    assert "security definer" in function_block(name).lower(), f"{name} must be security definer"

for name in IMMUTABLE_FUNCTIONS:
    assert "immutable" in function_block(name).lower(), f"{name} must be immutable"

print("== no existing function is redefined ==")
EXISTING_FUNCTIONS = [
    "normalize_stock_item_name",
    "q7_material_inventory_can_view",
    "q7_material_inventory_can_edit",
    "link_approved_material_resolution",
    "resolve_q7_canonical_inventory_item",
    "get_stock_ledger_overview",
    "record_q7_stock_count",
    "confirm_q7_material_issue",
    "apply_approved_material_reconciliation",
    "reverse_material_issue_usage",
    "post_material_issue_usage",
]
for name in EXISTING_FUNCTIONS:
    assert not re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
        MIGRATION,
        re.IGNORECASE,
    ), f"{name} must not be redefined"

defined = {match.group("name").lower() for match in FUNCTION_RE.finditer(MIGRATION)}
assert defined == {name.lower() for name in ALL_NEW_FUNCTIONS}, (
    f"unexpected function definitions: {sorted(defined)}"
)

print("== RLS + explicit grants on the new tables ==")
NEW_TABLES = [
    "stock_catalog_suggestions",
    "stock_catalog_jev_usage",
    "stock_item_merges",
    "stock_item_merge_rows",
]
for table in NEW_TABLES:
    assert re.search(
        rf"alter\s+table\s+public\.{table}\s+enable\s+row\s+level\s+security",
        MIGRATION,
        re.IGNORECASE,
    ), f"RLS must be enabled on {table}"
    assert re.search(
        rf"grant\s+[a-z, ]+\s+on\s+table\s+public\.{table}\s+to\s+",
        MIGRATION,
        re.IGNORECASE,
    ), f"explicit grant missing for {table}"
    assert re.search(
        rf"create\s+policy\s+\w+\s+on\s+public\.{table}\s+for\s+select",
        MIGRATION,
        re.IGNORECASE,
    ), f"select policy missing for {table}"

assert "q7_material_inventory_can_view" in MIGRATION
assert "q7_material_inventory_can_edit" in MIGRATION

print("== no payable / receipt / PO / allocation write ==")
for table in ("payment_requests", "goods_receipts", "purchase_orders", "payment_allocations"):
    assert not re.search(
        rf"\b(update|delete\s+from)\s+(public\.)?{table}\b", LOWER
    ), f"migration must not write {table}"

print("== append-only ledger: no update/delete on the forbidden reference tables ==")
for table in FORBIDDEN_REFERENCE_TABLES:
    assert not re.search(
        rf"\bupdate\s+public\.{re.escape(table)}\b", LOWER
    ), f"migration must not update {table}"
    assert not re.search(
        rf"\bdelete\s+from\s+public\.{re.escape(table)}\b", LOWER
    ), f"migration must not delete from {table}"

# Explicit call-outs from the design: the Q7 ledger and its audit log.
assert "update public.q7_inventory_movements" not in LOWER
assert "delete from public.q7_inventory_movements" not in LOWER
assert "update public.q7_inventory_opening_audit_logs" not in LOWER
assert "delete from public.q7_inventory_opening_audit_logs" not in LOWER
assert "update public.q7_inventory_openings" not in LOWER
assert "delete from public.q7_inventory_openings" not in LOWER

print("== apply_stock_item_merge moves the four allowed reference tables only ==")
apply_block = function_block("apply_stock_item_merge")
for table in ALLOWED_REFERENCE_TABLES:
    assert table in apply_block, f"apply_stock_item_merge must still move {table}"
applied_reference = write_targets(apply_block) & set(FORBIDDEN_REFERENCE_TABLES)
assert not applied_reference, f"apply_stock_item_merge must not write {sorted(applied_reference)}"

assert "insert into public.stock_item_merge_rows" in apply_block
assert "old_values" in apply_block and "new_values" in apply_block
assert "merged_into_id = p_target" in apply_block
assert "active = false" in apply_block

print("== stock moves as append-only item_merge adjustments ==")
assert "item-merge:" in MIGRATION
assert "item-merge-revert:" in MIGRATION
assert "get_q7_inventory_snapshot" in apply_block, "apply must read the source balance"
assert "insert into public.q7_inventory_movements" in apply_block
assert "'item_merge'" in apply_block
assert "on conflict (source, source_ref_key)" in apply_block

print("== source CHECK keeps every old value and adds the merge keys ==")
source_check = re.search(
    r"add\s+constraint\s+q7_inventory_movements_source_check\s+"
    r"check\s+\(source\s+in\s+\(([^)]*)\)\)",
    MIGRATION,
    re.IGNORECASE,
)
assert source_check, "missing q7_inventory_movements_source_check"
constraint_body = source_check.group(1)
for value in OLD_SOURCES + ["item_merge", "item_merge_revert"]:
    assert f"'{value}'" in constraint_body, f"source check is missing {value}"

print("== forward trigger mirrors rows of an already-merged item ==")
forward_block = function_block("stock_item_merge_forward").lower()
assert "new.source in ('item_merge', 'item_merge_revert')" in forward_block, (
    "forward trigger must skip its own item_merge rows"
)
assert "stock_item_merge_resolve" in forward_block
assert re.search(
    r"create\s+trigger\s+q7_inventory_movements_item_merge_forward\s+"
    r"after\s+insert\s+on\s+public\.q7_inventory_movements",
    MIGRATION,
    re.IGNORECASE,
), "forward trigger must run AFTER INSERT on q7_inventory_movements"

print("== merge resolver limits the chain depth ==")
resolve_block = function_block("stock_item_merge_resolve").lower()
assert "merged_into_id" in resolve_block and "merged_factor" in resolve_block
assert "> 5" in resolve_block and "too_deep" in resolve_block
assert "cycle" in resolve_block, "resolver must detect a cyclic chain"

print("== suggestion / merge bookkeeping ==")
assert "least(item_id, coalesce(other_item_id, item_id))" in MIGRATION
assert "greatest(item_id, coalesce(other_item_id, item_id))" in MIGRATION
assert "factor_source in ('unit_rule', 'none')" in MIGRATION
assert re.search(r"call_limit\s+integer\s+not\s+null\s+default\s+600", LOWER)
assert "stock_unit_factor" in function_block("get_stock_catalog_candidates")

print("== revert restores the four tables and appends reversal adjustments ==")
revert_block = function_block("revert_stock_item_merge")
assert "stock_item_merge_rows" in revert_block
assert "jsonb_populate_record" in revert_block
assert "active = true" in revert_block
assert "status = 'reverted'" in revert_block
for table in ALLOWED_REFERENCE_TABLES:
    assert table in revert_block, f"revert must restore {table}"
reverted_forbidden = write_targets(revert_block) & set(FORBIDDEN_REFERENCE_TABLES)
assert not reverted_forbidden, f"revert must not write {sorted(reverted_forbidden)}"
assert "merge_revert_unsupported_table" in revert_block, "revert must refuse unlisted tables"
assert "'item_merge_revert'" in revert_block
assert "item-merge-revert:" in revert_block
assert "'item-merge:' || p_merge_id::text || ':%'" in revert_block

print("== edge function kill switch + daily quota ==")
assert "BMQ_JEV_KILL_SWITCH" in EDGE_INDEX
assert "stock_catalog_jev_usage" in EDGE_STORE
assert "STOCK_CATALOG_DAILY_CALL_LIMIT" in EDGE_HANDLER
assert "call_limit" in EDGE_HANDLER
assert "AI_GATEWAY_API_KEY" in EDGE_INDEX
assert "JEV_TIMEOUT_MS = 4000" in EDGE_JEV
assert "[functions.stock-catalog-jev]" in CONFIG

print("stock catalog contract passed")
