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

PHONE_MIGRATION_PATH = ROOT / "supabase/migrations/20261102310000_phone_bill_nonstock.sql"
PHONE_MIGRATION = PHONE_MIGRATION_PATH.read_text(encoding="utf-8")
STOCK_LEDGER = (ROOT / "supabase/migrations/20261013100000_stock_ledger_flow.sql").read_text(encoding="utf-8")

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

print("== phone-only non-stock names get a stable alias key ==")


def source_function_block(source: str, name: str) -> str:
    match = re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
        source,
        re.IGNORECASE,
    )
    assert match, f"missing function public.{name}"
    tail = source[match.start():]
    end = tail.find("\n$$;")
    assert end != -1, f"unterminated function public.{name}"
    return tail[:end]


assert PHONE_MIGRATION_PATH.name > "20261102300000", "phone migration must sort after 20261102300000"
outside_body = re.sub(r"as\s+\$\$.*?\$\$;", "", PHONE_MIGRATION, flags=re.IGNORECASE | re.DOTALL)
assert not re.search(r"\b(insert\s+into|update|delete\s+from)\b", outside_body, re.IGNORECASE), (
    "the migration must not rewrite existing aliases, receipts or ledger rows"
)
phone_block = source_function_block(PHONE_MIGRATION, "confirm_material_alias")
assert PHONE_MIGRATION.lower().count("create or replace function public.confirm_material_alias(") == 1, (
    "the migration re-creates only the latest 13-argument overload"
)
assert "p_line_class text default 'stock'" in phone_block, "the latest 13-argument signature must stay"
assert "security definer" in phone_block.lower(), "confirm_material_alias must stay security definer"
assert "set search_path = public, pg_temp" in phone_block.lower(), "confirm_material_alias must pin search_path"
assert (
    "grant execute on function public.confirm_material_alias("
    "uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid, text) "
    "to authenticated, service_role" in PHONE_MIGRATION
), "the 13-argument overload must keep its grants"

fallback_match = re.search(
    r"if\s+v_norm\s+is\s+null\s+and\s+p_line_class\s*=\s*'non_stock'\s+then"
    r"(?P<body>.*?)\bend\s+if\s*;",
    phone_block,
    re.IGNORECASE | re.DOTALL,
)
assert fallback_match, "non_stock must fall back when normalize_stock_item_name returns null"
fallback = fallback_match.group("body")
assert "regexp_replace(" in fallback.lower(), "the fallback must build a key from the raw name"
assert "lower(btrim(coalesce(p_raw_name, '')))" in fallback.lower(), (
    "the fallback key must use the original raw name"
)
assert "'[^a-z0-9]'" in fallback and "'g'" in fallback, (
    "the fallback key must keep only digits and letters"
)
assert "nullif(" in fallback.lower(), "a punctuation-only name must fall back to null"

after_fallback = phone_block[fallback_match.end():]
assert re.search(
    r"if\s+v_norm\s+is\s+null\s+then\s+raise\s+exception\s+'item_name_required'",
    after_fallback,
    re.IGNORECASE,
), "an actually empty name must still raise item_name_required"
stock_branch = after_fallback.lower().find("if p_line_class = 'non_stock' then")
assert stock_branch != -1, "the non_stock item branch must stay after normalization"
assert "regexp_replace(" not in after_fallback[:stock_branch].lower(), (
    "stock must not use the phone fallback before the strict item_name_required raise"
)

# Mirror public.normalize_stock_item_name (20261013100000) so the phone cases
# exercise the same trailing-digit rule that made the key null in the first place.
normalize_block = source_function_block(STOCK_LEDGER, "normalize_stock_item_name")
translate_match = re.search(
    r"translate\(\s*lower\(coalesce\(p_name, ''\)\),\s*'([^']*)',\s*'([^']*)'\s*\)",
    normalize_block,
    re.IGNORECASE | re.DOTALL,
)
assert translate_match, "normalize_stock_item_name must keep its translate table"
UNACCENT = str.maketrans(translate_match.group(1), translate_match.group(2))
assert r"\s*\([^()]*\)\s*$" in normalize_block, "normalize_stock_item_name must keep the parenthetical rule"
assert r"\s*(ngay\s*[0-9]+|[0-9]+)\s*$" in normalize_block, "normalize_stock_item_name must keep the trailing-digit rule"


def normalize_mirror(name: str | None) -> str | None:
    value = (name or "").lower().translate(UNACCENT)
    value = re.sub(r"\s+", " ", value)
    value = re.sub(r"\s*\([^()]*\)\s*$", "", value)
    value = re.sub(r"\s*(ngay\s*[0-9]+|[0-9]+)\s*$", "", value)
    return value.strip() or None


def phone_alias_key(raw: str | None) -> str | None:
    return re.sub(r"[^a-z0-9]", "", (raw or "").lower().strip()) or None


def effective_alias_key(raw: str | None, line_class: str) -> str | None:
    normalized = normalize_mirror(raw)
    if normalized is None and line_class == "non_stock":
        return phone_alias_key(raw)
    return normalized


PHONE_CASES = [
    ("0966998998", "0966998998"),
    ("011532087 (Vnpt)", "011532087vnpt"),
]
for raw, expected in PHONE_CASES:
    assert normalize_mirror(raw) is None, f"{raw!r} must normalize to null (the bug case)"
    assert effective_alias_key(raw, "non_stock") == expected, f"{raw!r} must get key {expected!r}"
    assert effective_alias_key(raw, "stock") is None, f"stock {raw!r} must still raise item_name_required"

for raw, expected in (
    ("Cước điện thoại_0966998998", "cuoc dien thoai_"),
    ("Bánh mì lớn 17", "banh mi lon"),
):
    assert normalize_mirror(raw) == expected, f"text name {raw!r} normalization changed"
    assert effective_alias_key(raw, "non_stock") == expected, f"text name {raw!r} must keep its normalized key"

for raw in ("", "   ", "()", None):
    assert normalize_mirror(raw) is None, f"{raw!r} must normalize to null"
    assert phone_alias_key(raw) is None, f"a truly empty name {raw!r} must still raise"
    assert effective_alias_key(raw, "non_stock") is None, f"a truly empty non_stock name {raw!r} must still raise"

print("== suggest finds a phone-bill alias by the same fallback key ==")
assert PHONE_MIGRATION.lower().count("create or replace function public.suggest_material_aliases(") == 1
phone_suggest = source_function_block(PHONE_MIGRATION, "suggest_material_aliases")
base_suggest = source_function_block(MIGRATION, "suggest_material_aliases")
suggest_fallback = re.search(
    r"\n(?:\s*--[^\n]*\n)*\s*if\s+v_norm\s+is\s+null\s+then.*?\bend\s+if\s*;",
    phone_suggest,
    re.IGNORECASE | re.DOTALL,
)
assert suggest_fallback, "suggest_material_aliases must fall back when the name normalizes to null"
added = suggest_fallback.group(0)
assert "lower(btrim(coalesce(v_raw_name, '')))" in added and "'[^a-z0-9]'" in added and "nullif(" in added
assert phone_suggest.replace(added, "", 1) == base_suggest, (
    "suggest_material_aliases must otherwise match 20261019100000 byte for byte"
)
assert phone_suggest.find("normalize_stock_item_name(v_raw_name)") < suggest_fallback.start(), (
    "the fallback runs right after normalization"
)

print("purchase must stock contract passed")
