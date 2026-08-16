#!/usr/bin/env python3
"""Compatibility entrypoint for Task 7 Q7 confirmation contracts.

Task 7 was intentionally replaced: confirmation no longer posts to the shared
kitchen ledger.  The authoritative static contracts live in
`test_q7_material_inventory_ledger.py` and assert Q7-only negative-allowed
posting with structured actuals.
"""
from __future__ import annotations

from test_q7_material_inventory_ledger import (  # noqa: F401
    test_confirm_posts_actual_quantities_to_q7_ledger_without_stock_blockers,
    test_old_monolithic_migration_removes_shared_kitchen_task7_posting,
    test_q7_ledger_schema_is_append_only_costless_negative_allowed,
    test_snapshot_receipt_opening_and_adjustment_rpcs_are_safe_and_q7_only,
    test_structured_actuals_and_service_role_finalize_contract,
)


if __name__ == "__main__":
    failures: list[str] = []
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as exc:  # noqa: BLE001
                failures.append(f"FAIL {name}: {exc}")
                print(failures[-1])
    if failures:
        raise SystemExit(1)
