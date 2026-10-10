#!/usr/bin/env python3
"""Static contract for the 2026-10-14 Q7 auto-purchase migration.

Checks that every new function is a fixed-search_path security definer, that the
new tables carry RLS and explicit grants, that the flow is OFF / suggest by
default, that the only 'sent' transition goes through the existing material
controller RPC after the max_po_amount / max_daily_amount gates, that payable /
receipt tables are never written directly, that no existing function is
redefined, and that both cron jobs are scheduled.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_PATH = ROOT / "supabase/migrations/20261014100000_q7_auto_purchase.sql"
MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
LOWER = MIGRATION.lower()

FUNCTION_RE = re.compile(
    r"create\s+or\s+replace\s+function\s+public\.(?P<name>[a-z0-9_]+)\s*\(",
    re.IGNORECASE,
)


def function_block(name: str) -> str:
    match = re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
        MIGRATION,
        re.IGNORECASE,
    )
    assert match, f"missing function public.{name}"
    tail = MIGRATION[match.start():]
    end = tail.find("\n$$;")
    assert end != -1, f"unterminated function public.{name}"
    return tail[:end]


NEW_FUNCTIONS = [
    "q7_reason_label",
    "q7_pack_from_name",
    "q7_purchase_daily_usage",
    "get_q7_purchase_forecast",
    "q7_backtest_relative_error",
    "learn_q7_purchase_parameters",
    "build_q7_auto_purchase_order_message",
    "build_q7_auto_purchase_summary_message",
    "run_q7_auto_purchase",
    "get_q7_auto_purchase_status",
    "upsert_q7_purchase_item_setting",
    "update_q7_auto_purchase_settings",
    "run_q7_auto_purchase_now",
    "create_q7_draft_purchase_orders",
]

print("== security definer + pinned search_path ==")
for name in NEW_FUNCTIONS:
    block = function_block(name)
    lowered = block.lower()
    assert "security definer" in lowered, f"{name} must be security definer"
    assert "set search_path" in lowered, f"{name} must pin search_path"
    occurrences = len(
        re.findall(
            rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
            MIGRATION,
            re.IGNORECASE,
        )
    )
    assert occurrences == 1, f"{name} is defined {occurrences} times"

print("== no existing function is redefined ==")
EXISTING_FUNCTIONS = [
    "update_purchase_order_status_with_material_controller",
    "normalize_stock_item_name",
    "get_q7_inventory_snapshot",
    "get_stock_ledger_overview",
    "record_q7_stock_count",
    "post_material_issue_usage",
    "finance_format_vnd",
    "enqueue_finance_zalo_goods_receipt",
    "claim_finance_zalo_notifications",
]
for name in EXISTING_FUNCTIONS:
    assert not re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
        MIGRATION,
        re.IGNORECASE,
    ), f"{name} must not be redefined"

# Every function actually defined here must be in the new-function list.
defined = {match.group("name").lower() for match in FUNCTION_RE.finditer(MIGRATION)}
assert defined == {name.lower() for name in NEW_FUNCTIONS}, (
    f"unexpected function definitions: {sorted(defined)}"
)

print("== RLS + grants on new tables ==")
NEW_TABLES = [
    "q7_auto_purchase_settings",
    "q7_purchase_item_settings",
    "q7_auto_purchase_runs",
    "q7_auto_purchase_decisions",
    "q7_auto_purchase_idempotency",
]
for table in NEW_TABLES:
    assert re.search(
        rf"alter\s+table\s+public\.{table}\s+enable\s+row\s+level\s+security",
        MIGRATION,
        re.IGNORECASE,
    ), f"RLS must be enabled on {table}"
    assert re.search(
        rf"grant\s+[a-z, ]+\s+on\s+table\s+public\.{table}\s+to\s+",
        MIGRATION,
        re.IGNORECASE,
    ), f"explicit grant missing for {table}"

assert "q7_material_inventory_can_view" in MIGRATION
assert "q7_material_inventory_can_edit" in MIGRATION
assert "has_role((select auth.uid()), 'owner')" in MIGRATION

print("== default-off and default-suggest ==")
assert re.search(
    r"enabled\s+boolean\s+not\s+null\s+default\s+false", LOWER
), "enabled must default false"
assert re.search(
    r"mode\s+text\s+not\s+null\s+default\s+'suggest'", LOWER
), "mode must default 'suggest'"
assert "q7_auto_purchase_settings_enabled_actor_check" in MIGRATION

print("== run only sends through the material controller after the limits ==")
run_block = function_block("run_q7_auto_purchase")
assert "update_purchase_order_status_with_material_controller" in run_block
assert "max_po_amount" in run_block
assert "max_daily_amount" in run_block
assert "'sent'" in run_block
# No direct status write to 'sent'.
assert not re.search(r"set\s+status\s*=\s*'sent'", run_block, re.IGNORECASE)
assert "public.purchase_orders" in run_block

print("== payable / receipt tables are never written ==")
for table in ("payment_requests", "goods_receipts", "payment_allocations"):
    assert not re.search(
        rf"\b(update|delete\s+from)\s+(public\.)?{table}\b", LOWER
    ), f"migration must not write {table} directly"

print("== unique run_date and idempotent run ==")
assert re.search(r"run_date\s+date\s+not\s+null\s+unique", LOWER), "run_date must be unique"
assert "on conflict (run_date) do nothing" in LOWER
assert "on conflict (event_type, entity_id) do nothing" in LOWER

print("== cron schedules ==")
assert "q7-auto-purchase-daily" in MIGRATION
assert "q7-auto-purchase-learn-weekly" in MIGRATION
assert "0 23 * * *" in MIGRATION
assert "30 22 * * 0" in MIGRATION
assert "cron.unschedule" in LOWER
assert "cron.schedule" in LOWER

print("== zalo event types ==")
for event_type in ("auto_purchase_order_sent", "auto_purchase_daily_summary"):
    assert f"'{event_type}'" in MIGRATION, f"missing zalo event type {event_type}"

print("q7 auto purchase contract passed")
