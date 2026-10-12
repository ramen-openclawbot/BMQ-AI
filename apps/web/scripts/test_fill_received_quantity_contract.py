#!/usr/bin/env python3
"""Static contract checks for the fill received quantity migration.

These checks never connect to a database or Supabase. They guard that migration
20261029160000_fill_received_quantity.sql:

  * backfills only public.goods_receipt_items.actual_quantity, with the exact
    predicate (parent goods_receipts.status in ('confirmed','received'),
    actual_quantity is null, coalesce(quantity,0) = 0, ordered_quantity > 0) and
    one append-only log row per filled line (source 'backfill_2026_10_12');
  * the only tables it inserts into / updates are
    goods_receipt_quantity_fill_log and goods_receipt_items — no goods_receipts
    row, payment request, payable, VAT or JEV document is created or changed;
  * the log table is append-only (RLS on, select for authenticated goods-receipt
    viewers, insert only through the SECURITY DEFINER functions, a trigger that
    rejects update / delete, explicit grants);
  * both trigger functions are SECURITY DEFINER with a pinned search_path; the
    goods_receipt_items trigger sets actual_quantity = ordered_quantity and logs;
    the goods_receipts status trigger only touches goods_receipt_items and never
    updates goods_receipts, payment_requests or a payable / VAT / JEV table;
  * the status trigger is named so it sorts before
    goods_receipts_stock_ledger_post;
  * no pre-existing trigger on goods_receipt_items reacts to actual_quantity or
    quantity, and no goods_receipts trigger fires for an item change;
  * the migration does not contain 'supabase db push' and does not redefine the
    20261029150000 helper / readers.
It also checks the rollback-only smoke test inlines the migration and covers the
backfill, the untouched-row hashes, the money-document counts and the triggers.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261029160000_fill_received_quantity.sql"
SMOKE = SCRIPTS / "smoke_fill_received_quantity.sql"

LOG_TABLE = "public.goods_receipt_quantity_fill_log"
ITEM_FN = "create or replace function public.goods_receipt_items_fill_received_quantity("
STATUS_FN = "create or replace function public.goods_receipts_fill_received_quantity("
STATUS_TRIGGER = "a_goods_receipts_fill_received_quantity"

FORBIDDEN_WRITES = (
    r"\bupdate\s+public\.goods_receipts\b",
    r"\binsert\s+into\s+public\.goods_receipts\b",
    r"\bdelete\s+from\s+public\.goods_receipts\b",
    r"\bupdate\s+public\.payment_requests\b",
    r"\binsert\s+into\s+public\.payment_requests\b",
    r"\bdelete\s+from\s+public\.payment_requests\b",
    r"\bupdate\s+public\.payment_request_items\b",
    r"\binsert\s+into\s+public\.payment_request_items\b",
    r"\bdelete\s+from\s+public\.payment_request_items\b",
    r"\b(insert|update|delete)\b[^;]{0,120}\bpublic\.invoices\b",
    r"\b(insert|update|delete)\b[^;]{0,120}\bpublic\.invoice_items\b",
    r"\b(insert|update|delete)\b[^;]{0,120}\bpublic\.finance_jev_duplicate_checks\b",
    r"\b(insert|update|delete)\b[^;]{0,120}\bpublic\.vnagent_jev_events\b",
    r"\b(insert|update|delete)\b[^;]{0,120}\bpublic\.stock_catalog_jev_usage\b",
    r"\b(insert|update|delete)\b[^;]{0,120}\bpublic\.material_alias_jev_cache\b",
)


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


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def flat(text: str) -> str:
    return re.sub(r"\s+", "", text).lower()


def goods_receipt_item_triggers(text: str) -> list[tuple[str, str]]:
    """(trigger name, column-of list lower) for every goods_receipt_items trigger."""
    results: list[tuple[str, str]] = []
    pattern = re.compile(
        r"create\s+trigger\s+([a-z0-9_]+)"
        # stop before any other "on public." so a trigger on another table can
        # never be paired with a later goods_receipt_items definition
        r"((?:(?!\bon\s+public\.).)*?)\bon\s+public\.goods_receipt_items\b",
        re.IGNORECASE | re.DOTALL,
    )
    for match in pattern.finditer(text):
        name = match.group(1).lower()
        before_on = match.group(2)
        of_match = re.search(r"\bof\s+([a-z0-9_,\s]+)", before_on, re.IGNORECASE)
        of_list = re.sub(r"\s+", " ", of_match.group(1)).strip().lower() if of_match else ""
        results.append((name, of_list))
    return results


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261029160000_fill_received_quantity.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()
    flat_lower = flat(migration)
    prose_lower = prose(migration)

    # --- 1. the backfill writes only actual_quantity with the exact predicate --
    do_start = migration.index("do $$")
    do_end = migration.index("end $$;", do_start)
    backfill = migration[do_start:do_end]
    backfill_norm = normalize(backfill)

    assert_true(
        f"insert into {LOG_TABLE} (" in backfill_norm,
        "backfill must log every filled line",
    )
    assert_true(
        "'backfill_2026_10_12'" in backfill_norm,
        "backfill log rows must use source backfill_2026_10_12",
    )
    assert_true(
        "update public.goods_receipt_items gri "
        "set actual_quantity = gri.ordered_quantity from public.goods_receipts gr" in backfill_norm,
        "backfill must update goods_receipt_items.actual_quantity from ordered_quantity",
    )
    for needle in (
        "gr.status in ('confirmed', 'received')",
        "gri.actual_quantity is null",
        "coalesce(gri.quantity, 0) = 0",
        "gri.ordered_quantity > 0",
    ):
        assert_true(needle in backfill_norm, f"backfill predicate must contain: {needle}")

    update_match = re.search(
        r"update public\.goods_receipt_items gri(.*?);", backfill, re.IGNORECASE | re.DOTALL
    )
    assert_true(update_match is not None, "backfill update statement not found")
    update_tail = normalize(update_match.group(1))
    assert_true(
        update_tail.startswith("set actual_quantity = gri.ordered_quantity "),
        "the backfill UPDATE must set only actual_quantity",
    )
    assert_true(
        len(re.findall(r"\bset\b", update_tail)) == 1,
        "the backfill UPDATE must contain exactly one SET clause",
    )

    # --- 2. no other table is written -----------------------------------------
    inserts = set(re.findall(r"insert\s+into\s+public\.([a-z_]+)", lower))
    updates = set(re.findall(r"update\s+public\.([a-z_]+)", lower))
    deletes = set(re.findall(r"delete\s+from\s+public\.([a-z_]+)", lower))
    assert_true(
        inserts == {"goods_receipt_quantity_fill_log"},
        f"the migration may only insert into the log table, found {inserts}",
    )
    assert_true(
        updates == {"goods_receipt_items"},
        f"the migration may only update goods_receipt_items, found {updates}",
    )
    assert_true(deletes == set(), f"the migration must not delete, found {deletes}")

    # --- 3. the append-only log table, RLS, grants ----------------------------
    for needle in (
        "create table if not exists public.goods_receipt_quantity_fill_log",
        "source text not null check (source in ('backfill_2026_10_12', 'trigger'))",
        "alter table public.goods_receipt_quantity_fill_log enable row level security",
        f"create policy goods_receipt_quantity_fill_log_read on {LOG_TABLE} for select to authenticated",
        f"revoke all on {LOG_TABLE} from public, anon, authenticated;",
        f"grant select on {LOG_TABLE} to authenticated;",
        f"grant all on {LOG_TABLE} to service_role;",
        f"before update or delete on {LOG_TABLE}",
    ):
        assert_true(flat(needle) in flat_lower, f"migration must contain: {needle}")
    assert_true(
        flat(f"grant insert on {LOG_TABLE} to authenticated") not in flat_lower,
        "authenticated must not insert into the log table directly",
    )
    assert_true(
        flat("has_module_permission((select auth.uid()), 'goods_receipts', 'view')")
        in flat_lower,
        "log read policy must reuse the goods_receipts view permission",
    )

    # --- 4. both trigger functions: security definer, pinned path, no money ---
    item_header, item_body = extract_function(migration, ITEM_FN)
    status_header, status_body = extract_function(migration, STATUS_FN)

    for name, header, body in (
        ("goods_receipt_items_fill_received_quantity", item_header, item_body),
        ("goods_receipts_fill_received_quantity", status_header, status_body),
    ):
        header_norm = normalize(header)
        assert_true("returns trigger" in header_norm, f"{name} must return trigger")
        assert_true("language plpgsql" in header_norm, f"{name} must be plpgsql")
        assert_true("security definer" in header_norm, f"{name} must be SECURITY DEFINER")
        assert_true(
            "set search_path = public, pg_temp" in header_norm,
            f"{name} must pin search_path",
        )
        body_lower = body.lower()
        for pattern in FORBIDDEN_WRITES:
            assert_true(
                re.search(pattern, body_lower) is None,
                f"{name} must never write goods_receipts / payment / money docs ({pattern})",
            )

    item_norm = normalize(item_body)
    assert_true(
        "new.actual_quantity := new.ordered_quantity" in item_norm,
        "the item trigger must set actual_quantity = ordered_quantity",
    )
    assert_true(
        f"insert into {LOG_TABLE}" in item_norm
        and "'trigger'" in item_norm
        and "new_actual_quantity" in item_norm,
        "the item trigger must append a source-trigger log row",
    )
    assert_true(
        "coalesce(new.quantity, 0) <> 0" in item_norm
        and "new.actual_quantity is not null" in item_norm
        and "coalesce(new.ordered_quantity, 0) <= 0" in item_norm,
        "the item trigger must apply the exact predicate",
    )

    status_norm = normalize(status_body)
    assert_true(
        "update public.goods_receipt_items" in status_norm,
        "the status trigger must update goods_receipt_items",
    )
    assert_true(
        "set ordered_quantity = gri.ordered_quantity" in status_norm,
        "the status trigger must be a no-op touch handled by the item trigger",
    )
    assert_true(
        "new.status::text not in ('confirmed', 'received')" in status_norm,
        "the status trigger must only act on confirmed / received",
    )
    status_trigger = normalize(
        migration[
            migration.index(f"create trigger {STATUS_TRIGGER}")
            : migration.index("execute function public.goods_receipts_fill_received_quantity()")
        ]
    )
    assert_true(
        "after update of status on public.goods_receipts" in status_trigger,
        "the status trigger must be AFTER UPDATE OF status on goods_receipts",
    )
    assert_true(
        "when (old.status is distinct from new.status"
        " and new.status::text in ('confirmed', 'received'))" in status_trigger,
        "the status trigger must be guarded by the status change",
    )
    assert_true(
        STATUS_TRIGGER < "goods_receipts_stock_ledger_post",
        "the status trigger name must sort before goods_receipts_stock_ledger_post",
    )
    assert_true(
        "drop trigger if exists goods_receipts_stock_ledger_post" not in lower,
        "the migration must not touch the stock ledger trigger",
    )

    # --- 5. preserves 20261029150000 and bans 'supabase db push' --------------
    for preserved in (
        "goods_receipt_effective_quantity",
        "get_crate_receipt_lines",
        "get_item_receipt_lines",
        "post_stock_goods_receipt_item",
    ):
        assert_true(
            f"create or replace function public.{preserved}(" not in lower,
            f"the migration must not redefine {preserved}",
        )
    assert_true(
        "supabase db push" not in lower,
        "the migration must not contain 'supabase db push'",
    )

    # --- 6. header reports the leaking path and the trigger audit -------------
    for documented in (
        "ensure_purchase_order_receipt_queue",
        "ensure_payment_request_receipt_queue",
        "auto_receive_goods_receipt",
        "finalize_goods_receipt",
        "finalize_historical_paid_goods_receipt",
    ):
        assert_true(documented in lower, f"the header must report {documented}")
    assert_true(
        prose("none reacts to actual_quantity or quantity") in prose_lower,
        "the header must state no goods_receipt_items trigger watches actual_quantity / quantity",
    )
    assert_true(
        prose("none fires for a goods_receipt_items change") in prose_lower,
        "the header must state no goods_receipts trigger fires for an item change",
    )
    assert_true(
        prose("no goods_receipts row, payment request, payable, vat or jev document is created")
        in prose_lower,
        "the header must state money documents are not created or changed",
    )

    # --- 7. pre-existing triggers on goods_receipt_items are not quantity-aware
    # The latest create-trigger per name wins (migrations run in filename order),
    # so a superseded column list is ignored, matching the live definition.
    last_defs: dict[str, str] = {}
    for path in sorted(MIGRATIONS.glob("*.sql")):
        if path.resolve() == MIGRATION.resolve():
            continue
        for name, of_list in goods_receipt_item_triggers(read(path)):
            last_defs[name] = of_list
    for name, of_list in last_defs.items():
        reacts = not of_list or "actual_quantity" in of_list or re.search(
            r"\bquantity\b", of_list
        )
        assert_true(
            not reacts,
            f"pre-existing trigger {name} on goods_receipt_items"
            f" reacts to actual_quantity / quantity (of: {of_list!r})",
        )

    # --- 8. smoke test --------------------------------------------------------
    assert_true(SMOKE.exists(), f"missing smoke test {SMOKE.name}")
    smoke = read(SMOKE)
    smoke_lower = smoke.lower()
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true("rollback;" not in smoke_lower, "smoke must roll back via the final RAISE")
    assert_true("commit;" not in smoke_lower, "smoke must not commit")
    assert_true(
        migration.strip() in smoke,
        "smoke must inline the migration byte-for-byte (regenerate it when the migration changes)",
    )
    assert_true("SMOKE_RESULT PASS" in smoke, "smoke must raise SMOKE_RESULT PASS")
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL on a bad step")
    assert_true(
        "SMOKE_RESULT PASS: fill received quantity" in smoke,
        "smoke must end with the exact PASS message",
    )
    for step in (
        "backfill_log_count",
        "filled_not_ordered",
        "remaining_predicate",
        "kept_hash",
        "draft_hash",
        "gr_count",
        "pr_count",
        "confirmed_insert_actual",
        "confirmed_insert_log",
        "draft_insert_actual",
        "draft_confirm_actual",
        "draft_confirm_log",
        "log_update_allowed",
        "log_delete_allowed",
        "request.jwt.claims",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} step")
    for table in (
        "public.goods_receipts",
        "public.payment_requests",
        "public.payment_request_items",
        "public.invoices",
        "public.invoice_items",
    ):
        assert_true(table in smoke, f"smoke must snapshot {table}")
    assert_true(
        "md5(" in smoke_lower,
        "smoke must hash the untouched rows before / after",
    )

    print("PASS: fill received quantity contracts hold")


def prose(text: str) -> str:
    """Lower-case text with whitespace and comment dashes removed.

    Comment markers sit between lines, so a phrase spanning two '--' comment
    lines only matches once both the whitespace and the '--' are gone.
    """
    return re.sub(r"--+", "", re.sub(r"[\s]+", "", text.lower()))


if __name__ == "__main__":
    main()
