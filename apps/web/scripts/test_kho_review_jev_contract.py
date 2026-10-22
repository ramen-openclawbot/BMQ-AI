#!/usr/bin/env python3
"""Static contract checks for 20261102740000_kho_review_jev.sql.

No database connection.  These checks guard the Jev review slice:
  * the marks table shape, its one-row-per-(target, line, prompt) key and RLS:
    authenticated readers only, no client write policy, service_role writes;
  * kho_review_list keeps the 90-day filter and adds target_key + jev_* fields,
    ranking same-item candidates first;
  * kho_review_jev_feedback is SECURITY DEFINER with the shared kho gate and the
    warehouse_game_requests replay key;
  * the action check keeps every previous action and adds the feedback action;
  * the link helper records the human 'linked' decision;
  * the edge function asks the shared decisions provider, never links/creates,
    and caps one request at 40 pairs.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102740000_kho_review_jev.sql"
EDGE = ROOT / "supabase" / "functions" / "kho-review-jev"

PREVIOUS_ACTIONS = (
    "rename",
    "change_unit",
    "set_item_pastry_q7",
    "kho_save_item",
    "kho_add_unit",
    "kho_set_conversion",
    "set_item_kho_locations",
    "kho_review_link_line",
    "kho_review_create_item",
)
NEW_ACTION = "kho_review_jev_feedback"

LIST_MARKER = "create or replace function public.kho_review_list("
FEEDBACK_MARKER = "create or replace function public.kho_review_jev_feedback("
HELPER_MARKER = "create or replace function public.kho_review_link_line_internal("
CREATE_MARKER = "create or replace function public.kho_review_create_item_from_line("


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

    # --- 1. marks table shape and unique key ------------------------------
    table = re.search(
        r"create table if not exists public\.kho_review_jev_marks\s*\((.*?)\);",
        sql,
        re.IGNORECASE | re.S,
    )
    assert table is not None, "missing public.kho_review_jev_marks"
    columns = re.sub(r"\s+", " ", table.group(1).lower())
    for needle in (
        "id uuid primary key default gen_random_uuid()",
        "target_key text not null",
        "receipt_item_id uuid not null references public.goods_receipt_items(id) on delete cascade",
        "verdict text not null check (verdict in ('same_item', 'different', 'unsure'))",
        "probability numeric check (probability between 0 and 1)",
        "suggested_class text check (suggested_class in ('raw_material', 'packaging_supply'))",
        "prompt_version text not null",
        "model text",
        "provider text",
        "human_action text check (human_action in ('linked', 'dismissed'))",
        "human_action_at timestamptz",
        "created_by uuid",
        "created_at timestamptz default now()",
        "unique (target_key, receipt_item_id, prompt_version)",
    ):
        assert needle in columns, f"marks table is missing {needle}"

    # --- 2. RLS: authenticated read only, service_role writes -------------
    assert (
        "alter table public.kho_review_jev_marks enable row level security;"
        in lower
    ), "marks table must enable RLS"
    policies = re.findall(r"create policy[\s\S]*?;", sql, re.IGNORECASE)
    assert len(policies) == 1, "marks table must have exactly one select policy"
    policy = re.sub(r"\s+", " ", policies[0].lower())
    assert "on public.kho_review_jev_marks" in policy
    assert "for select to authenticated" in policy
    assert "public.q7_material_inventory_can_edit((select auth.uid()))" in policy
    assert (
        "public.has_module_permission((select auth.uid()), 'inventory', 'edit')"
        in policy
    )
    for write in ("for insert", "for update", "for delete", "for all"):
        assert write not in policy, f"marks table must not have a client {write} policy"
    assert (
        "revoke all on public.kho_review_jev_marks from public, anon, authenticated;"
        in lower
    ), "client roles must be revoked before the narrow grant"
    assert (
        "grant select on public.kho_review_jev_marks to authenticated;" in lower
    ), "authenticated readers need select"
    assert (
        "grant all on public.kho_review_jev_marks to service_role;" in lower
    ), "service_role needs the write grant"

    # --- 3. kho_review_list keeps the 90-day filter and adds jev fields ---
    assert LIST_MARKER in lower, "missing kho_review_list"
    list_body = extract_function(migration, LIST_MARKER).lower()
    assert (
        "gr.receipt_date >= current_date - 90" in list_body
    ), "kho_review_list must keep the 90-day receipt filter"
    for needle in (
        "public.kho_review_jev_marks",
        "latest_marks",
        "left join latest_marks",
        "jev_verdict",
        "jev_probability",
        "jev_model",
        "'target_key'",
        "'i:' ||",
        "'m:' ||",
    ):
        assert needle in list_body, f"kho_review_list is missing {needle}"
    assert "order by (lm.verdict = 'same_item') desc nulls last" in list_body, (
        "candidates must rank same_item marks first"
    )
    assert "lm.probability desc nulls last" in list_body, (
        "candidates must rank by same-item probability next"
    )
    assert "limit 300" in list_body and "limit 100" in list_body, (
        "the 300 item / 100 material limits must stay"
    )

    # --- 4. feedback RPC: signature, gate, idempotency --------------------
    args = function_arg_types(flat, "kho_review_jev_feedback")
    assert args == ["text", "uuid", "text", "uuid"], f"feedback args {args}"
    feedback = extract_function(migration, FEEDBACK_MARKER).lower()
    for needle in (
        "security definer",
        "set search_path = public, pg_temp",
        "coalesce(auth.role(), '') <> 'service_role'",
        "public.q7_material_inventory_can_edit(v_actor)",
        "public.has_module_permission(v_actor, 'inventory', 'edit')",
        "'kho_review_forbidden'",
        "errcode = '42501'",
        "p_action not in ('linked', 'dismissed')",
        "pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text))",
        "from public.warehouse_game_requests r",
        "r.action = 'kho_review_jev_feedback'",
        "'kho_review_jev_feedback', null, v_result",
        "set human_action = p_action",
        "human_action_at = now()",
        "where target_key = p_target_key",
        "receipt_item_id = p_receipt_item_id",
    ):
        assert needle in feedback, f"feedback RPC is missing {needle}"
    # The human decision applies to every prompt version of the pair.
    update_section = feedback[feedback.index("update public.kho_review_jev_marks"):]
    assert "prompt_version" not in update_section.split("get diagnostics")[0], (
        "feedback must not filter by prompt_version"
    )
    assert (
        "revoke all on function public.kho_review_jev_feedback(text, uuid, text, uuid) from public, anon;"
        in flat
    ), "feedback RPC must revoke public/anon"
    assert (
        "grant execute on function public.kho_review_jev_feedback(text, uuid, text, uuid) to authenticated, service_role;"
        in flat
    ), "feedback RPC must grant authenticated/service_role"

    # --- 5. action check keeps every previous action ----------------------
    constraint = re.search(
        r"add constraint warehouse_game_requests_action_check[\s\S]*?\);",
        sql,
        re.IGNORECASE,
    )
    assert constraint is not None, "missing warehouse_game_requests_action_check"
    block = constraint.group(0)
    for action in PREVIOUS_ACTIONS + (NEW_ACTION,):
        assert f"'{action}'" in block, f"action check is missing {action}"
    assert "drop constraint if exists warehouse_game_requests_action_check" in lower, (
        "the old action check must be dropped before the new one is added"
    )

    # --- 6. link helper / create-from-line record the human 'linked' ------
    helper = extract_function(migration, HELPER_MARKER).lower()
    assert "human_action = 'linked'" in helper, "link helper must record linked"
    assert "target_key = 'i:' || p_item_id::text || ':' || v_location" in helper, (
        "link helper must target the linked item at that kho"
    )
    create = extract_function(migration, CREATE_MARKER).lower()
    assert "human_action = 'linked'" in create, (
        "create-from-line must record the human linked decision"
    )

    # --- 7. edge function: shared provider, no links, 40-pair cap ---------
    assert EDGE.exists(), f"missing edge function directory {EDGE}"
    index = read(EDGE / "index.ts")
    handler = read(EDGE / "handler.ts")
    jev = read(EDGE / "jev.ts")
    edge = f"{index}\n{handler}\n{jev}"
    edge_flat = re.sub(r"\s+", " ", edge).lower()

    assert "kho_review_list" in index, "edge must read kho_review_list as the caller"
    assert "kho_review_jev_marks" in index, "edge must store marks"
    assert "onconflict: \"target_key,receipt_item_id,prompt_version\"" in edge_flat, (
        "edge must upsert on the marks unique key"
    )
    assert "decisions-provider" in jev, "edge must use the shared decisions provider"
    assert "evaluatedecisions" in jev.lower(), "edge must call evaluateDecisions"
    assert "zeroDataRetention".lower() in edge_flat, "edge must keep zero data retention"
    assert "typesafe-ai" in edge_flat, "edge must pin the typesafe provider"
    assert "kho_review_jev_prompt_version" in jev.lower(), "edge needs a prompt version"
    assert "type: \"boolean\"" in jev.lower().replace(" ", " "), (
        "edge must ask the same-item boolean question"
    )
    assert "type: \"choice\"" in jev, "edge must ask the material class choice question"
    assert "raw_material" in jev and "packaging_supply" in jev
    assert "0.8" in jev and "0.2" in jev, "edge must keep the verdict thresholds"
    for verdict in ("same_item", "different", "unsure"):
        assert verdict in jev, f"edge is missing the {verdict} verdict"

    assert "KHO_REVIEW_JEV_MAX_LIMIT = 40" in handler, "edge must cap limit at 40"
    assert "Math.min(raw.limit, KHO_REVIEW_JEV_MAX_LIMIT)" in handler, (
        "edge must clamp a requested limit to 40"
    )
    assert "KHO_REVIEW_JEV_DEFAULT_LIMIT = 20" in handler, "edge default limit must be 20"

    for forbidden in (
        "kho_review_link_line",
        "kho_review_create_item_from_line",
        "create_stock_material_item",
        "post_stock_goods_receipt_item",
    ):
        assert forbidden not in edge, f"edge function must never call {forbidden}"

    print("PASS: kho review Jev contracts hold")


if __name__ == "__main__":
    main()
