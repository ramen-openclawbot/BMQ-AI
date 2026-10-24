#!/usr/bin/env python3
"""Static contract checks for the kho ATTP checklist migration.

No database or Supabase connection is made.  These checks guard migration
20261102990000_kho_attp_checklist.sql and the mirrored TypeScript rule table:
item profiles, certificate review state, item links, the checklist read model,
the pending/confirm/link RPCs, the pending reminder filter and the no-ledger
boundary.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102990000_kho_attp_checklist.sql"
TS_LIB = ROOT / "src" / "lib" / "kho-attp.ts"


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


def parse_sql_required_kinds(migration: str) -> dict[str, list[str]]:
    body = body_after(migration, "CREATE OR REPLACE FUNCTION public.kho_attp_required_kinds(")
    table: dict[str, list[str]] = {}
    for match in re.finditer(
        r"when\s+'([a-z_]+)'\s+then\s+array\[([^\]]*)\]\s*::text\[\]",
        body,
        flags=re.IGNORECASE,
    ):
        profile = match.group(1)
        kinds = re.findall(r"'([a-z_]+)'", match.group(2))
        table[profile] = kinds
    return table


def parse_ts_required_kinds(lib: str) -> dict[str, list[str]]:
    marker = "export const ATTP_REQUIRED_KINDS: Record<AttpProfile, readonly AttpKind[]> = {"
    start = lib.index(marker)
    end = lib.index("};", start)
    block = lib[start:end]
    table: dict[str, list[str]] = {}
    for match in re.finditer(r"([a-z_]+):\s*\[([^\]]*)\]", block):
        profile = match.group(1)
        kinds = re.findall(r'"([a-z_]+)"', match.group(2))
        table[profile] = kinds
    return table


def main() -> None:
    assert_true(
        MIGRATION.name == "20261102990000_kho_attp_checklist.sql",
        "migration must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lib = read(TS_LIB)
    lower = migration.lower()

    # --- item profile column + check ---------------------------------------
    assert_true(
        "alter table public.kitchen_inventory_items" in lower
        and "add column if not exists attp_profile text" in lower,
        "kitchen_inventory_items.attp_profile is required",
    )
    for profile in (
        "packaged_food",
        "fresh_meat",
        "fresh_produce",
        "food_contact_packaging",
        "none",
    ):
        assert_true(
            f"'{profile}'" in lower,
            f"ATTP profile check missing {profile}",
        )
    assert_true(
        "kitchen_inventory_items_attp_profile_check" in lower
        and "attp_profile is null" in lower,
        "attp_profile must allow null (derived) and pin its check constraint",
    )

    # --- default profile rules ---------------------------------------------
    default_profile = body_after(
        migration,
        "CREATE OR REPLACE FUNCTION public.kho_attp_default_profile(",
    )
    default_lower = default_profile.lower()
    assert_true("immutable" in default_lower, "default profile must be immutable")
    assert_true(
        "set search_path = public, pg_temp" in default_lower,
        "default profile search_path",
    )
    assert_true(
        "public.normalize_stock_item_name(p_name)" in default_lower,
        "default profile must reuse the shared normalizer",
    )
    assert_true(
        "when p_class = 'non_stock' then 'none'" in default_lower,
        "non_stock -> none",
    )
    assert_true(
        "when p_class = 'raw_material'" in default_lower
        and "then 'fresh_meat'" in default_lower
        and "then 'fresh_produce'" in default_lower
        and "'packaged_food'" in default_lower,
        "raw_material rules must map to fresh_meat/fresh_produce/packaged_food",
    )
    assert_true(
        "when p_class = 'packaging_supply'" in default_lower
        and "then 'food_contact_packaging'" in default_lower,
        "packaging_supply rules must map to food_contact_packaging",
    )
    assert_true(
        "else 'packaged_food'" in default_lower,
        "unknown class -> packaged_food",
    )
    for pattern, label in (
        ("nac|mo|gan|thit|xuong|da bao|suon|ba chi|dui", "meat"),
        ("ca rot|dua leo|hanh|ngo|ot|toi|cu cai|rau|xa lach|ca chua|chanh|gung|sa", "produce"),
        ("boc|mang|hop|tui|khay|giay nen|nhom|ly|nap|bao banh|giay goi|opp|pe", "packaging"),
    ):
        assert_true(pattern in default_lower, f"default profile missing {label} pattern")

    # --- certificate review state ------------------------------------------
    assert_true(
        "add column if not exists review_status text not null default 'confirmed'" in lower,
        "review_status must default to 'confirmed'",
    )
    assert_true(
        "review_status in ('pending', 'confirmed')" in lower,
        "review_status check must allow pending/confirmed",
    )
    assert_true(
        "update public.food_safety_certificates" in lower
        and "set review_status = 'confirmed'" in lower
        and "where review_status is null" in lower,
        "existing certificate rows must be backfilled 'confirmed'",
    )
    assert_true(
        "add column if not exists reviewed_by uuid" in lower
        and "add column if not exists reviewed_at timestamptz" in lower
        and "add column if not exists extracted jsonb" in lower,
        "reviewer fields and extracted jsonb are required",
    )

    # --- quarantine cert type ----------------------------------------------
    assert_true(
        "food_safety_certificates_cert_type_check" in lower
        and "'quarantine'" in lower,
        "cert_type check must include quarantine",
    )
    upsert = body_after(migration, "CREATE OR REPLACE FUNCTION public.food_cert_upsert(")
    upsert_lower = upsert.lower()
    assert_true(
        "'quarantine'" in upsert_lower,
        "food_cert_upsert validation must accept quarantine",
    )
    assert_true(
        "'confirmed'" in upsert_lower and "review_status" in upsert_lower,
        "food_cert_upsert must keep inserting confirmed",
    )
    assert_true("security definer" in upsert_lower, "food_cert_upsert must stay SECURITY DEFINER")
    assert_true(
        "public.kho_item_can_edit(v_actor)" in upsert_lower,
        "food_cert_upsert must keep the kho editor gate",
    )
    assert_true(
        "revoke all on function public.food_cert_upsert(uuid, text, uuid, text, text, text, "
        "date, date, text, text, text, text, uuid) from public, anon" in lower,
        "food_cert_upsert must stay revoked from public/anon",
    )

    # --- links table ---------------------------------------------------------
    assert_true(
        "create table if not exists public.food_cert_item_links" in lower,
        "food_cert_item_links table is required",
    )
    for fragment in (
        "cert_id uuid not null references public.food_safety_certificates(id) on delete cascade",
        "item_id uuid not null references public.kitchen_inventory_items(id) on delete cascade",
        "created_by uuid",
        "created_at timestamptz",
        "primary key (cert_id, item_id)",
    ):
        assert_true(fragment in lower, f"food_cert_item_links missing {fragment}")
    assert_true(
        "alter table public.food_cert_item_links enable row level security" in lower,
        "food_cert_item_links must enable RLS",
    )
    links_policy = block_after(migration, "create policy food_cert_item_links_select", ";")
    links_policy_lower = links_policy.lower()
    assert_true("for select" in links_policy_lower, "links SELECT policy is required")
    assert_true("to authenticated" in links_policy_lower, "links SELECT is for authenticated")
    for gate in (
        "public.q7_material_inventory_can_view((select auth.uid()))",
        "public.stock_count_can_view('tan_tao')",
        "public.stock_count_can_view('q7')",
        "public.kho_item_can_edit((select auth.uid()))",
    ):
        assert_true(gate in links_policy_lower, f"links SELECT gate missing {gate}")
    assert_true(
        links_policy_lower.count("((select auth.uid()))") == 2,
        "links SELECT must use the authenticated uid twice",
    )
    assert_true(
        "revoke all on table public.food_cert_item_links from public, anon, authenticated" in lower,
        "links writes must stay RPC-only",
    )
    assert_true(
        "grant select on table public.food_cert_item_links to authenticated" in lower,
        "links needs the explicit authenticated SELECT grant",
    )
    assert_true(
        "grant all on table public.food_cert_item_links to service_role" in lower,
        "links needs the service_role grant",
    )
    write_policies = re.findall(
        r"create policy\s+food_cert_item_links_[a-z0-9_]+[^;]*?for\s+(insert|update|delete)",
        migration,
        flags=re.IGNORECASE | re.DOTALL,
    )
    assert_true(not write_policies, "links must not have client write policies")

    # --- required kinds: SQL == TS -----------------------------------------
    sql_kinds = parse_sql_required_kinds(migration)
    ts_kinds = parse_ts_required_kinds(lib)
    assert_true(sql_kinds, "could not parse SQL required-kind table")
    assert_true(ts_kinds, "could not parse TS required-kind table")
    assert_true(
        sql_kinds == ts_kinds,
        f"required-kind tables drifted: SQL={sql_kinds} TS={ts_kinds}",
    )
    assert_true(
        sql_kinds.get("packaged_food") == ["attp_facility", "product_declaration", "coa"],
        "packaged_food kinds",
    )
    assert_true(sql_kinds.get("fresh_meat") == ["attp_facility", "quarantine"], "fresh_meat kinds")
    assert_true(sql_kinds.get("fresh_produce") == ["attp_facility"], "fresh_produce kinds")
    assert_true(
        sql_kinds.get("food_contact_packaging") == ["product_declaration", "coa"],
        "food_contact_packaging kinds",
    )
    assert_true(sql_kinds.get("none") == [], "none kinds")

    # --- checklist read model ----------------------------------------------
    checklist = body_after(migration, "CREATE OR REPLACE FUNCTION public.kho_attp_checklist(")
    checklist_lower = checklist.lower()
    assert_true("p_days integer default 180" in checklist_lower, "checklist signature")
    assert_true("returns jsonb" in checklist_lower, "checklist must return jsonb")
    assert_true("stable" in checklist_lower, "checklist must be stable")
    assert_true("security definer" in checklist_lower, "checklist must be SECURITY DEFINER")
    assert_true("set search_path = public, pg_temp" in checklist_lower, "checklist search_path")
    assert_true(
        "auth.role(), '') <> 'service_role'" in checklist_lower,
        "checklist service_role bypass",
    )
    for gate in (
        "public.q7_material_inventory_can_view(v_actor)",
        "public.stock_count_can_view('tan_tao')",
        "public.stock_count_can_view('q7')",
        "public.kho_item_can_edit(v_actor)",
    ):
        assert_true(gate in checklist_lower, f"checklist gate missing {gate}")
    assert_true(
        "gr.status in ('confirmed', 'received')" in checklist_lower,
        "checklist must scope to confirmed/received receipts",
    )
    assert_true(
        "gr.receipt_date >= current_date - v_days" in checklist_lower,
        "checklist must scope by receipt_date within p_days",
    )
    assert_true(
        "kii.active is true" in checklist_lower and "kii.merged_into_id is null" in checklist_lower,
        "checklist must exclude inactive/merged items",
    )
    assert_true(
        checklist_lower.count("public.kho_receipt_line_item(gri.id)") == 1,
        "receipt-line resolver must run exactly once per line",
    )
    assert_true(
        "scoped_lines as materialized" in checklist_lower
        and "resolved_lines as materialized" in checklist_lower,
        "receipt lines must be materialised once",
    )
    assert_true(
        "kii.default_manufacturer_id, lm.manufacturer_id" in checklist_lower,
        "manufacturer falls back to the latest receipt line",
    )
    assert_true(
        "public.kho_attp_default_profile(kii.item_class, kii.item_type, kii.name)" in checklist_lower,
        "checklist must derive the effective profile",
    )
    assert_true(
        "when kii.attp_profile is null then 'default' else 'set'" in checklist_lower,
        "checklist profile_source",
    )
    for state in ("'ok'", "'warn'", "'wait'", "'miss'", "'na'"):
        assert_true(state in checklist_lower, f"checklist missing state {state}")
    assert_true(
        "current_date + 30" in checklist_lower,
        "checklist must use the 30-day warn window",
    )
    assert_true(
        "b.expires_on >= current_date" in checklist_lower,
        "warn covers 0..30 days",
    )
    assert_true(
        "jsonb_build_object(" in checklist_lower and "'shared_count'" in checklist_lower,
        "requirements must carry shared_count",
    )
    assert_true(
        "b.review_status = 'pending'" in checklist_lower
        and "'extracted'" in checklist_lower,
        "wait must expose the pending extract",
    )
    assert_true(
        "'expired_cert'" in checklist_lower,
        "an expired confirmed cert must be returned as expired_cert",
    )
    assert_true(
        "count(distinct cic.item_id)" in checklist_lower,
        "shared_count must count distinct in-scope items",
    )
    assert_true(
        "round(i.done_count::numeric * 100 / i.total_count)" in checklist_lower,
        "item pct = round(done*100/total)",
    )
    assert_true(
        "when i.total_count = 0 then 100" in checklist_lower,
        "item pct is 100 when total is 0",
    )
    assert_true(
        "order by sr.pct, sr.supplier_name" in checklist_lower,
        "suppliers must be ordered by pct ascending then name",
    )
    for key in (
        "'generated_at'",
        "'days'",
        "'totals'",
        "'suppliers'",
        "'items_by_item'",
        "'requirements'",
        "'profile_source'",
        "'manufacturer_name'",
    ):
        assert_true(key in checklist_lower, f"checklist output missing {key}")
    assert_true(
        "distinct on (i.item_id)" in checklist_lower,
        "items_by_item must de-duplicate an item across suppliers",
    )
    assert_true(
        "revoke all on function public.kho_attp_checklist(integer) from public, anon" in lower
        and "grant execute on function public.kho_attp_checklist(integer) to authenticated, service_role"
        in lower,
        "checklist grants",
    )

    # --- gated RPCs ---------------------------------------------------------
    rpc_bodies = {
        "public.kho_attp_set_profile(": "public.kho_attp_set_profile(uuid, text)",
        "public.food_cert_upload_pending(": (
            "public.food_cert_upload_pending(text, text, uuid, text, text, date, date, "
            "text, text, text, jsonb, uuid[], uuid)"
        ),
        "public.food_cert_confirm(": (
            "public.food_cert_confirm(uuid, text, text, uuid, text, text, date, date, uuid[], uuid)"
        ),
        "public.food_cert_link_items(": "public.food_cert_link_items(uuid, uuid[])",
    }
    for marker, signature in rpc_bodies.items():
        body = body_after(migration, f"CREATE OR REPLACE FUNCTION {marker}")
        body_lower = body.lower()
        assert_true("security definer" in body_lower, f"{marker} must be SECURITY DEFINER")
        assert_true(
            "set search_path = public, pg_temp" in body_lower,
            f"{marker} search_path",
        )
        assert_true(
            "public.kho_item_can_edit(v_actor)" in body_lower,
            f"{marker} must use the kho editor gate",
        )
        assert_true(
            "auth.role(), '') <> 'service_role'" in body_lower,
            f"{marker} needs the service_role bypass",
        )
        assert_true(
            f"revoke all on function {signature} from public, anon" in lower,
            f"{signature} must be revoked from public/anon",
        )
        assert_true(
            f"grant execute on function {signature} to authenticated, service_role" in lower,
            f"{signature} must be granted to authenticated/service_role",
        )

    upload = body_after(migration, "CREATE OR REPLACE FUNCTION public.food_cert_upload_pending(")
    upload_lower = upload.lower()
    assert_true("review_status" in upload_lower and "'pending'" in upload_lower, "upload starts pending")
    assert_true("v_file_path not like 'certs/%'" in upload_lower, "upload file_path must stay under certs/")
    assert_true("insert into public.food_cert_item_links" in upload_lower, "upload inserts links")
    assert_true(
        "food_cert_requests" in upload_lower and "on conflict (request_id) do nothing" in upload_lower,
        "upload must be idempotent per request_id",
    )

    confirm = body_after(migration, "CREATE OR REPLACE FUNCTION public.food_cert_confirm(")
    confirm_lower = confirm.lower()
    assert_true(
        "review_status = 'confirmed'" in confirm_lower
        and "reviewed_by = v_actor" in confirm_lower
        and "reviewed_at = now()" in confirm_lower,
        "confirm must set review_status/reviewer",
    )
    for assignment in (
        "cert_type = p_cert_type",
        "owner_kind = p_owner_kind",
        "cert_no =",
        "issuer =",
        "issued_on = p_issued_on",
        "expires_on = p_expires_on",
    ):
        assert_true(assignment in confirm_lower, f"confirm must overwrite {assignment}")
    assert_true(
        "delete from public.food_cert_item_links" in confirm_lower
        and "insert into public.food_cert_item_links" in confirm_lower,
        "confirm must replace the item links",
    )

    link = body_after(migration, "CREATE OR REPLACE FUNCTION public.food_cert_link_items(")
    link_lower = link.lower()
    assert_true(
        "delete from public.food_cert_item_links" in link_lower
        and "insert into public.food_cert_item_links" in link_lower,
        "link RPC must replace the item links",
    )

    listing = body_after(migration, "CREATE OR REPLACE FUNCTION public.food_cert_list(")
    listing_lower = listing.lower()
    assert_true("security definer" in listing_lower, "food_cert_list must be SECURITY DEFINER")
    assert_true(
        "public.kho_lot_can_view(v_actor)" in listing_lower,
        "food_cert_list must keep the kho view gate",
    )
    assert_true(
        "revoke all on function public.food_cert_list(text, uuid, integer) from public, anon" in lower,
        "food_cert_list must stay revoked from public/anon",
    )

    payload = body_after(migration, "CREATE OR REPLACE FUNCTION public.food_cert_payload(")
    payload_lower = payload.lower()
    for key in (
        "'review_status'",
        "'reviewed_by'",
        "'reviewed_at'",
        "'extracted'",
        "'linked_item_ids'",
        "'linked_items'",
        "'linked_item_names'",
    ):
        assert_true(key in payload_lower, f"food_cert_payload missing {key}")
    for old_key in (
        "'owner_kind'",
        "'owner_id'",
        "'owner_name'",
        "'cert_type'",
        "'cert_no'",
        "'issuer'",
        "'issued_on'",
        "'expires_on'",
        "'days_left'",
        "'file_path'",
        "'file_name'",
        "'mime_type'",
        "'note'",
        "'created_by'",
        "'created_at'",
        "'archived_at'",
        "'archived_by'",
    ):
        assert_true(old_key in payload_lower, f"food_cert_payload dropped {old_key}")

    # --- pending reminders --------------------------------------------------
    reminder = body_after(
        migration,
        "CREATE OR REPLACE FUNCTION public.enqueue_food_cert_expiry_reminders(",
    )
    reminder_lower = reminder.lower()
    assert_true(
        "c.review_status = 'confirmed'" in reminder_lower,
        "the reminder function must skip pending certificates",
    )
    assert_true(
        "c.archived_at is null" in reminder_lower
        and "c.expires_on is not null" in reminder_lower,
        "the reminder function must keep its archived/no-expiry filters",
    )
    assert_true(
        "revoke all on function public.enqueue_food_cert_expiry_reminders(date) from public, anon"
        in lower,
        "reminder must be revoked from public/anon",
    )

    # --- no stock/ledger/payment writes ------------------------------------
    forbidden = (
        "insert into public.inventory_movements",
        "update public.inventory_movements",
        "insert into public.q7_inventory_movements",
        "update public.q7_inventory_movements",
        "insert into public.tan_tao_material_movements",
        "update public.tan_tao_material_movements",
        "insert into public.stock_ledger_entries",
        "update public.stock_ledger_entries",
        "insert into public.goods_receipts",
        "update public.goods_receipts",
        "insert into public.goods_receipt_items",
        "update public.goods_receipt_items",
        "insert into public.purchase_orders",
        "update public.purchase_orders",
        "insert into public.payment_requests",
        "update public.payment_requests",
        "insert into public.payment_allocations",
        "update public.payment_allocations",
    )
    for statement in forbidden:
        assert_true(statement not in lower, f"migration must not write {statement}")


    # --- 20261103000000: only items the business still uses ---------------
    scope_mig = read(ROOT / "supabase" / "migrations" / "20261103000000_kho_attp_active_scope.sql").lower()
    scope_fn = body_after(scope_mig, "create or replace function public.kho_attp_checklist(")
    assert_true("kii.active is true" in scope_fn, "OFF items stay excluded")
    assert_true("public.kho_attp_default_profile(kii.item_class, kii.item_type, kii.name)) <> 'none'" in scope_fn, "items needing no paper drop out")
    assert_true("ps.discontinued_at is null" in scope_fn and "cogs_ingredient_stock_map" in scope_fn, "recipe of a SKU still on sale keeps an item")
    assert_true("interval '60 days'" in scope_fn, "recent production/sales use keeps an item")
    assert_true("kii.attp_profile is not null" in scope_fn, "an owner-set paper group keeps an item")
    assert_true("revoke all on function public.kho_attp_checklist(integer) from public, anon" in scope_mig, "grants kept")

    print("test_kho_attp_contract: OK")


if __name__ == "__main__":
    main()
