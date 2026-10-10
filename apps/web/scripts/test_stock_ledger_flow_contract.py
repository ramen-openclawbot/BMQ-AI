#!/usr/bin/env python3
"""Static contract for the 2026-10-13 stock ledger flow migration.

Checks the migration ships fixed search_path security definer functions, uses
the expected idempotency keys, gates writes on the configured cutover, never
redefines finalize_goods_receipt, enables RLS on the new tables and keeps the
normalization test cases shared with the TS layer and the SQL smoke.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_PATH = ROOT / "supabase/migrations/20261013100000_stock_ledger_flow.sql"
TS_PATH = ROOT / "src/lib/stock-ledger.ts"
TEST_PATH = ROOT / "src/lib/stock-ledger.test.ts"
SMOKE_PATH = ROOT / "scripts/smoke_stock_ledger_flow.sql"

MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
TS = TS_PATH.read_text(encoding="utf-8")
TS_TEST = TEST_PATH.read_text(encoding="utf-8")
SMOKE = SMOKE_PATH.read_text(encoding="utf-8")

FUNCTION_RE = re.compile(
    r"create\s+or\s+replace\s+function\s+public\.(?P<name>[a-z0-9_]+)\s*\(",
    re.IGNORECASE,
)


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


SECURITY_DEFINER_FUNCTIONS = [
    "stock_ledger_cutover_date",
    "resolve_stock_material_alias",
    "stock_goods_receipt_item_is_posted",
    "post_stock_goods_receipt_item",
    "post_goods_receipt_to_stock",
    "stock_ledger_default_goods_receipt_location",
    "trg_stock_ledger_goods_receipt",
    "resolve_stock_alias",
    "set_supplier_receiving_location",
    "set_goods_receipt_receiving_location",
    "post_material_issue_usage",
    "reverse_material_issue_usage",
    "trg_stock_ledger_material_issue",
    "confirm_q7_material_issue",
    "record_q7_stock_count",
    "stock_ledger_tan_tao_stock_count_cutover",
    "get_stock_ledger_overview",
]

for function_name in SECURITY_DEFINER_FUNCTIONS:
    block = function_block(function_name)
    lowered = block.lower()
    assert "security definer" in lowered, f"{function_name} must be security definer"
    assert "set search_path" in lowered, f"{function_name} must pin search_path"

# The pure normalization function must stay immutable with a pinned search_path.
normalize_block = function_block("normalize_stock_item_name").lower()
assert "immutable" in normalize_block
assert "set search_path" in normalize_block

# Exactly one definition per new function: no accidental duplicate CREATE OR REPLACE.
for match in FUNCTION_RE.finditer(MIGRATION):
    name = match.group("name")
    if name in SECURITY_DEFINER_FUNCTIONS or name == "normalize_stock_item_name":
        occurrences = len(
            re.findall(
                rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
                MIGRATION,
                re.IGNORECASE,
            )
        )
        assert occurrences == 1, f"{name} is defined {occurrences} times"

# Payable/payment logic stays untouched.
assert not re.search(
    r"create\s+or\s+replace\s+function\s+public\.finalize_goods_receipt",
    MIGRATION,
    re.IGNORECASE,
), "finalize_goods_receipt must not be redefined"

# Idempotency keys.
for key in ("'gr-item:'", "'pmi-item:'", "'pmi-item-reverse:'"):
    assert key in MIGRATION, f"missing idempotency key {key}"

# Cutover gating.
assert "stock_ledger_cutover_date" in MIGRATION
assert "before_cutover" in MIGRATION
assert "cutover_not_set" in MIGRATION
assert "receipt_date < v_cutover" in MIGRATION
assert "issue_date < v_cutover" in MIGRATION

# Location columns and constraints.
assert "add column if not exists receiving_location text" in MIGRATION
assert "add column if not exists default_receiving_location text" in MIGRATION
assert "receiving_location is null or receiving_location in ('q7', 'tan_tao')" in MIGRATION
assert "unique (supplier_id, normalized_name, location)" in MIGRATION

# RLS on the new tables.
for table in ("stock_ledger_settings", "stock_material_aliases"):
    assert re.search(
        rf"alter\s+table\s+public\.{table}\s+enable\s+row\s+level\s+security",
        MIGRATION,
        re.IGNORECASE,
    ), f"RLS must be enabled on {table}"

# RLS policies reuse the existing permission helpers per location.
assert "q7_material_inventory_can_view" in MIGRATION
assert "q7_material_inventory_can_edit" in MIGRATION
assert "can_view_tan_tao_warehouse" in MIGRATION
assert "can_manage_tan_tao_warehouse" in MIGRATION

# Shared normalization test cases must appear in SQL, TS and the SQL smoke.
SHARED_CASES = [
    ("tỏi ngày 10", "toi"),
    ("bánh mì lớn 17", "banh mi lon"),
    ("Chả lụa lá TVP XL (kg)", "cha lua la tvp xl"),
]
for source, expected in SHARED_CASES:
    assert source in TS, f"TS normalize case missing input: {source}"
    assert f'"{expected}"' in TS, f"TS normalize case missing output: {expected}"
    assert source in SMOKE, f"smoke normalize case missing input: {source}"
    assert expected in SMOKE, f"smoke normalize case missing output: {expected}"

# The TS layer declares the shared case table used by the node test.
assert "NORMALIZE_STOCK_ITEM_NAME_TEST_CASES" in TS
assert "NORMALIZE_STOCK_ITEM_NAME_TEST_CASES" in TS_TEST
assert "parseStockLedgerOverview" in TS
assert "isLowStock" in TS

print("stock ledger flow contract passed")
