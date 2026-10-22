#!/usr/bin/env python3
"""Static contract checks for 20261102760000_kho_review_corrected_name.sql.

No database connection.  These checks guard the corrected/raw-name review
slice:
  * the migration only redefines public.kho_review_list() with the same
    signature, security, search_path and grants as the applied definition;
  * the lines CTE reads both gri.product_name and gri.raw_product_name and
    derives norm_corrected / norm_raw from them;
  * line_words tags words from both names and scored keeps the per-name
    maximum before ranking;
  * linked prefers the corrected-name alias and only falls back to the
    raw-name alias when no corrected-name alias exists at all;
  * candidates output product_name = corrected name and raw_name only when it
    differs after normalization;
  * the 90-day filter, permission gate, Jev marks, ranking and limits stay;
  * no other function, table, index or policy is created or altered.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102760000_kho_review_corrected_name.sql"
PREVIOUS = ROOT / "supabase" / "migrations" / "20261102740000_kho_review_jev.sql"

LIST_MARKER = "create or replace function public.kho_review_list("

SIGNATURE = (
    "create or replace function public.kho_review_list() returns jsonb "
    "language plpgsql stable security definer "
    "set search_path = public, pg_temp"
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


def function_header(text: str) -> str:
    start = text.lower().index(LIST_MARKER)
    end = text.lower().index("as $$", start)
    return re.sub(r"\s+", " ", text[start:end]).strip().lower()


def function_arg_types(flat_text: str, name: str) -> list[str]:
    match = re.search(
        rf"create or replace function public\.{name}\((.*?)\)\s*returns",
        flat_text,
        re.IGNORECASE,
    )
    assert match is not None, f"missing function {name}"
    args = match.group(1).strip()
    if not args:
        return []
    return [part.strip().split()[-1].lower() for part in args.split(",")]


def cte(text: str, name: str, next_name: str) -> str:
    start = re.search(rf"\n  {re.escape(name)} as (?:materialized )?\(", text)
    assert start is not None, f"missing CTE {name}"
    end = re.search(
        rf"\n  {re.escape(next_name)} as (?:materialized )?\(",
        text[start.end() :],
    )
    assert end is not None, f"missing CTE {next_name} after {name}"
    return text[start.start() : start.end() + end.start()]


def main() -> None:
    assert MIGRATION.exists(), f"missing migration {MIGRATION.name}"
    assert PREVIOUS.exists(), f"missing applied migration {PREVIOUS.name}"
    migration = read(MIGRATION)
    lower = migration.lower()
    flat = re.sub(r"\s+", " ", migration).lower()
    sql = strip_comments(migration)

    # --- 1. One function only, same signature/security/search_path --------
    assert len(re.findall(r"create\s+or\s+replace\s+function", lower)) == 1, (
        "the migration must only redefine kho_review_list()"
    )
    assert function_arg_types(flat, "kho_review_list") == [], (
        "kho_review_list must keep its no-argument signature"
    )
    assert "returns jsonb" in flat, "kho_review_list must keep returning jsonb"
    assert SIGNATURE in flat, (
        "kho_review_list must keep language plpgsql, stable, security definer "
        "and the pinned search_path"
    )
    assert function_header(migration) == function_header(read(PREVIOUS)), (
        "the definition header must match the applied kho_review_list()"
    )

    # --- 2. No other function/table/index/policy created or altered ------
    for forbidden in (
        r"\bcreate\s+table\b",
        r"\balter\s+table\b",
        r"\bdrop\s+table\b",
        r"\bcreate\s+index\b",
        r"\bdrop\s+index\b",
        r"\bcreate\s+policy\b",
        r"\balter\s+policy\b",
        r"\bdrop\s+policy\b",
        r"\bcreate\s+trigger\b",
        r"\balter\s+type\b",
    ):
        assert not re.search(forbidden, lower), (
            f"the migration must not run {forbidden}"
        )

    # --- 3. lines carries both corrected and raw names --------------------
    lines = cte(migration, "lines", "line_words").lower()
    for needle in (
        "nullif(btrim(gri.product_name), '') as corrected_name",
        "nullif(btrim(gri.raw_product_name), '') as raw_name",
        "as norm_corrected",
        "as norm_raw",
        "coalesce(nullif(btrim(gri.product_name), ''), nullif(btrim(gri.raw_product_name), ''))",
        "coalesce(nullif(btrim(gri.raw_product_name), ''), nullif(btrim(gri.product_name), ''))",
    ):
        assert needle in lines, f"lines CTE is missing {needle}"
    assert "public.normalize_stock_item_name" in lines

    # --- 4. line_words tags both names; scored keeps the per-name max -----
    words = cte(migration, "line_words", "scored").lower()
    for needle in ("'c'::text as src", "'r'::text as src", "l.norm_corrected", "l.norm_raw"):
        assert needle in words, f"line_words is missing {needle}"
    assert re.search(r"\bunion\b", words), "line_words must union the two tagged word sets"

    scored = cte(migration, "scored", "linked").lower()
    for needle in (
        "lw.src",
        "max(score) as score",
        "group by tkey, receipt_item_id",
        "having count(*)::numeric / ts.n >= 0.5",
    ):
        assert needle in scored, f"scored is missing {needle}"
    # The max happens over the per (target, line, src) score subquery.
    assert scored.index("group by tw.tkey, lw.receipt_item_id, lw.src, ts.n") < (
        scored.index("group by tkey, receipt_item_id")
    ), "scored must keep the per-name scores before taking the maximum"

    # --- 5. linked prefers the corrected-name alias ----------------------
    linked = cte(migration, "linked", "latest_marks").lower()
    assert linked.count("a.normalized_name = l.norm_corrected") >= 1, (
        "linked must match the alias on the corrected name"
    )
    assert "a.normalized_name = l.norm_raw" in linked, (
        "linked must fall back to the raw-name alias"
    )
    assert linked.index("a.normalized_name = l.norm_corrected") < linked.index(
        "a.normalized_name = l.norm_raw"
    ), "the corrected-name alias must be preferred over the raw-name alias"
    for needle in (
        "a.location = l.location",
        "a.supplier_id is not distinct from l.supplier_id",
        "a.kitchen_inventory_item_id is not null",
        "not exists (",
        "c.normalized_name = l.norm_corrected",
    ):
        assert needle in linked, f"linked is missing {needle}"

    # The 'linked elsewhere' filter still uses this linked_item_id.
    ranked = cte(migration, "ranked", "cand").lower()
    assert "left join linked lk on lk.receipt_item_id = l.receipt_item_id" in ranked
    assert "lk.linked_item_id is null or lk.linked_item_id = t.item_id" in ranked

    # --- 6. candidate output: corrected product_name + conditional raw ---
    cand = cte(migration, "cand", "item_out").lower()
    for needle in (
        "'product_name', coalesce(r.corrected_name, r.raw_name)",
        "'raw_name', case",
        "public.normalize_stock_item_name(r.raw_name)",
        "public.normalize_stock_item_name(coalesce(r.corrected_name, r.raw_name))",
        "then r.raw_name",
        "'linked_item_id', r.linked_item_id",
    ):
        assert needle in cand, f"cand is missing {needle}"
    assert cand.count("'raw_name'") == 1, "cand must emit exactly one raw_name key"

    # --- 7. Unchanged gate, 90-day filter, Jev marks, ranking and limits --
    assert "coalesce(auth.role(), '') <> 'service_role'" in lower
    assert "public.q7_material_inventory_can_edit(v_actor)" in lower
    assert "public.has_module_permission(v_actor, 'inventory', 'edit')" in lower
    assert "'kho_review_forbidden'" in lower and "errcode = '42501'" in lower
    assert "gr.receipt_date >= current_date - 90" in lower, (
        "the 90-day receipt filter must stay"
    )
    assert "gr.status in ('confirmed', 'received')" in lower
    assert "coalesce(gr.receiving_location, 'tan_tao') in ('q7', 'tan_tao')" in lower
    for needle in (
        "public.kho_review_jev_marks",
        "latest_marks",
        "left join latest_marks",
        "jev_verdict",
        "jev_probability",
        "jev_model",
        "order by (lm.verdict = 'same_item') desc nulls last",
        "lm.probability desc nulls last",
        "sc.score desc, l.receipt_date desc, l.receipt_item_id desc",
        "where r.rn <= 5",
        "limit 300",
        "limit 100",
        "'target_key'",
    ):
        assert needle in lower, f"kho_review_list is missing {needle}"

    # --- 8. Grants unchanged ----------------------------------------------
    assert (
        "revoke all on function public.kho_review_list() from public, anon;" in flat
    ), "kho_review_list must keep revoking public/anon"
    assert (
        "grant execute on function public.kho_review_list() to authenticated, service_role;"
        in flat
    ), "kho_review_list must keep granting authenticated/service_role"

    print("PASS: kho review corrected-name contracts hold")


if __name__ == "__main__":
    main()
