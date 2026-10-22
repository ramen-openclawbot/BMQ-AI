#!/usr/bin/env python3
"""Static contract checks for 20261102790000_kho_review_search_dismiss.sql.

No database connection.  These checks guard the search/dismiss slice:
  * kho_review_meaningful_word() is immutable SQL with the agreed stop list;
  * kho_review_list() uses it in both word CTEs, keeps all words for a target
    that has no meaningful word, and computes target_sizes from kept words;
  * ranked drops latest-Jev 'different' candidates while hidden_different
    counts them per target and item/material rows emit it;
  * item_gaps drops item targets with an active dismissal;
  * kho_review_search_lines() has no 90-day filter, reads both corrected and
    raw names with every query word, clamps the limit, is gated and granted;
  * kho_review_dismissals has the required shape, partial unique index, RLS and
    service-role-only access;
  * kho_review_dismiss / kho_review_undismiss validate the target, are gated,
    idempotent and audited;
  * the evidence precedence and corrected/raw-name logic of kho_review_list()
    are still present.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102790000_kho_review_search_dismiss.sql"
BASE = ROOT / "supabase" / "migrations" / "20261102770000_kho_review_evidence_links.sql"

HELPER_MARKER = "create or replace function public.kho_review_meaningful_word("
LIST_MARKER = "create or replace function public.kho_review_list("
SEARCH_MARKER = "create or replace function public.kho_review_search_lines("
DISMISS_MARKER = "create or replace function public.kho_review_dismiss("
UNDISMISS_MARKER = "create or replace function public.kho_review_undismiss("

STOP_WORDS = (
    "in", "x", "size", "loai", "cai", "goi", "hop", "bich", "chai",
    "thung", "kg", "g", "ml", "l", "gr", "lit", "cuon",
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
    result = []
    for part in args.split(","):
        part = re.sub(r"\s+default\s+\S+$", "", part.strip(), flags=re.IGNORECASE)
        result.append(part.split()[-1].lower())
    return result


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
    assert BASE.exists(), f"missing base migration {BASE.name}"
    migration = read(MIGRATION)
    lower = migration.lower()
    flat = re.sub(r"\s+", " ", migration).lower()
    sql = strip_comments(migration)

    # --- 1. Meaningful word helper ---------------------------------------
    assert HELPER_MARKER in lower, "missing public.kho_review_meaningful_word()"
    helper = extract_function(migration, HELPER_MARKER).lower()
    assert "returns boolean" in helper, "meaningful-word helper must return boolean"
    assert "language sql" in helper, "meaningful-word helper must be SQL"
    assert "immutable" in helper, "meaningful-word helper must be immutable"
    assert "length(btrim(coalesce(p_word, ''))) >= 2" in helper, (
        "helper must ignore words shorter than 2 characters"
    )
    assert "not in (" in helper, "helper must apply a stop list"
    for word in STOP_WORDS:
        assert f"'{word}'" in helper, f"helper stop list is missing {word}"

    # --- 2. Both word CTEs use the helper / target fallback --------------
    target_words = cte(migration, "target_words", "target_sizes").lower()
    assert "public.kho_review_meaningful_word(aw.w)" in target_words, (
        "target_words must use the meaningful-word helper"
    )
    assert "not exists (" in target_words, (
        "a target with no meaningful word must fall back to all its words"
    )
    assert "target_words_all" in target_words, (
        "the fallback must read the unfiltered target words"
    )
    target_sizes = cte(migration, "target_sizes", "lines").lower()
    assert "from target_words" in target_sizes, (
        "target_sizes must count only the kept (meaningful) words"
    )
    line_words = cte(migration, "line_words", "scored").lower()
    assert "public.kho_review_meaningful_word(w)" in line_words, (
        "line_words must use the meaningful-word helper"
    )

    # --- 3. hidden_different and the 'different' exclusion ---------------
    ranked = cte(migration, "ranked", "hidden_different").lower()
    assert "lm.verdict is distinct from 'different'" in ranked, (
        "ranked must hide candidates whose latest Jev verdict is different"
    )
    hidden = cte(migration, "hidden_different", "cand").lower()
    assert "lm.verdict = 'different'" in hidden
    assert "count(*)::integer as n" in hidden, (
        "hidden_different must count the hidden candidates per target"
    )
    assert "group by sc.tkey" in hidden

    item_out = cte(migration, "item_out", "material_out").lower()
    assert "coalesce(h.n, 0) as hidden_different" in item_out, (
        "item_out must emit hidden_different"
    )
    material_start = re.search(r"\n  material_out as (?:materialized )?\(", migration)
    assert material_start is not None, "missing CTE material_out"
    material_out = migration[material_start.start() :].lower()
    assert "coalesce(h.n, 0) as hidden_different" in material_out, (
        "material_out must emit hidden_different"
    )
    assert lower.count("'hidden_different', x.hidden_different") == 2, (
        "both item and material output objects must carry hidden_different"
    )

    # --- 4. Dismissed item targets are excluded from the list ------------
    gaps = cte(migration, "item_gaps", "latest_versions").lower()
    assert "public.kho_review_dismissals" in gaps, (
        "item_gaps must read the dismissals table"
    )
    assert "d.removed_at is null" in gaps
    assert "':tan_tao'" in gaps and "':q7'" in gaps, (
        "dismissal keys must cover both kho locations"
    )

    # --- 5. Search RPC ----------------------------------------------------
    assert function_arg_types(flat, "kho_review_search_lines") == [
        "text",
        "text",
        "integer",
    ], "search RPC must take (target_key text, query text, limit integer)"
    assert re.search(
        r"p_limit\s+(?:int|integer)\s+default\s+20", lower
    ), "search limit must default to 20"
    search = extract_function(migration, SEARCH_MARKER).lower()
    assert "current_date - 90" not in search, (
        "the search RPC must not keep the 90-day filter"
    )
    assert "gr.status in ('confirmed', 'received')" in search
    assert "as norm_corrected" in search and "as norm_raw" in search, (
        "search must normalize both corrected and raw names"
    )
    assert "not ilike" in search and "ilike" in search, (
        "every query word must match with ilike"
    )
    assert "unnest(v_words)" in search, "search must require every query word"
    assert "length(btrim(coalesce(p_query, ''))) < 2" in search, (
        "empty/1-character search must return []"
    )
    assert "least(greatest(coalesce(p_limit, 20), 1), 50)" in search, (
        "search limit must clamp to 1..50"
    )
    assert "order by m.receipt_date desc" in search, (
        "search results must be newest receipt first"
    )
    assert "'target_key', p_target_key" in search
    assert "'score', 1" in search, "search rows must use score 1"
    for needle in (
        "'raw_name', case",
        "'linked_item_id', m.linked_item_id",
        "'posted', exists (",
        "'jev_verdict', null",
        "'jev_probability', null",
        "'jev_model', null",
    ):
        assert needle in search, f"search candidate shape is missing {needle}"
    # Evidence precedence survives in the search linked CTE.
    # linked runs after matched so aliases are only looked up for matching lines.
    assert search.index("matched as materialized (") < search.index("linked as materialized ("), (
        "search must filter lines before resolving their links"
    )
    linked = search[search.index("linked as materialized (") :].lower()
    assert "from matched l" in linked, "linked must only resolve matched lines"
    assert "public.kho_review_evidence_links" in linked
    assert linked.index("public.kho_review_evidence_links") < linked.index(
        "a.normalized_name = l.norm_corrected"
    ), "search must prefer evidence over the corrected-name alias"

    # Shared gate + grants.
    for body_name, body in (
        ("search", search),
        ("dismiss", extract_function(migration, DISMISS_MARKER).lower()),
        ("undismiss", extract_function(migration, UNDISMISS_MARKER).lower()),
    ):
        assert "coalesce(auth.role(), '') <> 'service_role'" in body, (
            f"{body_name} must keep the service-role bypass"
        )
        assert "public.q7_material_inventory_can_edit(v_actor)" in body
        assert "public.has_module_permission(v_actor, 'inventory', 'edit')" in body
        assert "'kho_review_forbidden'" in body and "errcode = '42501'" in body

    assert (
        "revoke all on function public.kho_review_search_lines(text, text, integer) from public, anon;"
        in flat
    ), "search RPC must revoke public/anon"
    assert (
        "grant execute on function public.kho_review_search_lines(text, text, integer) to authenticated, service_role;"
        in flat
    ), "search RPC must grant authenticated/service_role"

    # --- 6. Dismissals table ---------------------------------------------
    table = re.search(
        r"create table if not exists public\.kho_review_dismissals\s*\((.*?)\);",
        sql,
        re.IGNORECASE | re.S,
    )
    assert table is not None, "missing public.kho_review_dismissals"
    columns = re.sub(r"\s+", " ", table.group(1).lower())
    for needle in (
        "id uuid primary key default gen_random_uuid()",
        "target_key text not null",
        "reason text not null check (reason in ('self_made', 'gift', 'no_receipt', 'other'))",
        "note text",
        "request_id uuid unique",
        "created_by uuid",
        "created_at timestamptz default now()",
        "removed_at timestamptz",
        "removed_by uuid",
    ):
        assert needle in columns, f"dismissals table is missing {needle}"

    active_index = re.search(
        r"create unique index [^;]*?on public\.kho_review_dismissals\s*"
        r"\(target_key\)\s*where removed_at is null;",
        lower,
        re.S,
    )
    assert active_index is not None, (
        "dismissals need a partial unique index on target_key where removed_at is null"
    )
    assert (
        "alter table public.kho_review_dismissals enable row level security;"
        in lower
    ), "dismissals table must enable RLS"
    assert (
        "revoke all on public.kho_review_dismissals from public, anon, authenticated;"
        in lower
    ), "client roles must be revoked from the dismissals table"
    assert (
        "grant all on public.kho_review_dismissals to service_role;" in lower
    ), "service_role needs the dismissals grant"
    assert "create policy" not in lower, (
        "the dismissals table must not add a client policy"
    )

    # --- 7. Dismiss / undismiss RPCs -------------------------------------
    assert function_arg_types(flat, "kho_review_dismiss") == [
        "text",
        "text",
        "text",
        "uuid",
    ], "dismiss must take (target_key, reason, note, request_id)"
    dismiss = extract_function(migration, DISMISS_MARKER).lower()
    for needle in (
        "invalid_target",
        "^i:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(q7|tan_tao)$",
        "'self_made', 'gift', 'no_receipt', 'other'",
        "p_request_id",
        "pg_advisory_xact_lock",
        "insert into public.kho_review_dismissals",
        "created_by",
        "v_actor",
        "'dismissed'",
        "'replayed'",
    ):
        assert needle in dismiss, f"dismiss RPC is missing {needle}"
    assert (
        "revoke all on function public.kho_review_dismiss(text, text, text, uuid) from public, anon;"
        in flat
    ), "dismiss RPC must revoke public/anon"
    assert (
        "grant execute on function public.kho_review_dismiss(text, text, text, uuid) to authenticated, service_role;"
        in flat
    ), "dismiss RPC must grant authenticated/service_role"

    assert function_arg_types(flat, "kho_review_undismiss") == [
        "text",
        "uuid",
    ], "undismiss must take (target_key, request_id)"
    undismiss = extract_function(migration, UNDISMISS_MARKER).lower()
    for needle in (
        "invalid_target",
        "pg_advisory_xact_lock",
        "update public.kho_review_dismissals",
        "set removed_at = now()",
        "removed_by = v_actor",
        "where target_key = p_target_key",
        "and removed_at is null",
        "'removed'",
        "'none'",
    ):
        assert needle in undismiss, f"undismiss RPC is missing {needle}"
    assert (
        "revoke all on function public.kho_review_undismiss(text, uuid) from public, anon;"
        in flat
    ), "undismiss RPC must revoke public/anon"
    assert (
        "grant execute on function public.kho_review_undismiss(text, uuid) to authenticated, service_role;"
        in flat
    ), "undismiss RPC must grant authenticated/service_role"

    # --- 8. Evidence precedence + corrected/raw logic still present ------
    review = extract_function(migration, LIST_MARKER)
    review_lower = review.lower()
    linked = cte(review, "linked", "latest_marks").lower()
    assert "public.kho_review_evidence_links" in linked
    assert "e.removed_at is null" in linked
    assert linked.index("public.kho_review_evidence_links") < linked.index(
        "a.normalized_name = l.norm_corrected"
    ), "the evidence item must still take precedence over the corrected alias"
    assert "a.normalized_name = l.norm_raw" in linked
    assert "not exists (" in linked, "the corrected-name shadowing rule must stay"
    cand = cte(review, "cand", "item_out").lower()
    assert "'product_name', coalesce(r.corrected_name, r.raw_name)" in cand
    assert "'raw_name', case" in cand
    assert "public.normalize_stock_item_name(r.raw_name)" in cand
    assert "gr.receipt_date >= current_date - 90" in review_lower, (
        "the suggestion list must keep its 90-day filter"
    )
    assert "where r.rn <= 5" in review_lower
    assert "limit 300" in review_lower and "limit 100" in review_lower
    assert (
        "revoke all on function public.kho_review_list() from public, anon;" in flat
    )
    assert (
        "grant execute on function public.kho_review_list() to authenticated, service_role;"
        in flat
    )

    print("PASS: kho review search/dismiss contracts hold")


if __name__ == "__main__":
    main()
