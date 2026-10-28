#!/usr/bin/env python3
"""Static contract checks for 20261103090000_cogs_backflush_rounding_fix.sql.

No database connection.  These checks guard the COGS backflush safety slice:
  * the migration defines only the two rounding helpers, the usage-reference
    helper, run_cogs_backflush and the two owner hold RPCs;
  * after whitespace normalisation run_cogs_backflush keeps the 20261102590000
    body exactly apart from the explicit allowed hunks (3-decimal desired and
    posted quantities, frozen-date predicates, the ledger-quantity guard, the
    extra desired_qty column, the hold block and the two summary keys);
  * the hold check only runs for positive deltas, after the ledger-qty guard and
    before either insert, in both the Q7 and Tan Tao branches;
  * the thresholds are exactly 5 reference days, 5 x reference and 1.10 x the
    approved quantity, and a hold never raises;
  * cogs_backflush_holds has RLS, no policies and no anon/authenticated grants;
  * the two hold RPCs are owner-gated, SECURITY DEFINER with a pinned
    search_path, revoked from public/anon and granted to authenticated;
  * neither stock ledger is updated or deleted.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261103090000_cogs_backflush_rounding_fix.sql"
BASELINE = ROOT / "supabase" / "migrations" / "20261102590000_revenue_cogs_backflush.sql"

LEDGERS = ("q7_inventory_movements", "tan_tao_material_movements")
FUNCTIONS = (
    "cogs_backflush_ledger_qty",
    "cogs_backflush_item_frozen_through",
    "cogs_backflush_usage_reference",
    "run_cogs_backflush",
    "cogs_backflush_list_holds",
    "cogs_backflush_decide_hold",
)

# The exact block inserted before the posting insert in each branch.  Comments
# are stripped by normalize_sql, so this can keep the migration's comments.
HOLD_BLOCK = """
            if v_delta_qty > 0 then
              -- Hold an abnormal positive day until an owner decides.
              v_hold_reason := null;
              v_hold_found := false;
              select * into v_hold
              from public.cogs_backflush_holds h
              where h.location = v_setting.location
                and h.kitchen_inventory_item_id = v_delta.item_id
                and h.movement_date = v_delta.movement_date;
              v_hold_found := found;

              if v_hold_found and v_hold.status = 'rejected' then
                v_rejected_skip := v_rejected_skip + 1;
                continue;
              end if;

              if v_hold_found
                 and v_hold.status = 'approved'
                 and v_delta.desired_qty <= v_hold.approved_desired_qty * 1.10 then
                -- Approved and still within the owner's 1.10 allowance.
                null;
              else
                select r.reference_qty, r.reference_days
                  into v_reference_qty, v_reference_days
                from public.cogs_backflush_usage_reference(
                  v_setting.location, v_delta.item_id, v_delta.movement_date
                ) r;

                if v_hold_found and v_hold.status = 'approved' then
                  -- An approval is stale once the 1.10 allowance is exceeded.
                  v_hold_reason := case
                    when v_reference_days < 5 then 'no_reference'
                    else 'outlier'
                  end;
                elsif v_reference_days < 5 then
                  v_hold_reason := 'no_reference';
                elsif v_delta.desired_qty > 5 * v_reference_qty then
                  v_hold_reason := 'outlier';
                end if;

                if v_hold_reason is not null then
                  insert into public.cogs_backflush_holds(
                    location, kitchen_inventory_item_id, movement_date,
                    desired_qty, delta_qty, reference_qty, reference_days,
                    reason, status, run_id
                  ) values (
                    v_setting.location, v_delta.item_id, v_delta.movement_date,
                    v_delta.desired_qty, v_delta_qty,
                    case when v_hold_reason = 'no_reference' then null
                         else v_reference_qty end,
                    v_reference_days,
                    v_hold_reason, 'held', v_run_id
                  )
                  on conflict (location, kitchen_inventory_item_id, movement_date)
                  do update set
                    desired_qty = excluded.desired_qty,
                    delta_qty = excluded.delta_qty,
                    reference_qty = excluded.reference_qty,
                    reference_days = excluded.reference_days,
                    reason = excluded.reason,
                    status = 'held',
                    run_id = excluded.run_id,
                    updated_at = now();
                  v_held := v_held + 1;
                  continue;
                end if;
              end if;
            end if;
