#!/usr/bin/env python3
"""Static contract checks for 20261102750000_kho_review_read_line.sql.

No database connection.  These checks guard the read/fix slice:
  * the OCR cache table shape, composite key, RLS and service-role-only grants;
  * the unit-fix audit table with a unique request_id;
  * kho_review_line_context is SECURITY DEFINER with the shared kho gate and
    returns the line, receipt image paths and posted/link state;
  * kho_review_fix_line_unit refuses posted/linked lines, normalizes through the
    stock unit catalog, writes an audit row and never writes quantity, price or
    total;
  * kho_review_undo_unit_fix restores the old unit only while unposted/unlinked;
  * kho_review_factor_hint only returns an approved_conversion, alias,
    name_pack or standard factor and otherwise returns null;
  * only authenticated/service_role may execute the four RPCs.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102750000_kho_review_read_line.sql"

CONTEXT = "create or replace function public.kho_review_line_context("
FIX = "create or replace function public.kho_review_fix_line_unit("
UNDO = "create or replace function public.kho_review_undo_unit_fix("
FACTOR = "create or replace function public.kho_review_factor_hint("


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


def main() -> None:
    assert MIGRATION.exists(), f"missing migration {MIGRATION.name}"
    migration = read(MIGRATION)
    lower = migration.lower()
    flat = re.sub(r"\s+", " ", migration).lower()
    sql = strip_comments(migration)

    # --- 1. OCR cache table ------------------------------------------------
    reads = re.search(
        r"create table if not exists public\.kho_review_line_reads\s*\((.*?)\);",
        sql,
        re.IGNORECASE | re.S,
    )
    assert reads is not None, "missing public.kho_review_line_reads"
    reads_columns = re.sub(r"\s+", " ", reads.group(1).lower())
    for needle in (
        "receipt_item_id uuid not null references public.goods_receipt_items(id) on delete cascade",
        "images_sha text not null",
        "prompt_version text not null",
        "result jsonb",
        "ocr_engine text",
        "created_by uuid",
        "created_at timestamptz",
        "primary key (receipt_item_id, images_sha, prompt_version)",
    ):
        assert needle in reads_columns, f"read cache is missing {needle}"
    assert (
        "alter table public.kho_review_line_reads enable row level security;" in lower
    ), "read cache must enable RLS"
    assert (
        "revoke all on table public.kho_review_line_reads from public, anon, authenticated;"
        in lower
    ), "read cache must revoke client table access"
    assert (
        "grant all on table public.kho_review_line_reads to service_role;" in lower
    ), "read cache must be service_role-only"

    # --- 2. Unit-fix audit table ------------------------------------------
    fixes = re.search(
        r"create table if not exists public\.kho_review_unit_fixes\s*\((.*?)\);",
        sql,
        re.IGNORECASE | re.S,
    )
    assert fixes is not None, "missing public.kho_review_unit_fixes"
    fix_columns = re.sub(r"\s+", " ", fixes.group(1).lower())
    for needle in (
        "id uuid primary key",
        "receipt_item_id uuid not null",
        "old_unit text",
        "new_unit text not null",
        "request_id uuid unique",
        "actor uuid",
        "created_at timestamptz",
        "undone_at timestamptz",
    ):
        assert needle in fix_columns, f"unit-fix table is missing {needle}"

    # --- 3. Four SECURITY DEFINER RPCs with the shared gate ---------------
    expected_args = {
        "kho_review_line_context": ["uuid"],
        "kho_review_fix_line_unit": ["uuid", "text", "uuid"],
        "kho_review_undo_unit_fix": ["uuid"],
        "kho_review_factor_hint": ["uuid", "uuid", "text"],
    }
    for name, args in expected_args.items():
        assert function_arg_types(flat, name) == args, f"{name} args changed"

    for marker in (CONTEXT, FIX, UNDO, FACTOR):
        body = extract_function(migration, marker).lower()
        assert "security definer" in body, f"{marker} must be SECURITY DEFINER"
        assert "set search_path = public, pg_temp" in body, f"{marker} must pin search_path"
        assert "coalesce(auth.role(), '') <> 'service_role'" in body, (
            f"{marker} must bypass the gate only for service_role"
        )
        assert "public.q7_material_inventory_can_edit(v_actor)" in body, (
            f"{marker} must use the kho_review_list permission"
        )
        assert "public.has_module_permission(v_actor, 'inventory', 'edit')" in body, (
            f"{marker} must use the kho_review_list permission"
        )
        assert "'kho_review_forbidden'" in body and "errcode = '42501'" in body, (
            f"{marker} must raise kho_review_forbidden"
        )

    # --- 4. Context returns image paths and posted/link state -------------
    context = extract_function(migration, CONTEXT).lower()
    for needle in (
        "public.goods_receipts",
        "v_receipt.image_url",
        "v_receipt.product_photos",
        "'image_url'",
        "'product_photos'",
        "'image_paths'",
        "'actual_quantity'",
        "'unit_price'",
        "public.q7_inventory_movements",
        "public.tan_tao_material_movements",
        "'gr-item:'",
        "'posted'",
        "public.stock_material_aliases",
        "'linked_item_id'",
        "'linked_factor'",
    ):
        assert needle in context, f"context is missing {needle}"

    # --- 5. Fix refuses posted/linked, writes audit, never qty/price -------
    fix = extract_function(migration, FIX).lower()
    for needle in (
        "public.kho_review_unit_fixes",
        "public.normalize_document_unit(p_new_unit)",
        "public.stock_unit_code(v_new_unit)",
        "public.stock_units",
        "'unknown_unit'",
        "'line_posted'",
        "'line_linked'",
        "public.q7_inventory_movements",
        "public.tan_tao_material_movements",
        "from public.goods_receipt_items",
        "for update",
        "request_id",
        "insert into public.kho_review_unit_fixes",
        "old_unit",
        "new_unit",
    ):
        assert needle in fix, f"fix RPC is missing {needle}"

    # Every UPDATE of the line writes only the unit column.
    line_updates = re.findall(
        r"update\s+public\.goods_receipt_items\s+set\s+(.*?)\s+where",
        sql,
        re.IGNORECASE | re.S,
    )
    assert len(line_updates) == 2, f"expected 2 line updates, found {len(line_updates)}"
    allowed_sets = {"unit = v_new_unit", "unit = v_fix.old_unit"}
    for set_clause in line_updates:
        normalized = re.sub(r"\s+", " ", set_clause).strip().lower()
        assert normalized in allowed_sets, f"unexpected line update set: {normalized}"
    for forbidden in ("set quantity", "set unit_price", "set line_total"):
        assert forbidden not in lower, f"fix/undo must never {forbidden}"

    # --- 6. Undo restores the old unit while still safe -------------------
    undo = extract_function(migration, UNDO).lower()
    for needle in (
        "public.kho_review_unit_fixes",
        "for update",
        "'fix_not_found'",
        "undone_at is not null",
        "'already_undone'",
        "'line_posted'",
        "'line_linked'",
        "set unit = v_fix.old_unit",
        "set undone_at = now()",
    ):
        assert needle in undo, f"undo RPC is missing {needle}"

    # --- 7. Factor hint has only the approved sources ---------------------
    factor = extract_function(migration, FACTOR).lower()
    for needle in (
        "public.stock_item_unit_factors",
        "public.material_unit_conversions",
        "public.cogs_ingredient_stock_map",
        "public.stock_material_aliases",
        "public.stock_unit_pack_factor",
        "public.stock_units",
        "'approved_conversion'",
        "'alias'",
        "'name_pack'",
        "'standard'",
        "jsonb_build_object('factor', null, 'source', null)",
        "c.approved = true",
        "a.status = 'auto'",
    ):
        assert needle in factor, f"factor hint is missing {needle}"

    # --- 8. Grants: authenticated/service_role, never anon/public ---------
    for signature in (
        "public.kho_review_line_context(uuid)",
        "public.kho_review_fix_line_unit(uuid, text, uuid)",
        "public.kho_review_undo_unit_fix(uuid)",
        "public.kho_review_factor_hint(uuid, uuid, text)",
    ):
        assert (
            f"revoke all on function {signature} from public, anon;" in flat
        ), f"{signature} must revoke public/anon"
        assert (
            f"grant execute on function {signature} to authenticated, service_role;"
            in flat
        ), f"{signature} must grant authenticated/service_role only"
    assert not re.search(r"grant execute on function public\.kho_review_[a-z_]+\([^)]*\)\s+to\s+(?:public|anon)", lower), (
        "no RPC may be granted to public/anon"
    )

    # The new write path is the audit table, not the warehouse game request log.
    assert "warehouse_game_requests" not in lower, (
        "this migration does not add a warehouse_game_requests action"
    )

    print("PASS: kho review read-line contracts hold")


if __name__ == "__main__":
    main()
