#!/usr/bin/env python3
"""Static contract checks for the 2026-10-20 document-unit factors migration.

These checks never connect to a database or Supabase. They guard that the
newest migration:

  * normalizes only the known document-unit misreads, mirrored by the TS lib;
  * derives candidate factors from confirmed game labels and the existing
    standard conversion chain;
  * writes only one agreed factor, and turns disagreements into owner questions;
  * keeps every existing mission_evaluate branch, including manual_review and
    stock_count_questions_done, and adds document_unit_questions_done;
  * revokes public/anon from every new function and gates the owner RPCs;
  * never updates/deletes product_name, quantity, unit_price or line_total;
  * ships a rollback-only smoke test for the live linked database.

Everything here is a text assertion; it does not prove runtime behaviour.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
TESTS = ROOT / "supabase" / "tests"

MIGRATION = MIGRATIONS / "20261102400000_document_unit_factors.sql"
SMOKE = TESTS / "document_unit_factors_smoke.sql"

NEW_FUNCTIONS = (
    "normalize_document_unit(text)",
    "document_unit_to_material_factor(uuid, text)",
    "document_unit_factor_candidates(uuid, text, uuid, text)",
    "document_unit_mismatch_pairs_internal()",
    "document_unit_sample_lines(uuid, uuid, text, text, integer)",
    "document_unit_question_upsert(text, uuid, text, text, text, integer, jsonb, jsonb)",
    "document_unit_question_json(public.document_unit_questions)",
    "seed_document_unit_conversions(boolean)",
    "get_document_unit_questions(text)",
    "answer_document_unit_question(uuid, text, numeric, text, text)",
)

OLD_RULES = (
    "manual_review",
    "stock_alias_factor_fixed",
    "stock_duplicate_resolved",
    "stock_unknown_units_cleared",
    "material_links_done",
    "stock_count_questions_done",
    "q7_bom_mismatch_resolved",
    "tan_tao_recipe_done",
    "sku_counted",
)

LINE_TABLES = (
    "purchase_order_items",
    "payment_request_items",
    "goods_receipt_items",
    "invoice_items",
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

    # --- 1. migration number is unique ------------------------------------
    same_number = sorted(path.name for path in MIGRATIONS.glob("2026110240*.sql"))
    assert_true(same_number == [MIGRATION.name], f"migration number reused: {same_number}")

    # --- 2. every new function is revoked from public / anon --------------
    for signature in NEW_FUNCTIONS:
        marker = f"function public.{signature}"
        assert_true(marker in lower, f"missing new function {signature}")
        assert_true(
            f"revoke all on function public.{signature} from public, anon" in lower,
            f"{signature} must revoke public/anon",
        )

    # --- 3. normalization mirrors the TS table ----------------------------
    for literal in ("'ky'", "'ký'", "'kilogram'", "'b bao'", "'hop'", "'hôp'", "'hộp'"):
        assert_true(literal in lower, f"SQL normalize must contain {literal}")
    assert_true("\\s*kg\\s*" in lower, "SQL normalize must treat (kg) as kg")
    assert_true("pack" in lower, "SQL normalize must drop the (pack) suffix")

    # --- 4. candidates use game labels, then the standard chain ------------
    candidates = extract_function(
        migration,
        "create or replace function public.document_unit_factor_candidates(",
    ).lower()
    assert_true("conversion_factor" in candidates, "candidates must use the label conversion_factor")
    assert_true("pack_label" in candidates, "candidates must match pack_label")
    assert_true("normalize_document_unit" in candidates, "candidates must normalize the label unit")
    assert_true("q7_unit_factor" in candidates, "candidates must use the standard unit factor")
    assert_true(
        "document_unit_to_material_factor" in candidates,
        "candidates must multiply the stock item -> material step",
    )
    assert_true("round(" in candidates and ", 6)" in candidates, "candidates must round to 6 digits")

    # --- 5. mismatch pairs read the four document tables only -------------
    pairs = extract_function(
        migration,
        "create or replace function public.document_unit_mismatch_pairs_internal()",
    ).lower()
    for table in LINE_TABLES:
        assert_true(f"public.{table}" in pairs, f"pairs must read public.{table}")
    assert_true("canonical_material_id is null" in pairs, "pairs must only consider unlinked lines")
    assert_true("stock_alias_canonical_material" in pairs, "pairs must resolve through stock aliases")
    assert_true("default_unit" in pairs, "pairs must compare with the material default unit")

    # --- 6. seed is owner/service gated, dry-run by default, idempotent ---
    assert_true(
        "create or replace function public.seed_document_unit_conversions(\n  p_dry_run boolean default true"
        in migration,
        "seed must be dry-run by default",
    )
    seed = extract_function(
        migration,
        "create or replace function public.seed_document_unit_conversions(",
    ).lower()
    assert_true("has_role(v_actor, 'owner')" in seed, "seed must gate on owner")
    assert_true("'document_unit_auto'" in seed, "seed must write source_type document_unit_auto")
    assert_true("'game_alias_factor'" in seed, "seed must record game_alias_factor")
    assert_true("'standard_auto'" in seed, "seed must record standard_auto")
    assert_true("'misread_standard'" in seed, "seed must record misread_standard")
    assert_true("'lấy từ hệ số đã chốt trong game kho'" in seed, "seed must write the reason")
    assert_true("alias_ids" in seed, "seed metadata must carry alias_ids")
    assert_true("link_documents_from_stock_aliases" in seed, "seed must relink through the controller")
    assert_true("document_unit_question_upsert" in seed, "seed must create/reopen questions")
    assert_true("v_written_total" in seed, "seed must return written counts")
    assert_true("v_lines_linked" in seed, "seed must return linked line counts")

    # --- 7. questions table, RLS and no direct client DML ------------------
    table_def = lower[
        lower.index("create table if not exists public.document_unit_questions") :
        lower.index("alter table public.document_unit_questions enable row level security")
    ]
    for fragment in (
        "id uuid primary key default gen_random_uuid()",
        "batch text not null",
        "material_id uuid not null references public.sku_cogs_materials(id)",
        "doc_unit text not null",
        "doc_unit_normalized text not null",
        "default_unit text not null",
        "line_count integer not null",
        "candidates jsonb not null",
        "sample_lines jsonb not null",
        "status text not null default 'open' check (status in ('open', 'answered', 'skipped'))",
        "action text check (action is null or action in ('factor', 'misread', 'skip'))",
        "factor numeric check (factor is null or factor > 0)",
        "actual_unit text",
        "reason text",
        "answered_by uuid",
        "answered_at timestamptz",
        "created_at timestamptz not null default now()",
        "unique (batch, material_id, doc_unit_normalized)",
    ):
        assert_true(fragment in canon(table_def), f"missing question column/constraint: {fragment}")

    assert_true(
        "alter table public.document_unit_questions enable row level security" in lower,
        "questions must enable RLS",
    )
    assert_true(
        "revoke all on table public.document_unit_questions from public, anon, authenticated" in lower,
        "questions must revoke client DML",
    )
    assert_true(
        "grant select on table public.document_unit_questions to authenticated" in lower,
        "authenticated may only read questions",
    )
    policy_start = lower.index("create policy document_unit_questions_select")
    policy_end = lower.index(";", policy_start)
    policy = canon(lower[policy_start:policy_end])
    assert_true("for select to authenticated" in policy, "the only question policy must be SELECT")
    assert_true("'owner'" in policy, "the policy must allow the owner")
    assert_true("material_alias_can_view" in policy, "the policy must allow the warehouse game viewer")

    # --- 8. answer RPC is owner-only and retires the old pair -------------
    answer = extract_function(
        migration,
        "create or replace function public.answer_document_unit_question(",
    ).lower()
    assert_true("security definer" in answer, "answer must be SECURITY DEFINER")
    assert_true("set search_path = public, pg_temp" in answer, "answer must pin search_path")
    assert_true(
        re.search(r"has_role\s*\(\s*v_actor\s*,\s*'owner'\s*\)", answer) is not None,
        "answer must gate on has_role(..., 'owner')",
    )
    assert_true("errcode = '42501'" in answer, "answer must raise 42501 on denial")
    assert_true("for update" in answer, "answer must lock the question")
    assert_true("'factor_required'" in answer, "answer factor must require a positive value")
    assert_true("'actual_unit_required'" in answer, "misread must require the actual unit")
    assert_true("'document_unit_question'" in answer, "answer must write source_type document_unit_question")
    assert_true("'owner_factor_doc'" in answer, "answer must write factor_source owner_factor_doc")
    assert_true(
        "set active = false" in canon(answer),
        "answer must retire the old conversion of the pair",
    )
    assert_true("link_documents_from_stock_aliases" in answer, "answer must relink the lines")

    # --- 9. never write the protected document values ---------------------
    for table in LINE_TABLES:
        assert_true(
            re.search(rf"\bupdate\s+public\.{table}\b", lower) is None,
            f"migration must not update public.{table}",
        )
        assert_true(
            re.search(rf"\bdelete\s+from\s+public\.{table}\b", lower) is None,
            f"migration must not delete from public.{table}",
        )
    for column in ("product_name", "quantity", "unit_price", "line_total"):
        assert_true(
            re.search(rf"\bset\s+{column}\b", lower) is None,
            f"migration must not set {column}",
        )

    # --- 10. trigger keeps the game label factor in sync -------------------
    trigger = extract_function(
        migration,
        "create or replace function public.trg_stock_material_alias_document_unit_factor()",
    ).lower()
    assert_true("conversion_factor" in trigger, "trigger must read the game conversion_factor")
    assert_true("pack_label" in trigger, "trigger must read pack_label")
    assert_true("normalize_document_unit" in trigger, "trigger must normalize the pack unit")
    assert_true("document_unit_to_material_factor" in trigger, "trigger must use the same chain")
    assert_true("'game_alias_factor'" in trigger, "trigger must write factor_source game_alias_factor")
    assert_true("document_unit_question_upsert" in trigger, "trigger must create/reopen conflicts")
    assert_true("link_documents_from_stock_aliases" in trigger, "trigger must relink")
    assert_true("raise warning" in trigger, "trigger errors must only warn")
    assert_true(
        "after insert or update of conversion_factor, pack_label, unit, kitchen_inventory_item_id"
        in canon(lower),
        "trigger must fire after insert or update of the factor columns",
    )
    assert_true(
        "drop trigger if exists trg_stock_material_aliases_link_documents" not in lower,
        "the old alias trigger must stay untouched",
    )

    # --- 11. mission_evaluate keeps every branch and adds the new one ------
    evaluate_files = [
        path
        for path in MIGRATIONS.glob("*.sql")
        if "create or replace function public.mission_evaluate(" in read(path).lower()
    ]
    assert_true(bool(evaluate_files), "no migration defines public.mission_evaluate")
    newest = max(evaluate_files, key=lambda path: path.name)
    assert_true(
        newest.name == MIGRATION.name,
        f"the newest mission_evaluate migration must be {MIGRATION.name}, got {newest.name}",
    )
    mission = read(newest).lower()
    for rule in OLD_RULES:
        assert_true(f"'{rule}'" in mission, f"mission_evaluate must keep {rule}")
    assert_true(
        "'document_unit_questions_done'" in mission,
        "mission_evaluate must add document_unit_questions_done",
    )
    assert_true("document_unit_questions" in mission, "the new rule must read the questions table")
    assert_true("'document_unit_questions'" in mission, "the detail must carry its kind marker")
    assert_true("v_total > 0 and v_left = 0" in canon(mission), "the rule must require zero open")
    assert_true(
        "create or replace function public.mission_evaluate(p_mission_id uuid)\nreturns jsonb" in lower,
        "mission_evaluate must keep its signature",
    )
    try:
        block = lower[
            lower.index("do $mission_check_rule$") : lower.index("$mission_check_rule$;")
        ]
    except ValueError as error:  # pragma: no cover - defensive
        raise AssertionError("migration must wrap the check_rule change in a DO block") from error
    assert_true("'manual_review'" in block, "the constraint block must preserve manual_review")
    assert_true(
        "'document_unit_questions_done'" in block,
        "the constraint block must add document_unit_questions_done",
    )
    assert_true(
        "check_rule in (" not in block,
        "the constraint block must not hard-code today's rule list",
    )

    mission_seed_start = lower.index("$seed_document_unit_mission$")
    mission_seed_end = lower.index("$seed_document_unit_mission$;", mission_seed_start)
    mission_seed = lower[mission_seed_start:mission_seed_end]
    for token in (
        "'wh-doc-units-20261020'",
        "'quy đổi đơn vị chứng từ'",
        "'document_unit_questions_done'",
        "'2026-10-20'",
        "'warehouse'",
        "on conflict (code) do nothing",
        "role::text = 'owner'",
    ):
        assert_true(token in mission_seed, f"mission seed must contain {token}")

    # --- 12. rollback-only smoke ------------------------------------------
    smoke = read(SMOKE)
    smoke_lower = smoke.lower()
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true("rollback;" in smoke_lower, "smoke must roll back")
    assert_true("commit;" not in smoke_lower, "smoke must not commit")
    for needle in (
        "27dbc34e-75ee-4973-8f9a-d1b125c90483",
        "seed_document_unit_conversions",
        "Găng tay",
        "Bột mì 888",
        "Hành lá",
        "Băng keo lớn",
        "Cholimex",
        "808361da-6b7e-4bae-a803-329b789aac5d",
        "answer_document_unit_question",
        "game_alias_factor",
        "SMOKE_RESULT PASS",
        "SMOKE_RESULT FAIL",
    ):
        assert_true(needle in smoke, f"smoke must cover {needle!r}")
    assert_true(
        "md5(" in smoke_lower and "line_total" in smoke_lower,
        "smoke must fingerprint the protected document values",
    )

    print("PASS: document unit question contracts hold")


if __name__ == "__main__":
    main()