"""


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"--[^\n]*", "", text)


def normalize_sql(text: str) -> str:
    text = strip_comments(text)
    return re.sub(r"\s+", " ", text).strip().lower()


def extract_function(text: str, marker: str) -> str:
    lower = text.lower()
    start = lower.index(marker.lower())
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert match is not None, f"no AS dollar-quote after {marker}"
    tag = match.group(1)
    end = text.index(tag + ";", start + match.end())
    return text[start : end + len(tag) + 1]


def function_name(body: str) -> str:
    match = re.search(r"function\s+public\.([a-z0-9_]+)\s*\(", body, re.IGNORECASE)
    assert match is not None
    return match.group(1)


def remove_once(text: str, snippet: str, expected: int = 1) -> str:
    assert text.count(snippet) == expected, f"expected {expected} of {snippet[:80]!r}"
    return text.replace(snippet, "", expected)


def main() -> None:
    assert MIGRATION.exists(), f"missing migration {MIGRATION.name}"
    assert BASELINE.exists(), f"missing baseline {BASELINE.name}"
    migration = read(MIGRATION)
    baseline = read(BASELINE)
    sql = strip_comments(migration)
    norm = normalize_sql(migration)

    # --- 1. Only the expected functions and the holds table --------------
    created = re.findall(
        r"create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)\s*\(",
        migration,
        re.IGNORECASE,
    )
    assert created == list(FUNCTIONS), f"unexpected functions defined: {created}"
    names = {function_name(extract_function(migration, f"create or replace function public.{name}("))
             for name in FUNCTIONS}
    assert names == set(FUNCTIONS), names

    assert norm.count("create table if not exists public.cogs_backflush_holds (") == 1
    for statement in (
        "create index",
        "create trigger",
        "create policy",
        "drop function",
        "drop table",
        "alter function",
    ):
        assert statement not in norm, f"migration must not contain {statement}"
    assert norm.count("create table") == 1, "only cogs_backflush_holds may be created"
    assert norm.count("alter table") == 1, "only the holds table RLS may be altered"
    assert "alter table public.cogs_backflush_holds enable row level security" in norm
    assert (
        "revoke all on table public.cogs_backflush_holds "
        "from public, anon, authenticated;" in norm
    )

    table_start = norm.index("create table if not exists public.cogs_backflush_holds (")
    table_end = norm.index(");", table_start) + 2
    holds_table = norm[table_start:table_end]
    for column in (
        "id uuid primary key default gen_random_uuid()",
        "location text not null check (location in ('q7', 'tan_tao'))",
        "kitchen_inventory_item_id uuid not null references "
        "public.kitchen_inventory_items(id)",
        "movement_date date not null",
        "desired_qty numeric(15, 3) not null",
        "delta_qty numeric(15, 3) not null",
        "reference_qty numeric(15, 3)",
        "reference_days integer not null",
        "reason text not null check (reason in ('outlier', 'no_reference'))",
        "status text not null default 'held' check "
        "(status in ('held', 'approved', 'rejected'))",
        "approved_desired_qty numeric(15, 3)",
        "run_id uuid",
        "created_at timestamptz default now()",
        "updated_at timestamptz default now()",
        "decided_by uuid references auth.users(id) on delete set null",
        "decided_at timestamptz",
        "unique (location, kitchen_inventory_item_id, movement_date)",
    ):
        assert column in holds_table, f"holds table missing {column}"
    assert "grant " not in holds_table, "holds table must not grant client access"
    assert "reference_qty numeric(15, 3) not null" not in holds_table
    assert "create policy" not in norm, "holds table must have no policies"

    # --- 2. Runner body = baseline except for the explicit allowed hunks --
    new_runner = extract_function(
        migration, "create or replace function public.run_cogs_backflush("
    )
    base_runner = extract_function(
        baseline, "create or replace function public.run_cogs_backflush("
    )
    new_norm = normalize_sql(new_runner)
    base_norm = normalize_sql(base_runner)
    hold_block = normalize_sql(HOLD_BLOCK)

    # The desired and posted CTEs now round at ledger precision (2 + 2).
    assert new_norm.count("round(sum(t.stock_qty), 3) as desired_qty") == 2
    assert new_norm.count("), 3) as posted_qty") == 2
    # The delta is converted to a ledger quantity and skipped when NULL.
    assert new_norm.count(
        "v_delta_qty := public.cogs_backflush_ledger_qty(v_delta.delta);"
    ) == 2
    assert new_norm.count("if v_delta_qty is null then continue; end if;") == 2
    # Each branch returns desired_qty and contains the hold block once.
    assert new_norm.count("coalesce(d.desired_qty, 0) as desired_qty") == 2
    assert new_norm.count(hold_block) == 2, "hold block must appear in both branches"
    assert hold_block.startswith("if v_delta_qty > 0 then")
    assert "raise" not in hold_block, "a hold must never raise"
    assert new_norm.count("'held_rows', v_held") == 2
    assert new_norm.count("'rejected_skip_rows', v_rejected_skip") == 2
    summary_start = new_norm.index("v_summary := jsonb_build_object(")
    return_start = new_norm.index("return jsonb_build_object(", summary_start)
    summary_block = new_norm[summary_start:return_start]
    return_block = new_norm[return_start:]
    for key in ("'held_rows', v_held", "'rejected_skip_rows', v_rejected_skip"):
        assert key in summary_block, f"summary missing {key}"
        assert key in return_block, f"returned JSON missing {key}"
    # Posting shape and idempotency key are untouched.
    assert new_norm.count(
        "'cogs:' || v_delta.movement_date::text || ':' || v_delta.item_id::text "
        "|| ':' || v_run_id::text"
    ) == 4
    assert new_norm.count("'revenue_cogs'") == base_norm.count("'revenue_cogs'")
    assert new_norm.count("raise exception") == base_norm.count("raise exception")

    # Thresholds are exact: 1.10 approval allowance, 5 reference days, 5x.
    assert new_norm.count("v_hold.approved_desired_qty * 1.10") == 2
    assert new_norm.count("v_reference_days < 5") == 4
    assert new_norm.count("v_delta.desired_qty > 5 * v_reference_qty") == 2
    assert "v_delta.desired_qty > 5 * v_reference_qty" in hold_block
    assert "'no_reference'" in hold_block and "'outlier'" in hold_block
    assert "case when v_hold_reason = 'no_reference' then null" in hold_block

    # Undo only the allowed hunks, then the bodies must match exactly.
    reverted = new_norm
    reverted = remove_once(reverted, " " + hold_block, 2)
    reverted = remove_once(reverted, ", coalesce(d.desired_qty, 0) as desired_qty", 2)
    reverted = remove_once(reverted, " v_held integer := 0;")
    reverted = remove_once(reverted, " v_rejected_skip integer := 0;")
    reverted = remove_once(
        reverted,
        " v_hold public.cogs_backflush_holds%rowtype; v_hold_found boolean; "
        "v_reference_qty numeric; v_reference_days integer; v_hold_reason text;",
    )
    reverted = remove_once(reverted, "'held_rows', v_held, ", 2)
    reverted = remove_once(reverted, "'rejected_skip_rows', v_rejected_skip, ", 2)

    for location, item_col, date_col in (
        ("q7", "t.kitchen_inventory_item_id", "t.revenue_date"),
        ("q7", "m.kitchen_inventory_item_id", "m.movement_date"),
        ("tan_tao", "t.kitchen_inventory_item_id", "t.revenue_date"),
        ("tan_tao", "m.kitchen_inventory_item_id", "m.movement_date"),
    ):
        snippet = (
            f" and ( public.cogs_backflush_item_frozen_through('{location}', "
            f"{item_col}) is null or {date_col} > "
            f"public.cogs_backflush_item_frozen_through('{location}', {item_col}) )"
        )
        reverted = remove_once(reverted, snippet)

    reverted = reverted.replace(
        "round(sum(t.stock_qty), 3) as desired_qty",
        "round(sum(t.stock_qty), 6) as desired_qty",
    ).replace("), 3) as posted_qty", "), 6) as posted_qty")

    guarded = (
        "v_delta_qty := public.cogs_backflush_ledger_qty(v_delta.delta); "
        "if v_delta_qty is null then continue; end if; if v_delta_qty > 0 then"
    )
    unguarded = "v_delta_qty := v_delta.delta; if v_delta_qty > 0 then"
    assert reverted.count(guarded) == 2
    reverted = reverted.replace(guarded, unguarded)
    assert reverted == base_norm, (
        "run_cogs_backflush changed beyond the allowed rounding/freeze/guard/"
        "desired_qty/hold/summary hunks"
    )

    # --- 3. Neither ledger is updated or deleted -------------------------
    for table in LEDGERS:
        assert not re.search(
            rf"\b(?:update|delete\s+from)\s+(?:public\.)?{table}\b",
            sql,
            re.IGNORECASE,
        ), f"migration must not update or delete {table}"
        assert not re.search(
            rf"\btruncate\s+(?:table\s+)?(?:public\.)?{table}\b",
            sql,
            re.IGNORECASE,
        ), f"migration must not truncate {table}"

    # --- 4. Rounding helpers, frozen helper and usage reference -----------
    ledger_helper = normalize_sql(
        extract_function(
            migration,
            "create or replace function public.cogs_backflush_ledger_qty(",
        )
    )
    assert "returns numeric" in ledger_helper
    assert "immutable" in ledger_helper
    assert "round(p_delta, 3)" in ledger_helper
    assert "nullif(round(p_delta, 3), 0::numeric)" in ledger_helper

    frozen_helper = normalize_sql(
        extract_function(
            migration,
            "create or replace function public.cogs_backflush_item_frozen_through(",
        )
    )
    assert "returns date" in frozen_helper
    assert "stable" in frozen_helper
    assert "security definer" in frozen_helper
    assert "set search_path = public, pg_temp" in frozen_helper
    assert frozen_helper.count("m.movement_type = 'adjustment'") == 2

    reference_helper = normalize_sql(
        extract_function(
            migration,
            "create or replace function public.cogs_backflush_usage_reference(",
        )
    )
    assert "returns table(reference_qty numeric, reference_days integer)" in reference_helper
    assert "stable" in reference_helper
    assert "security definer" in reference_helper
    assert "set search_path = public, pg_temp" in reference_helper
    assert "percentile_cont(0.5) within group" in reference_helper
    assert "m.movement_date between p_date - 30 and p_date - 1" in reference_helper
    assert reference_helper.count("m.movement_type = 'production_usage'") == 2
    assert reference_helper.count("having sum(m.quantity) > 0") == 2
    assert "m.source" not in reference_helper, "reference must use any source"

    for signature in (
        "cogs_backflush_ledger_qty(numeric)",
        "cogs_backflush_item_frozen_through(text, uuid)",
        "cogs_backflush_usage_reference(text, uuid, date)",
        "run_cogs_backflush(date, date, boolean)",
    ):
        assert (
            f"revoke all on function public.{signature} "
            "from public, anon, authenticated;" in norm
        ), f"missing revoke for {signature}"
        assert (
            f"grant execute on function public.{signature} to service_role;" in norm
        ), f"missing service_role grant for {signature}"

    # --- 5. Hold check position and positive-only guard ------------------
    q7_start = new_norm.index("if v_setting.location = 'q7' then")
    tt_start = new_norm.index("elsif v_setting.location = 'tan_tao' then", q7_start)
    q7_branch = new_norm[q7_start:tt_start]
    tt_branch = new_norm[tt_start:]

    for branch, ledger, location in (
        (q7_branch, "q7_inventory_movements", "q7"),
        (tt_branch, "tan_tao_material_movements", "tan_tao"),
    ):
        call = "v_delta_qty := public.cogs_backflush_ledger_qty(v_delta.delta);"
        guard = "if v_delta_qty is null then continue; end if;"
        insert = f"insert into public.{ledger}("
        assert branch.count(hold_block) == 1, f"{location}: hold block missing"
        assert call in branch, f"{location}: missing ledger quantity call"
        assert guard in branch, f"{location}: missing NULL continue"
        assert branch.count(insert) == 2, f"{location}: expected two inserts"
        first_insert = branch.index(insert)
        last_insert = branch.rindex(insert)
        hold_index = branch.index(hold_block)
        assert branch.index(call) < branch.index(guard) < hold_index < first_insert
        assert branch.index(guard) < hold_index < last_insert
        assert f"cogs_backflush_item_frozen_through('{location}'" in branch
        for other in ("q7", "tan_tao"):
            if other != location:
                assert f"cogs_backflush_item_frozen_through('{other}'" not in branch

    assert "insert into public.q7_inventory_movements(" not in tt_branch
    assert "insert into public.tan_tao_material_movements(" not in q7_branch

    # --- 6. Each ledger uses its own stock-count ref prefix --------------
    q7_frozen = frozen_helper.index("when 'q7' then")
    tt_frozen = frozen_helper.index("when 'tan_tao' then")
    q7_arm = frozen_helper[q7_frozen:tt_frozen]
    tt_arm = frozen_helper[tt_frozen:]
    assert "q7_inventory_movements" in q7_arm
    assert "'q7-stock-count:%'" in q7_arm
    assert "tan_tao_material_movements" not in q7_arm
    assert "tan_tao_material_movements" in tt_arm
    assert "'tt-material-count:%'" in tt_arm
    assert "q7_inventory_movements" not in tt_arm
    assert "source_ref_key like 'q7-stock-count:%'" in q7_arm
    assert "source_ref_key like 'tt-material-count:%'" in tt_arm

    # --- 7. Owner-only hold RPCs -----------------------------------------
    list_holds = normalize_sql(
        extract_function(
            migration,
            "create or replace function public.cogs_backflush_list_holds(",
        )
    )
    assert "returns jsonb" in list_holds
    assert "stable" in list_holds
    assert "security definer" in list_holds
    assert "set search_path = public, pg_temp" in list_holds
    assert "auth.uid() is null or not public.has_role(auth.uid(), 'owner')" in list_holds
    assert "raise exception 'insufficient_privilege' using errcode = '42501'" in list_holds
    assert "public.cogs_backflush_holds" in list_holds
    assert "public.kitchen_inventory_items" in list_holds
    assert "'item_name', kii.name" in list_holds
    assert "'item_unit', kii.unit" in list_holds
    assert "limit 200" in list_holds
    assert "order by h.movement_date desc" in list_holds
    assert "p_status text default 'held'" in list_holds

    decide_hold = normalize_sql(
        extract_function(
            migration,
            "create or replace function public.cogs_backflush_decide_hold(",
        )
    )
    assert "returns jsonb" in decide_hold
    assert "security definer" in decide_hold
    assert "set search_path = public, pg_temp" in decide_hold
    assert "auth.uid() is null or not public.has_role(auth.uid(), 'owner')" in decide_hold
    assert "raise exception 'insufficient_privilege' using errcode = '42501'" in decide_hold
    assert "p_decision not in ('approve', 'reject')" in decide_hold
    assert "if v_hold.status = 'held' then" in decide_hold
    assert "and status = 'held'" in decide_hold
    assert "status = 'approved'" in decide_hold
    assert "approved_desired_qty = desired_qty" in decide_hold
    assert "status = 'rejected'" in decide_hold
    assert "decided_by = auth.uid()" in decide_hold
    assert "decided_at = now()" in decide_hold
    assert "'hold_already_decided'" in decide_hold
    for rpc in (list_holds, decide_hold):
        assert "insert into public.q7_inventory_movements" not in rpc
        assert "insert into public.tan_tao_material_movements" not in rpc

    for signature in (
        "cogs_backflush_list_holds(text)",
        "cogs_backflush_decide_hold(uuid, text)",
    ):
        assert (
            f"revoke all on function public.{signature} from public, anon;" in norm
        ), f"missing client revoke for {signature}"
        assert (
            f"grant execute on function public.{signature} to authenticated;" in norm
        ), f"missing authenticated grant for {signature}"
        assert (
            f"grant execute on function public.{signature} to service_role;" not in norm
        ), f"{signature} is owner-only, not service_role"

    print("PASS: cogs backflush rounding, freeze and hold contracts hold")


if __name__ == "__main__":
    main()
