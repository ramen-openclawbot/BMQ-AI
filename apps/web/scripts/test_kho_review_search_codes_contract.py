#!/usr/bin/env python3
"""Static contract checks for 20261102800000_kho_review_search_codes.sql (no DB)."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
sql = (ROOT / "supabase" / "migrations" / "20261102800000_kho_review_search_codes.sql").read_text(encoding="utf-8").lower()
flat = re.sub(r"\s+", " ", sql)

assert len(re.findall(r"create\s+or\s+replace\s+function", sql)) == 1, "only kho_review_search_lines is redefined"
assert "create or replace function public.kho_review_search_lines(" in sql
assert "lower(extensions.unaccent(btrim(coalesce(p_query, ''))))" in sql, "query words are raw unaccented tokens"
assert "normalize_stock_item_name(p_query)" not in sql, "codes must not be stripped by name normalization"
for needle in ("gr.receipt_number", "po.po_number", "s.name", "left join public.purchase_orders po on po.id = gr.purchase_order_id", "as doc_text", "l.doc_text not ilike"):
    assert needle in sql, f"missing {needle}"
assert "current_date - 90" not in sql, "search keeps no 90-day window"
assert "least(greatest(coalesce(p_limit, 20), 1), 50)" in sql
assert "'kho_review_forbidden'" in sql and "public.has_module_permission(v_actor, 'inventory', 'edit')" in sql
assert "revoke all on function public.kho_review_search_lines(text, text, integer) from public, anon;" in flat
assert "grant execute on function public.kho_review_search_lines(text, text, integer) to authenticated, service_role;" in flat
print("PASS: kho review search-by-code contracts hold")
