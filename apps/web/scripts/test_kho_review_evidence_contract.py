#!/usr/bin/env python3
"""Static contract checks for 20261102770000_kho_review_evidence_links.sql.

No database connection.  These checks guard the evidence-link slice:
  * the evidence table shape, one-active-row-per-line index, RLS and the
    service-role-only grant;
  * kho_review_link_line_internal replaces the item_wrong_kho raise with an
    evidence insert + return, and that branch writes no alias and posts nothing;
  * the normal same-kho path soft-removes an older evidence row;
  * kho_get_items doc_lines counts active evidence links with count(distinct),
    unioned with the alias-based lines;
  * kho_review_list's linked CTE prefers the active evidence row over aliases,
    while keeping the 90-day filter and corrected/raw-name logic;
  * kho_review_unlink_evidence has the shared gate and the right grants;
  * kho_review_link_line itself is not redefined.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102770000_kho_review_evidence_links.sql"
CORRECTED = ROOT / "supabase" / "migrations" / "20261102760000_kho_review_corrected_name.sql"

INTERNAL_MARKER = "create or replace function public.kho_review_link_line_internal("
ITEMS_MARKER = "create or replace function public.kho_get_items("
LIST_MARKER = "create or replace function public.kho_review_list("
UNLINK_MARKER = "create or replace function public.kho_review_unlink_evidence("


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
    close = text.index(tag, start + match.end())
    end = text.index(";", close + len(tag))
    return text[start : end + 1]


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
    assert CORRECTED.exists(), f"missing applied migration {CORRECTED.name}"
    migration = read(MIGRATION)
    lower = migration.lower()
    flat = re.sub(r"\s+", " ", migration).lower()
    sql = strip_comments(migration)

    # --- 1. Evidence table shape -----------------------------------------
    table = re.search(
        r"create table if not exists public\.kho_review_evidence_links\s*\((.*?)\);",
        sql,
        re.IGNORECASE | re.S,
    )
    assert table is not None, "missing public.kho_review_evidence_links"
    columns = re.sub(r"\s+", " ", table.group(1).lower())
    for needle in (
        "id uuid primary key default gen_random_uuid()",
        "receipt_item_id uuid not null references public.goods_receipt_items(id) on delete cascade",
        "item_id uuid not null references public.kitchen_inventory_items(id)",
        "factor numeric not null check (factor > 0)",
        "line_location text not null check (line_location in ('q7', 'tan_tao'))",
        "request_id uuid unique",
        "created_by uuid",
        "created_at timestamptz default now()",
        "removed_at timestamptz",
        "removed_by uuid",
    ):
        assert needle in columns, f"evidence table is missing {needle}"

    # --- 2. One active row per receipt line ------------------------------
    active_index = re.search(
        r"create unique index [^;]*?on public\.kho_review_evidence_links\s*"
        r"\(receipt_item_id\)\s*where removed_at is null;",
        lower,
        re.S,
    )
    assert active_index is not None, (
        "evidence links need a partial unique index on receipt_item_id "
        "where removed_at is null"
    )

    # --- 3. RLS and service-role-only access -----------------------------
    assert (
        "alter table public.kho_review_evidence_links enable row level security;"
        in lower
    ), "evidence table must enable RLS"
    assert (
        "revoke all on public.kho_review_evidence_links from public, anon, authenticated;"
        in lower
    ), "client roles must be revoked from the evidence table"
    assert (
        "grant all on public.kho_review_evidence_links to service_role;" in lower
    ), "service_role needs the write grant"
    assert "create policy" not in lower, (
        "evidence table must not add a client policy"
    )

    # --- 4. Only the expected functions are defined ----------------------
    assert len(re.findall(r"create\s+or\s+replace\s+function", lower)) == 4, (
        "the migration must define exactly the helper, get_items, list and unlink"
    )
    assert not re.search(
        r"create\s+or\s+replace\s+function public\.kho_review_link_line\s*\(",
        lower,
    ), "kho_review_link_line must not be redefined (it already replays the result)"

    # --- 5. Link helper: evidence branch where item_wrong_kho was --------
    helper = extract_function(migration, INTERNAL_MARKER)
    helper_lower = helper.lower()
    assert "item_wrong_kho" not in helper_lower, (
        "the item_wrong_kho raise must be replaced by the evidence branch"
    )
    assert helper_lower.count("status', 'evidence'") == 1, (
        "the helper must return status evidence"
    )

    branch_start = helper_lower.index("if (v_location = 'tan_tao'")
    branch_end = helper_lower.index("end if;", branch_start) + len("end if;")
    branch = helper_lower[branch_start:branch_end]
    for needle in (
        "insert into public.kho_review_evidence_links",
        "receipt_item_id, item_id, factor, line_location, created_by",
        "p_receipt_item_id, p_item_id, p_factor, v_location, auth.uid()",
        "on conflict (receipt_item_id) where removed_at is null",
        "item_id = excluded.item_id",
        "factor = excluded.factor",
        "returning e.id into v_evidence_id",
        "'status', 'evidence'",
        "'posted', false",
        "'location', v_location",
        "'evidence_id', v_evidence_id",
        "human_action = 'linked'",
        "coalesce(v_item.pastry_q7, false) then 'q7' else 'tan_tao' end",
    ):
        assert needle in branch, f"evidence branch is missing {needle}"
    for forbidden in ("stock_material_aliases", "post_stock_goods_receipt_item"):
        assert forbidden not in branch, (
            f"the evidence branch must not touch {forbidden}"
        )

    # The normal same-kho path still writes the alias and posts, and it
    # soft-removes an older evidence row first.
    normal = helper_lower[branch_end:]
    assert "insert into public.stock_material_aliases" in normal
    assert "post_stock_goods_receipt_item" in normal
    soft_remove = "update public.kho_review_evidence_links"
    assert soft_remove in normal, "the normal path must soft-remove evidence"
    remove_section = normal[normal.index(soft_remove) :]
    assert "set removed_at = now()" in remove_section
    assert "removed_by = auth.uid()" in remove_section
    assert "and removed_at is null" in remove_section
    assert normal.index(soft_remove) < normal.index(
        "insert into public.stock_material_aliases"
    ), "the evidence row must be removed before the alias write"

    assert (
        "revoke all on function public.kho_review_link_line_internal(uuid, uuid, numeric) from public, anon, authenticated;"
        in flat
    ), "the helper must keep its live revoke"
    assert (
        "grant execute on function public.kho_review_link_line_internal(uuid, uuid, numeric) to service_role;"
        in flat
    ), "the helper must keep its live service_role grant"

    # --- 6. kho_get_items docs counts evidence with count(distinct) ------
    items = extract_function(migration, ITEMS_MARKER)
    items_lower = items.lower()
    docs_start = items_lower.index("docs as (")
    docs_end = items_lower.index("select coalesce(jsonb_agg(", docs_start)
    docs = items_lower[docs_start:docs_end]
    for needle in (
        "public.kho_review_evidence_links",
        "public.stock_material_aliases",
        "e.removed_at is null",
        "gr.status in ('confirmed', 'received')",
        "count(distinct",
        "receipt_item_id",
    ):
        assert needle in docs, f"docs CTE is missing {needle}"
    assert "count(distinct u.receipt_item_id)" in docs, (
        "docs must count distinct receipt lines across the union"
    )
    assert re.search(r"\bunion\b", docs), (
        "docs must union the alias-based and evidence-based lines"
    )
    assert docs.index("union") < docs.index(") u"), (
        "the union must be the subquery counted by count(distinct)"
    )
    assert "a.normalized_name = public.normalize_stock_item_name(" in docs, (
        "the alias-based doc_lines must stay"
    )
    assert (
        "revoke all on function public.kho_get_items() from public, anon;" in flat
    ), "kho_get_items must keep its live revoke"
    assert (
        "grant execute on function public.kho_get_items() to authenticated, service_role;"
        in flat
    ), "kho_get_items must keep its live grants"

    # --- 7. kho_review_list linked prefers evidence ----------------------
    review = extract_function(migration, LIST_MARKER)
    review_lower = review.lower()
    linked = cte(review, "linked", "latest_marks").lower()
    assert "public.kho_review_evidence_links" in linked, (
        "linked must read the evidence links"
    )
    assert "e.receipt_item_id = l.receipt_item_id" in linked
    assert "e.removed_at is null" in linked
    assert "e.item_id" in linked
    assert linked.index("public.kho_review_evidence_links") < linked.index(
        "a.normalized_name = l.norm_corrected"
    ), "the evidence item must take precedence over the corrected-name alias"
    assert "a.normalized_name = l.norm_raw" in linked, (
        "the raw-name alias fallback must stay"
    )
    assert "not exists (" in linked, "the corrected-name shadowing rule must stay"

    # --- 8. 90-day filter and corrected-name logic still present ---------
    assert "gr.receipt_date >= current_date - 90" in review_lower, (
        "the 90-day receipt filter must stay"
    )
    assert "as norm_corrected" in review_lower
    assert "as norm_raw" in review_lower
    assert "coalesce(nullif(btrim(gri.product_name), ''), nullif(btrim(gri.raw_product_name), ''))" in review_lower
    assert "coalesce(nullif(btrim(gri.raw_product_name), ''), nullif(btrim(gri.product_name), ''))" in review_lower
    assert "'product_name', coalesce(r.corrected_name, r.raw_name)" in review_lower
    assert "where r.rn <= 5" in review_lower
    assert "limit 300" in review_lower and "limit 100" in review_lower
    assert (
        "revoke all on function public.kho_review_list() from public, anon;" in flat
    ), "kho_review_list must keep its live revoke"
    assert (
        "grant execute on function public.kho_review_list() to authenticated, service_role;"
        in flat
    ), "kho_review_list must keep its live grants"

    # --- 9. Unlink RPC: gate, soft remove, result, grants ----------------
    assert function_arg_types(flat, "kho_review_unlink_evidence") == [
        "uuid",
        "uuid",
    ], "unlink must take (receipt_item_id, request_id)"
    unlink = extract_function(migration, UNLINK_MARKER).lower()
    for needle in (
        "security definer",
        "set search_path = public, pg_temp",
        "coalesce(auth.role(), '') <> 'service_role'",
        "public.q7_material_inventory_can_edit(v_actor)",
        "public.has_module_permission(v_actor, 'inventory', 'edit')",
        "'kho_review_forbidden'",
        "errcode = '42501'",
        "update public.kho_review_evidence_links",
        "set removed_at = now()",
        "removed_by = v_actor",
        "where receipt_item_id = p_receipt_item_id",
        "and removed_at is null",
        "'removed'",
        "'none'",
    ):
        assert needle in unlink, f"unlink RPC is missing {needle}"
    assert (
        "revoke all on function public.kho_review_unlink_evidence(uuid, uuid) from public, anon;"
        in flat
    ), "unlink RPC must revoke public/anon"
    assert (
        "grant execute on function public.kho_review_unlink_evidence(uuid, uuid) to authenticated, service_role;"
        in flat
    ), "unlink RPC must grant authenticated/service_role"

    print("PASS: kho review evidence-link contracts hold")


if __name__ == "__main__":
    main()
