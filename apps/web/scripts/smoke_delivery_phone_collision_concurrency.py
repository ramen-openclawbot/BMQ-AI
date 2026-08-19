#!/usr/bin/env python3
"""Disposable PostgreSQL concurrency smoke for report/dealer/delivery phone guards."""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase/migrations"
PHONE = "84901234567"
LOCK_MARKER = "pg_advisory_xact_lock(hashtextextended('public.report_actor_phone:' || coalesce(new.phone_normalized, ''), 0))"

FUNCTION_FILES = [
    "20260819103010_delivery_staff_phone_collision_function.sql",
    "20260819103020_delivery_staff_report_phone_collision_function.sql",
    "20260819103030_delivery_staff_dealer_phone_collision_function.sql",
]
TRIGGER_FILES = [
    "20260819103011_delivery_staff_phone_collision_trigger.sql",
    "20260819103021_delivery_staff_report_phone_collision_trigger.sql",
    "20260819103031_delivery_staff_dealer_phone_collision_trigger.sql",
]

DDL = """
drop table if exists public.delivery_staff cascade;
drop table if exists public.kiosk_report_staff cascade;
drop table if exists public.dealer_customer_contacts cascade;
drop function if exists public.block_delivery_staff_active_phone_collision() cascade;
drop function if exists public.block_report_staff_dealer_contact_phone() cascade;
drop function if exists public.block_dealer_contact_report_staff_phone() cascade;
create table public.delivery_staff (
  id uuid primary key default gen_random_uuid(),
  phone_normalized text,
  active boolean not null default true
);
create table public.kiosk_report_staff (
  id uuid primary key default gen_random_uuid(),
  phone_normalized text,
  active boolean not null default true,
  allow_dual_portal_access boolean not null default false
);
create table public.dealer_customer_contacts (
  id uuid primary key default gen_random_uuid(),
  phone_normalized text,
  is_active boolean not null default true,
  allow_dual_portal_access boolean not null default false
);
"""

CLEANUP = """
drop table if exists public.delivery_staff cascade;
drop table if exists public.kiosk_report_staff cascade;
drop table if exists public.dealer_customer_contacts cascade;
drop function if exists public.block_delivery_staff_active_phone_collision() cascade;
drop function if exists public.block_report_staff_dealer_contact_phone() cascade;
drop function if exists public.block_dealer_contact_report_staff_phone() cascade;
"""


def read_sql(name: str) -> str:
    source = (MIGRATIONS / name).read_text(encoding="utf-8")
    if name in FUNCTION_FILES and LOCK_MARKER not in source:
        raise AssertionError(f"{name} is missing pg_advisory_xact_lock")
    return source


def setup(conninfo: str) -> None:
    with psycopg.connect(conninfo, autocommit=True) as conn:
        conn.execute(DDL)
        for name in FUNCTION_FILES + TRIGGER_FILES:
            conn.execute(read_sql(name))


def cleanup(conninfo: str) -> None:
    with psycopg.connect(conninfo, autocommit=True) as conn:
        conn.execute(CLEANUP)


def concurrent_insert(conninfo: str, sql_a: str, sql_b: str) -> list[tuple[str, str]]:
    barrier = threading.Barrier(2)
    results: list[tuple[str, str]] = []
    result_lock = threading.Lock()

    def worker(label: str, sql: str, hold_after_insert: float) -> None:
        try:
            with psycopg.connect(conninfo) as conn:
                conn.execute("set lock_timeout = '5s'")
                conn.execute("begin")
                barrier.wait(timeout=10)
                conn.execute(sql)
                if hold_after_insert:
                    time.sleep(hold_after_insert)
                conn.execute("commit")
                outcome = "committed"
        except Exception as exc:  # expected for one loser transaction
            outcome = f"failed:{getattr(exc, 'sqlstate', type(exc).__name__)}"
        with result_lock:
            results.append((label, outcome))

    threads = [
        threading.Thread(target=worker, args=("a", sql_a, 1.0)),
        threading.Thread(target=worker, args=("b", sql_b, 0.0)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=15)
    if any(thread.is_alive() for thread in threads):
        raise AssertionError("concurrency worker hung")
    return sorted(results)


def assert_one_winner(results: list[tuple[str, str]], label: str) -> None:
    commits = [result for _, result in results if result == "committed"]
    failures = [result for _, result in results if result.startswith("failed:")]
    assert len(commits) == 1 and len(failures) == 1, f"{label}: expected one commit and one trigger failure, got {results}"


def main() -> None:
    conninfo = os.environ.get("DATABASE_URL") or os.environ.get("PGDATABASE_URL")
    if not conninfo:
        raise SystemExit("Set DATABASE_URL to a disposable PostgreSQL database.")

    setup(conninfo)
    try:
        # only_one_active_audience_commit: delivery and report cannot both commit for one active phone.
        results = concurrent_insert(
            conninfo,
            f"insert into public.delivery_staff(phone_normalized, active) values ('{PHONE}', true)",
            f"insert into public.kiosk_report_staff(phone_normalized, active) values ('{PHONE}', true)",
        )
        assert_one_winner(results, "delivery_vs_report only_one_active_audience_commit")

        with psycopg.connect(conninfo, autocommit=True) as conn:
            conn.execute("truncate public.delivery_staff, public.kiosk_report_staff, public.dealer_customer_contacts")

        results = concurrent_insert(
            conninfo,
            f"insert into public.delivery_staff(phone_normalized, active) values ('{PHONE}', true)",
            f"insert into public.dealer_customer_contacts(phone_normalized, is_active) values ('{PHONE}', true)",
        )
        assert_one_winner(results, "delivery_vs_dealer delivery_never_shares")

        with psycopg.connect(conninfo, autocommit=True) as conn:
            conn.execute("truncate public.delivery_staff, public.kiosk_report_staff, public.dealer_customer_contacts")
            # dealer_report_dual_portal_exception: kiosk/dealer can deliberately share only when both flags are true.
            conn.execute(
                f"insert into public.kiosk_report_staff(phone_normalized, active, allow_dual_portal_access) values ('{PHONE}', true, true)"
            )
            conn.execute(
                f"insert into public.dealer_customer_contacts(phone_normalized, is_active, allow_dual_portal_access) values ('{PHONE}', true, true)"
            )
            try:
                conn.execute(f"insert into public.delivery_staff(phone_normalized, active) values ('{PHONE}', true)")
            except Exception as exc:
                assert getattr(exc, "sqlstate", "") == "P0001", f"unexpected delivery denial SQLSTATE: {exc}"
            else:
                raise AssertionError("delivery_never_shares: delivery insert unexpectedly shared with dual portal phone")

        print("PASS delivery phone collision concurrency smoke")
    finally:
        cleanup(conninfo)


if __name__ == "__main__":
    main()
