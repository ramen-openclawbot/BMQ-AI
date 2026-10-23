#!/usr/bin/env python3
"""Static contract for 20261102840000_kho_unit_change_keeps_class.sql (no DB)."""
from pathlib import Path
import re

sql = (Path(__file__).resolve().parents[1] / "supabase" / "migrations" / "20261102840000_kho_unit_change_keeps_class.sql").read_text(encoding="utf-8").lower()
flat = re.sub(r"\s+", " ", sql)
assert re.findall(r"create or replace function public\.([a-z_]+)\(", sql) == ["change_stock_item_unit"], "only change_stock_item_unit is redefined"
assert "item_code, normalized_key, item_type, item_class, pastry_q7, in_tan_tao, note," in flat, "sibling copies class, places and note"
assert "null, v_key, v_item.item_type, v_item.item_class, v_item.pastry_q7, v_item.in_tan_tao, v_item.note," in flat
assert "public.apply_stock_item_merge(p_item_id, v_new_item_id, v_factor, null)" in flat
assert "set item_code = 'unit-' || p_item_id::text" in flat and "set item_code = v_item.item_code where id = v_new_item_id" in flat, "the item keeps its code"
assert flat.index("apply_stock_item_merge(p_item_id, v_new_item_id") < flat.index("set item_code = v_item.item_code"), "code swap happens after the merge"
print("PASS: kho unit change keeps class/code contract holds")
