#!/usr/bin/env python3
"""Static contract checks for the receipts-default-to-Tân-Tạo migration.

These checks never connect to a database or Supabase. They guard that migration
20261031150000_receipts_default_tan_tao.sql:

  * re-creates every function that fell back to 'q7' for a null
    receiving_location with the body of its newest definition, changing only the
    coalesce fallback from 'q7' to 'tan_tao'
    (get_material_alias_backlog, get_material_alias_backlog_review,
    receipt_lines_for_game_base, list_unmatched_purchase_names);
  * re-creates public.stock_ledger_default_goods_receipt_location so a receipt
    still null after the supplier default becomes 'tan_tao' and a q7 supplier
    default is coerced too, while keeping the central q7 -> tan_tao guard;
  * backfills null-location receipts (q7 when a line already posted to the Q7
    ledger, otherwise tan_tao) and writes one stock_location_moves audit row per
    changed receipt with reason 'null location → default (owner 13/10)';
  * never inserts, updates or deletes a ledger row and never runs
    'supabase db push';
  * keeps the signature and grants of every re-created function;
  * ships a rollback-only smoke that inlines the migration byte-for-byte and
    ends with the exact PASS raise.

The Maestro owns the edge-function q7 default listed in the migration header,
so the edge files are not inspected here beyond the header note.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261031150000_receipts_default_tan_tao.sql"
SMOKE = SCRIPTS / "smoke_receipts_default_tan_tao.sql"

# function name -> (newest source file, marker in that file)
SOURCES = {
    "get_material_alias_backlog": (
        MIGRATIONS / "20261025100000_alias_backlog_active_60.sql",
        "create or replace function public.get_material_alias_backlog(",
    ),
    "get_material_alias_backlog_review": (
        MIGRATIONS / "20261027100000_backlog_raw_unit.sql",
        "create function public.get_material_alias_backlog_review(",
    ),
    "receipt_lines_for_game_base": (
        MIGRATIONS / "20261028110000_receipt_lines_for_game.sql",
        "create or replace function public.receipt_lines_for_game_base(",
    ),
    "list_unmatched_purchase_names": (
        MIGRATIONS / "20261021100000_new_item_suggestions.sql",
        "create or replace function public.list_unmatched_purchase_names(",
    ),
}

MIG_MARKER = "create or replace function public.{name}("

# The only literal the re-creation may change.
OLD_FALLBACK = "s.default_receiving_location, 'q7')"
NEW_FALLBACK = "s.default_receiving_location, 'tan_tao')"

LEDGER_TABLES = (
    "q7_inventory_movements",
    "tan_tao_material_movements",
    "tan_tao_warehouse_movements",
    "tan_tao_warehouse_documents",
)

GRANTS = (
    "revoke all on function public.get_material_alias_backlog(text, integer) "
    "from public, anon, authenticated;",
    "grant execute on function public.get_material_alias_backlog(text, integer) to service_role;",
    "revoke all on function public.get_material_alias_backlog_review(text, integer) from public, anon;",
    "grant execute on function public.get_material_alias_backlog_review(text, integer) "
    "to authenticated, service_role;",
    "revoke all on function public.receipt_lines_for_game_base(integer) "
    "from public, anon, authenticated;",
    "grant execute on function public.receipt_lines_for_game_base(integer) to service_role;",
    "revoke all on function public.list_unmatched_purchase_names(text, integer) "
    "from public, anon, authenticated;",
    "grant execute on function public.list_unmatched_purchase_names(text, integer) to service_role;",
    "revoke all on function public.stock_ledger_default_goods_receipt_location() "
    "from public, anon, authenticated;",
)


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
    """Drop the create keyword and collapse whitespace for a body comparison."""
    body = re.sub(r"^create\s+(or\s+replace\s+)?function\s+", "", text.strip(), count=1, flags=re.I)
    return re.sub(r"\s+", " ", body).strip()


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261031150000_receipts_default_tan_tao.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. no q7 fallback survives anywhere ---------------------------------
    assert_true(
        "'q7')" not in migration,
        "no 'q7') fallback may remain after the migration",
    )
    assert_true(
        NEW_FALLBACK in migration,
        "the re-created functions must fall back to 'tan_tao'",
    )

    # --- 2. re-created functions match their newest definition ----------------
    for name, (source_path, source_marker) in SOURCES.items():
        mig_marker = MIG_MARKER.format(name=name)
        assert_true(mig_marker in migration, f"migration must re-create public.{name}")
        mig_def = extract_function(migration, mig_marker)
        src_def = extract_function(read(source_path), source_marker)
        assert_true(
            canon(mig_def.replace(NEW_FALLBACK, OLD_FALLBACK)) == canon(src_def),
            f"public.{name} must keep the newest definition byte-for-byte with only the fallback changed",
        )
        assert_true(
            "'q7')" not in mig_def,
            f"public.{name} must not keep a q7 fallback",
        )

    # --- 3. default-location trigger -----------------------------------------
    trig_marker = "create or replace function public.stock_ledger_default_goods_receipt_location("
    assert_true(trig_marker in migration, "migration must re-create the default-location trigger")
    trig = extract_function(migration, trig_marker).lower()
    assert_true(
        "new.receiving_location is null" in trig,
        "the default-location trigger must detect a still-null location",
    )
    assert_true(
        "new.receiving_location := 'tan_tao'" in trig,
        "the default-location trigger must default to tan_tao",
    )
    assert_true(
        "new.receiving_location = 'q7'" in trig,
        "the default-location trigger must coerce a q7 supplier default too",
    )
    assert_true(
        "goods_receipts_central_receiving_guard" in lower
        and "before insert or update of receiving_location" not in lower,
        "the central q7 -> tan_tao guard is kept in the database, not redefined here",
    )

    # --- 4. backfill writes audit rows ---------------------------------------
    assert_true(
        "insert into public.stock_location_moves" in lower,
        "backfill must write stock_location_moves audit rows",
    )
    assert_true(
        "null location → default (owner 13/10)" in migration,
        "audit rows must use the owner 13/10 reason",
    )
    assert_true(
        "set receiving_location = 'q7'" in lower and "set receiving_location = 'tan_tao'" in lower,
        "backfill must pin posted receipts to q7 and move the rest to tan_tao",
    )
    assert_true(
        "'gr-item:' || gri.id::text" in lower,
        "backfill must key on the gr-item:<id> q7 movement reference",
    )
    assert_true(
        "disable trigger goods_receipts_stock_ledger_post" in lower
        and "enable trigger goods_receipts_stock_ledger_post" in lower,
        "backfill must disable and re-enable the posting trigger",
    )
    assert_true(
        "disable trigger goods_receipts_central_receiving_guard" in lower
        and "enable trigger goods_receipts_central_receiving_guard" in lower,
        "backfill must disable and re-enable the central guard for the data move",
    )

    # --- 5. the backfill never writes a ledger row ---------------------------
    for table in LEDGER_TABLES:
        for verb in ("update", "delete"):
            pattern = rf"\b{verb}\s+(from\s+)?public\.{table}\b"
            assert_true(
                re.search(pattern, lower) is None,
                f"the migration must never {verb} public.{table}",
            )
    assert_true(
        "supabase db push" not in lower,
        "the migration must not contain 'supabase db push'",
    )

    # --- 6. grants identical to the originals --------------------------------
    for line in GRANTS:
        assert_true(line in lower, f"migration must re-issue: {line}")

    # --- 6b. the header lists the edge-function q7 default -------------------
    assert_true(
        "stock-alias-jev/store.ts" in migration and 'row.location ?? "q7"' in migration,
        "the header must list the edge-function q7 default for the Maestro",
    )

    # --- 7. smoke test --------------------------------------------------------
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
        "SMOKE_RESULT PASS: receipts default tan tao" in smoke,
        "smoke must end with the exact PASS message",
    )
    assert_true(
        smoke.rstrip().endswith("$smoke$;"),
        "smoke must end with the assertion DO block",
    )
    for step in (
        "null_location_left",
        "pinned_location",
        "audit_count",
        "audit_not_one_per_receipt",
        "audit_pinned",
        "q7_only_null_crate",
        "default_tan_tao",
        "q7_supplier_default_tan_tao",
        "ledger_counts",
        "no_owner",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} step")
    assert_true(
        "request.jwt.claims" in smoke,
        "smoke must impersonate the real owner through auth claims",
    )
    assert_true(
        "from public.user_roles" in smoke and "role::text = 'owner'" in smoke,
        "smoke must take the owner from public.user_roles",
    )

    print("PASS: receipts default Tân Tạo contracts hold")


if __name__ == "__main__":
    main()
