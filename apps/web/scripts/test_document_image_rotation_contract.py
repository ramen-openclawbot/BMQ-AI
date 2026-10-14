#!/usr/bin/env python3
"""Static contract checks for the document-image-rotation foundation.

These checks never connect to a database or Supabase. They guard that migration
20261101140000_document_image_rotation.sql, the match-delivery-note edge
function and the shared rotation helpers agree on:

  * the public.document_image_rotations table: text primary key with a non-blank
    check, rotation smallint limited to (0, 90, 180, 270), source limited to
    ('ai', 'manual'), RLS enabled, a read-only select policy for authenticated,
    grant select to authenticated and all to service_role, and no
    insert/update/delete policy (all writes go through the functions);
  * public.set_document_image_rotation(text, integer): security definer with
    search_path = public, raises forbidden / invalid_rotation / invalid_path /
    not_authenticated, is revoked from anon and granted to authenticated;
  * public.set_document_image_rotation_ai(text, integer): security definer with
    search_path = public, silently ignores an invalid rotation or blank path,
    only updates a row whose source is still 'ai', and is granted to service_role
    only (never to authenticated or anon);
  * match-delivery-note asks the AI for rotation_cw, calls the AI RPC inside a
    try/catch, and returns rotation_cw in every parsed response body;
  * the src/lib/image-rotation.ts helpers and the useImageRotation hook exist
    with the expected exports;
  * the rollback-only smoke exercises the AI insert, the manual-protection rule
    and the rotation check constraint.

Exit non-zero on any failure; print PASS on success.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261101140000_document_image_rotation.sql"
SMOKE = SCRIPTS / "smoke_document_image_rotation.sql"
EDGE = ROOT / "supabase" / "functions" / "match-delivery-note" / "index.ts"
LIB = ROOT / "src" / "lib" / "image-rotation.ts"
LIB_TEST = ROOT / "src" / "lib" / "image-rotation.test.ts"
HOOK = ROOT / "src" / "hooks" / "useImageRotation.ts"

MANUAL_RPC = "public.set_document_image_rotation(text, integer)"
AI_RPC = "public.set_document_image_rotation_ai(text, integer)"


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


def test_migration_name_is_free() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261101140000_document_image_rotation.sql",
        "migration must keep its timestamped name",
    )
    clashes = [p.name for p in MIGRATIONS.glob("20261101140000*") if p.name != MIGRATION.name]
    assert_true(not clashes, f"migration version 20261101140000 is already used by {clashes}")


def test_table_and_rls(migration: str) -> None:
    lower = migration.lower()
    assert_true(
        "create table if not exists public.document_image_rotations" in lower,
        "migration must create public.document_image_rotations",
    )
    assert_true(
        "check (btrim(image_path) <> '')" in lower,
        "image_path must reject a blank path",
    )
    assert_true(
        "check (rotation in (0, 90, 180, 270))" in lower,
        "rotation must be limited to (0, 90, 180, 270)",
    )
    assert_true(
        "check (source in ('ai', 'manual'))" in lower,
        "source must be limited to ('ai', 'manual')",
    )
    assert_true(
        "alter table public.document_image_rotations enable row level security" in lower,
        "RLS must be enabled on public.document_image_rotations",
    )
    assert_true(
        "create policy document_image_rotations_select" in lower,
        "a select policy must exist for the viewer",
    )
    assert_true(
        re.search(r"document_image_rotations_select[\s\S]*?for select", lower) is not None,
        "the select policy must be FOR SELECT",
    )
    assert_true(
        re.search(r"document_image_rotations_select[\s\S]*?using \(true\)", lower) is not None,
        "the select policy must allow authenticated reads with using (true)",
    )
    assert_true(
        "grant select on table public.document_image_rotations to authenticated" in lower,
        "authenticated must be granted select",
    )
    assert_true(
        "grant all on table public.document_image_rotations to service_role" in lower,
        "service_role must be granted all",
    )
    for verb in ("for insert", "for update", "for delete"):
        assert_true(verb not in lower, f"no {verb} policy may exist: writes go through the RPCs")


def test_manual_rpc(migration: str) -> None:
    lower = migration.lower()
    body = extract_function(migration, "create or replace function public.set_document_image_rotation(").lower()
    assert_true("security definer" in body, "manual RPC must be security definer")
    assert_true("set search_path = public" in body, "manual RPC must set search_path = public")
    assert_true("plpgsql" in body, "manual RPC must be plpgsql")
    assert_true("returns jsonb" in body, "manual RPC must return jsonb")
    assert_true("raise exception 'not_authenticated'" in body, "manual RPC must reject anonymous callers")
    assert_true("raise exception 'invalid_rotation'" in body, "manual RPC must reject a bad rotation")
    assert_true("raise exception 'invalid_path'" in body, "manual RPC must reject a blank path")
    assert_true("raise exception 'forbidden'" in body, "manual RPC must reject an unauthorised caller")
    assert_true("on conflict (image_path) do update" in body, "manual RPC must upsert by image_path")
    assert_true("'manual'" in body, "manual RPC must write source 'manual'")
    assert_true(
        "auth.uid()" in body,
        "manual RPC must resolve the acting user from auth.uid()",
    )
    assert_true(
        f"revoke all on function {MANUAL_RPC} from public, anon;" in lower,
        "manual RPC must be revoked from public and anon",
    )
    assert_true(
        f"grant execute on function {MANUAL_RPC} to authenticated, service_role;" in lower,
        "manual RPC must be granted to authenticated and service_role",
    )


def test_ai_rpc(migration: str) -> None:
    lower = migration.lower()
    body = extract_function(
        migration, "create or replace function public.set_document_image_rotation_ai("
    ).lower()
    assert_true("security definer" in body, "AI RPC must be security definer")
    assert_true("set search_path = public" in body, "AI RPC must set search_path = public")
    assert_true("returns void" in body, "AI RPC must return void")
    assert_true("return;" in body, "AI RPC must silently return for an invalid rotation / blank path")
    assert_true("on conflict (image_path) do update" in body, "AI RPC must upsert by image_path")
    assert_true(
        re.search(r"where\s+document_image_rotations\.source\s*=\s*'ai'", body) is not None,
        "the AI update must be guarded by source = 'ai' so it never overwrites a manual row",
    )
    assert_true(
        f"revoke all on function {AI_RPC} from public, anon, authenticated;" in lower,
        "AI RPC must be revoked from public, anon and authenticated",
    )
    assert_true(
        f"grant execute on function {AI_RPC} to service_role;" in lower,
        "AI RPC must be granted to service_role",
    )
    for role in ("authenticated", "anon", "public"):
        assert_true(
            f"grant execute on function {AI_RPC} to {role}" not in lower,
            f"AI RPC execute must not be granted to {role}",
        )


def test_edge_function() -> None:
    assert_true(EDGE.exists(), f"missing edge function {EDGE}")
    edge = read(EDGE)
    assert_true("rotation_cw" in edge, "match-delivery-note must ask the AI for rotation_cw")
    assert_true(
        "set_document_image_rotation_ai" in edge,
        "match-delivery-note must call the AI rotation RPC",
    )
    call_index = edge.index('supabase.rpc("set_document_image_rotation_ai"')
    try_index = edge.rfind("try {", 0, call_index)
    catch_index = edge.find("catch", call_index)
    assert_true(try_index != -1, "the AI rotation RPC call must be inside a try block")
    assert_true(catch_index != -1 and catch_index > call_index, "the AI rotation RPC call needs a catch")
    assert_true("console.warn" in edge[try_index:catch_index], "a failed rotation save must be warned about")
    assert_true(
        edge.count("rotation_cw: rotationCw") >= 3,
        "every parsed response body (empty / matched / no-match) must include rotation_cw",
    )


def test_shared_helpers() -> None:
    assert_true(LIB.exists(), f"missing {LIB}")
    lib = read(LIB)
    for export in (
        "export type ImageRotation",
        "export function normalizeRotation",
        "export function nextRotation",
        "export function isSideways",
        "export function imageRotationErrorCode",
        "export function imageRotationErrorText",
    ):
        assert_true(export in lib, f"{LIB.name} must declare {export}")
    assert_true(
        "Bạn không có quyền xoay ảnh phiếu" in lib,
        "forbidden must map to the Vietnamese permission message",
    )
    assert_true(
        "Chưa lưu được hướng xoay ảnh" in lib,
        "the default rotation error message must be the Vietnamese fallback",
    )
    assert_true(LIB_TEST.exists(), f"missing {LIB_TEST}")
    lib_test = read(LIB_TEST)
    assert_true("node:test" in lib_test, "rotation tests must use node:test")
    assert_true("node:assert/strict" in lib_test, "rotation tests must use node:assert/strict")
    assert_true("vitest" not in lib_test.lower(), "rotation tests must not use vitest")
    assert_true(HOOK.exists(), f"missing {HOOK}")
    hook = read(HOOK)
    for marker in (
        "useQuery",
        "useMutation",
        '"document_image_rotations"',
        '"set_document_image_rotation"',
        "@/integrations/supabase/client",
    ):
        assert_true(marker in hook, f"{HOOK.name} must use {marker}")


def test_smoke() -> None:
    assert_true(SMOKE.exists(), f"missing smoke test {SMOKE.name}")
    smoke = read(SMOKE)
    lower = smoke.lower()
    assert_true(smoke.lstrip().startswith("--"), "smoke must start with a comment header")
    assert_true("begin;" in lower, "smoke must open one transaction")
    assert_true("rollback;" in lower, "smoke must end with rollback")
    assert_true("commit;" not in lower, "smoke must never commit")
    assert_true("smoke pass" in lower, "smoke must raise SMOKE PASS")
    assert_true(
        "set_document_image_rotation_ai('__smoke__/a.jpg', 90)" in smoke
        or "set_document_image_rotation_ai('__smoke__/a.jpg',90)" in smoke,
        "smoke must first save the AI rotation 90 for __smoke__/a.jpg",
    )
    assert_true("source = 'manual'" in smoke.lower(), "smoke must switch the row to a manual source")
    assert_true("check_violation" in lower, "smoke must assert rotation 45 raises check_violation")
    assert_true("270" in smoke, "smoke must retry the AI with 270 after the manual override")


def main() -> None:
    test_migration_name_is_free()
    migration = read(MIGRATION)
    test_table_and_rls(migration)
    test_manual_rpc(migration)
    test_ai_rpc(migration)
    test_edge_function()
    test_shared_helpers()
    test_smoke()
    print("PASS: document image rotation contracts hold")


if __name__ == "__main__":
    main()
