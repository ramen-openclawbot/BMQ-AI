#!/usr/bin/env python3
"""Static contract for the 2026-10-17 stock routing migration.

The Giai đoạn 3 migration may only *redefine* the three ledger helpers and the
four alias-learning RPCs; every other old function must stay untouched. The
ledger keeps its `gr-item:` idempotency keys and `on conflict (source,
source_ref_key)` guards, the migration never updates or deletes the payable /
receipt / ledger tables, and the only `goods_receipts` write is the
`receiving_location` fill inside `apply_supplier_routing`. The new tables carry
RLS plus explicit grants, and the edge function keeps the kill switch, the shared
daily quota and the 0.9 / 0.85 auto-apply thresholds.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_PATH = ROOT / "supabase/migrations/20261017100000_stock_routing.sql"
MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
LOWER = MIGRATION.lower()

EDGE_DIR = ROOT / "supabase/functions/stock-routing-jev"
EDGE_INDEX = (EDGE_DIR / "index.ts").read_text(encoding="utf-8")
EDGE_HANDLER = (EDGE_DIR / "handler.ts").read_text(encoding="utf-8")
EDGE_STORE = (EDGE_DIR / "store.ts").read_text(encoding="utf-8")
EDGE_JEV = (EDGE_DIR / "jev.ts").read_text(encoding="utf-8")

CONFIG = (ROOT / "supabase/config.toml").read_text(encoding="utf-8")
TS_LIB = (ROOT / "src/lib/stock-routing.ts").read_text(encoding="utf-8")
TS_HOOK = (ROOT / "src/hooks/useStockRouting.ts").read_text(encoding="utf-8")
SMOKE = (ROOT / "scripts/smoke_stock_routing.sql").read_text(encoding="utf-8")

FUNCTION_RE = re.compile(
    r"create\s+or\s+replace\s+function\s+public\.(?P<name>[a-z0-9_]+)\s*\(",
    re.IGNORECASE,
)

# The only functions that pre-existed and may be redefined here.
REDEFINED_FUNCTIONS = [
    "post_stock_goods_receipt_item",
    "post_goods_receipt_to_stock",
    "get_stock_ledger_overview",
    "confirm_material_alias",
    "suggest_material_aliases",
    "get_material_alias_review",
    "undo_material_alias_event",
]

NEW_FUNCTIONS = [
    "supplier_routing_evidence",
    "apply_supplier_routing",
    "revert_supplier_routing",
    "decide_supplier_routing",
    "decide_material_category",
    "revert_material_category",
    "get_stock_routing_supplier_candidates",
    "get_stock_routing_material_candidates",
    "get_stock_routing_review",
]

ALL_FUNCTIONS = REDEFINED_FUNCTIONS + NEW_FUNCTIONS

FORBIDDEN_WRITE_TABLES = [
    "purchase_orders",
    "payment_requests",
    "goods_receipt_items",
    "q7_inventory_movements",
]

NEW_TABLES = [
    "stock_material_categories",
    "supplier_routing_suggestions",
    "material_category_suggestions",
]

CATEGORY_SEED = [
    ("flour", "Bột và ngũ cốc"),
    ("dairy_fat", "Sữa, bơ, chất béo"),
    ("eggs", "Trứng"),
    ("sugar_additives", "Đường và phụ gia"),
    ("meat_filling", "Nhân thịt, chả, pate"),
    ("cheese", "Phô mai"),
    ("vegetables", "Rau củ, gia vị"),
    ("packaging", "Bao bì"),
    ("supplies", "Vật tư, dụng cụ"),
    ("service", "Dịch vụ, phí"),
    ("other", "Khác"),
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


print("== only the allowed old functions are redefined ==")
prior_defined: set[str] = set()
for path in sorted((ROOT / "supabase/migrations").glob("*.sql")):
    if path.name >= MIGRATION_PATH.name:
        continue
    prior_defined.update(
        match.group("name").lower() for match in FUNCTION_RE.finditer(path.read_text(encoding="utf-8"))
    )
defined = {match.group("name").lower() for match in FUNCTION_RE.finditer(MIGRATION)}
assert defined == {name.lower() for name in ALL_FUNCTIONS}, (
    f"unexpected function definitions: {sorted(defined)}"
)
overlap = prior_defined & defined
assert overlap == {name.lower() for name in REDEFINED_FUNCTIONS}, (
    f"unexpected redefinitions: {sorted(overlap - {n.lower() for n in REDEFINED_FUNCTIONS})}"
)
for name in REDEFINED_FUNCTIONS:
    block = function_block(name).lower()
    assert "security definer" in block, f"{name} must be security definer"
    assert "set search_path" in block, f"{name} must pin search_path"

print("== ledger idempotency guards are kept ==")
post_item_block = function_block("post_stock_goods_receipt_item")
assert "'gr-item:'" in post_item_block, "post_stock_goods_receipt_item must keep the gr-item key"
assert "on conflict (source, source_ref_key)" in post_item_block
assert "on conflict (idempotency_key)" in post_item_block
to_stock_block = function_block("post_goods_receipt_to_stock")
assert "post_stock_goods_receipt_item" in to_stock_block
assert "'gr-item:'" in MIGRATION
assert "on conflict (source, source_ref_key)" in MIGRATION
assert "on conflict (idempotency_key)" in MIGRATION

print("== non_stock and stock_exempt are skipped ==")
assert "line_class = 'non_stock'" in MIGRATION
assert "stock_exempt" in LOWER
assert "'supplier_exempt'" in MIGRATION
assert "'non_stock'" in MIGRATION
assert "alter table public.stock_material_aliases" in MIGRATION
assert "add column if not exists line_class text not null default 'stock'" in MIGRATION
assert re.search(
    r"drop\s+constraint\s+if\s+exists\s+stock_material_aliases_location_item_check",
    MIGRATION,
    re.IGNORECASE,
), "the location/item constraint must be dropped by name"
assert "previous_line_class" in MIGRATION
assert "new_line_class" in MIGRATION
assert "p_line_class text default 'stock'" in MIGRATION

print("== no payable / receipt-item / ledger write ==")
for table in FORBIDDEN_WRITE_TABLES:
    assert not re.search(rf"\bupdate\s+(public\.)?{re.escape(table)}\b", LOWER), f"must not update {table}"
    assert not re.search(rf"\bdelete\s+from\s+(public\.)?{re.escape(table)}\b", LOWER), f"must not delete {table}"

print("== goods_receipts is only written by apply_supplier_routing, only receiving_location ==")
assert len(re.findall(r"update\s+public\.goods_receipts", LOWER)) == 1, (
    "goods_receipts must be updated exactly once"
)
apply_block = function_block("apply_supplier_routing")
assert "update public.goods_receipts" in apply_block
set_clause = apply_block.split("update public.goods_receipts", 1)[1].split("where", 1)[0]
assignments = re.findall(r"([a-z_]+)\s*=(?!=)", set_clause)
assert assignments == ["receiving_location"], f"goods_receipts set clause is not receiving_location only: {assignments}"

print("== supplier routing schema ==")
for column in [
    "add column if not exists stock_exempt boolean not null default false",
    "add column if not exists receiving_location_source text",
    "add column if not exists receiving_location_set_at timestamptz",
    "check (receiving_location_source is null or receiving_location_source in ('manual', 'jev', 'rule'))",
]:
    assert column in MIGRATION, f"missing suppliers column/check: {column}"
for column in [
    "proposed_location text not null check (proposed_location in ('q7', 'tan_tao', 'non_stock'))",
    "jev_answer jsonb",
    "evidence jsonb",
    "prompt_version text not null",
    "previous_location text",
    "previous_exempt boolean",
    "status text not null default 'pending'",
    "unique (supplier_id, prompt_version)",
]:
    assert column in MIGRATION, f"missing supplier suggestion column: {column}"
for column in [
    "material_id uuid not null references public.sku_cogs_materials(id)",
    "proposed_category text not null references public.stock_material_categories(code)",
    "previous_category text",
    "decided_by uuid",
    "unique (material_id, prompt_version)",
]:
    assert column in MIGRATION, f"missing material suggestion column: {column}"

print("== 11 seeded material categories ==")
assert re.search(r"create\s+table\s+if\s+not\s+exists\s+public\.stock_material_categories", MIGRATION, re.IGNORECASE)
assert "code text primary key" in MIGRATION
assert "label_vi text not null" in MIGRATION
assert "sort_order integer" in MIGRATION
for code, label in CATEGORY_SEED:
    assert f"('{code}'" in MIGRATION, f"missing category seed {code}"
    assert label in MIGRATION, f"missing category label {label}"

print("== RLS + explicit grants on the new tables ==")
for table in NEW_TABLES:
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
    assert re.search(
        rf"create\s+policy\s+\w+\s+on\s+public\.{table}\s+for\s+select\s+to\s+authenticated\s+"
        rf"using\s*\(\s*public\.material_alias_can_view",
        MIGRATION,
        re.IGNORECASE,
    ), f"{table} must be readable via material_alias_can_view"

print("== RPC permissions and ledger helpers ==")
assert "material_alias_can_admin" in MIGRATION
assert "material_alias_can_view" in MIGRATION
assert "security definer" in function_block("apply_supplier_routing").lower()
assert "stock_ledger_cutover_date" in function_block("apply_supplier_routing")
review_block = function_block("get_stock_routing_review")
for key in (
    "supplier_pending",
    "supplier_recent",
    "supplier_counts",
    "material_pending",
    "material_category_counts",
    "categories",
    "stock_catalog_jev_usage",
):
    assert key in review_block, f"review is missing {key}"
assert "material_alias_can_view" in review_block

print("== edge function kill switch + quota + thresholds ==")
assert "BMQ_JEV_KILL_SWITCH" in EDGE_INDEX
assert "AI_GATEWAY_API_KEY" in EDGE_INDEX
assert "stock_catalog_jev_usage" in EDGE_STORE
assert "STOCK_ROUTING_DAILY_CALL_LIMIT" in EDGE_HANDLER
assert "STOCK_ROUTING_ROUTE_THRESHOLD = 0.9" in EDGE_HANDLER
assert "STOCK_ROUTING_CATEGORY_THRESHOLD = 0.85" in EDGE_HANDLER
assert "JEV_TIMEOUT_MS = 4000" in EDGE_JEV
assert "JEV_PROMPT_VERSION" in EDGE_JEV
assert "route" in EDGE_JEV and "category" in EDGE_JEV
assert "q7" in EDGE_JEV and "tan_tao" in EDGE_JEV and "non_stock" in EDGE_JEV
assert "[functions.stock-routing-jev]" in CONFIG

print("== TS lib and hook ==")
assert "shouldAutoApplyRouting" in TS_LIB
assert "shouldAutoApplyCategory" in TS_LIB
assert "parseStockRoutingReview" in TS_LIB
assert "parseStockRoutingJevResponse" in TS_LIB
assert "0.9" in TS_LIB and "0.85" in TS_LIB
for hook in (
    "useStockRoutingReview",
    "useRunStockRoutingJev",
    "useDecideSupplierRouting",
    "useRevertSupplierRouting",
    "useDecideMaterialCategory",
    "useRevertMaterialCategory",
):
    assert hook in TS_HOOK, f"missing hook {hook}"

print("== smoke scenarios ==")
for marker in (
    "supplier_routing_evidence",
    "apply_supplier_routing",
    "revert_supplier_routing",
    "post_goods_receipt_to_stock",
    "confirm_material_alias",
    "decide_material_category",
    "revert_material_category",
    "get_stock_routing_review",
):
    assert marker in SMOKE, f"smoke is missing {marker}"

print("stock routing contract passed")
