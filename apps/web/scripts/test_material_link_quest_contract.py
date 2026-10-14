#!/usr/bin/env python3
"""Static contract checks for the two-warehouse material link quest migration.

These checks never connect to a database or Supabase. They guard that migration
20261101180000_material_link_quest.sql and the shipped source:

  * create public.material_link_skips with its reason check, RLS, one select
    policy and the client/service grants;
  * expose public.material_link_review_items(text) + public.get_material_link_review(text),
    keep public.get_q7_material_link_review() as a CREATE OR REPLACE that calls the
    core with 'q7', and keep a gate-free internal core used by mission_evaluate;
  * widen the link eligibility of public.q7_link_item_material (no more
    "pastry_q7 = true" gate inside the linking internal) and add
    public.link_item_material + public.link_exact_materials(text, uuid);
  * add skip/unskip RPCs;
  * add the 'material_links_done' mission rule (constraint + mission_evaluate
    branch) and seed 'wh-link-q7' / 'wh-link-tan-tao';
  * add public.assign_material_link_missions(uuid) gated on owner;
  * keep the hook free of .tsx imports, teach lib/missions.ts the
    "material_links" detail kind and re-export factorPrefill from the lib.

Everything here is a text assertion; it does not prove runtime behaviour.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"
SRC = ROOT / "src"

MIGRATION = MIGRATIONS / "20261101180000_material_link_quest.sql"
SMOKE = SCRIPTS / "smoke_material_link_quest.sql"
HOOK = SRC / "hooks" / "useMaterialLinkQuest.ts"
MISSIONS_TS = SRC / "lib" / "missions.ts"
LINK_STATION = SRC / "game" / "LinkStation.tsx"
QUEST_LIB = SRC / "lib" / "material-link-quest.ts"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def extract_function(text: str, marker: str) -> str:
    """Return the full function definition from marker to its closing dollar tag."""
    start = text.index(marker)
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert_true(match is not None, f"no AS dollar-quote after {marker}")
    tag = match.group(1)
    end = text.index(tag + ";", start + match.end())
    return text[start:end + len(tag) + 1]


def canon(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261101180000_material_link_quest.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. material_link_skips table + RLS + policy + grants ----------------
    assert_true(
        "create table if not exists public.material_link_skips" in lower,
        "migration must create public.material_link_skips",
    )
    assert_true(
        "reason in ('not_material')" in lower,
        "material_link_skips must restrict reason to 'not_material'",
    )
    assert_true(
        "alter table public.material_link_skips enable row level security" in lower,
        "material_link_skips must enable RLS",
    )
    assert_true(
        "create policy material_link_skips_select on public.material_link_skips" in lower
        and "for select to authenticated using (true)" in lower,
        "material_link_skips must have one authenticated select policy",
    )
    assert_true(
        "grant select on table public.material_link_skips to authenticated" in lower,
        "material_link_skips must grant select to authenticated",
    )
    assert_true(
        "grant all on table public.material_link_skips to service_role" in lower,
        "material_link_skips must grant all to service_role",
    )

    # --- 2. core read RPCs ----------------------------------------------------
    core_marker = "create or replace function public.material_link_review_items_internal("
    pub_marker = "create or replace function public.material_link_review_items("
    get_marker = "create or replace function public.get_material_link_review("
    q7_review_marker = "create or replace function public.get_q7_material_link_review()"
    for marker, label in (
        (core_marker, "material_link_review_items_internal"),
        (pub_marker, "material_link_review_items"),
        (get_marker, "get_material_link_review"),
        (q7_review_marker, "get_q7_material_link_review"),
    ):
        assert_true(marker in migration, f"migration must define public.{label}")

    core_def = extract_function(migration, core_marker)
    assert_true(
        "can_edit_material_master" not in core_def,
        "the internal review core must be gate-free so mission_evaluate can call it",
    )
    assert_true(
        "material_link_skips" in core_def,
        "the review core must exclude skipped items",
    )
    assert_true(
        "pastry_q7 = true" in core_def,
        "the review core must keep the Q7 item set condition",
    )
    assert_true(
        "material_link_material_skus" in core_def,
        "the review core must attach the fed SKUs to materials",
    )
    assert_true(
        "'last_buy'" in core_def and "'receipt_photo_count'" in core_def,
        "the review core must return last_buy and receipt_photo_count",
    )
    assert_true(
        "'none'" in core_def and "'skipped'" in core_def,
        "the review core counts must include none and skipped",
    )

    pub_def = extract_function(migration, pub_marker)
    assert_true(
        "can_edit_material_master" in pub_def
        and "material_link_review_items_internal" in pub_def,
        "the public review RPC must check the gate then call the internal core",
    )
    get_def = extract_function(migration, get_marker)
    assert_true(
        "material_link_review_items" in get_def,
        "get_material_link_review must delegate to the shared review core",
    )
    q7_def = extract_function(migration, q7_review_marker)
    assert_true(
        canon(q7_def).find("material_link_review_items('q7')") != -1,
        "get_q7_material_link_review must call the core with 'q7'",
    )

    # --- 3. widened eligibility + new write RPCs ------------------------------
    assert_true(
        "create or replace function public.link_item_material(" in migration,
        "migration must define public.link_item_material",
    )
    internal_marker = "create or replace function public.q7_link_item_material_internal("
    internal_def = extract_function(migration, internal_marker)
    assert_true(
        "pastry_q7" not in internal_def,
        "the linking eligibility must no longer require pastry_q7 / Q7 movements",
    )
    assert_true(
        "material_link_skips" in internal_def,
        "the linking eligibility must reject skipped items",
    )
    assert_true(
        "v_item.canonical_material_id is not null" in internal_def,
        "the linking eligibility must reject linked items",
    )

    assert_true(
        "create or replace function public.link_exact_materials(" in migration,
        "migration must define public.link_exact_materials",
    )
    exact_def = extract_function(
        migration, "create or replace function public.link_exact_materials("
    )
    assert_true(
        "p_location" in exact_def
        and "material_link_review_items_internal(p_location)" in canon(exact_def),
        "link_exact_materials must work over the p_location item set",
    )
    assert_true(
        "'needs_factor'" in exact_def,
        "link_exact_materials must split out needs_factor rows",
    )
    assert_true(
        "create or replace function public.link_q7_exact_materials(" in migration
        and "link_exact_materials('q7'" in canon(migration),
        "link_q7_exact_materials must keep working through the shared batch",
    )

    # --- 4. skip / unskip -----------------------------------------------------
    assert_true(
        "create or replace function public.skip_item_material_link(" in migration,
        "migration must define public.skip_item_material_link",
    )
    assert_true(
        "create or replace function public.unskip_item_material_link(" in migration,
        "migration must define public.unskip_item_material_link",
    )
    skip_def = extract_function(
        migration, "create or replace function public.skip_item_material_link("
    )
    assert_true(
        "'item_not_eligible'" in skip_def and "using errcode = '22023'" in skip_def,
        "skip must reject ineligible items with item_not_eligible",
    )
    assert_true(
        "on conflict (item_id) do update" in canon(skip_def),
        "skip must upsert on conflict (item_id)",
    )
    unskip_def = extract_function(
        migration, "create or replace function public.unskip_item_material_link("
    )
    assert_true(
        "delete from public.material_link_skips" in unskip_def,
        "unskip must delete the skip row",
    )

    # --- 5. mission rule + seeds + assign ------------------------------------
    assert_true(
        "alter table public.missions drop constraint if exists missions_check_rule_check" in lower,
        "migration must drop the old mission check-rule constraint",
    )
    constraint_block = migration[migration.index("alter table public.missions add constraint missions_check_rule_check") :]
    constraint_block = constraint_block[: constraint_block.index(");") + 2]
    for rule in (
        "stock_alias_factor_fixed",
        "stock_duplicate_resolved",
        "stock_unknown_units_cleared",
        "material_links_done",
    ):
        assert_true(
            f"'{rule}'" in constraint_block,
            f"missions_check_rule_check must include {rule}",
        )

    evaluate_def = extract_function(
        migration, "create or replace function public.mission_evaluate("
    )
    assert_true(
        "material_links_done" in evaluate_def,
        "mission_evaluate must have a material_links_done branch",
    )
    assert_true(
        "material_link_review_items_internal(v_location)" in canon(evaluate_def),
        "mission_evaluate must read the gate-free review core",
    )
    assert_true(
        "jsonb_build_array(jsonb_build_object(" in canon(evaluate_def)
        and "'remaining', v_left" in canon(evaluate_def)
        and "'location', v_location" in canon(evaluate_def),
        "mission_evaluate material_links detail must expose location + remaining",
    )
    for key in ("'done', v_done", "'total', v_total", "'left', v_left", "'detail', v_detail"):
        assert_true(key in canon(evaluate_def), f"mission_evaluate must keep key {key}")

    assert_true(
        "'wh-link-q7'" in migration and "'wh-link-tan-tao'" in migration,
        "migration must seed wh-link-q7 and wh-link-tan-tao",
    )
    assert_true(
        migration.count("on conflict (code) do nothing") >= 2,
        "seed missions must use on conflict (code) do nothing",
    )
    assert_true(
        "jsonb_build_object('location', 'q7')" in migration
        and "jsonb_build_object('location', 'tan_tao')" in migration,
        "seeded missions must pin the q7 / tan_tao location",
    )

    assert_true(
        "create or replace function public.assign_material_link_missions(" in migration,
        "migration must define public.assign_material_link_missions",
    )
    assign_def = extract_function(
        migration, "create or replace function public.assign_material_link_missions("
    )
    assert_true(
        "public.has_role(v_actor, 'owner')" in assign_def
        or "public.has_role(auth.uid(), 'owner')" in assign_def,
        "assign_material_link_missions must gate on the owner role",
    )
    assert_true(
        "'wh-link-q7-' || left(p_user::text, 8)" in canon(assign_def)
        and "'wh-link-tan-tao-' || left(p_user::text, 8)" in canon(assign_def),
        "assign_material_link_missions must use the per-user mission codes",
    )

    # --- 6. source contracts --------------------------------------------------
    hook = read(HOOK)
    assert_true(".tsx" not in hook, "the material-link hook must not import any .tsx")
    assert_true(
        "MATERIAL_LINK_REVIEW_QUERY_KEY" in hook
        and '"material-link-review"' in hook,
        "the hook must export MATERIAL_LINK_REVIEW_QUERY_KEY = 'material-link-review'",
    )
    assert_true(
        "get_material_link_review" in hook
        and "link_item_material" in hook
        and "link_exact_materials" in hook
        and "skip_item_material_link" in hook
        and "unskip_item_material_link" in hook,
        "the hook must call all five new RPCs",
    )
    assert_true(
        "Q7_MATERIAL_LINK_REVIEW_QUERY_KEY" in hook
        and "MISSIONS_QUERY_KEY" in hook
        and "WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY" in hook,
        "the hook must invalidate the Q7 review, missions and warehouse snapshot",
    )

    missions_ts = read(MISSIONS_TS)
    assert_true(
        'kind: "material_links"' in missions_ts or 'kind: "material_links",' in missions_ts,
        'lib/missions.ts must tag the material_links detail kind',
    )
    assert_true(
        '"remaining" in row' in missions_ts and '"location" in row' in missions_ts,
        "lib/missions.ts must detect the material_links row by remaining + location",
    )

    link_station = read(LINK_STATION)
    assert_true(
        'export { factorPrefill } from "@/lib/material-link-quest";' in link_station,
        "LinkStation.tsx must re-export factorPrefill from the quest lib",
    )
    assert_true(
        "function factorPrefill(" not in link_station,
        "LinkStation.tsx must not keep its own factorPrefill definition",
    )

    assert_true(QUEST_LIB.exists(), f"missing {QUEST_LIB.name}")
    quest_lib = read(QUEST_LIB)
    assert_true(
        "export function factorPrefill(" in quest_lib
        and "export function deckOrder(" in quest_lib
        and "export function bulkableRows(" in quest_lib
        and "export function parseMaterialLinkReview(" in quest_lib,
        "material-link-quest.ts must export factorPrefill, deckOrder, bulkableRows and parseMaterialLinkReview",
    )

    # --- 7. smoke test --------------------------------------------------------
    assert_true(SMOKE.exists(), f"missing smoke test {SMOKE.name}")
    smoke = read(SMOKE)
    smoke_lower = smoke.lower()
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true("rollback;" in smoke_lower, "smoke must roll back")
    assert_true("commit;" not in smoke_lower, "smoke must not commit")
    assert_true(
        "raise notice 'SMOKE PASS'" in smoke,
        "smoke must raise SMOKE PASS",
    )
    assert_true(
        "request.jwt.claims" in smoke,
        "smoke must impersonate an owner through auth claims",
    )
    assert_true(
        "from public.user_roles" in smoke and "role = 'owner'" in smoke,
        "smoke must take the owner from public.user_roles",
    )
    for step in (
        "get_material_link_review",
        "skip_item_material_link",
        "unskip_item_material_link",
        "link_item_material",
        "mission_evaluate",
        "item_not_eligible",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} step")

    print("PASS: material link quest contracts hold")


if __name__ == "__main__":
    main()
