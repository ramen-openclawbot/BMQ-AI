#!/usr/bin/env python3
"""Static contract checks for kho lot info / shelf life / expiry overview.

No database or Supabase connection is made.  These checks guard migration
20261102850000_kho_lots_expiry.sql against schema, permission, idempotency and
ledger-posting drift, and assert that 20261102950000_kho_trace_report.sql
removes the legacy SKU shelf-life RPC/column.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102850000_kho_lots_expiry.sql"
TRACE_MIGRATION = ROOT / "supabase" / "migrations" / "20261102950000_kho_trace_report.sql"


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
        MIGRATION.name == "20261102850000_kho_lots_expiry.sql",
        "migration must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- food_manufacturers -------------------------------------------------
    assert_true(
        "create table if not exists public.food_manufacturers" in lower,
        "food_manufacturers table is required",
    )
    for column in (
        "id uuid primary key",
        "name text not null",
        "normalized_name text generated always as (public.normalize_stock_item_name(name)) stored",
        "address text",
        "tax_code text",
        "note text",
        "created_by uuid",
        "created_at timestamptz",
        "updated_at timestamptz",
        "unique (normalized_name)",
    ):
        assert_true(column in lower, f"food_manufacturers missing {column}")
    assert_true(
        "alter table public.food_manufacturers enable row level security" in lower,
        "food_manufacturers must enable RLS",
    )
    assert_true(
        "create policy food_manufacturers_select" in lower
        and "for select" in lower
        and "to authenticated" in lower,
        "food_manufacturers needs an authenticated SELECT policy",
    )
    assert_true(
        "revoke all on table public.food_manufacturers from public, anon, authenticated" in lower
        and "grant select on table public.food_manufacturers to authenticated" in lower,
        "food_manufacturers writes must stay RPC-only",
    )

    # --- lot columns --------------------------------------------------------
    receipt_alter = lower[lower.index("alter table public.goods_receipt_items"):]
    assert_true("manufacture_date date" in receipt_alter, "receipt lines need manufacture_date")
    assert_true("manufacturer_lot text" in receipt_alter, "receipt lines need manufacturer_lot")
    assert_true(
        "manufacturer_id uuid references public.food_manufacturers(id)" in receipt_alter,
        "receipt lines need manufacturer_id FK",
    )
    assert_true(
        "check (manufacturer_lot is null or char_length(manufacturer_lot) <= 60)" in lower,
        "manufacturer_lot must be capped at 60 characters",
    )
    assert_true(
        "alter table public.inventory_batches" in lower
        and "manufacturer_lot text" in lower
        and "manufacturer_id uuid references public.food_manufacturers(id)" in lower,
        "inventory_batches needs manufacturer_lot / manufacturer_id",
    )
    assert_true(
        "alter table public.kitchen_inventory_items" in lower
        and "default_manufacturer_id uuid references public.food_manufacturers(id)" in lower,
        "kitchen items need default_manufacturer_id",
    )
    assert_true(
        "alter table public.product_skus" in lower
        and "shelf_life_days integer" in lower
        and "shelf_life_days is null or shelf_life_days between 0 and 3650" in lower,
        "product_skus needs the 0..3650 shelf life check",
    )

    # --- idempotency ledger -------------------------------------------------
    assert_true(
        "create table if not exists public.kho_lot_edits" in lower,
        "kho_lot_edits log is required",
    )
    for column in (
        "request_id uuid primary key",
        "receipt_item_id uuid not null references public.goods_receipt_items(id)",
        "old_values jsonb",
        "new_values jsonb",
        "actor_id uuid",
        "created_at timestamptz",
    ):
        assert_true(column in lower, f"kho_lot_edits missing {column}")
    assert_true(
        "revoke all on table public.kho_lot_edits from public, anon, authenticated" in lower,
        "kho_lot_edits must be server-only",
    )

    # --- kho_set_receipt_line_lot ------------------------------------------
    set_lot = body_after(migration, "CREATE OR REPLACE FUNCTION public.kho_set_receipt_line_lot(")
    set_lot_lower = set_lot.lower()
    for parameter in (
        "p_receipt_item_id uuid",
        "p_manufacture_date date",
        "p_expiry_date date",
        "p_lot text",
        "p_manufacturer_name text",
        "p_request_id uuid",
    ):
        assert_true(parameter in set_lot_lower, f"kho_set_receipt_line_lot missing {parameter}")
    assert_true("returns jsonb" in set_lot_lower, "kho_set_receipt_line_lot must return jsonb")
    assert_true("security definer" in set_lot_lower, "kho_set_receipt_line_lot must be SECURITY DEFINER")
    assert_true("set search_path = public, pg_temp" in set_lot_lower, "search_path must be pinned")
    assert_true("auth.role(), '') <> 'service_role'" in set_lot_lower, "service_role bypass is required")
    assert_true(
        "public.q7_material_inventory_can_edit(v_actor)" in set_lot_lower
        and "public.has_module_permission(v_actor, 'inventory', 'edit')" in set_lot_lower,
        "lot save must use the kho edit + inventory edit gate",
    )
    assert_true(
        "p_expiry_date < p_manufacture_date" in set_lot_lower,
        "expiry before manufacture must be rejected",
    )
    assert_true(
        "insert into public.food_manufacturers" in set_lot_lower
        and "on conflict (normalized_name)" in set_lot_lower,
        "manufacturer must be upserted by normalized name",
    )
    assert_true(
        "update public.goods_receipt_items" in set_lot_lower
        and "manufacturer_lot = v_lot" in set_lot_lower,
        "all four lot fields must be written on the receipt line",
    )
    assert_true(
        "update public.inventory_batches b" in set_lot_lower
        and "where b.goods_receipt_item_id = p_receipt_item_id" in set_lot_lower,
        "lot fields must be copied to every batch of the line",
    )
    assert_true(
        "public.stock_material_aliases" in set_lot_lower
        and "a.normalized_name = public.normalize_stock_item_name(" in set_lot_lower,
        "the linked item must use the same alias match as kho_get_items",
    )
    assert_true(
        "update public.kitchen_inventory_items" in set_lot_lower
        and "default_manufacturer_id is null" in set_lot_lower,
        "the linked item default manufacturer is set only when null",
    )
    assert_true(
        "pg_advisory_xact_lock" in set_lot_lower
        and "insert into public.kho_lot_edits" in set_lot_lower
        and "on conflict (request_id) do nothing" in set_lot_lower,
        "lot save must be idempotent per request_id and logged",
    )
    assert_true(
        "replayed" in set_lot_lower and "request_id_conflict" in set_lot_lower,
        "replaying a request id must be safe and conflicts must be rejected",
    )

    # --- kho_manufacturer_suggest ------------------------------------------
    suggest = body_after(migration, "CREATE OR REPLACE FUNCTION public.kho_manufacturer_suggest(")
    suggest_lower = suggest.lower()
    assert_true("p_receipt_item_id uuid" in suggest_lower, "suggest must take a receipt item id")
    assert_true("returns jsonb" in suggest_lower, "suggest must return jsonb")
    assert_true(
        "public.q7_material_inventory_can_view(v_actor)" in suggest_lower
        and "public.kho_item_can_edit(v_actor)" in suggest_lower,
        "suggest must use the kho view gate",
    )
    assert_true(
        "kii.default_manufacturer_id" in suggest_lower,
        "suggest must read the linked item default manufacturer",
    )
    assert_true(
        "order by gr.receipt_date desc nulls last, gri.created_at desc" in suggest_lower,
        "suggest must take the latest line from the same supplier",
    )
    assert_true(
        "manufacturer_id', v_manufacturer_id" in suggest_lower,
        "suggest must return manufacturer_id",
    )

    # --- legacy shelf-life RPC + column removed -----------------------------
    # 20261102850000 introduced sku_set_shelf_life and
    # product_skus.shelf_life_days, but 20261102950000 makes
    # product_label_specs.shelf_life_days the single source.  Assert the new
    # state instead of the dropped RPC.
    trace_migration = read(TRACE_MIGRATION)
    trace_lower = trace_migration.lower()
    assert_true(
        "drop function if exists public.sku_set_shelf_life(uuid, integer, uuid)" in trace_lower,
        "the legacy sku_set_shelf_life RPC must be dropped",
    )
    assert_true(
        "product_skus_shelf_life_days_not_empty" in trace_lower
        and "raise exception" in trace_lower
        and "where ps.shelf_life_days is not null" in trace_lower,
        "dropping product_skus.shelf_life_days must be guarded by a non-null check",
    )
    assert_true(
        trace_lower.index("product_skus_shelf_life_days_not_empty")
        < trace_lower.index("drop column if exists shelf_life_days"),
        "the non-null guard must run before the column drop",
    )

    # --- kho_expiry_overview ------------------------------------------------
    overview = body_after(migration, "CREATE OR REPLACE FUNCTION public.kho_expiry_overview(")
    overview_lower = overview.lower()
    assert_true(
        "p_days integer default 30" in overview_lower,
        "kho_expiry_overview must default to 30 days",
    )
    assert_true("returns jsonb" in overview_lower, "kho_expiry_overview must return jsonb")
    assert_true(
        "b.expiry_date is not null" in overview_lower
        and "b.expiry_date <= current_date + v_days" in overview_lower,
        "overview must filter by days-to-expiry",
    )
    assert_true(
        "b.received_date >= current_date - 365" in overview_lower,
        "overview must only read lots received in the last 365 days",
    )
    for field in (
        "'batch_id'",
        "'item_id'",
        "'sku_id'",
        "'name'",
        "'kho'",
        "'receipt_number'",
        "'received_date'",
        "'quantity'",
        "'unit'",
        "'manufacture_date'",
        "'expiry_date'",
        "'days_left'",
        "'manufacturer_lot'",
        "'manufacturer_name'",
    ):
        assert_true(field in overview_lower, f"expiry overview missing {field}")
    assert_true(
        "order by x.expiry_date, x.received_date, x.batch_id" in overview_lower,
        "expiry overview must be ordered by expiry_date",
    )
    assert_true(
        "public.q7_material_inventory_can_view(v_actor)" in overview_lower
        and "public.stock_count_can_view('tan_tao')" in overview_lower,
        "expiry overview must use the kho_get_items view gate",
    )
    assert_true(
        "join public.goods_receipts gr" in overview_lower
        and "left join public.kitchen_inventory_items kii" in overview_lower
        and "left join public.product_skus ps" in overview_lower
        and "left join public.food_manufacturers fm" in overview_lower,
        "expiry overview must join receipts, items/SKUs and manufacturer",
    )

    # --- finalize copies lot fields ----------------------------------------
    finalize_marker = (
        "CREATE OR REPLACE FUNCTION public.finalize_goods_receipt_stock_payable_unchecked_20260817("
    )
    finalize = body_after(migration, finalize_marker)
    assert_true(
        "insert into public.inventory_batches" in finalize.lower(),
        "finalize redefinition must keep inserting inventory_batches",
    )
    for value in (
        "manufacture_date",
        "manufacturer_lot",
        "manufacturer_id",
        "v_item.manufacture_date",
        "v_item.manufacturer_lot",
        "v_item.manufacturer_id",
    ):
        assert_true(value in finalize, f"finalize batch insert missing {value}")
    assert_true(
        "grant execute on function public.finalize_goods_receipt_stock_payable_unchecked_20260817(uuid, uuid) to service_role"
        in lower,
        "the unchecked finalize must stay service_role-only",
    )

    # --- grants -------------------------------------------------------------
    for signature in (
        "public.kho_lot_can_view(uuid)",
        "public.kho_set_receipt_line_lot(uuid, date, date, text, text, uuid)",
        "public.kho_manufacturer_suggest(uuid)",
        "public.kho_expiry_overview(integer)",
    ):
        assert_true(
            f"grant execute on function {signature} to authenticated, service_role" in lower,
            f"missing grant for {signature}",
        )
        assert_true(
            f"revoke all on function {signature} from public, anon" in lower,
            f"missing revoke for {signature}",
        )

    # --- ledger posting stays untouched ------------------------------------
    for ledger_write in (
        "insert into public.inventory_movements",
        "update public.inventory_movements",
        "insert into public.stock_ledger_entries",
        "update public.stock_ledger_entries",
        "insert into public.q7_material_inventory_movements",
        "update public.q7_material_inventory_movements",
    ):
        assert_true(ledger_write not in lower, f"migration must not write {ledger_write}")

    print("test_kho_lots_contract: OK")


if __name__ == "__main__":
    main()
