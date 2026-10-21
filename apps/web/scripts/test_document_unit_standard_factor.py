#!/usr/bin/env python3
"""Static contract checks for 20261102490000_document_unit_standard_factor.sql.

These checks never connect to a database.  They guard that the standard
weight/volume table wins over a stale game alias factor, that the repair block
only touches material_unit_conversions (deactivate + corrected insert), and that
the 2026-10-20 question block only reopens batch '2026-10-20' status 'open'.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
MIGRATION = MIGRATIONS / "20261102490000_document_unit_standard_factor.sql"

REDEFINED = (
    "document_unit_to_material_factor(uuid, text)",
    "document_unit_factor_candidates(uuid, text, uuid, text)",
    "document_unit_answer_internal(uuid, text, numeric, text, text, uuid)",
    "answer_document_unit_question(uuid, text, numeric, text, text)",
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
    start = text.index(marker)
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert_true(match is not None, f"no AS dollar-quote after {marker}")
    tag = match.group(1)
    end = text.index(tag + ";", start + match.end())
    return text[start : end + len(tag) + 1]


def extract_do_block(text: str, tag: str) -> str:
    start = text.index(f"do ${tag}$")
    end = text.index(f"${tag}$;", start) + len(f"${tag}$;")
    return text[start:end]


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. only the intended functions are redefined ---------------------
    defined = re.findall(r"create or replace function public\.([a-z0-9_]+)\(", lower)
    assert_true(
        len(defined) == len(REDEFINED),
        f"unexpected function count: {defined}",
    )
    for signature in REDEFINED:
        name = signature.split("(")[0]
        assert_true(name in defined, f"missing redefined function {signature}")
        body = extract_function(migration, f"create or replace function public.{name}(")
        body_lower = body.lower()
        assert_true("security definer" in body_lower, f"{name} must be SECURITY DEFINER")
        assert_true(
            "set search_path = public, pg_temp" in body_lower,
            f"{name} must pin search_path = public, pg_temp",
        )
        assert_true(
            f"revoke all on function public.{signature} from public, anon" in lower,
            f"{signature} must revoke public/anon",
        )
        if name == "answer_document_unit_question":
            assert_true(
                f"grant execute on function public.{signature} to authenticated, service_role"
                in lower,
                f"{signature} must keep its authenticated grant",
            )
        else:
            assert_true(
                f"grant execute on function public.{signature} to service_role" in lower,
                f"{signature} must be granted to service_role",
            )

    # The old trigger keeps its own definition.
    assert_true(
        "create or replace function public.trg_stock_material_alias_document_unit_factor"
        not in lower,
        "the alias trigger must be left unchanged",
    )
    assert_true(
        "trg_stock_material_alias_document_unit_factor" in lower
        and "cannot write or reopen an alias factor" in lower,
        "the migration must explain why the trigger is left unchanged",
    )

    # --- 2. to_material_factor checks the standard table first ------------
    to_material = extract_function(
        migration,
        "create or replace function public.document_unit_to_material_factor(",
    )
    q7_at = to_material.index("public.q7_unit_factor(p_from_unit, v_material.default_unit)")
    conversion_at = to_material.index("from public.material_unit_conversions")
    assert_true(
        q7_at < conversion_at,
        "q7_unit_factor must be checked before material_unit_conversions",
    )
    assert_true(
        "return round(v_factor, 6)" in to_material,
        "the standard factor must be rounded to 6 digits",
    )

    # --- 3. candidates take the standard path before the alias branch -----
    candidates = extract_function(
        migration,
        "create or replace function public.document_unit_factor_candidates(",
    )
    std_assign = candidates.index("v_std := public.q7_unit_factor(v_doc, r.item_unit)")
    pack_branch = candidates.index("elsif r.pack_match then")
    assert_true(std_assign < pack_branch, "v_std must be evaluated before pack_match")
    assert_true(
        "round(v_std * v_step, 6)" in candidates,
        "the standard branch must multiply and round the item -> material step",
    )
    assert_true(
        "v_std := public.q7_unit_factor(v_doc, v_material.default_unit)" in candidates,
        "the approved_conversion fallback must try the standard document -> material pair",
    )
    assert_true(
        candidates.index("v_std := public.q7_unit_factor(v_doc, v_material.default_unit)")
        < candidates.index("source', 'approved_conversion'"),
        "the standard fallback must be checked before approved_conversion",
    )

    # --- 4. repair block: material_unit_conversions only ------------------
    repair = extract_do_block(migration, "document_unit_standard_factor_repair")
    repair_lower = repair.lower()
    assert_true(
        "public.q7_unit_factor(c.from_unit, c.to_unit) is not null" in repair_lower,
        "the repair must find rows the standard table can convert",
    )
    assert_true(
        "c.factor <> round(public.q7_unit_factor(c.from_unit, c.to_unit), 6)" in repair_lower,
        "the repair must find rows whose factor is wrong",
    )
    assert_true(
        "update public.material_unit_conversions" in repair_lower
        and "set active = false" in repair_lower
        and "effective_to = coalesce(effective_to, current_date)" in repair_lower,
        "the repair must deactivate and close the bad row first",
    )
    assert_true(
        "insert into public.material_unit_conversions" in repair_lower,
        "the repair must insert the corrected row",
    )
    assert_true(
        "round(v_row.standard_factor, 6)" in repair_lower,
        "the corrected row must use the standard factor",
    )
    assert_true(
        "'sửa 21/10: đơn vị chuẩn thay hệ số game cũ'" in repair_lower,
        "the corrected row must carry the owner note",
    )
    assert_true(
        re.search(r"\bdelete\s+from\b", repair_lower) is None,
        "the repair must never delete",
    )
    for statement in re.findall(r"\bupdate\s+public\.([a-z0-9_]+)", repair_lower):
        assert_true(
            statement == "material_unit_conversions",
            f"the repair must not update public.{statement}",
        )
    for statement in re.findall(r"\binsert\s+into\s+public\.([a-z0-9_]+)", repair_lower):
        assert_true(
            statement == "material_unit_conversions",
            f"the repair must not insert into public.{statement}",
        )

    # --- 5. question block: one batch, only open rows ---------------------
    questions = extract_do_block(migration, "document_unit_standard_factor_questions")
    questions_lower = questions.lower()
    assert_true(
        "q.batch = '2026-10-20'" in questions_lower
        and "q.status = 'open'" in questions_lower,
        "the question block must only read batch 2026-10-20 open rows",
    )
    assert_true(
        "public.document_unit_mismatch_pairs_internal()" in questions_lower
        and "public.document_unit_factor_candidates(" in questions_lower,
        "the block must recompute with the existing pair + candidate functions",
    )
    assert_true(
        "public.document_unit_answer_internal(" in questions_lower,
        "a single factor must answer through the existing answer code path",
    )
    assert_true(
        "'factor'" in questions_lower and "'đổi chuẩn tự động 21/10'" in questions_lower,
        "the answer must use action factor and the owner reason",
    )
    assert_true(
        "update public.document_unit_questions" in questions_lower
        and "set candidates = v_candidates" in questions_lower,
        "an ambiguous question must only refresh candidates",
    )

    # --- 6. no protected direct writes -----------------------------------
    assert_true(re.search(r"\bdelete\s+from\b", lower) is None, "migration must not DELETE")
    for table in LINE_TABLES:
        assert_true(
            re.search(rf"\bupdate\s+public\.{table}\b", lower) is None,
            f"migration must not update public.{table}",
        )
    assert_true(
        re.search(r"\bupdate\s+public\.stock_material_aliases\b", lower) is None,
        "migration must not update stock_material_aliases",
    )

    print("PASS: document unit standard-factor contracts hold")


if __name__ == "__main__":
    main()
