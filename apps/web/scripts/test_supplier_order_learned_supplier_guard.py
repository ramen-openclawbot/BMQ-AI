#!/usr/bin/env python3
"""Static contract for the learned-supplier / price-outlier proposal guard.

Checks that migration 20261103340000 redefines supplier_order_catalog with the
new flags while keeping the security-definer shape and the public/anon revoke,
and that its smoke test stays rollback-only.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = (
    ROOT
    / "supabase/migrations/20261103340000_supplier_order_learned_supplier_guard.sql"
)

assert MIGRATION.exists(), f"missing migration {MIGRATION.name}"
TEXT = MIGRATION.read_text(encoding="utf-8")
LOWER = TEXT.lower()

match = re.search(
    r"create\s+or\s+replace\s+function\s+public\.supplier_order_catalog"
    r"\s*\(\s*p_supplier_id\s+uuid\s*\)",
    TEXT,
    re.IGNORECASE,
)
assert match, "migration must redefine public.supplier_order_catalog(uuid)"
tail = TEXT[match.start():]
end = tail.find("\n$$;")
assert end != -1, "unterminated supplier_order_catalog definition"
BLOCK = tail[:end]
BLOCK_LOWER = BLOCK.lower()

print("== redefines supplier_order_catalog with the same signature ==")
assert re.search(r"returns\s+jsonb", BLOCK_LOWER)
assert "language plpgsql" in BLOCK_LOWER
assert "stable" in BLOCK_LOWER

print("== keeps security definer, pinned search_path and grants ==")
assert "security definer" in BLOCK_LOWER
assert "set search_path = public, pg_temp" in BLOCK_LOWER
assert re.search(
    r"revoke\s+all\s+on\s+function\s+public\.supplier_order_catalog"
    r"\s*\(\s*uuid\s*\)\s+from\s+public\s*,\s*anon\s*;",
    LOWER,
), "supplier_order_catalog must keep revoking public/anon"
assert re.search(
    r"grant\s+execute\s+on\s+function\s+public\.supplier_order_catalog"
    r"\s*\(\s*uuid\s*\)\s+to\s+authenticated\s*,\s*service_role\s*;",
    LOWER,
), "supplier_order_catalog must stay callable by authenticated + service_role"

print("== learned supplier guard ==")
assert "warehouse_item_learning" in BLOCK_LOWER
assert "learned_supplier_id" in BLOCK_LOWER
assert re.search(
    r"if\s+v_learned_supplier_mismatch\s+then", BLOCK_LOWER
), "the tan_tao branch must zero the suggestion on a learned-supplier mismatch"
assert "'learned_supplier_mismatch', v_learned_supplier_mismatch" in BLOCK
assert "'learned_supplier', v_learned_supplier" in BLOCK

print("== price outlier guard ==")
assert "supplier_order_line_price" in BLOCK_LOWER
assert "'price_outlier', v_price_outlier" in BLOCK
assert "'reference_price', v_reference_price" in BLOCK
assert re.search(r"'supplier_id',\s*v_reference_supplier_id", BLOCK)
assert re.search(r"'supplier_name',\s*v_reference_supplier_name", BLOCK)
assert re.search(r"'unit_price',\s*v_reference_unit_price", BLOCK)
assert "> 3" in BLOCK
assert "1.0 / 3" in BLOCK

print("== both guards only zero the proposal ==")
assert re.search(
    r"if\s+v_price_outlier\s+or\s+v_learned_supplier_mismatch\s+then"
    r"\s*v_proposal\s*:=\s*0;",
    BLOCK_LOWER,
), "price_outlier / learned_supplier_mismatch must set proposal_qty to 0"

print("== smoke is rollback-only and asserts both suppliers ==")
SMOKE = ROOT / "scripts/smoke_supplier_order_learned_supplier_guard.sql"
assert SMOKE.exists(), f"missing smoke {SMOKE.name}"
SMOKE_TEXT = SMOKE.read_text(encoding="utf-8")
SMOKE_LOWER = SMOKE_TEXT.lower()
assert re.search(r"^\s*begin\s*;", SMOKE_TEXT, re.IGNORECASE | re.MULTILINE)
assert re.search(r"^\s*rollback\s*;\s*$", SMOKE_TEXT, re.IGNORECASE | re.MULTILINE)
assert not re.search(r"^\s*commit\s*;", SMOKE_TEXT, re.IGNORECASE | re.MULTILINE)
for token in (
    "dad2d28e-4f0b-4e6f-b07c-4497b14968e6",
    "ecd49e72-96fe-465d-b8a5-2c474aa7d6ae",
    "1891a408-b223-41c9-aa3a-b192e8d2e6f8",
    "52c6aea1-ff28-449f-accb-e2482128c339",
    "supplier_order_catalog",
    "proposal_qty",
    "learned_supplier_mismatch",
    "price_outlier",
    "set local role service_role",
):
    assert token in SMOKE_LOWER, f"smoke is missing {token}"

print("supplier order learned supplier guard contract passed")
