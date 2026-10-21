#!/usr/bin/env python3
"""Static contract checks for 20261102580000_kho_commitments.sql.

No database connection.  These checks guard the read-only commitment RPC and
the hourly cron move:
  * kho_get_commitments is SECURITY DEFINER with a pinned search_path;
  * its reader gate is the exact kho_get_items gate;
  * as_of uses Asia/Ho_Chi_Minh and the payload exposes items/skus/gaps;
  * anon cannot execute it;
  * it never writes the ledgers, documents or production tables;
  * only the two named jobs are altered to the two hourly schedules.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102580000_kho_commitments.sql"

PRESERVED = (
    "run_tan_tao_daily_ledger",
    "run_q7_fg_daily_ledger",
    "post_stock_goods_receipt_item",
    "kho_get_items",
)

WRITE_TABLES = (
    "q7_inventory_movements",
    "tan_tao_material_movements",
    "tan_tao_warehouse_movements",
    "tan_tao_warehouse_documents",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"--[^\n]*", "", text)


def extract_function(text: str, marker: str) -> str:
    start = text.index(marker)
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert match is not None, f"no AS dollar-quote after {marker}"
    tag = match.group(1)
    end = text.index(tag + ";", start + match.end())
    return text[start : end + len(tag) + 1]


def main() -> None:
    assert MIGRATION.exists(), f"missing migration {MIGRATION.name}"
    migration = read(MIGRATION)
    lower = migration.lower()
    sql = strip_comments(migration)

    # --- 1. RPC envelope and reader gate --------------------------------
    marker = "create or replace function public.kho_get_commitments()"
    assert marker in lower, "missing kho_get_commitments()"
    body = extract_function(migration, marker)
    body_lower = body.lower()
    assert "returns jsonb" in body_lower, "kho_get_commitments must return jsonb"
    assert "language plpgsql" in body_lower, "kho_get_commitments must be plpgsql"
    assert "stable" in body_lower, "kho_get_commitments must be stable"
    assert "security definer" in body_lower, "kho_get_commitments must be SECURITY DEFINER"
    assert (
        "set search_path = public, pg_temp" in body_lower
    ), "kho_get_commitments must pin search_path = public, pg_temp"

    for needle in (
        "if v_actor is null then",
        "'actor_required'",
        "public.q7_material_inventory_can_view(v_actor)",
        "public.stock_count_can_view('tan_tao')",
        "public.stock_count_can_view('q7')",
        "public.kho_item_can_edit(v_actor)",
        "'insufficient_privilege'",
        "errcode = '42501'",
    ):
        assert needle in body_lower, f"reader gate is missing {needle}"

    # --- 2. as_of and payload -------------------------------------------
    assert (
        "(now() at time zone 'asia/ho_chi_minh')::date" in body_lower
    ), "as_of must use Asia/Ho_Chi_Minh"
    for field in (
        "'as_of'",
        "'items'",
        "'skus'",
        "'gaps'",
        "'kitchen_inventory_item_id'",
        "'committed_qty'",
        "'next_date'",
        "'sources'",
        "'kind', 'pxk'",
        "'overdue_qty'",
        "'available'",
        "'orders'",
        "'pxk_lines_unposted'",
        "'pxk_unposted_issues'",
    ):
        assert field in body_lower, f"payload is missing {field}"

    # --- 3. grants -------------------------------------------------------
    assert (
        "revoke all on function public.kho_get_commitments() from public, anon"
        in lower
    ), "kho_get_commitments must revoke public/anon"
    assert (
        "grant execute on function public.kho_get_commitments() to authenticated, service_role"
        in lower
    ), "kho_get_commitments must grant authenticated/service_role"

    # --- 4. no ledger/document/production writes ------------------------
    assert re.search(r"\bdelete\s+from\b", sql, re.IGNORECASE) is None, (
        "migration must not DELETE"
    )
    for table in WRITE_TABLES:
        pattern = (
            rf"\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?)"
            rf"\s+(?:public\.)?{table}\b"
        )
        assert re.search(pattern, sql, re.IGNORECASE) is None, (
            f"migration must not write {table}"
        )
    assert (
        re.search(
            r"\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?)"
            r"\s+(?:public\.)?production_\w+",
            sql,
            re.IGNORECASE,
        )
        is None
    ), "migration must not write any production_* table"

    # --- 5. preserved functions are not redefined -----------------------
    for name in PRESERVED:
        assert (
            f"create or replace function public.{name}(" not in lower
        ), f"must not redefine {name}"

    # --- 6. only the two jobs, only the two hourly schedules ------------
    assert "cron.schedule" not in lower, "must not create a cron schedule"
    assert "cron.unschedule" not in lower, "must not unschedule a job"
    assert sql.lower().count("cron.alter_job(") == 2, "must alter exactly two jobs"

    cron_calls = re.findall(r"cron\.alter_job\s*\(([^;]*?)\)", sql, re.IGNORECASE)
    schedules = []
    for arguments in cron_calls:
        quoted = re.findall(r"'([^']*)'", arguments)
        assert quoted, "cron.alter_job must pass a quoted schedule"
        schedules.append(quoted[-1])
    assert set(schedules) == {"5 * * * *", "10 * * * *"}, (
        f"unexpected cron schedules: {schedules}"
    )

    jobnames = set(re.findall(r"jobname\s*=\s*'([^']+)'", sql, re.IGNORECASE))
    assert jobnames == {"tan-tao-daily-ledger", "q7-fg-daily-ledger"}, (
        f"unexpected job names: {jobnames}"
    )
    assert re.search(
        r"jobname\s*=\s*'tan-tao-daily-ledger'[\s\S]{0,400}?"
        r"cron\.alter_job\s*\([^;]*?'5 \* \* \* \*'",
        sql,
        re.IGNORECASE,
    ), "tan-tao-daily-ledger must get schedule 5 * * * *"
    assert re.search(
        r"jobname\s*=\s*'q7-fg-daily-ledger'[\s\S]{0,400}?"
        r"cron\.alter_job\s*\([^;]*?'10 \* \* \* \*'",
        sql,
        re.IGNORECASE,
    ), "q7-fg-daily-ledger must get schedule 10 * * * *"
    cron_refs = set(re.findall(r"cron\.\w+", sql, re.IGNORECASE))
    assert cron_refs <= {"cron.job", "cron.alter_job"}, (
        f"unexpected cron usage: {cron_refs}"
    )

    print("PASS: kho commitment contracts hold")


if __name__ == "__main__":
    main()
