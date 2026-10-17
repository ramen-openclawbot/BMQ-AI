#!/usr/bin/env python3
"""Static contract checks for the 16/10 stock-count unit questions migration.

These checks never connect to a database or Supabase. They guard that migration
20261101380000_stock_count_unit_questions.sql:

  * creates public.stock_count_unit_questions with RLS, a SELECT-only policy and
    explicit grants (authenticated may read, only service_role may write);
  * seeds exactly the 12 lines of batch '2026-10-16' with sort_order 1..12;
  * defines the answer RPC as SECURITY DEFINER with the owner/admin gate, a
    FOR UPDATE lock, a replay guard for non-open questions, and a call to the
    existing record_q7_stock_count / record_tan_tao_material_count writers with
    the 2026-10-16 date;
  * never updates / deletes the append-only stock ledger tables directly;
  * extends mission_evaluate while keeping every older rule name;
  * seeds the owner mission and keeps the rollback-only smoke test.

Everything here is a text assertion; it does not prove runtime behaviour.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261101380000_stock_count_unit_questions.sql"
SMOKE = SCRIPTS / "smoke_count_unit_questions.sql"

ANSWER_MARKER = "create or replace function public.answer_stock_count_unit_question("
GET_MARKER = "create or replace function public.get_stock_count_unit_questions("
MISSION_MARKER = "create or replace function public.mission_evaluate("

SEED_LABELS = [
    "Nước uống Bidrico",
    "Bột sữa nguyên chất",
    "Mật ong",
    "Tem pháp",
    "Tem 17k",
    "Muối",
    "Băng keo lớn",
    "Băng keo nhỏ",
    "Giấy bạc",
    "Giấy thấm dầu",
    "Nước rửa chén",
    "Bao giấy",
]

OLD_RULES = (
    "stock_alias_factor_fixed",
    "stock_duplicate_resolved",
    "stock_unknown_units_cleared",
    "material_links_done",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def canon(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def extract_function(text: str, marker: str) -> str:
    """Return the full function definition from marker to its closing dollar tag."""
    start = text.index(marker)
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert_true(match is not None, f"no AS dollar-quote after {marker}")
    tag = match.group(1)
    end = text.index(tag + ";", start + match.end())
    return text[start : end + len(tag) + 1]


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(SMOKE.exists(), f"missing smoke test {SMOKE.name}")
    migration = read(MIGRATION)
    lower = migration.lower()

    forbidden_push = "supabase" + " db push"
    assert_true(forbidden_push not in lower, "migration must not tell anyone to run db push")

    # --- 1. table + RLS select-only + grants --------------------------------
    assert_true(
        "create table if not exists public.stock_count_unit_questions" in lower,
        "migration must create public.stock_count_unit_questions",
    )
    table_def = lower[
        lower.index("create table if not exists public.stock_count_unit_questions") :
        lower.index("alter table public.stock_count_unit_questions enable row level security")
    ]
    for column_fragment in (
        "id uuid primary key default gen_random_uuid()",
        "batch text not null",
        "location text not null check (location in ('q7', 'tan_tao'))",
        "sort_order integer not null",
        "file_label text not null",
        "file_qty numeric not null check (file_qty >= 0)",
        "file_unit text not null",
        "suggested_item_id uuid references public.kitchen_inventory_items(id)",
        "suggested_factor numeric",
        "status text not null default 'open' check (status in ('open', 'answered', 'skipped'))",
        "item_id uuid references public.kitchen_inventory_items(id)",
        "factor numeric",
        "counted_qty numeric",
        "record_result jsonb",
        "note text",
        "answered_by uuid",
        "answered_at timestamptz",
        "unique (batch, location, file_label)",
    ):
        assert_true(column_fragment in canon(table_def), f"missing column/constraint: {column_fragment}")

    assert_true(
        "alter table public.stock_count_unit_questions enable row level security" in lower,
        "the questions table must enable RLS",
    )
    assert_true(
        "revoke all on table public.stock_count_unit_questions from public, anon, authenticated" in lower,
        "the questions table must revoke all default client access",
    )
    assert_true(
        "grant select on table public.stock_count_unit_questions to authenticated" in lower,
        "authenticated must only be granted SELECT",
    )
    assert_true(
        "grant all on table public.stock_count_unit_questions to service_role" in lower,
        "service_role must be granted all",
    )

    policy_start = lower.index("create policy stock_count_unit_questions_select")
    policy_end = lower.index(";", policy_start)
    policy = lower[policy_start:policy_end]
    assert_true("for select to authenticated" in canon(policy), "the only policy must be SELECT")
    assert_true("material_alias_can_admin" in policy, "the policy must allow the material admin")
    assert_true("'owner'" in policy, "the policy must allow the owner")
    for forbidden in ("for insert", "for update", "for delete"):
        assert_true(forbidden not in policy, f"the table must not grant {forbidden} to clients")

    # --- 2. seed: 12 rows of batch '2026-10-16' -----------------------------
    seed_start = lower.index("insert into public.stock_count_unit_questions (")
    seed_end = lower.index("on conflict (batch, location, file_label) do nothing;", seed_start)
    seed = lower[seed_start:seed_end]
    assert_true("'2026-10-16'" in seed, "the seed must use batch '2026-10-16'")
    tuples = re.findall(r"\(\s*'(q7|tan_tao)'\s*,\s*(\d+)\s*,", seed)
    assert_true(len(tuples) == 12, f"the seed must insert 12 rows, found {len(tuples)}")
    assert_true(
        [int(order) for _, order in tuples] == list(range(1, 13)),
        "the seed sort_order must be 1..12 in file order",
    )
    for label in SEED_LABELS:
        assert_true(f"'{label.lower()}'" in seed, f"the seed must contain {label!r}")
    for item_code in (
        "Q7-EE8D4E85B686C8A318AA",
        "NVL-014",
        "NVL-030",
        "CCDC-038",
        "NVL-082",
        "NVL-083",
        "CCDC-008",
        "NVL-091",
        "CCDC-017",
        "Q7-99937EABA6F1CCAFE425",
        "NVL-104",
    ):
        assert_true(item_code.lower() in seed, f"the seed must suggest item_code {item_code}")
    assert_true(
        "suggested_item_id" in seed and "item_code = seed.item_code" in seed,
        "the seed must resolve suggested_item_id by item_code",
    )

    # --- 3. answer RPC ------------------------------------------------------
    assert_true(ANSWER_MARKER in migration, "migration must define answer_stock_count_unit_question")
    answer = extract_function(migration, ANSWER_MARKER)
    answer_lower = answer.lower()
    assert_true("language plpgsql" in answer_lower, "answer RPC must be plpgsql")
    assert_true("security definer" in answer_lower, "answer RPC must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in answer_lower,
        "answer RPC must pin search_path = public, pg_temp",
    )
    assert_true(
        re.search(r"has_role\s*\(\s*v_actor\s*,\s*'owner'\s*\)", answer_lower) is not None,
        "answer RPC must gate on has_role(..., 'owner')",
    )
    assert_true("material_alias_can_admin" in answer_lower, "answer RPC must allow material admin")
    assert_true("errcode = '42501'" in answer_lower, "answer RPC must raise 42501 on denial")
    assert_true("for update" in answer_lower, "answer RPC must lock the question FOR UPDATE")
    assert_true(
        re.search(r"if\s+v_question\.status\s*<>\s*'open'\s+then", answer_lower) is not None,
        "answer RPC must detect a non-open question",
    )
    assert_true(
        re.search(r"'replay'\s*,\s*true", answer_lower) is not None,
        "answer RPC must return replay=true for a non-open question",
    )
    assert_true("record_q7_stock_count(" in answer_lower, "answer RPC must call record_q7_stock_count")
    assert_true(
        "record_tan_tao_material_count(" in answer_lower,
        "answer RPC must call record_tan_tao_material_count",
    )
    assert_true(answer.count("date '2026-10-16'") >= 2, "both writers must use date '2026-10-16'")
    assert_true(
        "round(v_question.file_qty * p_factor, 3)" in canon(answer_lower),
        "answer RPC must compute round(file_qty * factor, 3)",
    )
    assert_true(
        "'unit-question:' || v_question.id" in canon(answer_lower),
        "answer RPC must pass the unit-question idempotency key",
    )
    assert_true("'factor_required'" in answer_lower, "answer RPC must require a positive factor")
    assert_true(
        "create_stock_material_item(" in answer_lower,
        "answer RPC must create a new item through create_stock_material_item",
    )
    assert_true("link_q7_item_material(" in answer_lower, "answer RPC must link Q7 items")
    assert_true(
        "q7_material_issue_material_mappings" in answer_lower,
        "answer RPC must ensure the approved Q7 mapping",
    )
    assert_true(
        "nhiệm vụ quy đổi tồn 16/10" in answer_lower,
        "answer RPC must write the mapping note",
    )
    assert_true(
        "status = 'answered'" in canon(answer_lower),
        "answer RPC must store status 'answered'",
    )
    assert_true("v_question.status = 'open'" in canon(answer_lower) or
                re.search(r"if\s+v_question\.status\s*<>\s*'open'", answer_lower) is not None,
                "answer RPC must start from an open question")

    # write grants for the public RPC
    assert_true(
        "revoke all on function public.answer_stock_count_unit_question(" in lower,
        "answer RPC must be revoked from public/anon",
    )
    assert_true(
        "grant execute on function public.answer_stock_count_unit_question(" in lower,
        "answer RPC must be granted to authenticated/service_role",
    )

    # --- 4. read RPC --------------------------------------------------------
    assert_true(GET_MARKER in migration, "migration must define get_stock_count_unit_questions")
    getter = extract_function(migration, GET_MARKER)
    getter_lower = getter.lower()
    assert_true("language plpgsql" in getter_lower, "read RPC must be plpgsql")
    assert_true("security definer" in getter_lower, "read RPC must be SECURITY DEFINER")
    assert_true("set search_path = public, pg_temp" in getter_lower,
                "read RPC must pin search_path")
    assert_true("has_role(v_actor, 'owner')" in getter_lower, "read RPC must allow the owner")
    assert_true("material_alias_can_admin" in getter_lower, "read RPC must allow the material admin")
    assert_true("order by q.location desc, q.sort_order" in canon(getter_lower),
                "read RPC must order by location desc, sort_order")
    assert_true("stock_count_unit_question_json" in getter_lower,
                "read RPC must serialize each row through the shared helper")
    helper_marker = "create or replace function public.stock_count_unit_question_json("
    assert_true(helper_marker in migration, "migration must define the question JSON helper")
    helper = extract_function(migration, helper_marker).lower()
    assert_true("'suggested_item'" in helper, "the question JSON must return the suggested item")
    assert_true("'chosen_item'" in helper, "the question JSON must return the chosen item")
    assert_true("'item_units'" in helper, "the question JSON must return the display units")
    assert_true("jsonb_agg(" in helper, "the question JSON must return the display units array")

    # --- 5. never write the append-only ledgers directly ---------------------
    for ledger in (
        "q7_inventory_movements",
        "q7_inventory_openings",
        "tan_tao_material_movements",
        "tan_tao_warehouse_movements",
        "tan_tao_warehouse_documents",
        "stock_ledger_settings",
    ):
        assert_true(
            re.search(rf"\b(update|delete\s+from)\s+public\.{ledger}\b", lower) is None,
            f"migration must never update/delete public.{ledger}",
        )

    # --- 6. mission_evaluate keeps every older rule + adds the new branch ----
    assert_true(MISSION_MARKER in migration, "migration must keep public.mission_evaluate")
    mission = extract_function(migration, MISSION_MARKER)
    mission_lower = mission.lower()
    for rule in OLD_RULES:
        assert_true(f"'{rule}'" in mission_lower, f"mission_evaluate must keep the {rule} rule")
    assert_true("'stock_count_questions_done'" in mission_lower,
                "mission_evaluate must add the stock_count_questions_done rule")
    assert_true("stock_count_unit_questions" in mission_lower,
                "the new rule must read stock_count_unit_questions")
    assert_true("'count_questions'" in mission_lower, "the detail must carry the count_questions marker")
    assert_true("'batch'" in mission_lower, "the detail must carry the batch")
    for key in ("'total'", "'open'", "'answered'", "'skipped'"):
        assert_true(key in mission_lower, f"the detail must carry {key}")
    assert_true("v_total > 0 and v_left = 0" in canon(mission_lower),
                "the rule must require at least one question and none open")

    # --- 7. mission seed ----------------------------------------------------
    seed_start = lower.index("$seed_count_unit_mission$")
    seed_end = lower.index("$seed_count_unit_mission$;", seed_start)
    mission_seed = lower[seed_start:seed_end]
    assert_true("from public.user_roles" in mission_seed, "mission seed must read user_roles")
    assert_true("role::text = 'owner'" in mission_seed, "mission seed must pick the owner")
    assert_true("'wh-count-units-20261016'" in mission_seed, "mission seed must use its code")
    assert_true("'quy đổi tồn 16/10'" in mission_seed, "mission seed must use its title")
    assert_true("'warehouse'" in mission_seed, "mission seed area must match the warehouse missions")
    assert_true("'cham_chi'" in mission_seed, "mission seed badge must match the warehouse missions")
    assert_true("jsonb_build_object('batch', '2026-10-16')" in canon(mission_seed),
                "mission seed must pass the batch")
    assert_true("on conflict (code) do nothing" in mission_seed,
                "mission seed must be idempotent")
    assert_true("'open'" in mission_seed, "mission seed must be open")
    assert_true(re.search(r"\b6\b", mission_seed) is not None,
                "mission sort_order must come after the existing warehouse missions")

    # --- 8. rollback-only smoke --------------------------------------------
    smoke = read(SMOKE)
    smoke_lower = smoke.lower()
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true("rollback;" in smoke_lower, "smoke must roll back")
    assert_true("commit;" not in smoke_lower, "smoke must not commit")
    assert_true(forbidden_push not in smoke_lower, "smoke must not tell anyone to run db push")
    assert_true(
        "from public.user_roles" in smoke and "role::text = 'owner'" in smoke,
        "smoke must take the owner from public.user_roles",
    )
    assert_true(
        "request.jwt.claims" in smoke,
        "smoke must impersonate the real owner through auth claims",
    )
    for needle in (
        "Băng keo lớn",
        "NVL-083",
        "2026-10-16",
        "answer_stock_count_unit_question",
        "replay",
        "skipped",
        "mission_evaluate",
        "count_questions",
        "SMOKE_RESULT PASS",
        "SMOKE_RESULT FAIL",
    ):
        assert_true(needle in smoke, f"smoke must cover {needle!r}")
    assert_true(
        re.search(r"p_factor\s*=>|factor", smoke) is not None,
        "smoke must answer with a conversion factor",
    )

    print("PASS: stock count unit question contracts hold")


if __name__ == "__main__":
    main()
