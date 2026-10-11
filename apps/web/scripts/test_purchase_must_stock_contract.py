#!/usr/bin/env python3
"""Static contract for the 2026-10-19 purchase-must-stock migration.

A purchase line that must be received (hàng mua bắt buộc nhập kho) drops its VAT,
shipping and service lines automatically. This migration only *adds* the fixed
rule `stock_line_auto_non_stock` and *redefines* the ledger / alias RPCs to use
it. It must never touch the ledger idempotency key (`'gr-item:'`, its
`on conflict` guards), never UPDATE or DELETE a purchase order, payment request,
goods_receipt_item or q7_inventory_movement, and it must never match the single
token "phi" (otherwise "Tỏi phi", a real material, would be skipped).

The `stock_line_auto_non_stock` case table is shared, byte for byte, by the SQL
migration, src/lib/material-alias.ts, the edge mirror jev.ts and the smoke test.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = (ROOT / "supabase/migrations/20261019100000_purchase_must_stock.sql").read_text(encoding="utf-8")
LOWER = MIGRATION.lower()
BASE_MIGRATION = (ROOT / "supabase/migrations/20261017100000_stock_routing.sql").read_text(encoding="utf-8")

TS_LIB = (ROOT / "src/lib/material-alias.ts").read_text(encoding="utf-8")
EDGE_JEV = (ROOT / "supabase/functions/stock-alias-jev/jev.ts").read_text(encoding="utf-8")
SMOKE = (ROOT / "scripts/smoke_purchase_must_stock.sql").read_text(encoding="utf-8")

FUNCTION_RE = re.compile(
    r"create\s+or\s+replace\s+function\s+public\.(?P<name>[a-z0-9_]+)\s*\(",
    re.IGNORECASE,
)

# New helper + the functions the task allows to be redefined.
ALLOWED_FUNCTIONS = {
    "stock_line_auto_non_stock",
    "post_goods_receipt_to_stock",
    "get_stock_ledger_overview",
    "get_material_alias_backlog",
    "suggest_material_aliases",
    "confirm_material_alias",
}
# The untouched helper that owns the ledger idempotency key.
UNTOUCHED_FUNCTIONS = ["post_stock_goods_receipt_item"]

FORBIDDEN_WRITE_TABLES = [
    "purchase_orders",
    "payment_requests",
    "goods_receipt_items",
    "q7_inventory_movements",
]

UPDATE_RE = re.compile(r"\bupdate\s+(public\.)?([a-z0-9_]+)", re.IGNORECASE)
DELETE_RE = re.compile(r"\bdelete\s+from\s+(public\.)?([a-z0-9_]+)", re.IGNORECASE)

EXPECTED_CASES = [
    ("Thuế VAT 8%", "vat"),
    ("VAT", "vat"),
    ("Thuế GTGT", "vat"),
    ("Phí vận chuyển", "fee"),
    ("Phụ phí giao hàng", "fee"),
    ("Cước ship nội thành", "fee"),
    ("Vận chuyển hàng", "fee"),
    ("Xử lý côn trùng", "service"),
    ("Phí phân tích mẫu", "service"),
    ("Thuê máy", "service"),
    ("Tỏi phi", None),
    ("Bánh mì lớn 17", None),
    ("Phô mai Dairymont", None),
    ("Ship hàng", "fee"),
    ("Cước Rửa Chén TBP x 4 Miếng", None),
    ("Cước điện thoại_0966998998", "fee"),
    ("Thuê nhà Q.7 T9/26", "service"),
]


def function_blocks(name: str) -> list[str]:
    out: list[str] = []
    for match in re.finditer(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
        MIGRATION,
        re.IGNORECASE,
    ):
        tail = MIGRATION[match.start():]
        end = tail.find("\n$$;")
        assert end != -1, f"unterminated function public.{name}"
        out.append(tail[:end])
    return out


def function_block(name: str) -> str:
    blocks = function_blocks(name)
    assert len(blocks) == 1, f"public.{name} must be defined exactly once, got {len(blocks)}"
    return blocks[0]


print("== only the listed functions are defined ==")
defined = {match.group("name").lower() for match in FUNCTION_RE.finditer(MIGRATION)}
assert defined == ALLOWED_FUNCTIONS, f"unexpected function definitions: {sorted(defined)}"
assert len(function_blocks("confirm_material_alias")) == 2, "confirm_material_alias needs both overloads"
for name in ALLOWED_FUNCTIONS:
    blocks = function_blocks(name)
    assert blocks, f"missing function public.{name}"
    assert all("set search_path" in block.lower() for block in blocks), f"{name} must pin search_path"
rule_block = function_block("stock_line_auto_non_stock").lower()
assert "immutable" in rule_block, "stock_line_auto_non_stock must be immutable"
assert "language sql" in rule_block, "stock_line_auto_non_stock must be SQL"
assert re.search(
    r"grant\s+execute\s+on\s+function\s+public\.stock_line_auto_non_stock\(text\)\s+to\s+authenticated,\s*service_role",
    MIGRATION,
    re.IGNORECASE,
), "stock_line_auto_non_stock must be executable by authenticated and service_role"

print("== the idempotency helper and its gr-item key stay untouched ==")
for name in UNTOUCHED_FUNCTIONS:
    assert not re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
        MIGRATION,
        re.IGNORECASE,
    ), f"{name} must not be redefined"
assert "'gr-item:'" in MIGRATION, "the gr-item key must stay documented in the migration"
assert "on conflict" in LOWER, "the on conflict guard reference must stay in the migration"
assert "post_stock_goods_receipt_item" in function_block("post_goods_receipt_to_stock"), (
    "post_goods_receipt_to_stock must keep delegating to the untouched posting helper"
)
for marker in ("'gr-item:'", "on conflict (source, source_ref_key)", "on conflict (idempotency_key)"):
    assert marker in BASE_MIGRATION, f"the untouched helper lost {marker}"

print("== no purchase / payment / receipt-item / ledger write ==")
for table in FORBIDDEN_WRITE_TABLES:
    assert not re.search(rf"\bupdate\s+(public\.)?{re.escape(table)}\b", LOWER), f"must not update {table}"
    assert not re.search(rf"\bdelete\s+from\s+(public\.)?{re.escape(table)}\b", LOWER), f"must not delete {table}"
for match in UPDATE_RE.finditer(MIGRATION):
    assert match.group(2).lower() not in FORBIDDEN_WRITE_TABLES, f"unexpected update on {match.group(2)}"
for match in DELETE_RE.finditer(MIGRATION):
    assert match.group(2).lower() not in FORBIDDEN_WRITE_TABLES, f"unexpected delete on {match.group(2)}"

print("== the rule never matches the single token phi ==")
assert not re.search(r"'\s*phi\s*'", rule_block), "the rule must not use a lone 'phi' token"
assert "phu phi" in rule_block, "the legitimate phu phi phrase must stay"
for tab, array_name in (
    (TS_LIB, "AUTO_NON_STOCK_FEE_TOKENS"),
    (EDGE_JEV, "FEE_TOKENS"),
):
    match = re.search(rf"const\s+{array_name}[^=]*=\s*\[(.*?)\];", tab, re.DOTALL)
    assert match, f"missing {array_name}"
    tokens = [value.strip() for value in re.findall(r'"([^"]*)"', match.group(1))]
    assert tokens, f"{array_name} must not be empty"
    assert all(token != "phi" for token in tokens), f"{array_name} must not contain a lone phi token"
    assert any("phu phi" in token for token in tokens), f"{array_name} must keep the phu phi phrase"

print("== the shared stock_line_auto_non_stock case table matches everywhere ==")


def ts_cases(source: str) -> list[tuple[str, str | None]]:
    match = re.search(
        r"STOCK_LINE_AUTO_NON_STOCK_TEST_CASES[^=]*=\s*\[(.*?)\];",
        source,
        re.DOTALL,
    )
    assert match, "missing STOCK_LINE_AUTO_NON_STOCK_TEST_CASES"
    pairs = re.findall(r'\[\s*"([^"]+)"\s*,\s*(?:"([^"]+)"|null)\s*\]', match.group(1))
    return [(name, reason or None) for name, reason in pairs]


def sql_comment_cases(source: str) -> list[tuple[str, str | None]]:
    pairs = re.findall(
        r"^--\s+'([^']+)'\s*->\s*(vat|fee|service|null)\s*$",
        source,
        re.MULTILINE,
    )
    return [(name, None if reason == "null" else reason) for name, reason in pairs]


def smoke_cases(source: str) -> list[tuple[str, str | None]]:
    match = re.search(
        r"select\s+\*\s+from\s+\(values(.*?)\)\s+as\s+t\(raw_name,\s*expected\)",
        source,
        re.DOTALL | re.IGNORECASE,
    )
    assert match, "missing the smoke case table"
    pairs = re.findall(r"\(\s*'([^']+)'\s*,\s*(?:'([^']+)'|null)\s*\)", match.group(1))
    return [(name, reason or None) for name, reason in pairs]


lib_cases = ts_cases(TS_LIB)
edge_cases = ts_cases(EDGE_JEV)
mig_cases = sql_comment_cases(MIGRATION)
smoke_pairs = smoke_cases(SMOKE)
assert lib_cases == EXPECTED_CASES, f"src lib case table drifted: {lib_cases}"
assert edge_cases == EXPECTED_CASES, f"edge case table drifted: {edge_cases}"
assert mig_cases == EXPECTED_CASES, f"migration comment case table drifted: {mig_cases}"
assert smoke_pairs == EXPECTED_CASES, f"smoke case table drifted: {smoke_pairs}"

print("== the SQL rule and the TS/edge mirror implement the same tokens ==")
for table in (TS_LIB, EDGE_JEV):
    assert " phi van chuyen " in table
    assert " thue gtgt " in table
    assert " xu ly con trung " in table
    assert " chiet khau " in table

print("purchase must stock contract passed")
