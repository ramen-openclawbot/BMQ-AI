#!/usr/bin/env python3
"""Static contract for 20261103200000_cogs_hold_autoclear.sql: run_cogs_backflush equals the
20261103090000 body plus only the stale-hold delete block and the cleared_holds key."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NEW = ROOT / "supabase/migrations/20261103200000_cogs_hold_autoclear.sql"
OLD = ROOT / "supabase/migrations/20261103090000_cogs_backflush_rounding_fix.sql"
MARK = "create or replace function public.run_cogs_backflush("


def body(text: str) -> str:
    i = text.index(MARK)
    j = text.index("$$;", text.index("as $$", i) + 5) + 3
    return text[i:j]


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"--[^\n]*", "", text)).strip().lower()


def main() -> None:
    new_sql = NEW.read_text(encoding="utf-8")
    new, old = body(new_sql), body(OLD.read_text(encoding="utf-8"))
    block_start = new.index("      -- A held day this run did not hold again")
    block_end = new.index("      get diagnostics v_cleared = row_count;\n") + len("      get diagnostics v_cleared = row_count;\n")
    block = new[block_start:block_end]
    assert "delete from public.cogs_backflush_holds h" in block
    assert "h.status = 'held'" in block and "h.run_id is distinct from v_run_id" in block
    assert "h.movement_date between p_from and p_to" in block
    for table in ("q7_inventory_movements", "tan_tao_material_movements"):
        assert table not in block, "the clean-up never touches a ledger"
    restored = (new[:block_start] + new[block_end:]).replace("  v_cleared integer := 0;\n", "", 1)
    restored = restored.replace("'rejected_skip_rows', v_rejected_skip,\n      'cleared_holds', v_cleared,", "'rejected_skip_rows', v_rejected_skip,")
    assert norm(restored) == norm(old), "run_cogs_backflush changed beyond the clean-up block"
    assert new.count("'cleared_holds', v_cleared") == 2
    assert block_start > new.index("end loop;", new.index("for v_setting in")), "clean-up runs after the posting loop"
    assert "if not coalesce(p_dry_run, true) then" in new[:block_start], "dry runs never delete"
    sql = norm(new_sql)
    assert "revoke all on function public.run_cogs_backflush(date, date, boolean) from public, anon, authenticated;" in sql
    assert "grant execute on function public.run_cogs_backflush(date, date, boolean) to service_role;" in sql
    assert sql.count("create or replace function") == 1
    print("PASS: cogs hold auto-clear contract holds")


if __name__ == "__main__":
    main()
