#!/usr/bin/env python3
"""Static contract checks for the robot multi-debt learning slice.

These checks never connect to a database or Supabase. They guard migration
20261101280000_robot_multi_debt_learning.sql and the client lib/hook pair:

  * p_debt accepts the legacy single object or a JSON array (max 20) and rejects
    with debt_too_many / debt_invalid / debt_duplicate;
  * every pick is submitted through exactly ONE create_payment_submission call
    fed by the collected PR-id array;
  * the new supplier_debt_pick_history table is append-only: RLS enabled, one
    SELECT-only authenticated policy and the expected GRANTs;
  * get_supplier_debt_pick_pattern has the read gate and the authenticated /
    service_role grants;
  * the migration never updates or deletes a payment request / purchase order;
  * the TS lib exports DebtPick / toggleDebtPick / sumDebtPicks /
    SupplierDebtPickPattern and the hook sends the array + the new RPC.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261101280000_robot_multi_debt_learning.sql"
SMOKE = SCRIPTS / "smoke_robot_multi_debt.sql"
LIB = ROOT / "src" / "lib" / "robot-order.ts"
TEST = ROOT / "src" / "lib" / "robot-order.test.ts"
HOOK = ROOT / "src" / "hooks" / "useRobotOrder.ts"

HISTORY = "supplier_debt_pick_history"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261101280000_robot_multi_debt_learning.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. the learning table and its RLS / grants --------------------------
    assert_true(
        f"create table if not exists public.{HISTORY} (" in lower,
        f"migration must create public.{HISTORY}",
    )
    for column in (
        "package_id uuid not null unique references public.robot_order_packages(id)",
        "supplier_id uuid not null",
        "candidate_count int not null",
        "picked_count int not null check (picked_count >= 1)",
        "picked jsonb not null",
        "picked_total numeric not null",
        "skipped_older_count int not null",
        "created_by uuid",
    ):
        assert_true(column in lower, f"{HISTORY} must declare `{column}`")

    assert_true(
        f"alter table public.{HISTORY} enable row level security;" in lower,
        f"public.{HISTORY} must enable RLS",
    )
    assert_true(
        f"create policy {HISTORY}_select on public.{HISTORY}" in lower
        and "for select to authenticated using (true);" in lower,
        f"public.{HISTORY} must have one SELECT-only authenticated policy",
    )
    assert_true(
        f"revoke all on table public.{HISTORY} from public, anon, authenticated;" in lower,
        f"public.{HISTORY} must be revoked from public / anon / authenticated",
    )
    assert_true(
        f"grant select on table public.{HISTORY} to authenticated;" in lower,
        f"public.{HISTORY} must grant SELECT to authenticated",
    )
    assert_true(
        f"grant all on table public.{HISTORY} to service_role;" in lower,
        f"public.{HISTORY} must grant ALL to service_role",
    )
    # No write policy may exist for authenticated.
    for verb in ("insert", "update", "delete"):
        assert_true(
            f"for {verb} to authenticated" not in lower,
            f"no {verb} policy may exist for authenticated on the new table",
        )

    # --- 2. p_debt normalisation and guards ----------------------------------
    assert_true(
        "jsonb_typeof(p_debt) = 'object'" in lower
        and "p_debt := jsonb_build_array(p_debt)" in lower,
        "create_robot_order_package must wrap the legacy object as a one-element array",
    )
    assert_true(
        "v_debt_count := jsonb_array_length(p_debt)" in lower
        and "if v_debt_count > 20 then" in lower,
        "create_robot_order_package must cap the pick list at 20",
    )
    for guard in ("debt_too_many", "debt_invalid", "debt_duplicate", "debt_not_payable"):
        assert_true(
            f"raise exception '{guard}'" in lower,
            f"create_robot_order_package must raise {guard}",
        )
    assert_true(
        "having count(*) > 1" in lower,
        "create_robot_order_package must detect duplicate picked ids",
    )

    # --- 3. exactly one submission fed by the collected array ----------------
    assert_true(
        migration.count("public.create_payment_submission(") == 1,
        "create_robot_order_package must call create_payment_submission once",
    )
    assert_true(
        "public.create_payment_submission(v_pr_ids" in migration,
        "the single submission must be fed by the collected v_pr_ids array",
    )
    assert_true(
        "v_pr_ids uuid[] := '{}'::uuid[]" in migration
        and "v_pr_ids := v_pr_ids || v_pr_id" in migration,
        "picked payment request ids must be collected in pick order",
    )

    # --- 4. one learning row per package, never on the replay path -----------
    assert_true(
        f"insert into public.{HISTORY} (" in lower,
        f"create_robot_order_package must insert a {HISTORY} row",
    )
    history_index = migration.index(f"insert into public.{HISTORY} (")
    replay_index = migration.rindex("return v_existing || jsonb_build_object('idempotent', true);")
    assert_true(
        replay_index < history_index,
        "the idempotent replay path must return before writing history",
    )

    # --- 5. never mutate an existing payment request / purchase order --------
    for verb, table in (
        ("update", "payment_requests"),
        ("delete", "payment_requests"),
        ("update", "purchase_orders"),
        ("delete", "purchase_orders"),
    ):
        pattern = rf"\b{verb}\s+(from\s+)?public\.{table}\b"
        assert_true(
            re.search(pattern, lower) is None,
            f"the migration must never {verb} public.{table}",
        )

    # --- 6. the read RPC and its grants --------------------------------------
    assert_true(
        "create or replace function public.get_supplier_debt_pick_pattern(p_supplier_id uuid)"
        in migration,
        "migration must define get_supplier_debt_pick_pattern(uuid)",
    )
    assert_true(
        "if v_actor is null then" in lower and "not_authenticated" in lower,
        "get_supplier_debt_pick_pattern must keep the read gate",
    )
    for field in (
        "'supplier_id'",
        "'packages'",
        "'last_picked_count'",
        "'median_picked_count'",
        "'avg_picked_total'",
        "'oldest_first_share'",
        "'last_picked_at'",
    ):
        assert_true(field in lower, f"get_supplier_debt_pick_pattern must return {field}")
    assert_true(
        "revoke all on function public.get_supplier_debt_pick_pattern(uuid) from public, anon;"
        in lower,
        "get_supplier_debt_pick_pattern must be revoked from public / anon",
    )
    assert_true(
        "grant execute on function public.get_supplier_debt_pick_pattern(uuid) "
        "to authenticated, service_role;" in lower,
        "get_supplier_debt_pick_pattern must grant execute to authenticated / service_role",
    )

    # --- 7. the TS lib surface -----------------------------------------------
    assert_true(LIB.exists(), "missing src/lib/robot-order.ts")
    lib = read(LIB)
    for token in (
        "export type DebtPick",
        "export function toggleDebtPick",
        "export function sumDebtPicks",
        "export interface SupplierDebtPickPattern",
        "debt: DebtPick[] | null;",
    ):
        assert_true(token in lib, f"robot-order.ts must contain `{token}`")

    assert_true(TEST.exists(), "missing src/lib/robot-order.test.ts")
    test = read(TEST)
    assert_true(
        "toggleDebtPick" in test and "sumDebtPicks" in test,
        "robot-order.test.ts must cover toggleDebtPick and sumDebtPicks",
    )

    # --- 8. the hook sends the array and adds the pattern query --------------
    assert_true(HOOK.exists(), "missing src/hooks/useRobotOrder.ts")
    hook = read(HOOK)
    assert_true(
        "input.debt && input.debt.length > 0 ? input.debt : null" in hook,
        "useCreateRobotOrderPackage must send the pick array (empty -> null)",
    )
    assert_true(
        "get_supplier_debt_pick_pattern" in hook
        and "useSupplierDebtPickPattern" in hook
        and "SUPPLIER_DEBT_PICK_PATTERN_QUERY_KEY" in hook,
        "useRobotOrder.ts must add useSupplierDebtPickPattern with its own query key",
    )
    assert_true(
        ".tsx" not in hook,
        "useRobotOrder.ts must not import a .tsx file",
    )

    # --- 9. the rollback-only smoke exists -----------------------------------
    assert_true(SMOKE.exists(), f"missing smoke {SMOKE.name}")
    smoke = read(SMOKE)
    smoke_lower = smoke.lower()
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke_lower, "smoke must open one transaction")
    assert_true("rollback;" in smoke_lower, "smoke must roll back")
    assert_true("commit;" not in smoke_lower, "smoke must not commit")
    assert_true("SMOKE PASS" in smoke, "smoke must raise the SMOKE PASS notice")
    assert_true(
        "supplier_debt_pick_history" in smoke_lower,
        "smoke must assert the learning-history row",
    )
    assert_true(
        "picked_count" in smoke_lower and "= 2" in smoke_lower,
        "smoke must assert a picked_count of 2",
    )

    print("PASS: robot multi-debt contracts hold")


if __name__ == "__main__":
    main()
