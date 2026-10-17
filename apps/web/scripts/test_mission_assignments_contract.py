#!/usr/bin/env python3
"""Static contract checks for the mission assignment migration.

These checks never connect to a database or Supabase. They guard that migration
20261101400000_mission_assignments.sql:
  * adds the self-referencing parent_mission_id column, its index and the unique
    partial index on (parent_mission_id, assignee_user_id);
  * defines get_mission_staff, assign_mission, unassign_mission and
    get_mission_assignments as SECURITY DEFINER with a pinned search_path;
  * gates every new RPC on the owner role (or service_role) and gives clients
    only the required execute grants;
  * keeps mission_evaluate, get_my_missions and complete_mission untouched;
  * has no hard-coded UUID or company email;
  * ships a rollback-only smoke test that inlines the migration.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261101400000_mission_assignments.sql"
SMOKE = SCRIPTS / "smoke_mission_assignments.sql"

FUNCTIONS = (
    "get_mission_staff()",
    "assign_mission(uuid, uuid)",
    "unassign_mission(uuid)",
    "get_mission_assignments()",
)

UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def body_after(text: str, marker: str) -> str:
    """Return the SQL from marker to the end of that function ($;$)."""
    start = text.index(marker)
    end = text.index("$$;", start)
    return text[start:end]


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261101400000_mission_assignments.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. parent_mission_id column and indexes ---------------------------
    assert_true(
        "alter table public.missions" in lower
        and "add column if not exists parent_mission_id uuid" in lower,
        "migration must add public.missions.parent_mission_id",
    )
    assert_true(
        "references public.missions(id) on delete cascade" in lower,
        "parent_mission_id must be a self-referencing cascade FK",
    )
    assert_true(
        re.search(
            r"create index if not exists \w+\s+on public\.missions\(parent_mission_id\)",
            lower,
        )
        is not None,
        "migration must index parent_mission_id",
    )
    assert_true(
        re.search(
            r"create unique index if not exists \w+\s+on public\.missions\(parent_mission_id, assignee_user_id\)\s+where parent_mission_id is not null",
            lower,
        )
        is not None,
        "migration must add the unique partial index on (parent_mission_id, assignee_user_id)",
    )

    # --- 2. functions: security definer + pinned search_path + owner gate ---
    for signature in FUNCTIONS:
        marker = f"function public.{signature.split('(')[0]}("
        assert_true(marker in lower, f"migration must define {signature}")
        body = body_after(lower, marker)
        assert_true("returns jsonb" in body, f"{signature} must return jsonb")
        assert_true("security definer" in body, f"{signature} must be SECURITY DEFINER")
        assert_true(
            "set search_path = public, pg_temp" in body,
            f"{signature} must pin search_path = public, pg_temp",
        )
        assert_true(
            "public.has_role(auth.uid(), 'owner')" in body,
            f"{signature} must gate on has_role(auth.uid(), 'owner')",
        )
        assert_true(
            "coalesce(auth.role(), '') = 'service_role'" in body,
            f"{signature} must allow service_role",
        )
        assert_true(
            "raise exception 'forbidden' using errcode = '42501'" in body,
            f"{signature} must raise forbidden with errcode 42501",
        )
        assert_true(
            f"revoke all on function public.{signature} from public, anon" in lower,
            f"{signature} must revoke execute from public / anon",
        )
        assert_true(
            f"grant execute on function public.{signature} to authenticated, service_role"
            in lower,
            f"{signature} must grant execute to authenticated / service_role",
        )

    # get_mission_staff and get_mission_assignments are read-only.
    for signature in ("get_mission_staff()", "get_mission_assignments()"):
        body = body_after(lower, f"function public.{signature.split('(')[0]}(")
        assert_true("stable" in body, f"{signature} must be stable")

    for signature in ("assign_mission(uuid, uuid)", "unassign_mission(uuid)"):
        body = body_after(lower, f"function public.{signature.split('(')[0]}(")
        assert_true("volatile" in body, f"{signature} must be volatile")

    # --- 3. assign / unassign contract tokens ------------------------------
    assign = body_after(lower, "function public.assign_mission(")
    for token in (
        "for update",
        "'mission_not_found'",
        "'mission_not_open'",
        "'assignee_not_allowed'",
        "'already_assignee'",
        "parent_mission_id",
        "public.material_alias_can_admin(p_user_id)",
        "v_root.code || '@'",
        "'created'",
        "'reopened'",
    ):
        assert_true(token in assign, f"assign_mission must use {token}")

    unassign = body_after(lower, "function public.unassign_mission(")
    for token in (
        "for update",
        "'mission_not_found'",
        "'not_an_assignment'",
        "'mission_completed'",
        "set status = 'cancelled'",
        "'status', 'cancelled'",
    ):
        assert_true(token in unassign, f"unassign_mission must use {token}")

    staff = body_after(lower, "function public.get_mission_staff(")
    for token in (
        "from public.profiles",
        "public.material_alias_can_admin(p.user_id)",
        "p.user_id <> auth.uid()",
        "public.mission_level_for",
        "mission_badge_awards",
        "open_missions",
    ):
        assert_true(token in staff, f"get_mission_staff must use {token}")

    assignments = body_after(lower, "function public.get_mission_assignments(")
    for token in (
        "m.parent_mission_id is not null",
        "m.status in ('open', 'completed')",
        "public.mission_evaluate(m.id)",
        "assignee_name",
        "completed_at",
    ):
        assert_true(token in assignments, f"get_mission_assignments must use {token}")

    # --- 4. never redefine the existing mission functions -------------------
    for name in ("mission_evaluate", "get_my_missions", "complete_mission"):
        assert_true(
            f"create or replace function public.{name}" not in lower,
            f"migration must not redefine {name}",
        )
        assert_true(
            f"drop function if exists public.{name}" not in lower,
            f"migration must not drop {name}",
        )

    # --- 5. no hard-coded UUID or company email ----------------------------
    assert_true(
        UUID_RE.search(migration) is None,
        "migration must not hard-code any UUID",
    )
    assert_true("@bmq.vn" not in lower, "migration must not hard-code an @bmq.vn email")

    # --- 6. rollback-only smoke test ---------------------------------------
    assert_true(SMOKE.exists(), f"missing smoke test {SMOKE.name}")
    smoke = read(SMOKE)
    smoke_lower = smoke.lower()
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true(
        migration.strip() in smoke,
        "smoke must inline the migration byte-for-byte (regenerate it when the migration changes)",
    )
    assert_true(
        smoke.strip().lower().endswith("rollback;"),
        "smoke must end with ROLLBACK",
    )
    assert_true("commit;" not in smoke_lower, "smoke must not commit")
    assert_true("SMOKE_RESULT PASS" in smoke, "smoke must raise SMOKE_RESULT PASS")
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL on a bad step")
    assert_true(
        "request.jwt.claims" in smoke,
        "smoke must impersonate the real owner / staff through auth claims",
    )
    assert_true(
        "set role authenticated" not in smoke_lower,
        "smoke must not switch the session role",
    )
    for step in (
        "assign_created",
        "staff_copy_progress",
        "assign_again_copy_count",
        "unassign_status",
        "unassign_still_listed",
        "assign_reopen",
        "forbidden_assign",
        "already_assignee",
        "not_an_assignment",
        "staff_list_has_owner",
        "assignments_missing_copy",
        "staff_badge",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} step")

    print("PASS: mission assignment contracts hold")


if __name__ == "__main__":
    main()
