#!/usr/bin/env python3
"""Static contract for the 2026-10-16 material alias learning migration.

The Q7 ledger is append-only, so the alias-learning flow may never UPDATE or
DELETE q7_inventory_movements / goods receipts / purchase orders / payment
requests. It records human confirmations in an append-only event log, caches the
Jev ranking per (supplier, name, location, prompt, candidates) and applies a
confirmed alias only through the existing post_stock_goods_receipt_item helper.
This contract pins that design: every new function pins search_path (the RPCs are
security definer), the new tables carry RLS plus explicit grants, pre-existing
aliases are backfilled as auto, no old function is redefined, and the edge
function keeps the kill switch, the shared daily quota and the cache.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_PATH = ROOT / "supabase/migrations/20261016100000_material_alias_learning.sql"
MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
LOWER = MIGRATION.lower()

EDGE_DIR = ROOT / "supabase/functions/stock-alias-jev"
EDGE_INDEX = (EDGE_DIR / "index.ts").read_text(encoding="utf-8")
EDGE_HANDLER = (EDGE_DIR / "handler.ts").read_text(encoding="utf-8")
EDGE_STORE = (EDGE_DIR / "store.ts").read_text(encoding="utf-8")
EDGE_JEV = (EDGE_DIR / "jev.ts").read_text(encoding="utf-8")

CONFIG = (ROOT / "supabase/config.toml").read_text(encoding="utf-8")
TS_LIB = (ROOT / "src/lib/material-alias.ts").read_text(encoding="utf-8")
SMOKE = (ROOT / "scripts/smoke_material_alias_learning.sql").read_text(encoding="utf-8")

FUNCTION_RE = re.compile(
    r"create\s+or\s+replace\s+function\s+public\.(?P<name>[a-z0-9_]+)\s*\(",
    re.IGNORECASE,
)

SECURITY_DEFINER_FUNCTIONS = [
    "material_alias_can_view",
    "material_alias_can_edit",
    "material_alias_can_admin",
    "material_alias_candidates",
    "suggest_material_aliases",
    "confirm_material_alias",
    "undo_material_alias_event",
    "set_material_alias_status",
    "get_material_alias_review",
    "get_material_alias_backlog",
]

IMMUTABLE_FUNCTIONS = [
    "material_alias_candidate_score",
    "material_alias_candidates_hash",
]

ALL_NEW_FUNCTIONS = SECURITY_DEFINER_FUNCTIONS + IMMUTABLE_FUNCTIONS

OLD_FUNCTIONS = [
    "resolve_stock_alias",
    "resolve_stock_material_alias",
    "post_stock_goods_receipt_item",
    "post_goods_receipt_to_stock",
    "normalize_stock_item_name",
    "stock_catalog_token_jaccard",
    "get_stock_ledger_overview",
]

FORBIDDEN_WRITE_TABLES = [
    "purchase_orders",
    "purchase_order_items",
    "payment_requests",
    "payment_request_items",
    "goods_receipts",
    "goods_receipt_items",
    "q7_inventory_movements",
]

UPDATE_RE = re.compile(r"\bupdate\s+(public\.)?([a-z0-9_]+)", re.IGNORECASE)
DELETE_RE = re.compile(r"\bdelete\s+from\s+(public\.)?([a-z0-9_]+)", re.IGNORECASE)


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

defined = {match.group("name").lower() for match in FUNCTION_RE.finditer(MIGRATION)}
assert defined == {name.lower() for name in ALL_NEW_FUNCTIONS}, (
    f"unexpected function definitions: {sorted(defined)}"
)

print("== no existing function is redefined ==")
for name in OLD_FUNCTIONS:
    assert not re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
        MIGRATION,
        re.IGNORECASE,
    ), f"{name} must not be redefined"

print("== no payable / receipt / PO / ledger write ==")
for table in FORBIDDEN_WRITE_TABLES:
    assert not re.search(
        rf"\bupdate\s+(public\.)?{re.escape(table)}\b", LOWER
    ), f"migration must not update {table}"
    assert not re.search(
        rf"\bdelete\s+from\s+(public\.)?{re.escape(table)}\b", LOWER
    ), f"migration must not delete from {table}"

for match in UPDATE_RE.finditer(MIGRATION):
    table = match.group(2).lower()
    assert table not in FORBIDDEN_WRITE_TABLES, f"unexpected update on {table}"
for match in DELETE_RE.finditer(MIGRATION):
    table = match.group(2).lower()
    assert table not in FORBIDDEN_WRITE_TABLES, f"unexpected delete on {table}"

print("== learning columns and legacy backfill ==")
for column in [
    "confirm_count integer not null default 0",
    "confirmers uuid[] not null default '{}'",
    "status text not null default 'learning'",
    "pack_label text",
    "last_confirmed_at timestamptz",
    "jev_item_id uuid",
    "jev_probability numeric",
    "jev_disagreed boolean not null default false",
    "prompt_version text",
]:
    assert column in MIGRATION, f"missing alias column: {column}"
assert "check (status in ('learning', 'auto', 'disabled'))" in LOWER
assert "set status = 'auto'" in LOWER or "status = 'auto'" in LOWER
assert "confirm_count = 3" in LOWER, "legacy aliases must be backfilled with confirm_count 3"

print("== event log and Jev cache tables ==")
for column in [
    "action text not null check (action in ('confirm', 'correct', 'undo', 'auto_promoted', 'disabled'))",
    "previous_item_id uuid",
    "previous_sku_id uuid",
    "previous_factor numeric(18, 8)",
    "new_item_id uuid",
    "new_sku_id uuid",
    "new_factor numeric(18, 8)",
    "undo_of_event_id uuid",
]:
    assert column in MIGRATION, f"missing event column: {column}"
for column in [
    "normalized_name text not null",
    "prompt_version text not null",
    "candidates_hash text not null",
    "answer jsonb not null",
    "cost numeric(18, 8)",
]:
    assert column in MIGRATION, f"missing cache column: {column}"
assert "coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid)" in MIGRATION, (
    "cache unique key must treat null supplier as a real key"
)

print("== RLS + explicit grants on the new tables ==")
for table in ("material_alias_events", "material_alias_jev_cache"):
    assert re.search(
        rf"alter\s+table\s+public\.{table}\s+enable\s+row\s+level\s+security",
        MIGRATION,
        re.IGNORECASE,
    ), f"RLS must be enabled on {table}"
    assert re.search(
        rf"grant\s+select\s+on\s+table\s+public\.{table}\s+to\s+authenticated",
        MIGRATION,
        re.IGNORECASE,
    ), f"select grant missing for {table}"
    assert re.search(
        rf"grant\s+insert,\s*update,\s*delete\s+on\s+table\s+public\.{table}\s+to\s+service_role",
        MIGRATION,
        re.IGNORECASE,
    ), f"service-role write grant missing for {table}"
    assert re.search(
        rf"create\s+policy\s+\w+\s+on\s+public\.{table}\s+for\s+select",
        MIGRATION,
        re.IGNORECASE,
    ), f"select policy missing for {table}"
    assert re.search(
        rf"revoke\s+all\s+on\s+table\s+public\.{table}\s+from\s+public,\s*anon,\s*authenticated",
        MIGRATION,
        re.IGNORECASE,
    ), f"explicit revoke missing for {table}"

assert "q7_material_inventory_can_view" in MIGRATION
assert "q7_material_inventory_can_edit" in MIGRATION
assert "material_alias_can_view" in MIGRATION
assert "material_alias_can_edit" in MIGRATION

# Aliases are read-only for signed-in users too: learning writes go through the
# security definer RPCs.
assert re.search(
    r"revoke\s+insert,\s*update,\s*delete\s+on\s+table\s+public\.stock_material_aliases\s+"
    r"from\s+public,\s*anon,\s*authenticated",
    MIGRATION,
    re.IGNORECASE,
), "stock_material_aliases writes must be revoked from authenticated"
assert re.search(
    r"grant\s+select,\s*insert,\s*update,\s*delete\s+on\s+table\s+public\.stock_material_aliases\s+to\s+service_role",
    MIGRATION,
    re.IGNORECASE,
), "service role must keep stock_material_aliases access"

print("== the confirm RPC reuses the existing posting helper ==")
confirm_block = function_block("confirm_material_alias")
assert "post_stock_goods_receipt_item" in confirm_block
assert "stock_goods_receipt_item_is_posted" in confirm_block
assert "stock_ledger_cutover_date" in confirm_block
assert "auto_promoted" in confirm_block
assert "jev_disagreed" in confirm_block

undo_block = function_block("undo_material_alias_event")
assert "'undo'" in undo_block
assert "undo_of_event_id" in undo_block
assert "event_already_undone" in undo_block
assert "not_latest_confirm" in undo_block
assert "warning" in undo_block

suggest_block = function_block("suggest_material_aliases")
assert "material_alias_candidates" in suggest_block
assert "material_alias_jev_cache" in suggest_block
assert "material_alias_candidates_hash" in suggest_block
assert "q7_pack_from_name" in suggest_block
assert "Jev" not in suggest_block or "jev" in suggest_block

review_block = function_block("get_material_alias_review")
assert "stock_catalog_jev_usage" in review_block
assert "resolve_stock_material_alias" in review_block
assert "jev_disagreed" in review_block

print("== shared scoring test cases ==")
SHARED_SCORE_CASES = [
    "Tỏi ngày 10",
    "Tỏi bóc vỏ",
    "Tỏi phi",
    "Bột mì 888",
    "Bột mì 888 (25kg)",
    "Gạo tám",
]
for case in SHARED_SCORE_CASES:
    assert case in TS_LIB, f"TS lib missing scoring case: {case}"
    assert case in SMOKE, f"smoke missing scoring case: {case}"
assert "material_alias_candidate_score" in MIGRATION
assert "scoreCandidate" in TS_LIB

print("== edge function kill switch + shared quota + cache ==")
assert "BMQ_JEV_KILL_SWITCH" in EDGE_INDEX
assert "stock_catalog_jev_usage" in EDGE_STORE
assert "material_alias_jev_cache" in EDGE_STORE
assert "MATERIAL_ALIAS_DAILY_CALL_LIMIT" in EDGE_HANDLER
assert "call_limit" in EDGE_HANDLER
assert "candidatesHash" in EDGE_HANDLER
assert "AI_GATEWAY_API_KEY" in EDGE_INDEX
assert "JEV_TIMEOUT_MS = 4000" in EDGE_JEV
assert "NONE_OPTION" in EDGE_JEV
assert "[functions.stock-alias-jev]" in CONFIG

print("material alias learning contract passed")

# ---------------------------------------------------------------------------
# 2026-10-20 alias-learning fix
# ---------------------------------------------------------------------------
print("== 2026-10-20 alias-learning fix migration ==")
FIX_PATH = ROOT / "supabase/migrations/20261020100000_alias_learning_fix.sql"
assert FIX_PATH.exists(), "missing the 2026-10-20 alias-learning fix migration"
FIX = FIX_PATH.read_text(encoding="utf-8")
FIX_LOWER = FIX.lower()


def fix_block(name: str) -> str:
    match = re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
        FIX,
        re.IGNORECASE,
    )
    assert match, f"fix missing function public.{name}"
    tail = FIX[match.start():]
    end = tail.find("\n$$;")
    assert end != -1, f"unterminated function public.{name}"
    return tail[:end]


FIX_DEFINER = [
    "material_alias_candidates",
    "increment_stock_catalog_jev_usage",
    "get_material_alias_backlog_review",
    "create_stock_material_item",
]
FIX_IMMUTABLE = [
    "material_alias_clean_name",
    "material_alias_match_tokens",
    "material_alias_tokens_match",
]
for name in FIX_DEFINER + FIX_IMMUTABLE:
    block = fix_block(name).lower()
    assert "set search_path" in block, f"{name} must pin search_path"
for name in FIX_DEFINER:
    assert "security definer" in fix_block(name).lower(), f"{name} must be security definer"
for name in FIX_IMMUTABLE:
    assert "immutable" in fix_block(name).lower(), f"{name} must be immutable"

print("== candidates: bracket prefix, '/' split, fuzzy OCR tokens ==")
candidates_fix = fix_block("material_alias_candidates")
assert "material_alias_clean_name" in candidates_fix
assert "material_alias_match_tokens" in candidates_fix
assert "material_alias_tokens_match" in candidates_fix
assert "regexp_split_to_array" in candidates_fix, "a name with '/' must be scored part by part"
assert "name_exact" in candidates_fix
assert "+shared_alias" in candidates_fix
assert "[^\\]" in fix_block("material_alias_clean_name"), "the [Thùng] prefix must be stripped"

print("== atomic Jev usage counter ==")
increment_fix = fix_block("increment_stock_catalog_jev_usage").lower()
assert "on conflict (usage_date) do update" in increment_fix
assert "updated_at = now()" in increment_fix
assert re.search(
    r"grant\s+execute\s+on\s+function\s+public\.increment_stock_catalog_jev_usage\(date,\s*integer,\s*numeric\)\s+to\s+service_role",
    FIX,
    re.IGNORECASE,
), "increment_stock_catalog_jev_usage must be granted to service_role"
assert not re.search(
    r"grant\s+execute\s+on\s+function\s+public\.increment_stock_catalog_jev_usage[^;]*to\s+authenticated",
    FIX,
    re.IGNORECASE,
), "increment_stock_catalog_jev_usage must not be granted to authenticated"

print("== admin confirm promotes to auto, both overloads kept ==")
confirm_fix = fix_block("confirm_material_alias")
assert "material_alias_can_admin" in confirm_fix
assert "status = 'auto'" in confirm_fix
assert "auto_promoted" in confirm_fix
assert "post_stock_goods_receipt_item" in confirm_fix
assert len(re.findall(
    r"create\s+or\s+replace\s+function\s+public\.confirm_material_alias\s*\(",
    FIX,
    re.IGNORECASE,
)) == 2, "both confirm_material_alias overloads must be redefined"

print("== backlog review RPC is admin-only ==")
review_fix = fix_block("get_material_alias_backlog_review")
assert "material_alias_can_admin" in review_fix
assert "'forbidden'" in review_fix
assert "material_alias_jev_cache" in review_fix
assert "material_alias_candidates" in review_fix
assert "last_receipt_date" in review_fix
assert "jev_source" in review_fix

print("== create_stock_material_item permission + idempotency ==")
create_fix = fix_block("create_stock_material_item")
assert "create_item_forbidden" in create_fix
assert "q7_material_inventory_can_edit" in create_fix
assert "normalize_stock_item_name" in create_fix
assert "material_alias_item_requests" in create_fix
assert "canonical_material_id" not in create_fix, "a new item must not write canonical_material_id"
assert re.search(
    r"alter\s+table\s+public\.material_alias_item_requests\s+enable\s+row\s+level\s+security",
    FIX,
    re.IGNORECASE,
), "material_alias_item_requests must enable RLS"
assert re.search(
    r"grant\s+execute\s+on\s+function\s+public\.create_stock_material_item\(text,\s*text,\s*text,\s*uuid\)\s+to\s+authenticated",
    FIX,
    re.IGNORECASE,
), "create_stock_material_item must be granted to authenticated"

print("== edge function: short keys, deterministic exact, batched backlog ==")
assert "jev-material-alias-2026-10-20.1" in EDGE_JEV
assert "matchOptionKey" in EDGE_JEV
assert "candidateIdFromChoice" in EDGE_JEV
assert "Bột mì 888 Cam (25kg)" in EDGE_JEV, "the parsePackFromName case must be shared"
assert "MATERIAL_ALIAS_BACKLOG_BATCH_DEFAULT" in EDGE_HANDLER
assert "MATERIAL_ALIAS_BACKLOG_BATCH_MAX" in EDGE_HANDLER
assert "batch_size" in EDGE_HANDLER
assert "remaining" in EDGE_HANDLER
assert "incrementUsage" in EDGE_HANDLER
assert "exactCandidateAnswer" in EDGE_HANDLER
assert "increment_stock_catalog_jev_usage" in EDGE_STORE

print("== TS lib / hooks / types ==")
TS_HOOK = (ROOT / "src/hooks/useMaterialAlias.ts").read_text(encoding="utf-8")
TS_TYPES = (ROOT / "src/integrations/supabase/types.ts").read_text(encoding="utf-8")
assert "parseMaterialAliasBacklogReview" in TS_LIB
assert "parseCreateStockMaterialItem" in TS_LIB
assert "source" in TS_LIB
assert "remaining" in TS_LIB
assert "useMaterialAliasBacklogReview" in TS_HOOK
assert "useCreateStockMaterialItem" in TS_HOOK
assert "remaining" in TS_HOOK
assert "get_material_alias_backlog_review" in TS_TYPES
assert "create_stock_material_item" in TS_TYPES
assert "increment_stock_catalog_jev_usage" in TS_TYPES

print("== 2026-10-20 smoke ==")
SMOKE_FIX = (ROOT / "scripts/smoke_alias_learning_fix.sql").read_text(encoding="utf-8")
for case in [
    "Chicken egg 60gr/Trứng gà 60g",
    "Trứng gà 60gr",
    "DAIRYMONT WHITE SLICES CHEESE 1KG",
    "Phô mai 84 lát trắng Dairymont",
    "MUỐI SÁY KHÔ 500G BAO 25KG",
    "Muối sấy",
    "[Thùng] Sữa Tiệt Trùng Mekovita 3.5% Bélo 1L x 12 Hộp",
    "Sữa Mlekovita",
    "RE AN KHÈ",
    "RE AN KHÊ",
    "create_stock_material_item",
]:
    assert case in SMOKE_FIX, f"smoke missing case: {case}"

print("alias learning fix contract passed")
