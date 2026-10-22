#!/usr/bin/env python3
"""Static contract checks for 20261102720000_kho_review.sql.

No database connection.  These checks guard the three review RPCs:
  * kho_review_list / kho_review_link_line / kho_review_create_item_from_line
    are SECURITY DEFINER with a pinned search_path, revoke public/anon and
    grant authenticated + service_role;
  * every RPC uses the required inventory-edit gate and the
    'kho_review_forbidden' 42501 error;
  * warehouse_game_requests keeps every previous action and adds the two new
    review actions;
  * the link helper posts only after stock_ledger_cutover_date;
  * the migration never deletes or updates a stock ledger movement.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102720000_kho_review.sql"

PREVIOUS_ACTIONS = (
    "rename",
    "change_unit",
    "set_item_pastry_q7",
    "kho_save_item",
    "kho_add_unit",
    "kho_set_conversion",
    "set_item_kho_locations",
)
NEW_ACTIONS = ("kho_review_link_line", "kho_review_create_item")

RPC_SIGNATURES = (
    ("kho_review_list", []),
    ("kho_review_link_line", ["uuid", "uuid", "numeric", "uuid"]),
    (
        "kho_review_create_item_from_line",
        ["uuid", "text", "text", "text", "numeric", "uuid"],
    ),
)

LEDGER_TABLES = ("tan_tao_material_movements", "q7_inventory_movements")


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
    # Each parameter is "p_name type"; the type is the last token.
    return [part.strip().split()[-1].lower() for part in args.split(",")]


def signature(name: str, arg_types: list[str]) -> str:
    return f"public.{name}({', '.join(arg_types)})"


def main() -> None:
    assert MIGRATION.exists(), f"missing migration {MIGRATION.name}"
    migration = read(MIGRATION)
    lower = migration.lower()
    flat = re.sub(r"\s+", " ", migration).lower()
    sql = strip_comments(migration)

    # --- 1. three functions: envelope, search_path and the shared gate ----
    for name, expected_args in RPC_SIGNATURES:
        arg_types = function_arg_types(flat, name)
        assert arg_types == expected_args, (
            f"{name} arguments {arg_types} != {expected_args}"
        )
        marker = f"create or replace function public.{name}("
        assert marker in lower, f"missing {name}"
        body = extract_function(migration, marker).lower()

        assert "security definer" in body, f"{name} must be SECURITY DEFINER"
        assert (
            "set search_path = public, pg_temp" in body
        ), f"{name} must pin search_path = public, pg_temp"
        assert "returns jsonb" in body, f"{name} must return jsonb"

        # Gate: service_role, or the Q7 material editor / inventory editor.
        for needle in (
            "coalesce(auth.role(), '') <> 'service_role'",
            "public.q7_material_inventory_can_edit(v_actor)",
            "public.has_module_permission(v_actor, 'inventory', 'edit')",
            "'kho_review_forbidden'",
            "errcode = '42501'",
        ):
            assert needle in body, f"{signature} gate is missing {needle}"

    # --- 2. grants -------------------------------------------------------
    for name, arg_types in RPC_SIGNATURES:
        full = signature(name, arg_types)
        assert (
            f"revoke all on function {full} from public, anon;".lower() in flat
        ), f"{full} must revoke public/anon"
        assert (
            f"grant execute on function {full} to authenticated, service_role;".lower()
            in flat
        ), f"{full} must grant authenticated/service_role"

    # --- 3. action check keeps the old list and adds the two new actions --
    constraint = re.search(
        r"add constraint warehouse_game_requests_action_check[\s\S]*?\);",
        sql,
        re.IGNORECASE,
    )
    assert constraint is not None, "missing warehouse_game_requests_action_check"
    block = constraint.group(0)
    for action in PREVIOUS_ACTIONS + NEW_ACTIONS:
        assert f"'{action}'" in block, f"action check is missing {action}"
    assert "drop constraint if exists warehouse_game_requests_action_check" in lower, (
        "the old action check must be dropped before the new one is added"
    )

    # --- 4. link helper posts only after the cutover ---------------------
    helper_marker = "create or replace function public.kho_review_link_line_internal("
    assert helper_marker in lower, "missing kho_review_link_line_internal"
    helper = extract_function(migration, helper_marker).lower()
    cutover_pos = helper.find("public.stock_ledger_cutover_date(v_location)")
    post_pos = helper.find("public.post_stock_goods_receipt_item(p_receipt_item_id, v_alias)")
    assert cutover_pos != -1, "link helper must read stock_ledger_cutover_date(location)"
    assert post_pos != -1, "link helper must call post_stock_goods_receipt_item(line, alias)"
    assert cutover_pos < post_pos, "the cutover check must run before posting"
    assert re.search(
        r"v_receipt\.receipt_date\s*>\s*v_cutover", helper
    ), "posting must require receipt_date > stock_ledger_cutover_date"
    assert "v_cutover is not null" in helper, "a null cutover must not post"
    assert "if v_has_movement then" in helper, "an already-posted line must not post twice"

    # --- 5. idempotency for both write RPCs ------------------------------
    assert lower.count("pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text))") == 2, (
        "both write RPCs must take the warehouse_game advisory lock"
    )
    assert lower.count("from public.warehouse_game_requests r") == 2, (
        "both write RPCs must replay from warehouse_game_requests"
    )
    assert "'kho_review_link_line', p_item_id" in lower, (
        "link RPC must store its result under kho_review_link_line"
    )
    assert "'kho_review_create_item', v_item_id" in lower, (
        "create RPC must store its result under kho_review_create_item"
    )

    # --- 6. no delete/update of a stock ledger movement ------------------
    for table in LEDGER_TABLES:
        pattern = (
            rf"\b(?:delete\s+from|update|truncate(?:\s+table)?)"
            rf"\s+(?:public\.)?{table}\b"
        )
        assert re.search(pattern, sql, re.IGNORECASE) is None, (
            f"migration must not delete or update {table}"
        )

    print("PASS: kho review contracts hold")


if __name__ == "__main__":
    main()
