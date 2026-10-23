#!/usr/bin/env python3
"""Static contract for 20261102830000_kho_merge_by_class.sql (no DB)."""
from pathlib import Path
import re

sql = (Path(__file__).resolve().parents[1] / "supabase" / "migrations" / "20261102830000_kho_merge_by_class.sql").read_text(encoding="utf-8").lower()
flat = re.sub(r"\s+", " ", sql)
assert re.findall(r"create or replace function public\.([a-z_]+)\(", sql) == ["apply_stock_item_merge"], "only the merge is redefined"
assert "coalesce(v_source.item_class, v_source.item_type) is distinct from coalesce(v_target.item_class, v_target.item_type)" in flat
assert "v_source.item_type is distinct from v_target.item_type" not in flat, "legacy item_type check removed"
assert "merge_source_was_target" not in sql, "merge chains stay allowed"
for needle in ("for c in select sm.* from public.stock_item_merges sm where sm.target_id = p_source", "update public.stock_material_aliases", "insert into public.tan_tao_material_movements"):
    assert needle in flat, needle
assert "revoke all on function public.apply_stock_item_merge(uuid, uuid, numeric, uuid) from public, anon;" in flat
assert "grant execute on function public.apply_stock_item_merge(uuid, uuid, numeric, uuid) to authenticated, service_role;" in flat
print("PASS: kho merge-by-class contract holds")
