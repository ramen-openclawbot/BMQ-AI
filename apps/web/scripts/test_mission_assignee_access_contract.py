#!/usr/bin/env python3
"""Static contract checks for 20261101450000_mission_assignee_access.sql.

These checks never connect to a database or Supabase. They guard that the
migration:
  * adds public.mission_actor_holds with the open + assignee + rule filter;
  * lets every listed read / write RPC accept that helper while keeping its
    original owner / admin gate;
  * never redefines assign_mission or unassign_mission (they stay owner-only);
  * adds the sku_counted rule and record_mission_sku_count (open mission,
    owner or assignee, delegated to record_tan_tao_stock_count);
  * keeps every older mission_evaluate branch;
  * seeds 'wh-count-bmq001-20261017' idempotently;
  * ships a rollback-only smoke test that impersonates owner and assignee.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261101450000_mission_assignee_access.sql"
SMOKE = SCRIPTS / "smoke_mission_assignee_access.sql"

UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)

# name -> (original gate tokens, mission_actor_holds rule)
RPCS = {
    "get_q7_bom_mismatch_review": (
        ("public.has_role(v_actor, 'owner')", "public.q7_material_inventory_can_view(v_actor)"),
        "q7_bom_mismatch_resolved",
    ),
    "resolve_q7_bom_line": (
        ("public.has_role(v_actor, 'owner')",),
        "q7_bom_mismatch_resolved",
    ),
    "post_pending_q7_material_issues": (
        ("public.has_role(v_actor, 'owner')",),
        "q7_bom_mismatch_resolved",
    ),
    "get_tan_tao_recipe": (
        (
            "public.has_role(v_actor, 'owner'::public.app_role)",
            "public.can_view_tan_tao_warehouse()",
        ),
        "tan_tao_recipe_done",
    ),
    "answer_tan_tao_recipe_line": (
        ("public.has_role(v_actor, 'owner'::public.app_role)",),
        "tan_tao_recipe_done",
    ),
    "set_tan_tao_recipe_batch": (
        ("public.has_role(v_actor, 'owner'::public.app_role)",),
        "tan_tao_recipe_done",
    ),
    "get_stock_count_unit_questions": (
        ("public.has_role(v_actor, 'owner')", "public.material_alias_can_admin(v_actor)"),
        "stock_count_questions_done",
    ),
    "answer_stock_count_unit_question": (
        ("public.has_role(v_actor, 'owner')", "public.material_alias_can_admin(v_actor)"),
        "stock_count_questions_done",
    ),
}


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


def function_body(text: str, name: str) -> str:
    return body_after(text, f"function public.{name}(")


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261101450000_mission_assignee_access.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. helper ---------------------------------------------------------
    helper = function_body(lower, "mission_actor_holds")
    assert_true("returns boolean" in helper, "mission_actor_holds must return boolean")
    assert_true("stable" in helper, "mission_actor_holds must be stable")
    assert_true("security definer" in helper, "mission_actor_holds must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in helper,
        "mission_actor_holds must pin search_path",
    )
    assert_true(
        "m.assignee_user_id = p_actor" in helper,
        "mission_actor_holds must filter assignee_user_id = p_actor",
    )
    assert_true(
        "m.status = 'open'" in helper,
        "mission_actor_holds must require an open mission",
    )
    assert_true(
        "m.check_rule = p_check_rule" in helper,
        "mission_actor_holds must match the requested check_rule",
    )
    assert_true(
        "revoke all on function public.mission_actor_holds(uuid, text) from public, anon"
        in lower,
        "mission_actor_holds must revoke execute from public / anon",
    )
    assert_true(
        "grant execute on function public.mission_actor_holds(uuid, text)"
        " to authenticated, service_role" in lower,
        "mission_actor_holds must grant execute to authenticated / service_role",
    )

    # --- 2. every listed RPC keeps its old gate and adds the right rule ----
    for name, (old_tokens, rule) in RPCS.items():
        body = function_body(lower, name)
        assert_true("security definer" in body, f"{name} must stay SECURITY DEFINER")
        assert_true(
            "set search_path = public, pg_temp" in body,
            f"{name} must keep its pinned search_path",
        )
        for token in old_tokens:
            assert_true(token in body, f"{name} must keep its old gate token {token}")
        assert_true(
            f"public.mission_actor_holds(v_actor, '{rule}')" in body,
            f"{name} must accept mission_actor_holds for {rule}",
        )
        assert_true(
            "raise exception 'insufficient_privilege' using errcode = '42501'" in body,
            f"{name} must keep raising insufficient_privilege (42501)",
        )

    # --- 3. assign / unassign stay owner-only and untouched ----------------
    for name in ("assign_mission", "unassign_mission"):
        assert_true(
            f"create or replace function public.{name}" not in lower,
            f"migration must not redefine {name}",
        )
        assert_true(
            f"drop function if exists public.{name}" not in lower,
            f"migration must not drop {name}",
        )

    # --- 4. record_mission_sku_count ---------------------------------------
    record = function_body(lower, "record_mission_sku_count")
    for token in (
        "p_mission_id uuid",
        "p_counted_qty numeric",
        "p_note text",
        "p_request_id uuid",
        "returns jsonb",
        "security definer",
        "set search_path = public, pg_temp",
        "'mission_not_open'",
        "'forbidden' using errcode = '42501'",
        "v_actor = v_owner or v_actor = v_mission.assignee_user_id",
        "public.record_tan_tao_stock_count(",
        "p_counted_qty < 0",
        "p_counted_qty::text in ('nan', 'infinity', '-infinity')",
        "'mission-count:' || p_request_id::text",
        "'mission_id', v_mission.id",
        "'sku_code', v_sku_code",
        "'counted_qty', p_counted_qty",
        "'result', v_result",
    ):
        assert_true(token in record, f"record_mission_sku_count must use {token}")
    assert_true(
        "revoke all on function public.record_mission_sku_count(uuid, numeric, text, uuid)"
        in lower,
        "record_mission_sku_count must revoke execute from public / anon",
    )
    assert_true(
        re.search(
            r"grant execute on function public\.record_mission_sku_count"
            r"\(uuid, numeric, text, uuid\)\s+to authenticated, service_role",
            lower,
        )
        is not None,
        "record_mission_sku_count must grant execute to authenticated / service_role",
    )
    assert_true(
        "create or replace function public.record_tan_tao_stock_count" not in lower,
        "migration must not weaken / redefine record_tan_tao_stock_count",
    )

    # --- 5. mission_evaluate keeps every branch and adds sku_counted ------
    evaluate = function_body(lower, "mission_evaluate")
    for rule in (
        "stock_alias_factor_fixed",
        "stock_duplicate_resolved",
        "stock_unknown_units_cleared",
        "material_links_done",
        "stock_count_questions_done",
        "q7_bom_mismatch_resolved",
        "tan_tao_recipe_done",
        "sku_counted",
    ):
        assert_true(rule in evaluate, f"mission_evaluate must keep the {rule} branch")
    for token in (
        "tan_tao_warehouse_documents",
        "d.document_type = 'stock_count'",
        "d.status = 'posted'",
        "lower(btrim(d.sku_code_snapshot)) = lower(btrim(v_sku_code))",
        "(d.created_at at time zone 'asia/ho_chi_minh')::date >= v_since",
        "'kind', 'sku_count'",
        "'counted_at'",
        "'counted_qty'",
    ):
        assert_true(token in evaluate, f"mission_evaluate sku_counted must use {token}")
    assert_true(
        "revoke all on function public.mission_evaluate(uuid) from public, anon, authenticated"
        in lower,
        "mission_evaluate must stay internal (revoked from authenticated)",
    )
    assert_true(
        "grant execute on function public.mission_evaluate(uuid) to service_role" in lower,
        "mission_evaluate must stay granted to service_role",
    )

    # --- 6. seed ------------------------------------------------------------
    seed_start = lower.index("$seed_wh_count_bmq001_mission$")
    seed_end = lower.index("$seed_wh_count_bmq001_mission$;", seed_start)
    seed = lower[seed_start:seed_end]
    for token in (
        "from public.user_roles",
        "role::text = 'owner'",
        "raise notice",
        "wh-count-bmq001-20261017",
        "đếm bánh mì que tân tạo",
        "đếm số que bmq-001 đang có ở kho tân tạo và nhập vào",
        "'sku_counted'",
        "'location', 'tan_tao'",
        "'sku_code', 'bmq-001'",
        "'since', '2026-10-17'",
        "'warehouse'",
        "'cham_chi'",
        "on conflict (code) do nothing",
    ):
        assert_true(token in seed, f"seed must use {token}")
    assert_true(UUID_RE.search(seed) is None, "seed must not hard-code any UUID")

    # --- 7. rollback-only smoke --------------------------------------------
    assert_true(SMOKE.exists(), f"missing smoke test {SMOKE.name}")
    smoke = read(SMOKE)
    smoke_lower = smoke.lower()
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true(smoke.strip().lower().endswith("rollback;"), "smoke must end with ROLLBACK")
    assert_true("commit;" not in smoke_lower, "smoke must not commit")
    assert_true("SMOKE_RESULT PASS" in smoke, "smoke must raise SMOKE_RESULT PASS")
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL on a bad step")
    assert_true("SMOKE_RESULT SKIP" in smoke, "smoke must skip with a notice when no user")
    assert_true("request.jwt.claims" in smoke, "smoke must impersonate through auth claims")
    assert_true("sqlstate <> '42501'" in smoke, "smoke must assert the SQLSTATE 42501")
    for step in (
        "review_before_allowed",
        "assign_mission",
        "assign_created",
        "get_q7_bom_mismatch_review",
        "resolve_q7_bom_line",
        "resolve_as_assignee",
        "unassign_mission",
        "unassign_status",
        "review_after_unassign_allowed",
        "forbidden_assign accepted",
        "record_mission_sku_count",
        "wh-count-bmq001-20261017",
        "BMQ-001",
        "mission_evaluate",
        "sku_count_mission_not_done",
    ):
        assert_true(step in smoke, f"smoke must cover {step}")
    assert_true("set role authenticated" not in smoke_lower, "smoke must not switch the session role")
    assert_true("db push" not in smoke_lower, "smoke must not tell anyone to run db push")

    print("PASS: mission assignee access contracts hold")


if __name__ == "__main__":
    main()
