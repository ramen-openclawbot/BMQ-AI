#!/usr/bin/env python3
"""Static contract checks for the manual mission card migration (GĐ1).

These checks never connect to a database or Supabase. They guard that migration
20261102150000_manual_missions.sql and its worker / client layer:
  * add manual_mission_batches, missions.batch_id, mission_submissions and the
    append-only mission_events trail;
  * define every client RPC as SECURITY DEFINER with a pinned search_path and
    owner gates where the caller must be the owner;
  * extend missions_check_rule_check from the live pg_constraint definition
    instead of hard-coding the current rule list;
  * keep the newest mission_evaluate definition aware of manual_review and never
    redefine get_my_missions / complete_mission / assign_mission / unassign_mission;
  * ship the warehouse Zalo outbox worker, its cron schedule and the private
    mission-evidence bucket;
  * have no hard-coded UUID / company email;
  * ship a rollback-only smoke test that inlines the migration byte-for-byte.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"
FUNCTIONS = ROOT / "supabase" / "functions"

MIGRATION = MIGRATIONS / "20261102150000_manual_missions.sql"
SMOKE = SCRIPTS / "smoke_manual_missions.sql"
EDGE = FUNCTIONS / "mission-zalo-notify" / "index.ts"
TOKEN_HELPER = FUNCTIONS / "_shared" / "zalo-oa-token.ts"
CONFIG = ROOT / "supabase" / "config.toml"

CLIENT_FUNCTIONS = (
    "get_manual_mission_staff()",
    "create_manual_mission(text, text, uuid[], timestamptz, text, text, jsonb, uuid)",
    "add_manual_mission_assignee(uuid, uuid)",
    "cancel_manual_mission(uuid)",
    "submit_manual_mission(uuid, text, numeric, text[], jsonb, uuid)",
    "review_manual_mission(uuid, boolean, smallint, text)",
    "get_my_manual_missions()",
    "get_manual_missions_overview(integer)",
    "get_mission_submissions(uuid)",
)

OWNER_GATED = (
    "get_manual_mission_staff",
    "create_manual_mission",
    "add_manual_mission_assignee",
    "cancel_manual_mission",
    "review_manual_mission",
    "get_manual_missions_overview",
)

READ_ONLY = (
    "get_manual_mission_staff",
    "get_my_manual_missions",
    "get_manual_missions_overview",
    "get_mission_submissions",
)

WRITE = (
    "create_manual_mission",
    "add_manual_mission_assignee",
    "cancel_manual_mission",
    "submit_manual_mission",
    "review_manual_mission",
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


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261102150000_manual_missions.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()
    flat = squash(lower)

    # --- 1. schema additions ------------------------------------------------
    for token in (
        "create table if not exists public.manual_mission_batches",
        "create table if not exists public.mission_submissions",
        "create table if not exists public.mission_events",
        "create table if not exists public.mission_zalo_notifications",
        "create table if not exists public.mission_zalo_notification_config",
        "add column if not exists batch_id uuid",
        "create unique index if not exists idx_missions_batch_assignee_key",
        "where batch_id is not null",
        "create unique index if not exists idx_mission_submissions_pending",
        "where review_status = 'pending'",
        "'mission-evidence'",
        "insert into storage.buckets",
        "on conflict (id) do nothing",
    ):
        assert_true(token in flat, f"migration must contain {token}")

    # --- 2. dynamic check_rule constraint ----------------------------------
    assert_true("pg_constraint" in flat, "migration must read pg_constraint")
    assert_true(
        "pg_get_constraintdef" in flat,
        "migration must read the live check_rule definition",
    )
    assert_true(
        "drop constraint missions_check_rule_check" in flat,
        "migration must drop the old check_rule constraint before re-adding it",
    )
    try:
        block = lower[
            lower.index("do $mission_check_rule$") : lower.index("$mission_check_rule$;")
        ]
    except ValueError as error:  # pragma: no cover - defensive
        raise AssertionError("migration must wrap the constraint change in a DO block") from error
    assert_true("'manual_review'" in block, "the constraint DO block must add manual_review")
    assert_true(
        "check_rule in (" not in block,
        "the constraint DO block must not hard-code the current rule list",
    )

    # --- 3. client RPC bodies ----------------------------------------------
    for signature in CLIENT_FUNCTIONS:
        name = signature.split("(")[0]
        marker = f"function public.{name}("
        assert_true(marker in lower, f"migration must define {signature}")
        body = body_after(lower, marker)
        assert_true("returns jsonb" in body, f"{signature} must return jsonb")
        assert_true("security definer" in body, f"{signature} must be SECURITY DEFINER")
        assert_true(
            "set search_path = public, pg_temp" in body,
            f"{signature} must pin search_path = public, pg_temp",
        )
        assert_true(
            f"revoke all on function public.{signature} from public, anon" in flat,
            f"{signature} must revoke execute from public / anon",
        )
        assert_true(
            f"grant execute on function public.{signature} to authenticated, service_role" in flat,
            f"{signature} must grant execute to authenticated / service_role",
        )

    for name in OWNER_GATED:
        body = body_after(lower, f"function public.{name}(")
        assert_true(
            "public.has_role(auth.uid(), 'owner')" in body,
            f"{name} must gate on has_role(auth.uid(), 'owner')",
        )
        assert_true(
            "coalesce(auth.role(), '') = 'service_role'" in body,
            f"{name} must allow service_role",
        )
        assert_true(
            "raise exception 'forbidden' using errcode = '42501'" in body,
            f"{name} must raise forbidden with errcode 42501",
        )

    for name in READ_ONLY:
        body = body_after(lower, f"function public.{name}(")
        assert_true("stable" in body, f"{name} must be stable")
    for name in WRITE:
        body = body_after(lower, f"function public.{name}(")
        assert_true("volatile" in body, f"{name} must be volatile")

    # --- 4. append-only trail ----------------------------------------------
    assert_true(
        "raise exception 'mission_events_append_only' using errcode = '42501'" in flat,
        "mission_events must raise mission_events_append_only",
    )
    assert_true(
        "create trigger mission_events_append_only" in flat
        and "before update or delete on public.mission_events" in flat,
        "mission_events must have a BEFORE UPDATE OR DELETE append-only trigger",
    )

    # --- 5. manual_review / preserve existing mission RPCs -----------------
    for name in ("get_my_missions", "complete_mission", "assign_mission", "unassign_mission"):
        assert_true(
            f"create or replace function public.{name}(" not in lower,
            f"migration must not redefine {name}",
        )
        assert_true(
            f"drop function if exists public.{name}" not in lower,
            f"migration must not drop {name}",
        )

    evaluate_files = [
        path
        for path in MIGRATIONS.glob("*.sql")
        if "create or replace function public.mission_evaluate(" in read(path).lower()
    ]
    assert_true(bool(evaluate_files), "no migration defines public.mission_evaluate")
    newest = max(evaluate_files, key=lambda path: path.name)
    assert_true(
        "manual_review" in read(newest).lower(),
        f"newest mission_evaluate migration {newest.name} must keep the manual_review branch",
    )

    # --- 6. no hard-coded UUID / company email -----------------------------
    assert_true(UUID_RE.search(migration) is None, "migration must not hard-code any UUID")
    assert_true("@bmq.vn" not in lower, "migration must not hard-code an @bmq.vn email")

    # --- 7. cron schedule + storage policies -------------------------------
    for token in (
        "'mission-reminders-hourly'",
        "'mission-zalo-notify-every-2-min'",
        "net.http_post",
        "mission_zalo_notification_config",
        "timeout_milliseconds := 10000",
        "mission_evidence_objects_insert",
        "mission_evidence_objects_select",
    ):
        assert_true(token.lower() in flat, f"migration must contain {token}")

    # --- 8. edge worker -----------------------------------------------------
    assert_true(EDGE.exists(), f"missing edge function {EDGE}")
    edge = read(EDGE)
    edge_lower = edge.lower()
    for token in (
        "zalo_gmf_warehouse_group_id",
        "claim_mission_zalo_notifications",
        "sendzalogmftext",
        "mission_zalo_notification_config",
        "x-worker-secret",
        "resolvezaloaccesstoken",
        "max_attempts",
    ):
        assert_true(token in edge_lower, f"edge worker must use {token}")
    assert_true(
        "zalo_gmf_finance_group_id" not in edge_lower,
        "mission worker must never read the finance group id",
    )
    assert_true(TOKEN_HELPER.exists(), f"missing shared token helper {TOKEN_HELPER}")

    config_lower = read(CONFIG).lower()
    section = config_lower.find("[functions.mission-zalo-notify]")
    assert_true(section >= 0, "config.toml must declare [functions.mission-zalo-notify]")
    next_section = config_lower.find("\n[functions.", section + 1)
    section_text = config_lower[section : next_section if next_section >= 0 else len(config_lower)]
    assert_true(
        "verify_jwt = false" in section_text,
        "mission-zalo-notify must set verify_jwt = false",
    )

    # --- 9. rollback-only smoke test ---------------------------------------
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
        "create_batch_missions",
        "create_batch_notice",
        "create_batch_events",
        "staff_board_progress",
        "photo_required",
        "submit_pending",
        "submit_notice",
        "second_submit",
        "return_note_required",
        "return_notice",
        "resubmit_pending",
        "approve_mission",
        "approve_badge",
        "approve_notice",
        "staff_board_done",
        "staff_review_forbidden",
        "other_submit_forbidden",
        "create_due_in_past",
        "reminder_due_soon",
        "reminder_idempotent",
        "events_append_only",
        "existing_evaluate",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} step")

    print("PASS: manual mission contracts hold")


if __name__ == "__main__":
    main()
