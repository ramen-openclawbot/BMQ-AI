#!/usr/bin/env python3
"""Static contract for 20261102470000_stock_catalog_candidates_name_subset.sql.

get_stock_catalog_candidates() must keep its 2026-10-15 signature, output,
security and auth gate, and only widen the pairs rule with the guarded name
token-subset match. This contract also re-implements stock_catalog_item_tokens
in Python to pin the business examples that motivated the change.
"""
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_PATH = (
    ROOT
    / "supabase/migrations/20261102470000_stock_catalog_candidates_name_subset.sql"
)
MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
LOWER = MIGRATION.lower()
# Drop line comments so prose cannot satisfy (or trip) the SQL assertions.
CODE = re.sub(r"--[^\n]*", "", MIGRATION)
CODE_LOWER = CODE.lower()

FUNCTION_RE = re.compile(
    r"create\s+or\s+replace\s+function\s+public\.(?P<name>[a-z0-9_]+)\s*\(",
    re.IGNORECASE,
)

RETURN_COLUMNS = [
    "left_id",
    "right_id",
    "left_name",
    "right_name",
    "left_unit",
    "right_unit",
    "left_item_type",
    "right_item_type",
    "left_issue_count_90d",
    "right_issue_count_90d",
    "left_movement_count_90d",
    "right_movement_count_90d",
    "left_canonical_material_id",
    "right_canonical_material_id",
    "left_canonical_material_code",
    "right_canonical_material_code",
    "left_to_right_factor",
    "right_to_left_factor",
]

STOPWORDS = {
    "kg",
    "g",
    "gr",
    "gram",
    "kilogram",
    "l",
    "lit",
    "ml",
    "qua",
    "hop",
    "cai",
    "chiec",
    "chai",
    "goi",
    "bao",
    "thung",
    "ky",
}


def function_block(name: str) -> str:
    match = re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(\s*\)",
        MIGRATION,
        re.IGNORECASE,
    )
    assert match, f"missing zero-argument function public.{name}"
    tail = MIGRATION[match.start():]
    end = tail.find("\n$$;")
    assert end != -1, f"unterminated function public.{name}"
    return tail[:end]


def strip_vietnamese_accents(value: str) -> str:
    lowered = value.lower().replace("đ", "d")
    decomposed = unicodedata.normalize("NFD", lowered)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def item_tokens(name: str) -> frozenset:
    """Mirror public.stock_catalog_item_tokens for the contract examples."""
    normalized = strip_vietnamese_accents(name)
    words = re.split(r"[^a-z0-9]+", normalized)
    return frozenset(
        token
        for token in words
        if token and not re.fullmatch(r"[0-9]+", token) and token not in STOPWORDS
    )


def token_jaccard(left: str, right: str) -> float:
    left_tokens = item_tokens(left)
    right_tokens = item_tokens(right)
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def name_subset_match(left: str, right: str) -> bool:
    left_tokens = item_tokens(left)
    right_tokens = item_tokens(right)
    if not left_tokens or not right_tokens:
        return False
    return left_tokens <= right_tokens or right_tokens <= left_tokens


print("== only the candidate RPC is redefined ==")
defined = [match.group("name").lower() for match in FUNCTION_RE.finditer(MIGRATION)]
assert defined == ["get_stock_catalog_candidates"], (
    f"migration must redefine only get_stock_catalog_candidates, got {defined}"
)
assert not re.search(
    r"create\s+function\s+public\.", MIGRATION, re.IGNORECASE
), "migration must not create another function"
assert "create table" not in CODE_LOWER, "migration must not create a table"
assert "alter table" not in CODE_LOWER, "migration must not alter a table"
assert "drop table" not in CODE_LOWER, "migration must not drop a table"

block = function_block("get_stock_catalog_candidates")
block_lower = block.lower()

print("== identical signature + output shape ==")
assert "language plpgsql" in block_lower, "function must stay LANGUAGE plpgsql"
returns = re.search(r"returns\s+table\s*\((.*?)\)\s*language", block_lower, re.DOTALL)
assert returns, "function must return the same TABLE shape"
columns = re.findall(
    r"([a-z0-9_]+)\s+(uuid|text|bigint|numeric)", returns.group(1)
)
assert [column for column, _ in columns] == RETURN_COLUMNS, (
    f"unexpected output columns: {[column for column, _ in columns]}"
)

