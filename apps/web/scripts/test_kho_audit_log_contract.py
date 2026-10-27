#!/usr/bin/env python3
"""Static contract checks for the Kho audit-log migration.

No database connection.  These checks guard the data layer of the audit feed:
  * the migration timestamp is newer than every existing migration;
  * public.kho_audit_log has the agreed columns, RLS on, a read policy for
    warehouse viewers, no client write policy and no client write grant;
  * an UPDATE / DELETE trigger refuses rewrites of the log;
  * the item trigger is AFTER INSERT OR UPDATE, tracks exactly the fields that
    exist on kitchen_inventory_items, compares with IS DISTINCT FROM, skips a
    no-op UPDATE, resolves auth.uid(), writes source = 'system' without an
    actor and never raises into the original command;
  * every readable action name is produced;
  * public.kho_get_audit_log() is SECURITY DEFINER with a pinned search_path,
    uses the same viewer gate as get_stock_transfers, reads all five sources,
    dedupes the two transfer ledger rows, returns the normalised row shape and
    pages by occurred_at;
  * the migration never runs DROP TABLE and never redefines an existing RPC;
  * the rollback-only smoke and the web parser / hook files exist with the
    expected contract markers.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"
LIB = ROOT / "src" / "lib"
HOOKS = ROOT / "src" / "hooks"

MIGRATION_GLOB = "*kho_audit_log*.sql"
MIGRATION_NAME = "20261103070000_kho_audit_log.sql"
SMOKE = SCRIPTS / "smoke_kho_audit_log.sql"
LIB_FILE = LIB / "kho-audit.ts"
LIB_TEST = LIB / "kho-audit.test.ts"
HOOK_FILE = HOOKS / "useKhoAudit.ts"

TRACKED_FIELDS = (
    "name",
    "unit",
    "active",
    "item_class",
    "note",
    "in_tan_tao",
    "pastry_q7",
    "merged_into_id",
    "item_code",
)

ACTIONS = (
    "created",
    "renamed",
    "unit_changed",
    "class_changed",
    "note_changed",
    "activated",
    "deactivated",
    "places_changed",
    "merged",
    "code_changed",
    "edited",
)

SOURCES = (
    "kho_audit_log",
    "tan_tao_material_movements",
    "q7_inventory_movements",
    "stock_transfers",
    "stock_unit_events",
)

EXISTING_RPCS = (
    "get_stock_transfers",
    "get_stock_ledger_overview",
    "kho_get_items",
    "kho_save_item",
    "kho_set_item_note",
    "kho_create_item",
    "rename_stock_item",
    "change_stock_item_unit",
    "set_item_kho_locations",
    "set_stock_item_class",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def extract_function(text: str, marker: str) -> str:
    start = text.lower().index(marker.lower())
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert_true(match is not None, f"no AS dollar-quote after {marker}")
    tag = match.group(1)
    end = text.index(tag + ";", start + match.end())
    return text[start : end + len(tag) + 1]


def migration_prefix(path: Path) -> int:
    match = re.match(r"^(\d+)_", path.name)
    assert_true(match is not None, f"migration without numeric prefix: {path.name}")
    return int(match.group(1))


def latest_migration() -> Path:
    candidates = sorted(MIGRATIONS.glob(MIGRATION_GLOB))
    assert_true(len(candidates) >= 1, f"missing migration {MIGRATION_GLOB}")
    return candidates[-1]


def check_migration_shape(migration: Path, text: str) -> None:
    lower = text.lower()
    prefix = migration_prefix(migration)
    other_prefixes = [
        migration_prefix(path)
        for path in MIGRATIONS.glob("*.sql")
        if path.name != migration.name
    ]
    assert_true(
        prefix > max(other_prefixes),
        f"{migration.name} must be newer than every existing migration",
    )
    assert_true(
        "create table if not exists public.kho_audit_log" in lower,
        "missing public.kho_audit_log",
    )
    for column in (
        "id uuid primary key",
        "occurred_at timestamptz",
        "actor_id uuid",
        "action text not null",
        "item_id uuid",
        "item_name text not null",
        "changes jsonb not null",
        "source text not null",
    ):
        assert_true(column in lower, f"kho_audit_log missing column shape: {column}")
    assert_true(
        "jsonb_typeof(changes) = 'object'" in lower,
        "changes must be constrained to a jsonb object",
    )
    assert_true(
        "alter table public.kho_audit_log enable row level security" in lower,
        "kho_audit_log must enable RLS",
    )
    assert_true(
        "create policy kho_audit_log_select on public.kho_audit_log" in lower,
        "missing select policy on kho_audit_log",
    )
    assert_true(
        "for select to authenticated" in lower,
        "kho_audit_log policy must be SELECT for authenticated",
    )
    # No write policy at all.
    assert_true(
        re.search(
            r"create\s+policy[^;]*on\s+public\.kho_audit_log[^;]*for\s+(insert|update|delete)",
            lower,
        )
        is None,
        "kho_audit_log must not have a client write policy",
    )
    assert_true(
        "public.q7_material_inventory_can_view" in lower
        and "public.can_view_tan_tao_warehouse()" in lower,
        "kho_audit_log select policy must use the two warehouse viewers",
    )
    assert_true(
        "revoke all on table public.kho_audit_log from public, anon, authenticated" in lower,
        "kho_audit_log must revoke client write/read defaults",
    )
    assert_true(
        "grant select on table public.kho_audit_log to authenticated, service_role" in lower,
        "kho_audit_log must grant SELECT to authenticated/service_role",
    )
    assert_true(
        re.search(
            r"grant\s+(?:insert|update|delete|all)[^;]*on\s+table\s+public\.kho_audit_log[^;]*to[^;]*authenticated",
            lower,
        )
        is None,
        "kho_audit_log must not grant writes to authenticated",
    )

    # Append-only trigger.
    append = extract_function(
        text, "create or replace function public.kho_audit_log_append_only()"
    ).lower()
    assert_true("raise exception" in append, "append-only trigger must raise")
    assert_true("errcode = '42501'" in append, "append-only trigger must use 42501")
    assert_true(
        "before update or delete on public.kho_audit_log" in lower,
        "missing BEFORE UPDATE OR DELETE trigger on kho_audit_log",
    )
    assert_true(
        "execute function public.kho_audit_log_append_only()" in lower,
        "append-only trigger must call its function",
    )


def check_item_trigger(text: str) -> None:
    lower = text.lower()
    assert_true(
        "after insert or update on public.kitchen_inventory_items" in lower,
        "item audit trigger must be AFTER INSERT OR UPDATE",
    )
    assert_true(
        "execute function public.kho_audit_log_item_changes()" in lower,
        "item audit trigger must call kho_audit_log_item_changes",
    )
    body = extract_function(
        text, "create or replace function public.kho_audit_log_item_changes()"
    )
    body_lower = body.lower()
    assert_true("security definer" in body_lower, "item trigger must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in body_lower,
        "item trigger must pin search_path = public, pg_temp",
    )
    assert_true("auth.uid()" in body_lower, "item trigger must use auth.uid()")
    assert_true(
        "when v_actor is null then 'system'" in body_lower,
        "item trigger must store source = system without an actor",
    )
    assert_true(
        "exception when others then" in body_lower,
        "item trigger must swallow its own log failure",
    )
    assert_true(
        body_lower.count("is distinct from") >= len(TRACKED_FIELDS),
        "item trigger must compare every tracked field with IS DISTINCT FROM",
    )
    for field in TRACKED_FIELDS:
        # Both the no-op guard and the change builder mention the field.
        assert_true(
            body_lower.count(f"old.{field}") >= 2 and body_lower.count(f"new.{field}") >= 2,
            f"item trigger does not track {field}",
        )
    for action in ACTIONS:
        assert_true(f"'{action}'" in body_lower, f"item trigger never emits action {action}")
    # The target's in_q7 is not a column in the real table; pastry_q7 is.
    assert_true(
        "old.in_q7" not in body_lower and "new.in_q7" not in body_lower,
        "in_q7 is not a column on kitchen_inventory_items",
    )


def check_reader(text: str) -> None:
    lower = text.lower()
    marker = "create or replace function public.kho_get_audit_log("
    assert_true(marker in lower, "missing public.kho_get_audit_log")
    body = extract_function(text, marker)
    body_lower = body.lower()
    assert_true("security definer" in body_lower, "reader must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in body_lower,
        "reader must pin search_path = public, pg_temp",
    )
    assert_true("returns jsonb" in body_lower, "reader must return jsonb")
    for parameter in (
        "p_from date default null",
        "p_to date default null",
        "p_actor uuid default null",
        "p_item_id uuid default null",
        "p_kinds text[] default null",
        "p_limit integer default 50",
        "p_before timestamptz default null",
        "p_before_key text default null",
    ):
        assert_true(parameter in body_lower, f"reader missing parameter {parameter}")

    for gate in (
        "coalesce(auth.role(), '') <> 'service_role'",
        "actor_required",
        "public.q7_material_inventory_can_view(v_actor)",
        "public.can_view_tan_tao_warehouse()",
        "insufficient_privilege",
    ):
        assert_true(gate in body_lower, f"reader gate missing {gate}")

    for source in SOURCES:
        assert_true(f"public.{source}" in body_lower, f"reader does not read {source}")
    assert_true(body_lower.count("union all") >= 4, "reader must union all five sources")
    assert_true(
        "m.movement_type = 'transfer_out'" in body_lower
        and "m.movement_type = 'transfer_in'" in body_lower,
        "reader must skip the two ledger rows of a transfer",
    )
    assert_true(
        body_lower.count("m.source = 'stock_transfer'") >= 2,
        "reader must skip the ledger rows written by a stock transfer",
    )
    assert_true(
        "stock_count" in body_lower and "production_use" in body_lower,
        "reader must normalise stock-count and production-use kinds",
    )

    for key in (
        "'key'",
        "'occurred_at'",
        "'actor_id'",
        "'actor_name'",
        "'kind'",
        "'location'",
        "'item_id'",
        "'item_name'",
        "'summary'",
        "'details'",
        "'items'",
        "'has_more'",
    ):
        assert_true(key in body_lower, f"reader payload missing {key}")

    assert_true("u.occurred_at < p_before" in body_lower
                and "u.occurred_at = p_before and p_before_key is not null and u.row_key < p_before_key" in body_lower,
                "reader must page with an (occurred_at, key) cursor so equal timestamps are not skipped")
    assert_true("limit v_limit + 1" in body_lower, "reader must fetch limit + 1")
    assert_true(
        "(select count(*) from filtered) > v_limit" in body_lower,
        "reader must derive has_more from the extra row",
    )
    assert_true(
        "at time zone 'asia/ho_chi_minh'" in body_lower,
        "reader date filter must use the Vietnam day boundary",
    )

    assert_true(
        "revoke all on function public.kho_get_audit_log(date, date, uuid, uuid, text[], integer, timestamptz, text)"
        in lower,
        "reader must revoke public/anon",
    )
    assert_true(
        "grant execute on function public.kho_get_audit_log(date, date, uuid, uuid, text[], integer, timestamptz, text)"
        in lower,
        "reader must grant authenticated/service_role",
    )


def check_preserved(text: str) -> None:
    lower = text.lower()
    assert_true(
        re.search(r"\bdrop\s+table\b", lower) is None,
        "migration must not DROP TABLE",
    )
    for rpc in EXISTING_RPCS:
        assert_true(
            f"create or replace function public.{rpc}" not in lower,
            f"migration must not redefine public.{rpc}",
        )


def check_smoke() -> None:
    assert_true(SMOKE.exists(), f"missing {SMOKE.name}")
    lower = read(SMOKE).lower()
    assert_true("begin;" in lower, "smoke must open a transaction")
    assert_true("rollback;" in lower, "smoke must roll back")
    for marker in (
        "kho_audit_log",
        "kho_get_audit_log",
        "renamed",
        "unit_changed",
        "class_changed",
        "deactivated",
        "activated",
        "no-op",
        "p_before",
        "has_more",
        "42501",
    ):
        assert_true(marker in lower, f"smoke missing {marker}")


def check_web() -> None:
    assert_true(LIB_FILE.exists(), f"missing {LIB_FILE.name}")
    assert_true(LIB_TEST.exists(), f"missing {LIB_TEST.name}")
    assert_true(HOOK_FILE.exists(), f"missing {HOOK_FILE.name}")
    lib = read(LIB_FILE)
    assert_true("KhoAuditRow" in lib and "KhoAuditPage" in lib, "missing audit types")
    assert_true("parseKhoAuditPage" in lib, "missing parseKhoAuditPage")
    assert_true("KHO_AUDIT_KIND_LABELS" in lib, "missing Vietnamese kind labels")
    hook = read(HOOK_FILE)
    assert_true("useInfiniteQuery" in hook, "hook must use useInfiniteQuery")
    assert_true("kho_get_audit_log" in hook, "hook must call kho_get_audit_log")
    assert_true("p_before" in hook and "p_before_key" in hook, "hook must send the (p_before, p_before_key) cursor")
    assert_true("parseKhoAuditPage" in hook, "hook must use the strict parser")


def main() -> None:
    migration = latest_migration()
    assert_true(
        migration.name == MIGRATION_NAME,
        f"expected {MIGRATION_NAME}, found {migration.name}",
    )
    text = read(migration)
    check_migration_shape(migration, text)
    check_item_trigger(text)
    check_reader(text)
    check_preserved(text)
    check_smoke()
    check_web()
    print(f"PASS {migration.name}")


if __name__ == "__main__":
    main()
