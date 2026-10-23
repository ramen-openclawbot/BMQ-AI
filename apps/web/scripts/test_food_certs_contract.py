#!/usr/bin/env python3
"""Static contract checks for the food-safety certificate vault.

No database or Supabase connection is made.  These checks guard migration
20261102860000_food_safety_certificates.sql against table/owner/RLS/storage,
RPC signature, idempotency and ledger-posting drift.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102860000_food_safety_certificates.sql"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def block_after(text: str, marker: str, terminator: str = "$$;") -> str:
    """Case-insensitive slice from marker to the next terminator."""
    lowered = text.lower()
    start = lowered.index(marker.lower())
    end = lowered.index(terminator.lower(), start)
    return text[start:end]


def body_after(text: str, marker: str) -> str:
    return block_after(text, marker, "$$;")


def main() -> None:
    assert_true(
        MIGRATION.name == "20261102860000_food_safety_certificates.sql",
        "migration must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- table and owner checks --------------------------------------------
    assert_true(
        "create table if not exists public.food_safety_certificates" in lower,
        "food_safety_certificates table is required",
    )
    for column in (
        "id uuid primary key",
        "owner_kind text not null",
        "manufacturer_id uuid references public.food_manufacturers(id)",
        "item_id uuid references public.kitchen_inventory_items(id)",
        "supplier_id uuid references public.suppliers(id)",
        "cert_type text not null",
        "cert_no text",
        "issuer text",
        "issued_on date",
        "expires_on date",
        "file_path text not null",
        "file_name text",
        "mime_type text",
        "note text",
        "created_by uuid",
        "created_at timestamptz",
        "archived_at timestamptz",
        "archived_by uuid",
    ):
        assert_true(column in lower, f"food_safety_certificates missing {column}")
    assert_true(
        "owner_kind in ('manufacturer', 'item', 'supplier', 'company')" in lower,
        "owner_kind check is required",
    )
    assert_true(
        "cert_type in ('attp_facility', 'coa', 'product_declaration', 'other')" in lower,
        "cert_type check is required",
    )
    owner_check = block_after(
        migration,
        "constraint food_safety_certificates_owner_check check (",
        "\n  ),",
    )
    owner_check_lower = owner_check.lower()
    for fragment in (
        "owner_kind = 'manufacturer'",
        "owner_kind = 'item'",
        "owner_kind = 'supplier'",
        "owner_kind = 'company'",
        "manufacturer_id is not null and item_id is null and supplier_id is null",
        "item_id is not null and manufacturer_id is null and supplier_id is null",
        "supplier_id is not null and manufacturer_id is null and item_id is null",
        "manufacturer_id is null and item_id is null and supplier_id is null",
    ):
        assert_true(fragment in owner_check_lower, f"owner check missing {fragment}")

    # --- RLS ---------------------------------------------------------------
    assert_true(
        "alter table public.food_safety_certificates enable row level security" in lower,
        "food_safety_certificates must enable RLS",
    )
    select_policy = block_after(migration, "create policy food_safety_certificates_select", ";")
    assert_true("for select" in select_policy.lower(), "certificate SELECT policy is required")
    assert_true("to authenticated" in select_policy.lower(), "certificate SELECT is for authenticated")
    assert_true(
        "public.kho_lot_can_view((select auth.uid()))" in select_policy.lower(),
        "certificate SELECT must use the kho view gate",
    )
    assert_true(
        "revoke all on table public.food_safety_certificates from public, anon, authenticated" in lower
        and "grant select on table public.food_safety_certificates to authenticated" in lower,
        "certificate writes must stay RPC-only",
    )

    # --- private bucket ----------------------------------------------------
    bucket = block_after(migration, "insert into storage.buckets", ";")
    bucket_lower = bucket.lower()
    assert_true("'food-safety-docs'" in bucket_lower, "food-safety-docs bucket is required")
    assert_true("false," in bucket_lower, "food-safety-docs must be private")
    assert_true("20971520" in bucket_lower, "bucket must set the same 20 MB size limit")
    for mime in ("application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"):
        assert_true(mime in bucket_lower, f"bucket missing mime {mime}")

    for policy in ("food_safety_docs_select", "food_safety_docs_insert"):
        policy_body = block_after(migration, f"create policy {policy}", ";")
        policy_lower = policy_body.lower()
        assert_true("on storage.objects" in policy_lower, f"{policy} must target storage.objects")
        assert_true("to authenticated" in policy_lower, f"{policy} must be authenticated-only")
        assert_true("bucket_id = 'food-safety-docs'" in policy_lower, f"{policy} bucket mismatch")
        assert_true("name like 'certs/%'" in policy_lower, f"{policy} must stay under certs/")
        assert_true(
            "public.kho_item_can_edit((select auth.uid()))" in policy_lower,
            f"{policy} must use the kho editor gate",
        )
        assert_true(
            "public" not in policy_lower.replace("public.kho_item_can_edit", ""),
            f"{policy} must not be public",
        )

    # --- idempotency -------------------------------------------------------
    assert_true(
        "create table if not exists public.food_cert_requests" in lower,
        "food_cert_requests log is required",
    )
    for column in (
        "request_id uuid primary key",
        "cert_id uuid not null references public.food_safety_certificates(id)",
        "action text not null",
        "created_by uuid",
        "created_at timestamptz",
    ):
        assert_true(column in lower, f"food_cert_requests missing {column}")
    assert_true(
        "revoke all on table public.food_cert_requests from public, anon, authenticated" in lower,
        "food_cert_requests must be server-only",
    )

    # --- food_cert_upsert --------------------------------------------------
    upsert = body_after(migration, "CREATE OR REPLACE FUNCTION public.food_cert_upsert(")
    upsert_lower = upsert.lower()
    for parameter in (
        "p_id uuid",
        "p_owner_kind text",
        "p_owner_id uuid",
        "p_cert_type text",
        "p_cert_no text",
        "p_issuer text",
        "p_issued_on date",
        "p_expires_on date",
        "p_file_path text",
        "p_file_name text",
        "p_mime_type text",
        "p_note text",
        "p_request_id uuid",
    ):
        assert_true(parameter in upsert_lower, f"food_cert_upsert missing {parameter}")
    assert_true("returns jsonb" in upsert_lower, "food_cert_upsert must return jsonb")
    assert_true("security definer" in upsert_lower, "food_cert_upsert must be SECURITY DEFINER")
    assert_true("set search_path = public, pg_temp" in upsert_lower, "search_path must be pinned")
    assert_true(
        "public.kho_item_can_edit(v_actor)" in upsert_lower,
        "food_cert_upsert must use the kho editor gate",
    )
    assert_true(
        "p_owner_kind not in ('manufacturer', 'item', 'supplier', 'company')" in upsert_lower,
        "owner_kind must be validated",
    )
    assert_true(
        "p_owner_kind = 'manufacturer'" in upsert_lower
        and "p_owner_kind = 'item'" in upsert_lower
        and "p_owner_kind = 'supplier'" in upsert_lower
        and "p_owner_id is not null" in upsert_lower,
        "owner id must be validated by kind, with company having none",
    )
    assert_true("file_required" in upsert_lower, "file_path is required")
    assert_true("v_file_path not like 'certs/%'" in upsert_lower, "file_path must stay under certs/")
    assert_true(
        "insert into public.food_safety_certificates" in upsert_lower
        and "update public.food_safety_certificates c" in upsert_lower,
        "food_cert_upsert must insert and update",
    )
    assert_true(
        "pg_advisory_xact_lock" in upsert_lower
        and "insert into public.food_cert_requests" in upsert_lower
        and "on conflict (request_id) do nothing" in upsert_lower,
        "food_cert_upsert must be idempotent per request_id",
    )
    assert_true(
        "v_request_action <> 'upsert'" in upsert_lower and "replayed" in upsert_lower,
        "replaying an upsert request must be safe",
    )

    # --- food_cert_archive -------------------------------------------------
    archive = body_after(migration, "CREATE OR REPLACE FUNCTION public.food_cert_archive(")
    archive_lower = archive.lower()
    assert_true("p_id uuid" in archive_lower and "p_request_id uuid" in archive_lower, "archive signature")
    assert_true("returns jsonb" in archive_lower, "archive must return jsonb")
    assert_true(
        "archived_at = coalesce(c.archived_at, now())" in archive_lower,
        "archive must set archived_at",
    )
    assert_true(
        "archived_by = coalesce(c.archived_by, v_actor)" in archive_lower,
        "archive must record archived_by",
    )
    assert_true(
        "insert into public.food_cert_requests" in archive_lower
        and "v_request_action <> 'archive'" in archive_lower,
        "archive must be idempotent",
    )

    # --- food_cert_list ----------------------------------------------------
    listing = body_after(migration, "CREATE OR REPLACE FUNCTION public.food_cert_list(")
    listing_lower = listing.lower()
    for parameter in (
        "p_owner_kind text default null",
        "p_owner_id uuid default null",
        "p_expiring_days integer default null",
    ):
        assert_true(parameter in listing_lower, f"food_cert_list missing {parameter}")
    assert_true("returns jsonb" in listing_lower, "food_cert_list must return jsonb")
    assert_true(
        "public.kho_lot_can_view(v_actor)" in listing_lower,
        "food_cert_list must use the kho view gate",
    )
    assert_true("c.archived_at is null" in listing_lower, "archived certs must be excluded")
    assert_true(
        "order by c.created_at desc, c.id desc" in listing_lower,
        "certs must be newest first",
    )
    assert_true(
        "p_expiring_days is null" in listing_lower
        and "c.expires_on <= current_date + p_expiring_days" in listing_lower,
        "food_cert_list must support the expiring window",
    )
    assert_true(
        "public.food_cert_payload(c.id)" in listing_lower,
        "food_cert_list must use the shared payload helper",
    )
    payload = body_after(migration, "CREATE OR REPLACE FUNCTION public.food_cert_payload(")
    payload_lower = payload.lower()
    for piece in (
        "'owner_name'",
        "when 'manufacturer' then fm.name",
        "when 'item' then kii.name",
        "when 'supplier' then s.name",
        "when 'company' then 'công ty'",
        "'days_left'",
        "(c.expires_on - current_date)::integer",
    ):
        assert_true(piece in payload_lower, f"food_cert_payload missing {piece}")
    assert_true(
        "revoke all on function public.food_cert_payload(uuid) from public, anon, authenticated" in lower,
        "food_cert_payload must stay server-only",
    )

    # --- food_manufacturer_list -------------------------------------------
    manufacturers = body_after(migration, "CREATE OR REPLACE FUNCTION public.food_manufacturer_list(")
    manufacturers_lower = manufacturers.lower()
    assert_true("p_query text default null" in manufacturers_lower, "manufacturer list signature")
    assert_true("returns jsonb" in manufacturers_lower, "manufacturer list must return jsonb")
    assert_true(
        "public.kho_lot_can_view(v_actor)" in manufacturers_lower,
        "manufacturer list must use the kho view gate",
    )
    assert_true(
        "fm.normalized_name like '%' || v_query || '%'" in manufacturers_lower,
        "manufacturer list must search by normalized name",
    )
    assert_true("order by fm.name, fm.id" in manufacturers_lower, "manufacturer list order")

    # --- grants ------------------------------------------------------------
    for signature in (
        "public.food_cert_upsert(uuid, text, uuid, text, text, text, date, date, text, text, text, text, uuid)",
        "public.food_cert_archive(uuid, uuid)",
        "public.food_cert_list(text, uuid, integer)",
        "public.food_manufacturer_list(text)",
    ):
        assert_true(
            f"grant execute on function {signature} to authenticated, service_role" in lower,
            f"missing grant for {signature}",
        )
        assert_true(
            f"revoke all on function {signature} from public, anon" in lower,
            f"missing revoke for {signature}",
        )

    # --- no ledger writes --------------------------------------------------
    for ledger_write in (
        "insert into public.inventory_movements",
        "update public.inventory_movements",
        "insert into public.stock_ledger_entries",
        "update public.stock_ledger_entries",
        "insert into public.q7_material_inventory_movements",
        "update public.q7_material_inventory_movements",
    ):
        assert_true(ledger_write not in lower, f"migration must not write {ledger_write}")

    print("test_food_certs_contract: OK")


if __name__ == "__main__":
    main()
