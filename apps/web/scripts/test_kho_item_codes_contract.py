#!/usr/bin/env python3
"""Static contract checks for 20261102810000_kho_item_codes_notes.sql (no DB).

Guards the item-code/note slice:
  * history table shape, lower(old_code) index, RLS and service-role-only grants;
  * note column with the 500-character check;
  * NVL/CCDC prefix + next-code allocator (advisory lock, max suffix, 3-digit pad);
  * the insert/class-change trigger and its bypass for the bulk renumber;
  * the TMP- renumber pass, deterministic ordering and history logging;
  * kho_set_item_note gate / trim / invalid_note / grants;
  * kho_find_item_by_code reads current and historical codes;
  * apply_kitchen_inventory_import_batch resolves a historical code;
  * kho_get_items still counts evidence links and now emits note/old_codes.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102810000_kho_item_codes_notes.sql"

PREFIX_MARKER = "create or replace function public.kho_item_code_prefix("
NEXT_MARKER = "create or replace function public.kho_next_item_code("
STOCK_NEXT_MARKER = "create or replace function public.stock_unit_next_item_code("
ASSIGN_MARKER = "create or replace function public.kho_assign_item_code("
LOG_MARKER = "create or replace function public.kho_log_item_code_history("
IMPORT_MARKER = "create or replace function public.apply_kitchen_inventory_import_batch("
NOTE_MARKER = "create or replace function public.kho_set_item_note("
FIND_MARKER = "create or replace function public.kho_find_item_by_code("
ITEMS_MARKER = "create or replace function public.kho_get_items("


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"--[^\n]*", "", text)


def flat(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def extract_function(text: str, marker: str) -> str:
    start = text.index(marker)
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert match is not None, f"no AS dollar-quote after {marker}"
    tag = match.group(1)
    close = text.index(tag, start + match.end())
    end = text.index(";", close + len(tag))
    return text[start : end + 1]


def main() -> None:
    assert MIGRATION.exists(), f"missing migration {MIGRATION.name}"
    migration = read(MIGRATION)
    lower = migration.lower()
    sql = strip_comments(migration)
    flat_sql = flat(sql)

    # --- 1. History table ------------------------------------------------
    table = re.search(
        r"create table if not exists public\.kitchen_item_code_history\s*\((.*?)\);",
        sql,
        re.IGNORECASE | re.S,
    )
    assert table is not None, "missing public.kitchen_item_code_history"
    columns = flat(table.group(1))
    for needle in (
        "id uuid primary key default gen_random_uuid()",
        "item_id uuid not null references public.kitchen_inventory_items(id) on delete cascade",
        "old_code text not null",
        "new_code text not null",
        "reason text not null check (reason in ('renumber', 'class_change', 'auto_assign'))",
        "changed_by uuid",
        "changed_at timestamptz default now()",
    ):
        assert needle in columns, f"history table is missing {needle}"

    assert re.search(
        r"create index if not exists [^;]*?on public\.kitchen_item_code_history\s*"
        r"\(lower\(old_code\)\);",
        lower,
        re.S,
    ), "history needs an index on lower(old_code)"
    assert "alter table public.kitchen_item_code_history enable row level security;" in lower
    assert (
        "revoke all on public.kitchen_item_code_history from public, anon, authenticated;"
        in flat_sql
    ), "client roles must be revoked from the history table"
    assert (
        "grant all on public.kitchen_item_code_history to service_role;" in flat_sql
    ), "service_role needs the history grant"
    assert "create policy" not in lower, "history must not add a client policy"

    # --- 2. Note column --------------------------------------------------
    assert (
        "add column if not exists note text check (note is null or length(note) <= 500)"
        in flat_sql
    ), "note must be nullable text limited to 500 characters"

    # --- 3. Prefix and allocator ----------------------------------------
    assert len(re.findall(r"create\s+or\s+replace\s+function", lower)) == 9, (
        "the migration must define exactly the nine expected functions"
    )

    prefix = extract_function(migration, PREFIX_MARKER)
    prefix_flat = flat(prefix)
    assert "language sql" in prefix_flat and "immutable" in prefix_flat
    assert "case when p_class = 'raw_material' then 'nvl' else 'ccdc' end" in prefix_flat

    next_code = extract_function(migration, NEXT_MARKER)
    next_flat = flat(next_code)
    assert (
        "pg_advisory_xact_lock(hashtext('kho_item_code:' || v_prefix))" in next_flat
    ), "allocation must hold the per-series advisory lock"
    assert "regexp_match(kii.item_code, '^' || v_prefix || '-([0-9]+)$')" in next_flat
    assert "coalesce(max(" in next_flat and ") + 1" in next_flat
    assert "lpad(v_next::text, 3, '0')" in next_flat
    assert "revoke all on function public.kho_next_item_code(text)" in flat_sql
    assert (
        "grant execute on function public.kho_next_item_code(text) to service_role;"
        in flat_sql
    )

    stock_next = extract_function(migration, STOCK_NEXT_MARKER)
    assert "return public.kho_next_item_code('raw_material');" in flat(stock_next)
    assert (
        "revoke all on function public.stock_unit_next_item_code() from public, anon, authenticated;"
        in flat_sql
    )
    assert (
        "grant execute on function public.stock_unit_next_item_code() to service_role;"
        in flat_sql
    )

    # --- 4. Assignment + logging triggers --------------------------------
    assign = extract_function(migration, ASSIGN_MARKER)
    assign_flat = flat(assign)
    assert "current_setting('kho.renumbering', true)" in assign_flat, (
        "the trigger must honour the bulk-renumber bypass"
    )
    bypass = assign_flat[assign_flat.index("current_setting('kho.renumbering', true)") :]
    assert "return new;" in bypass[:160], "the bypass must leave the row untouched"
    assert "'^q7-[0-9a-f]{20}$'" in assign_flat, "legacy Q7 hashed codes must be replaced"
    assert assign_flat.count("public.kho_next_item_code(new.item_class)") == 2, (
        "insert and class change both allocate from the new class"
    )
    assert "new.item_class is distinct from old.item_class" in assign_flat
    assert (
        "public.kho_item_code_prefix(new.item_class)" in assign_flat
    ), "class change must compare the target series prefix"

    log_history = extract_function(migration, LOG_MARKER)
    log_flat = flat(log_history)
    assert "insert into public.kitchen_item_code_history" in log_flat
    assert "v_reason" in log_flat and "auth.uid()" in log_flat
    assert "new.item_code is distinct from v_old_code" in log_flat

    assert (
        "create trigger kitchen_inventory_items_assign_code before insert or update of item_class"
        in flat_sql
    ), "missing BEFORE INSERT OR UPDATE OF item_class trigger"
    assert (
        "create trigger kitchen_inventory_items_log_code after insert or update of item_class"
        in flat_sql
    ), "missing AFTER trigger that writes the history row"

    # --- 5. One-time renumber -------------------------------------------
    assert "create temporary table if not exists kho_item_code_renumber" in flat_sql
    assert "truncate pg_temp.kho_item_code_renumber" in flat_sql
    renumber_match = re.search(r"do \$\$(.*?)\$\$;", sql, re.S)
    assert renumber_match is not None, "missing renumber DO block"
    renumber = renumber_match.group(1)
    renumber_flat = flat(renumber)
    assert "set_config('kho.renumbering', 'on', true)" in renumber_flat
    assert "set_config('kho.renumbering', 'off', true)" in renumber_flat
    assert "'tmp-' || kii.id::text" in renumber_flat, (
        "the renumber must move every row to a TMP- code first"
    )
    assert "insert into public.kitchen_item_code_history" in renumber_flat
    assert "'renumber'" in renumber_flat
    assert "v_row.old_code is distinct from v_row.new_code" in renumber_flat, (
        "history must be written only for a real code change"
    )
    assert "order by new_code, id" in renumber_flat, "renumber pass must be deterministic"
    numbered = flat_sql[flat_sql.index("with numbered as (") :]
    assert "row_number() over (" in numbered
    assert "partition by public.kho_item_code_prefix(kii.item_class)" in numbered
    assert "(kii.merged_into_id is null) desc" in numbered, "non-merged items first"
    assert "coalesce(kii.active, false) desc" in numbered, "active items first"
    assert "extensions.unaccent(lower(coalesce(kii.name, '')))" in numbered
    assert "kii.id" in numbered.split("order by", 1)[1]

    # --- 6. Note RPC -----------------------------------------------------
    note = extract_function(migration, NOTE_MARKER)
    note_flat = flat(note)
    assert "security definer" in note_flat
    assert "coalesce(auth.role(), '') <> 'service_role'" in note_flat
    assert "public.kho_item_can_edit(v_actor)" in note_flat
    assert "btrim(coalesce(p_note, ''))" in note_flat
    assert "length(v_note) > 500" in note_flat
    assert "raise exception 'invalid_note'" in note_flat
    assert "'item_id', v_item_id, 'note', v_saved_note" in note_flat
    assert (
        "revoke all on function public.kho_set_item_note(uuid, text, uuid) from public, anon;"
        in flat_sql
    )
    assert (
        "grant execute on function public.kho_set_item_note(uuid, text, uuid) to authenticated, service_role;"
        in flat_sql
    )

    # --- 7. Find by code -------------------------------------------------
    find = extract_function(migration, FIND_MARKER)
    find_flat = flat(find)
    assert "lower(kii.item_code) = v_code" in find_flat
    assert "from public.kitchen_item_code_history h" in find_flat
    assert "lower(h.old_code) = v_code" in find_flat
    assert "order by h.changed_at desc, h.id desc" in find_flat
    for gate in (
        "public.q7_material_inventory_can_view(v_actor)",
        "public.stock_count_can_view('tan_tao')",
        "public.stock_count_can_view('q7')",
        "public.kho_item_can_edit(v_actor)",
    ):
        assert gate in find_flat, f"find-by-code gate is missing {gate}"
    assert "'item_id', v_item_id" in find_flat
    assert "'item_code', v_item_code" in find_flat
    assert "'name', v_name" in find_flat
    assert (
        "revoke all on function public.kho_find_item_by_code(text) from public, anon;"
        in flat_sql
    )
    assert (
        "grant execute on function public.kho_find_item_by_code(text) to authenticated, service_role;"
        in flat_sql
    )

    # --- 8. Import re-import resolution ---------------------------------
    imp = extract_function(migration, IMPORT_MARKER)
    imp_flat = flat(imp)
    assert "from public.kitchen_item_code_history h" in imp_flat
    assert "lower(h.old_code) = lower(btrim(source_row.source_item_code))" in imp_flat
    assert imp_flat.count("lower(h.old_code) = lower(btrim(source_row.source_item_code))") >= 2, (
        "history must drive both the match and its ordering"
    )
    generated = imp_flat[imp_flat.index("generated_code := case") :]
    assert "from public.kitchen_item_code_history h" in generated[:700], (
        "a historical code must not be written back as the current code"
    )
    assert "revoke all on function public.apply_kitchen_inventory_import_batch(uuid)" in flat_sql
    assert (
        "grant execute on function public.apply_kitchen_inventory_import_batch(uuid)"
        in flat_sql
    )
    assert "to service_role;" in flat_sql

    # --- 9. kho_get_items keeps evidence counts, adds the new fields -----
    items = extract_function(migration, ITEMS_MARKER)
    items_flat = flat(items)
    docs = items_flat[items_flat.index("docs as (") : items_flat.index("select coalesce(jsonb_agg(")]
    assert "public.kho_review_evidence_links" in docs
    assert "e.removed_at is null" in docs
    assert "count(distinct u.receipt_item_id)" in docs
    assert "union" in docs
    assert "'note', kii.note" in items_flat
    assert "'old_codes'" in items_flat
    assert "public.kitchen_item_code_history h" in items_flat
    assert "limit 5" in items_flat
    assert (
        "revoke all on function public.kho_get_items() from public, anon;" in flat_sql
    )
    assert (
        "grant execute on function public.kho_get_items() to authenticated, service_role;"
        in flat_sql
    )

    # --- 10. Client contract --------------------------------------------
    items_ts = read(ROOT / "src" / "lib" / "kho-items.ts")
    assert "note?: string | null;" in items_ts
    assert "old_codes?: string[];" in items_ts
    hook_ts = read(ROOT / "src" / "hooks" / "useKhoItems.ts")
    assert '"kho_set_item_note"' in hook_ts
    assert "p_item_id: input.itemId" in hook_ts
    assert "p_note: input.note" in hook_ts
    assert "p_request_id: input.requestId" in hook_ts
    assert "invalidateKhoItems(queryClient)" in hook_ts

    print("PASS: kho item codes/notes contracts hold")


if __name__ == "__main__":
    main()
