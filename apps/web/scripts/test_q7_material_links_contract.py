#!/usr/bin/env python3
"""Static contract checks for the Q7 Material Master link migration.

These checks never connect to a database or Supabase. They guard that migration
20261031140000_q7_material_links.sql:

  * defines exactly the three read/write RPCs, each SECURITY DEFINER with a pinned
    `search_path = public, pg_temp` and a `can_edit_material_master()` gate that
    raises SQLSTATE 42501;
  * stores idempotency in the server-only public.q7_material_link_requests table
    (RLS enabled, no client policy, grants to service_role only);
  * never disables a trigger, never sets session_replication_role, and never
    UPDATEs public.kitchen_inventory_items.canonical_material_id directly — the
    link is delegated to the existing Material Master reconciliation controller
    (public.apply_approved_material_reconciliation ->
    public.link_approved_material_resolution);
  * handles the item unit vs material default_unit mismatch by creating an
    approved, active public.material_unit_conversions row before linking: same
    unit links as before, a standard weight/volume pair (g/kg, ml/l) is computed
    automatically, and any other pair requires the owner's p_unit_factor
    (unit_factor_required, SQLSTATE 22023);
  * grants execute on the three RPCs to authenticated / service_role and revokes
    them from public / anon (internal helpers are revoked from every client role).

It also checks the rollback-only smoke test inlines the migration byte-for-byte
and ends by raising the PASS marker, and that the defensive TS parsers exist.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261031140000_q7_material_links.sql"
SMOKE = SCRIPTS / "smoke_q7_material_links.sql"
LIB = ROOT / "src" / "lib" / "q7-material-links.ts"
LIB_TEST = ROOT / "src" / "lib" / "q7-material-links.test.ts"
HOOK = ROOT / "src" / "hooks" / "useQ7MaterialLinks.ts"

INTERNAL_SIM = "function public.q7_material_name_similarity("
INTERNAL_LINK = "function public.q7_link_item_material_internal("

RPCS = {
    "get_q7_material_link_review": "function public.get_q7_material_link_review(",
    "link_q7_item_material": "function public.link_q7_item_material(",
    "link_q7_exact_materials": "function public.link_q7_exact_materials(",
}

BEGIN_MARKER = "-- == BEGIN INLINE MIGRATION 20261031140000_q7_material_links.sql =="
END_MARKER = "-- == END INLINE MIGRATION 20261031140000_q7_material_links.sql =="


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def extract_function(text: str, marker: str) -> tuple[str, str]:
    """Return (header, body) for the function that starts at marker."""
    start = text.index(marker)
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert_true(match is not None, f"no AS dollar-quote after {marker}")
    tag = match.group(1)
    header = text[start:start + match.start()]
    body_start = start + match.end()
    close = text.index(tag + ";", body_start)
    body = text[body_start:close]
    return header, body


def flatten(value: str) -> str:
    return re.sub(r"\s+", "", value).lower()


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261031140000_q7_material_links.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()
    flat = flatten(migration)

    # --- 1. the three RPCs: definer, pinned search_path, 42501 gate -----------
    bodies: dict[str, str] = {}
    for name, marker in RPCS.items():
        header, body = extract_function(migration, marker)
        bodies[name] = body
        flat_header = flatten(header)
        assert_true(
            "securitydefiner" in flat_header,
            f"{name} must be SECURITY DEFINER",
        )
        assert_true(
            "setsearch_path=public,pg_temp" in flat_header,
            f"{name} must pin search_path = public, pg_temp",
        )
        flat_body = flatten(body)
        assert_true(
            "can_edit_material_master()" in flat_body,
            f"{name} must gate on can_edit_material_master()",
        )
        assert_true(
            "insufficient_privilege" in flat_body and "'42501'" in flat_body,
            f"{name} must raise insufficient_privilege with SQLSTATE 42501",
        )

    # --- 2. idempotency table: RLS on, server-only, no client policy ----------
    assert_true(
        "create table if not exists public.q7_material_link_requests" in lower,
        "migration must create public.q7_material_link_requests",
    )
    assert_true(
        "request_id uuid primary key" in lower,
        "q7_material_link_requests.request_id must be the idempotency primary key",
    )
    assert_true(
        "alter table public.q7_material_link_requests enable row level security" in lower,
        "q7_material_link_requests must enable RLS",
    )
    assert_true(
        "grant select, insert, update on public.q7_material_link_requests to service_role"
        in lower,
        "q7_material_link_requests must grant only service_role",
    )
    assert_true(
        "revoke all on public.q7_material_link_requests from public, anon, authenticated"
        in lower,
        "q7_material_link_requests must revoke client roles",
    )
    for line in lower.splitlines():
        if "policy" in line and "q7_material_link_requests" in line:
            raise AssertionError(
                f"q7_material_link_requests must have no client policy: {line.strip()}"
            )

    # --- 3. no guard bypass ---------------------------------------------------
    for forbidden in ("disable trigger", "session_replication_role", "alter table"):
        if forbidden == "alter table":
            continue
        assert_true(
            forbidden not in lower,
            f"migration must not contain {forbidden!r}",
        )
    assert_true(
        re.search(r"update\s+public\.kitchen_inventory_items", lower) is None,
        "migration must never UPDATE kitchen_inventory_items directly",
    )
    # The only link writer is the existing reconciliation controller.
    assert_true(
        "public.apply_approved_material_reconciliation(" in migration,
        "linking must be delegated to apply_approved_material_reconciliation",
    )
    assert_true(
        "redefine" not in lower and "create or replace function public.link_approved_material_resolution"
        not in lower,
        "migration must not redefine the existing link guard/controller",
    )

    # --- 4. similarity helper and internal link helper are not client-callable -
    assert_true(INTERNAL_SIM in migration, "migration must define the similarity helper")
    assert_true(INTERNAL_LINK in migration, "migration must define the internal link helper")
    assert_true(
        "revoke execute on function public.q7_material_name_similarity(text, text) "
        "from public, anon, authenticated, service_role" in lower,
        "similarity helper must be revoked from every client role",
    )
    assert_true(
        "revoke execute on function public.q7_link_item_material_internal(uuid, uuid, boolean, uuid, numeric) "
        "from public, anon, authenticated, service_role" in lower,
        "internal link helper must be revoked from every client role",
    )

    # --- 4b. unit conversion handling ----------------------------------------
    assert_true(
        "drop function if exists public.link_q7_item_material(uuid, uuid, boolean, uuid);" in lower,
        "migration must drop the never-applied 4-arg link_q7_item_material",
    )
    for marker in (
        "p_unit_factor numeric default null",
        "public.q7_unit_status(",
        "public.q7_unit_factor(",
        "public.q7_unit_factor_suggestion(",
    ):
        assert_true(marker in migration, f"migration must define/use {marker}")
    assert_true(
        "'unit_factor_required' using errcode = '22023'" in lower,
        "migration must raise unit_factor_required with SQLSTATE 22023 when a factor is needed",
    )
    assert_true(
        "insert into public.material_unit_conversions" in lower,
        "migration must create the approved material_unit_conversions row before linking",
    )
    assert_true(
        "'q7_material_link'" in migration and "approved_by" in lower and "approved_at" in lower,
        "the conversion insert must be attributed to q7_material_link and approved",
    )
    # No conversion controller RPC exists; the migration writes directly and must
    # never disable or drop the overlap trigger.
    assert_true(
        "drop trigger" not in lower and "alter table public.material_unit_conversions" not in lower,
        "migration must not disable or drop the material_unit_conversions guard",
    )
    assert_true(
        "'same'" in lower and "'auto'" in lower and "needs_factor" in lower,
        "migration must classify unit_status as same / auto / needs_factor",
    )

    # --- 5. grants on the three RPCs -----------------------------------------
    grants = {
        "get_q7_material_link_review()": "get_q7_material_link_review()",
        "link_q7_item_material(uuid, uuid, boolean, uuid, numeric)": "link_q7_item_material(uuid, uuid, boolean, uuid, numeric)",
        "link_q7_exact_materials(uuid)": "link_q7_exact_materials(uuid)",
    }
    for signature in grants.values():
        assert_true(
            f"revoke execute on function public.{signature} from public, anon;" in lower,
            f"migration must revoke {signature} from public, anon",
        )
        assert_true(
            f"grant execute on function public.{signature} to authenticated, service_role;" in lower,
            f"migration must grant {signature} to authenticated, service_role",
        )

    # --- 6. smoke test --------------------------------------------------------
    assert_true(SMOKE.exists(), f"missing smoke test {SMOKE.name}")
    smoke = read(SMOKE)
    smoke_lower = smoke.lower()
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true("commit;" not in smoke_lower, "smoke must not commit")
    assert_true(
        BEGIN_MARKER in smoke and END_MARKER in smoke,
        "smoke must delimit the inline migration with markers",
    )
    inline = smoke.split(BEGIN_MARKER, 1)[1].split(END_MARKER, 1)[0]
    assert_true(
        inline.strip() == migration.strip(),
        "smoke must inline the migration byte-for-byte (regenerate it when the migration changes)",
    )
    assert_true(
        "SMOKE_RESULT PASS: q7 material links" in smoke,
        "smoke must raise the PASS marker",
    )
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise a FAIL marker on a bad step")
    assert_true(
        "from public.user_roles" in smoke and "role::text = 'owner'" in smoke,
        "smoke must take the owner from public.user_roles",
    )
    assert_true(
        "request.jwt.claims" in smoke,
        "smoke must impersonate the real owner through auth claims",
    )
    for needle in (
        "public.get_q7_material_link_review()",
        "public.link_q7_exact_materials(",
        "public.link_q7_item_material(",
        "public.record_q7_stock_count(",
        "q7_canonical_link_required",
        "record_q7_stock_count_error",
        "unit_factor_required",
        "needs_factor",
        "material_unit_conversions",
        "conversion_provenance_missing",
        "public.stock_unit_code(",
        "unit_status",
        "'42501'",
    ):
        assert_true(needle in smoke, f"smoke must cover {needle}")
    assert_true(
        smoke.rstrip().endswith("rollback;"),
        "smoke must end with an explicit rollback after the final RAISE",
    )

    # --- 7. defensive TS surface exists --------------------------------------
    assert_true(LIB.exists(), f"missing {LIB.name}")
    lib = read(LIB)
    for exported in (
        "parseQ7MaterialLinkReview",
        "parseQ7MaterialLinkResult",
        "parseQ7ExactLinkBatch",
        "q7MaterialLinkErrorText",
    ):
        assert_true(exported in lib, f"{LIB.name} must export {exported}")
    assert_true(LIB_TEST.exists(), f"missing {LIB_TEST.name}")
    assert_true(HOOK.exists(), f"missing {HOOK.name}")
    hook = read(HOOK)
    for exported in (
        "useQ7MaterialLinkReview",
        "useLinkQ7ItemMaterial",
        "useLinkQ7ExactMaterials",
    ):
        assert_true(exported in hook, f"{HOOK.name} must export {exported}")

    print("PASS: q7 material links contracts hold")


if __name__ == "__main__":
    main()
