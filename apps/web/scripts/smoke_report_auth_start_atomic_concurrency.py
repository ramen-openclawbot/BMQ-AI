#!/usr/bin/env python3
"""Disposable PostgreSQL smoke for atomic report-auth OTP challenge creation."""
from __future__ import annotations

import os
import threading
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase/migrations"
PHONE = "84901234567"
FUNCTION_FILE = "20260819103040_kiosk_report_otp_challenge_atomic_function.sql"
GRANT_FILE = "20260819103041_kiosk_report_otp_challenge_atomic_grants.sql"

DDL = """
create extension if not exists pgcrypto;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
end $$;
drop table if exists public.kiosk_report_otp_challenges cascade;
create table public.kiosk_report_otp_challenges (
  id uuid primary key,
  actor_type text not null default 'report_staff',
  staff_id uuid,
  delivery_staff_id uuid,
  location_id uuid,
  phone_normalized text not null,
  otp_hash text not null,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  sent_at timestamptz,
  send_provider text,
  send_status text not null default 'pending',
  send_error text,
  request_ip text,
  user_agent text,
  created_at timestamptz not null default clock_timestamp(),
  constraint kiosk_report_otp_actor_shape_check check (
    (actor_type = 'report_staff' and staff_id is not null and location_id is not null and delivery_staff_id is null)
    or
    (actor_type = 'delivery_staff' and delivery_staff_id is not null and staff_id is null and location_id is null)
  )
);
"""

CLEANUP = """
drop table if exists public.kiosk_report_otp_challenges cascade;
drop function if exists public.create_kiosk_report_otp_challenge_atomic(uuid, text, text, timestamptz, text, text, text, uuid, uuid, uuid) cascade;
"""


def read_sql(name: str) -> str:
    return (MIGRATIONS / name).read_text(encoding="utf-8")


def setup(conninfo: str) -> None:
    with psycopg.connect(conninfo, autocommit=True) as conn:
        conn.execute(DDL)
        conn.execute(read_sql(FUNCTION_FILE))
        conn.execute(read_sql(GRANT_FILE))


def cleanup(conninfo: str) -> None:
    with psycopg.connect(conninfo, autocommit=True) as conn:
        conn.execute(CLEANUP)


def concurrent_create(conninfo: str) -> list[str]:
    barrier = threading.Barrier(2)
    results: list[str] = []
    result_lock = threading.Lock()

    def worker(label: str) -> None:
        challenge_id = f"00000000-0000-0000-0000-00000000000{label}"
        try:
            with psycopg.connect(conninfo) as conn:
                conn.execute("set lock_timeout = '10s'")
                conn.execute("begin")
                barrier.wait(timeout=10)
                row = conn.execute(
                    """
                    select public.create_kiosk_report_otp_challenge_atomic(
                      %s::uuid,
                      %s,
                      repeat(%s, 64),
                      clock_timestamp() + interval '5 minutes',
                      '127.0.0.1',
                      'smoke-agent',
                      'report_staff',
                      %s::uuid,
                      %s::uuid,
                      null::uuid
                    ) ->> 'status'
                    """,
                    (
                        challenge_id,
                        PHONE,
                        str(label),
                        f"10000000-0000-0000-0000-00000000000{label}",
                        f"20000000-0000-0000-0000-00000000000{label}",
                    ),
                ).fetchone()
                conn.execute("commit")
                outcome = row[0]
        except Exception as exc:
            outcome = f"failed:{getattr(exc, 'sqlstate', type(exc).__name__)}"
        with result_lock:
            results.append(outcome)

    threads = [threading.Thread(target=worker, args=(1,)), threading.Thread(target=worker, args=(2,))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=20)
    if any(thread.is_alive() for thread in threads):
        raise AssertionError("concurrency worker hung")
    return sorted(results)


def main() -> None:
    conninfo = os.environ.get("DATABASE_URL") or os.environ.get("PGDATABASE_URL")
    if not conninfo:
        raise SystemExit("Set DATABASE_URL to a disposable PostgreSQL database.")

    setup(conninfo)
    try:
        results = concurrent_create(conninfo)
        assert results == ["cooldown", "created"], f"one_created_one_cooldown: got {results}"

        with psycopg.connect(conninfo) as conn:
            row = conn.execute(
                """
                select
                  count(*) as challenge_count,
                  count(*) filter (where send_status = 'pending') as pending_send_leases,
                  count(*) filter (where consumed_at is null) as active_challenges
                from public.kiosk_report_otp_challenges
                where phone_normalized = %s
                """,
                (PHONE,),
            ).fetchone()
        assert row == (1, 1, 1), f"one_created_one_cooldown: expected one pending active challenge, got {row}"
        print("PASS report auth-start atomic OTP challenge concurrency smoke")
    finally:
        cleanup(conninfo)


if __name__ == "__main__":
    main()
