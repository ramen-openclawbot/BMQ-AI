#!/usr/bin/env python3
"""Contract test for the procurement unit-drift fix (stdlib only).

Guards that apps/web/supabase/migrations/20261101130000_procurement_unit_drift.sql
re-creates public.apply_procurement_line_material_resolution from the newest
original definition (20260817170000_task6_procurement_material_controller.sql)
and changes ONLY the 'procurement source unit drift' comparison, casting both
sides through the same stock_unit_code -> label mapping the document-line
trigger applies. The signature, security, search_path, comments and grants stay
identical, no trigger is disabled, and the rollback-only smoke covers the unit
list and PO-000842 and ends with the SMOKE_RESULT PASS raise.

Run from the repository root:
  python3 apps/web/scripts/test_procurement_unit_drift_contract.py
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
MIGRATIONS = REPO / "apps/web" / "supabase" / "migrations"
ORIGINAL = MIGRATIONS / "20260817170000_task6_procurement_material_controller.sql"
NEW = MIGRATIONS / "20261101130000_procurement_unit_drift.sql"
SMOKE = REPO / "apps/web" / "scripts" / "smoke_procurement_unit_drift.sql"

FUNC_HEADER = "create or replace function public.apply_procurement_line_material_resolution("
FUNC_TAIL = "\n$$;"
DRIFT_RAISE = "raise exception 'procurement source unit drift' using errcode = '23514';"
DRIFT_MARKER = "<<UNIT_DRIFT_CHECK>>"
PASS_RAISE = "raise exception 'SMOKE_RESULT PASS: procurement unit drift';"

UNITS = [
    "Cái", "cai", "pcs", "chiếc", "Chiếc", "kg", "gr", "Gói", "thùng",
    "hộp", "tờ", "từ", "PCS", "cây", "bịch", "lít", "Lít",
]

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


def read(path: Path) -> str:
    check(path.is_file(), f"missing file: {path}")
    return path.read_text() if path.is_file() else ""


def extract_function(sql: str) -> str:
    start = sql.index(FUNC_HEADER)
    end = sql.index(FUNC_TAIL, start) + len(FUNC_TAIL)
    return sql[start:end]


def split_signature(func: str) -> tuple[str, str]:
    marker = "\nas $$"
    idx = func.index(marker)
    return func[:idx], func[idx:]


def strip_drift_block(func: str) -> str:
    """Replace the whole unit-drift 'if' construct with one marker."""
    raise_at = func.index(DRIFT_RAISE)
    if_start = func.rindex("\n  if ", 0, raise_at) + 1
    end_at = func.index("\n  end if;", raise_at) + len("\n  end if;")
    return func[:if_start] + DRIFT_MARKER + func[end_at:]


def function_grants(sql: str) -> list[str]:
    lines = []
    for raw in sql.splitlines():
        line = raw.strip()
        if "on function public.apply_procurement_line_material_resolution" not in line:
            continue
        if line.startswith("revoke ") or line.startswith("grant "):
            lines.append(line)
    return lines


def function_comments(sql: str) -> list[str]:
    return [
        raw.strip()
        for raw in sql.splitlines()
        if raw.strip().startswith("comment on function public.apply_procurement_line_material_resolution")
    ]


def main() -> int:
    original_sql = read(ORIGINAL)
    new_sql = read(NEW)
    smoke_sql = read(SMOKE)

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        return 1

    original_func = extract_function(original_sql)
    new_func = extract_function(new_sql)

    # 1. Signature + security + search_path are byte-for-byte identical.
    original_header, _ = split_signature(original_func)
    new_header, _ = split_signature(new_func)
    check(original_header == new_header, "function signature/security/search_path changed")

    # 2. Grants/revokes identical (re-issued in the migration).
    check(
        function_grants(original_sql) == function_grants(new_sql),
        "apply function grants/revokes changed",
    )
    check(
        function_comments(original_sql) == function_comments(new_sql),
        "apply function comment changed",
    )

    # 3. The only body difference is the unit-drift comparison.
    check(
        strip_drift_block(original_func) == strip_drift_block(new_func),
        "re-created function differs outside the unit-drift comparison",
    )
    check("stock_unit_code" not in original_func, "original function unexpectedly normalises units")
    check(
        "public.stock_unit_code(v_line.unit)" in new_func,
        "new function does not normalise the stored line unit",
    )
    check(
        "public.stock_unit_code(coalesce(v_raw_unit, v_line.unit))" in new_func,
        "new function does not normalise the caller raw unit",
    )
    check(
        "lower(btrim(coalesce(v_line.unit, '')))" in new_func
        and "lower(btrim(coalesce(v_raw_unit, v_line.unit, '')))" in new_func,
        "new function lost the lower(btrim(...)) fallback for unknown units",
    )

    # 4. No trigger is disabled and no trigger is dropped.
    lowered = new_sql.lower()
    for forbidden in ("disable trigger", "session_replication_role", "drop trigger"):
        check(forbidden not in lowered, f"migration must not use {forbidden!r}")

    # 5. Smoke covers the unit list, PO-000842 and the final PASS raise.
    for unit in UNITS:
        check(f"'{unit}'" in smoke_sql, f"smoke does not cover unit {unit!r}")
    check("'PO-000842'" in smoke_sql, "smoke does not reference PO-000842")
    check("5346000" in smoke_sql, "smoke does not assert the 5.346.000 total")
    check(
        "public.stock_unit_code(v_line.unit)" in smoke_sql,
        "smoke does not apply the fixed function body inline",
    )
    check(PASS_RAISE in smoke_sql, "smoke does not end with the PASS raise")
    check(
        smoke_sql.rindex("raise exception 'SMOKE_RESULT") == smoke_sql.rindex(PASS_RAISE),
        "the final smoke raise is not the PASS raise",
    )
    check(
        smoke_sql.rindex(PASS_RAISE) > smoke_sql.index("'PO-000842'"),
        "the PASS raise does not follow the PO-000842 assertions",
    )

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        return 1

    print("PASS: procurement unit drift contract")
    print(f"  original : {ORIGINAL.relative_to(REPO)}")
    print(f"  migration: {NEW.relative_to(REPO)}")
    print(f"  smoke    : {SMOKE.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
