#!/usr/bin/env python3
"""Static regression checks for daily 23:59 Asia/Ho_Chi_Minh PO scheduler."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHED = ROOT / "supabase/functions/po-sync-scheduler-run/index.ts"
VERCEL = ROOT / "vercel.json"
MIGRATION = ROOT / "supabase/migrations/20260509035900_revenue_option4_po_schedule_2359.sql"
CONTROL = ROOT / "src/pages/FinanceRevenueControl.tsx"

scheduler = SCHED.read_text(encoding="utf-8")
vercel = VERCEL.read_text(encoding="utf-8")
migration = MIGRATION.read_text(encoding="utf-8")
control = CONTROL.read_text(encoding="utf-8")


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"missing {label}: expected to find {needle!r}"


def test_vercel_cron_runs_at_2359_vietnam_time() -> None:
    assert_contains(vercel, '"schedule": "59 16 * * *"', "23:59 Asia/Ho_Chi_Minh cron in UTC")


def test_schedule_migration_upserts_2359_local_time() -> None:
    for needle, label in [
        ("revenue_option4_po_schedule_2359", "migration marker"),
        ("'23:59'", "local run time"),
        ("'Asia/Ho_Chi_Minh'", "timezone"),
        ("on conflict (config_key) do update", "idempotent schedule upsert"),
    ]:
        assert_contains(migration, needle, label)


def test_due_logic_checks_hour_and_minute() -> None:
    for needle, label in [
        ("parseLocalRunTime", "HH:mm parser"),
        ("current.hour !== scheduled.hour || current.minute !== scheduled.minute", "minute-aware due check"),
        ("Outside scheduled minute", "skip reason mentions minute"),
        ('schedule.run_hour_local || "23:59"', "23:59 due fallback"),
    ]:
        assert_contains(scheduler, needle, label)


def test_date_window_uses_schedule_timezone() -> None:
    assert_contains(scheduler, "buildDateRange(Number(schedule.lookback_days || 1), schedule.timezone || \"Asia/Ho_Chi_Minh\")", "timezone-aware date range call")
    assert_contains(scheduler, "getDatePartsInTimeZone(now, timeZone)", "local date calculation")


def test_received_at_window_uses_local_business_day_boundaries() -> None:
    assert_contains(scheduler, "timeZoneOffsetMinutes", "timezone offset helper")
    assert_contains(scheduler, "receivedFrom", "received_at lower bound from local midnight")
    assert_contains(scheduler, "receivedTo", "received_at upper bound from local end of day")
    assert_contains(scheduler, ".gte(\"received_at\", receivedFrom)", "UTC received_at lower bound")
    assert_contains(scheduler, ".lte(\"received_at\", receivedTo)", "UTC received_at upper bound")
    assert "`${dateFrom}T00:00:00.000Z`" not in scheduler
    assert "`${dateTo}T23:59:59.999Z`" not in scheduler


def test_finance_control_defaults_to_2359() -> None:
    assert '"23:59"' in control
    assert '"06:00"' not in control


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