print("== security definer + pinned search_path ==")
assert "security definer" in block_lower, "function must stay security definer"
assert "stable" in block_lower, "function must stay STABLE"
assert "set search_path = public, pg_temp" in block_lower, (
    "function must pin search_path to public, pg_temp"
)

print("== service_role / q7_material_inventory_can_view gate ==")
assert "auth.role()" in block_lower and "'service_role'" in block_lower, (
    "service_role bypass missing"
)
assert "auth.uid()" in block_lower, "actor id read missing"
assert "q7_material_inventory_can_view" in block_lower, "view gate missing"
assert "insufficient_privilege" in block_lower, "gate must raise on no view right"

print("== existing matching rules stay ==")
assert re.search(
    r"a\.norm\s+is\s+not\s+null\s+and\s+a\.norm\s*=\s*b\.norm", block_lower
), "normalized-name equality rule missing"
assert re.search(
    r"public\.stock_catalog_token_jaccard\(a\.name,\s*b\.name\)\s*>=\s*0\.6",
    block_lower,
), "jaccard >= 0.6 rule missing"
assert "public.stock_catalog_item_tokens(kii.name) as tokens" in block_lower, (
    "items CTE must compute stock_catalog_item_tokens(kii.name)"
)

print("== guarded token-subset rule ==")
subset_rule = re.search(
    r"cardinality\s*\(\s*a\.tokens\s*\)\s*>\s*0\s+and\s+"
    r"cardinality\s*\(\s*b\.tokens\s*\)\s*>\s*0\s+and\s*\(\s*"
    r"a\.tokens\s*<@\s*b\.tokens\s+or\s+b\.tokens\s*<@\s*a\.tokens\s*\)",
    block_lower,
)
assert subset_rule, "guarded a.tokens <@ b.tokens / b.tokens <@ a.tokens rule missing"
assert re.search(
    r"a\.id\s*<\s*b\.id\s+and\s+a\.item_type\s*=\s*b\.item_type", block_lower
), "a.id < b.id and a.item_type = b.item_type join missing"
assert "order by p.left_id, p.right_id" in block_lower, "deterministic order missing"

print("== grants restated ==")
assert (
    "revoke all on function public.get_stock_catalog_candidates() "
    "from public, anon;"
) in LOWER, "REVOKE for the RPC missing"
assert (
    "grant execute on function public.get_stock_catalog_candidates() "
    "to authenticated, service_role;"
) in LOWER, "GRANT EXECUTE for the RPC missing"

print("== no write statements ==")
for keyword in ("insert", "update", "delete"):
    assert not re.search(rf"\b{keyword}\b", CODE_LOWER), (
        f"migration must not contain {keyword.upper()} statements"
    )

print("== python token rule: subset candidates jaccard alone misses ==")
SUBSET_ONLY_EXAMPLES = [
    ("Đường", "Đường tinh luyện"),
    ("Bột Ngọt", "BỘT NGỘT VEYU 25KG F30"),
    ("Dầu hướng dương", "Dầu Hướng Dương Simply 2L x 6 Chai / Thùng"),
]
for left, right in SUBSET_ONLY_EXAMPLES:
    assert name_subset_match(left, right), f"{left!r} / {right!r} must be a subset match"
    assert token_jaccard(left, right) < 0.6, (
        f"{left!r} / {right!r} must not already match on jaccard >= 0.6"
    )

assert not name_subset_match("Bơ peerless", "Đường"), (
    "'Bơ peerless' / 'Đường' must not be a subset match"
)
assert token_jaccard("Bơ peerless", "Đường") < 0.6, (
    "'Bơ peerless' / 'Đường' must not match on jaccard"
)

# The unit/count tokens must be dropped, accents stripped and digits removed.
assert item_tokens("BỘT NGỌT VEYU 25KG F30") == {
    "bot",
    "ngot",
    "veyu",
    "25kg",
    "f30",
}
assert item_tokens("Dầu Hướng Dương Simply 2L x 6 Chai / Thùng") == {
    "dau",
    "huong",
    "duong",
    "simply",
    "2l",
    "x",
}
assert item_tokens("Đường") == {"duong"}

print("stock catalog name-subset contract passed")
