#!/usr/bin/env python3
"""Static contract checks for the dealer cart assistant slice.

Read-only: no deploy, no migration apply, no network calls.
Run from apps/web: python3 scripts/test_dealer_cart_assistant_contract.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS = ROOT / "supabase" / "functions"
EDGE = FUNCTIONS / "dealer-cart-assistant" / "index.ts"
CATALOG_DATA = FUNCTIONS / "_shared" / "dealer-catalog-data.ts"
RECENT_ORDERS = FUNCTIONS / "_shared" / "dealer-recent-orders.ts"
GATES = FUNCTIONS / "_shared" / "dealer-cart-gates.ts"
CATALOG_EDGE = FUNCTIONS / "dealer-catalog" / "index.ts"
MIGRATIONS = ROOT / "supabase" / "migrations"

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(condition), detail))


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


edge_text = read(EDGE) if EDGE.exists() else ""
catalog_data_text = read(CATALOG_DATA) if CATALOG_DATA.exists() else ""
recent_orders_text = read(RECENT_ORDERS) if RECENT_ORDERS.exists() else ""
gates_text = read(GATES) if GATES.exists() else ""
catalog_edge_text = read(CATALOG_EDGE) if CATALOG_EDGE.exists() else ""

# ── Edge function auth / AI / gates ─────────────────────────────────────────
check("edge function exists", EDGE.exists(), str(EDGE))
check("uses resolveDealerSession", "resolveDealerSession" in edge_text)
check("returns 401 dealer_session_required", "401" in edge_text and "dealer_session_required" in edge_text)
check("uses DeepSeek config", 'getScanAiConfig("deepseek")' in edge_text)
check("thinking is disabled", re.search(r"thinking\s*:\s*\{\s*type\s*:\s*[\"']disabled[\"']", edge_text) is not None)
check("runs normalizeProposal on server", "normalizeProposal(args.lines" in edge_text or "normalizeProposal(" in edge_text)
check("model tools include search_catalog", "search_catalog" in edge_text)
check("model tools include get_recent_orders", "get_recent_orders" in edge_text)
check("model tools include propose_cart", "propose_cart" in edge_text)
check("tool rounds are capped at 4", "MAX_TOOL_ROUNDS = 4" in edge_text)
check("daily limit is 60", "DAILY_LIMIT = 60" in edge_text)
check("daily limit returns 429 code", "429" in edge_text and "assistant_daily_limit" in edge_text)
check("returns reply / proposal / warnings", all(token in edge_text for token in ("reply", "proposal: finalProposal", "warnings")))
check("classifies DeepSeek errors", "classifyOpenAIError" in edge_text and "aiErrorJson" in edge_text)
check("logs dealer id, line count, tokens and duration",
      "dealer=${session.customer.id}" in edge_text
      and "lines=${finalProposal?.lines.length" in edge_text
      and "tokens=${totalTokens}" in edge_text
      and "duration_ms=" in edge_text)

# ── No sales writes anywhere in the assistant read path ────────────────────
WRITE_METHOD = re.compile(r"\.(insert|upsert|update|delete)\s*\(")
for label, text in (
    ("dealer-cart-assistant/index.ts", edge_text),
    ("_shared/dealer-catalog-data.ts", catalog_data_text),
    ("_shared/dealer-recent-orders.ts", recent_orders_text),
    ("_shared/dealer-cart-gates.ts", gates_text),
):
    check(f"{label} has no insert/upsert/update/delete", WRITE_METHOD.search(text) is None)

for table in ("dealer_orders", "dealer_order_items", "product_skus", "mini_crm_customer_price_list"):
    pattern = re.compile(rf"from\(\s*[\"']{re.escape(table)}[\"']\s*\)\s*\.\s*(insert|upsert|update|delete)")
    check(f"no write query to {table}", pattern.search(edge_text) is None)

# ── Shared helpers / catalog response preserved ───────────────────────────
check("loadDealerCatalog helper exists", "export async function loadDealerCatalog" in catalog_data_text)
check("recent orders helper exists", "export async function loadDealerRecentOrders" in recent_orders_text)
for field in (
    "id:", "sku_code:", "product_name:", "category:", "unit:", "unit_price:",
    "price_vnd:", "price_source:", "notes:", "image_url:", "image_path:",
    "image_updated_at:", "shelf_life_days:", "net_weight_value:", "net_weight_unit:",
):
    check(f"catalog product keeps field {field}", field in catalog_data_text)
for field in ("success: true", "products,", "announcements:", "customer:", "dealer_routes:"):
    check(f"dealer-catalog response keeps {field}", field in catalog_edge_text)
check("dealer-catalog delegates to shared helper", "loadDealerCatalog(supabase, sessionContext)" in catalog_edge_text)
check("dealer-catalog still hides dealer-hidden SKUs", "hide_from_dealer_portal" in catalog_data_text)
check("dealer-catalog still applies customer price list", "mini_crm_customer_price_list" in catalog_data_text)

# ── Pure gates ──────────────────────────────────────────────────────────────
for token in (
    "DEALER_ORDER_STEP = 10",
    "DEALER_CART_MAX_PER_LINE = 1000",
    "DEALER_CART_MAX_LINES = 60",
    "normalizeProposal",
    "Math.ceil",
    "warnings",
):
    check(f"gates contain {token}", token in gates_text)
check("gates fill price from catalog, not model", "product.price_vnd ?? product.unit_price" in gates_text)

# ── Migration security ──────────────────────────────────────────────────────
migrations = sorted(MIGRATIONS.glob("*_dealer_cart_assistant_usage.sql"))
check("exactly one usage migration exists", len(migrations) == 1, str(migrations))
migration_text = read(migrations[0]) if migrations else ""
lower_migration = migration_text.lower()
check("migration creates usage table", "create table if not exists public.dealer_cart_assistant_usage" in lower_migration)
check("migration primary key is dealer/day", "primary key (dealer_customer_id, usage_date)" in lower_migration)
check("migration enables RLS", "enable row level security" in lower_migration)
check("migration revokes table from clients",
      "revoke all on table public.dealer_cart_assistant_usage from public, anon, authenticated" in lower_migration)
check("migration grants table to service_role",
      "grant select, insert, update, delete on table public.dealer_cart_assistant_usage to service_role" in lower_migration)
check("migration RPC is security definer", "security definer" in lower_migration)
check("migration RPC locks the row", "for update" in lower_migration)
check("migration revokes RPC from clients",
      "revoke all on function public.increment_dealer_cart_assistant_usage(uuid, integer) from public, anon, authenticated" in lower_migration)
check("migration grants RPC to service_role",
      "grant execute on function public.increment_dealer_cart_assistant_usage(uuid, integer) to service_role" in lower_migration)
check("migration does not touch order tables",
      re.search(r"\b(from|into|update|delete\s+from|join)\s+(public\.)?dealer_orders?\b", lower_migration) is None)
check("migration does not touch product_skus or price columns",
      re.search(r"\b(from|into|update|delete\s+from|join)\s+(public\.)?product_skus\b", lower_migration) is None
      and not any(column in lower_migration for column in ("price_vnd_per_unit", "unit_price", "cost_values")))

failed = [item for item in CHECKS if not item[1]]
for name, ok, detail in CHECKS:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))

print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} checks passed")
if failed:
    sys.exit(1)
