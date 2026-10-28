#!/usr/bin/env python3
"""Static contract for 20261103240000_kho_revenue_auto.sql.

No database: it compares the redefined run_cogs_backflush with the 20261103200000 body apart from
the declared hunks and checks the warning table, learner, nightly order, reader gate and grants.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase/migrations"
NEW = MIGRATIONS / "20261103240000_kho_revenue_auto.sql"
BASE = MIGRATIONS / "20261103200000_cogs_hold_autoclear.sql"


def function_body(text: str, name: str) -> str:
    mark = f"create or replace function public.{name}("
    start = text.index(mark)
    end = text.index("$$;", text.index("as $$", start) + 5) + 3
    return text[start:end]


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"--[^\n]*", "", text)).strip().lower()


def remove_hold_blocks(body: str) -> str:
    """Blank the old/new hold decision block in both posting loops."""
    for _ in range(2):
        try:
            start = body.index("            if v_delta_qty > 0 then\n              -- Hold an abnormal positive day")
        except ValueError:
            start = body.index("            if v_delta_qty > 0 then\n              select * into v_hold")
        end = body.index("            if v_delta_qty > 0 then\n              insert into public.", start)
        body = body[:start] + body[end:]
    return body


def main() -> None:
    sql = NEW.read_text(encoding="utf-8")
    old_sql = BASE.read_text(encoding="utf-8")

    # --- expected version and presence of all five parts ---------------------
    assert NEW.name.startswith("2026110324"), NEW.name
    assert not list(MIGRATIONS.glob("2026110324*_*.sql"))[1:], "one migration at this version"
    for needle in (
        "create table if not exists public.cogs_backflush_warnings",
        "create or replace function public.run_cogs_backflush(",
        "create or replace function public.cogs_learn_usage_factors()",
        "create or replace function public.run_cogs_backflush_nightly()",
        "create or replace function public.kho_revenue_day(p_day date)",
    ):
        assert needle in sql, needle

    # --- run_cogs_backflush equals the old body apart from the listed hunks --
    new = function_body(sql, "run_cogs_backflush")
    old = function_body(old_sql, "run_cogs_backflush")

    for write in (
        "insert into public.cogs_backflush_holds",
        "update public.cogs_backflush_holds",
        "delete from public.cogs_backflush_holds",
    ):
        assert write not in new, f"run_cogs_backflush must not write holds: {write}"
    assert new.count("v_hold.status = 'rejected'") == 2, "rejected hold skip in both branches"
    assert new.count("v_rejected_skip := v_rejected_skip + 1;") == 2

    guard_at = [m.start() for m in re.finditer(r"w\.kind = 'unit'", new)]
    ledgers_at = [m.start() for m in re.finditer(r"insert into public\.(?:q7_inventory_movements|tan_tao_material_movements)\(", new)]
    assert len(guard_at) == 2, "one unit guard per branch"
    assert len(ledgers_at) == 4, "two ledger inserts (usage + adjustment) per branch"
    assert guard_at[0] < ledgers_at[0], "Q7 unit guard precedes its inserts"
    assert ledgers_at[1] < guard_at[1] < ledgers_at[2], "Tân Tạo unit guard sits between the two branches"

    # Reconstruct the unchanged body: drop the warning block, both hold decisions,
    # the old stale-hold clean-up and the changed declaration/summary bookkeeping.
    start = new.index("      -- Warnings are observations")
    end = new.index("      get diagnostics v_warned = row_count;\n") + len("      get diagnostics v_warned = row_count;\n")
    new_rest = new[:start] + new[end:]
    new_rest = remove_hold_blocks(new_rest)

    old_rest = remove_hold_blocks(old)
    start = old_rest.index("      -- A held day this run did not hold again")
    end = old_rest.index("      get diagnostics v_cleared = row_count;\n") + len("      get diagnostics v_cleared = row_count;\n")
    old_rest = old_rest[:start] + old_rest[end:]
    old_rest = (
        old_rest.replace("'held_rows', v_held", "'warned_rows', v_warned")
        .replace("'cleared_holds', v_cleared", "'blocked_rows', v_blocked")
    )

    declaration_lines = re.compile(
        r"^  v_(?:held|cleared|warned|blocked) integer := 0;\n"
        r"|^  v_(?:reference_qty|reference_days) (?:numeric|integer);\n"
        r"|^  v_hold_reason text;\n",
        re.M,
    )
    assert norm(declaration_lines.sub("", new_rest)) == norm(declaration_lines.sub("", old_rest)), (
        "run_cogs_backflush changed beyond the warning block, hold decision, stale clean-up and keys"
    )
    assert new.count("'warned_rows', v_warned") == 2
    assert new.count("'blocked_rows', v_blocked") == 2
    assert "'posted_rows', v_posted" in new and "'rejected_skip_rows', v_rejected_skip" in new

    # The ledger insert shape and source_ref_key must be byte-identical to the old body.
    for table in ("q7_inventory_movements", "tan_tao_material_movements"):
        pattern = re.compile(
            r"insert into public\." + table + r"\(.*?\);",
            re.S,
        )
        assert pattern.findall(new) == pattern.findall(old), f"{table} insert shape changed"

    # --- warnings table: RLS on, no policies, no grants -----------------------
    table_start = sql.index("create table if not exists public.cogs_backflush_warnings")
    table_end = sql.index(");", table_start) + 2
    table = sql[table_start:table_end]
    for column in (
        "location",
        "kitchen_inventory_item_id",
        "movement_date",
        "kind",
        "desired_qty",
        "reference_qty",
        "reference_days",
        "finished_units",
        "per_unit",
        "shrink_rate",
        "evidence",
        "run_id",
        "created_at",
        "updated_at",
    ):
        assert re.search(rf"\b{column}\b", table), column
    assert "check (location in ('q7', 'tan_tao'))" in table
    assert "check (kind in ('usual', 'unit', 'shrink'))" in table
    assert re.search(r"coalesce\(movement_date, '1900-01-01'", sql)
    assert "alter table public.cogs_backflush_warnings enable row level security;" in norm(sql)
    assert "revoke all on table public.cogs_backflush_warnings from public, anon, authenticated;" in norm(sql)
    assert "create policy" not in norm(sql).split("cogs_backflush_warnings")[1][:500]
    warn_section = sql[table_start:sql.index("create or replace function public.run_cogs_backflush(")]
    assert "grant " not in warn_section, "the warnings table has no grants"

    # --- learner --------------------------------------------------------------
    learner = norm(function_body(sql, "cogs_learn_usage_factors"))
    for table in ("q7_inventory_movements", "tan_tao_material_movements"):
        for write in ("insert into", "update", "delete from"):
            assert f"{write} public.{table}" not in learner, f"learner writes {table}"
    assert "0.02" in learner and "0.15" in learner
    assert "count_date - prev_date >= 3" in learner
    assert "rn <= 3" in learner
    assert "source = 'learned'" in learner
    assert "insert into public.cogs_usage_factors" in learner
    assert "on conflict (location, kitchen_inventory_item_id, effective_from)" in learner
    assert "'learned'," in learner or "'learned'\n" in learner
    assert all(key in learner for key in ("'learned'", "'skipped'", "'warned'"))
    assert "shrink_rate" in learner and "kind = 'shrink'" in learner

    # --- nightly calls learner before backflush -------------------------------
    nightly = norm(function_body(sql, "run_cogs_backflush_nightly"))
    learn_at = nightly.index("perform public.cogs_learn_usage_factors();")
    flush_at = nightly.index("return public.run_cogs_backflush(")
    assert learn_at < flush_at, "learner must run before the backflush"
    assert nightly.index("set_config('request.jwt.claim.role', 'service_role', true)") < learn_at

    # --- reader ---------------------------------------------------------------
    reader = norm(function_body(sql, "kho_revenue_day"))
    for gate in (
        "public.q7_material_inventory_can_view(v_actor)",
        "public.stock_count_can_view('tan_tao')",
        "public.stock_count_can_view('q7')",
        "public.kho_item_can_edit(v_actor)",
    ):
        assert gate in reader, gate
    assert "errcode = '42501'" in reader and "errcode = '22023'" in reader
    assert "v_today - 120" in reader
    assert "insert into" not in reader and "update " not in reader and "delete from" not in reader
    for key in (
        "'day'",
        "'generated_at'",
        "'channels'",
        "'materials'",
        "'items'",
        "'posted'",
        "'warnings'",
        "'refs'",
        "'counts'",
        "'count_periods'",
        "'factors'",
    ):
        assert key in reader, key

    # --- grants ---------------------------------------------------------------
    assert (
        "revoke all on function public.run_cogs_backflush(date, date, boolean) from public, anon, authenticated;"
        in norm(sql)
    )
    assert "grant execute on function public.run_cogs_backflush(date, date, boolean) to service_role;" in norm(sql)
    assert "revoke all on function public.cogs_learn_usage_factors() from public, anon, authenticated;" in norm(sql)
    assert "grant execute on function public.cogs_learn_usage_factors() to service_role;" in norm(sql)
    assert "revoke all on function public.kho_revenue_day(date) from public, anon;" in norm(sql)
    assert "grant execute on function public.kho_revenue_day(date) to authenticated;" in norm(sql)

    print("PASS: kho revenue auto contract holds")


if __name__ == "__main__":
    main()
