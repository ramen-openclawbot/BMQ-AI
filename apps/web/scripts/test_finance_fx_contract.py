#!/usr/bin/env python3
"""Static contract checks for the Finance USD / Vietcombank FX slice.

No database, network, or Supabase connection is used. The checks guard the
migration (table shape, RLS, RPC and cron), the Edge Function auth/validation,
and the pure rate parser.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102630000_finance_fx_rates.sql"
FUNCTION_DIR = ROOT / "supabase" / "functions" / "finance-fx-sync"
FUNCTION = FUNCTION_DIR / "index.ts"
RATES = FUNCTION_DIR / "rates.ts"
RATES_TEST = FUNCTION_DIR / "rates.test.ts"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def function_block(sql: str, name: str) -> tuple[str, str]:
    """Return (header, body) for a create-or-replace function using $$ quotes."""
    marker = f"function public.{name}("
    start = sql.find(marker)
    assert_true(start >= 0, f"missing function public.{name}")
    end = sql.find("$$;", start)
    assert_true(end >= 0, f"missing $$ terminator for public.{name}")
    block = sql[start:end]
    body_start = block.find("as $$")
    assert_true(body_start >= 0, f"missing AS $$ for public.{name}")
    return block[:body_start], block[body_start + len("as $$"):]


def main() -> None:
    for path in (MIGRATION, FUNCTION, RATES, RATES_TEST):
        assert_true(path.exists(), f"missing {path.relative_to(ROOT)}")

    sql = read(MIGRATION)
    lower = sql.lower()

    # --- table, RLS, read policy, grants ------------------------------------
    assert_true(
        "create table if not exists public.finance_fx_rates" in lower,
        "migration must create finance_fx_rates",
    )
    assert_true("rate_date date primary key" in lower, "rate_date must be the primary key")
    assert_true("currency text not null default 'usd'" in lower, "currency must default to USD")
    assert_true("check (currency = 'usd')" in lower, "currency must be constrained to USD")
    assert_true("vnd_per_usd numeric(12, 2) not null" in lower, "vnd_per_usd must be numeric(12,2)")
    assert_true("check (vnd_per_usd > 0)" in lower, "vnd_per_usd must be positive")
    assert_true(
        "source text not null default 'vietcombank_transfer'" in lower,
        "source must default to vietcombank_transfer",
    )
    assert_true("fetched_at timestamptz not null default now()" in lower, "fetched_at must default to now()")

    assert_true(
        "alter table public.finance_fx_rates enable row level security" in lower,
        "finance_fx_rates must enable RLS",
    )
    assert_true("create policy" not in lower, "finance_fx_rates is RPC-only: no client policy")
    assert_true(
        "revoke all on public.finance_fx_rates from public, anon, authenticated" in lower,
        "finance_fx_rates must revoke direct client access",
    )
    assert_true(
        "grant select on public.finance_fx_rates to authenticated" not in lower,
        "finance_fx_rates must not be selectable directly",
    )
    assert_true(
        "grant all on public.finance_fx_rates to service_role" in lower,
        "finance_fx_rates must be writable by service_role",
    )

    # --- monthly RPC --------------------------------------------------------
    header, body = function_block(sql, "finance_fx_monthly")
    assert_true("returns jsonb" in header.lower(), "finance_fx_monthly must return jsonb")
    assert_true("security definer" in header.lower(), "finance_fx_monthly must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in header.lower(),
        "finance_fx_monthly must pin search_path",
    )
    assert_true("p_from date" in header.lower() and "p_to date" in header.lower(), "RPC must take p_from/p_to")
    assert_true(
        "if not public.finance_can_view(auth.uid())" in body.lower(),
        "finance_fx_monthly must raise unless finance_can_view passes",
    )
    assert_true("insufficient_privilege" in body.lower(), "RPC must raise insufficient_privilege")
    assert_true("date_trunc('month', p_from)" in body.lower(), "RPC must start at the month of p_from")
    assert_true("round(avg(vnd_per_usd), 2)" in body.lower(), "RPC must round the monthly average to 2dp")
    assert_true("count(*)::integer" in body.lower(), "RPC must return the day count")
    assert_true("'month'" in body and "to_char(v_month, 'yyyy-mm')" in body.lower(), "RPC must return YYYY-MM")
    assert_true("'vnd_per_usd'" in body, "RPC must return vnd_per_usd")
    assert_true("'days'" in body, "RPC must return days")
    assert_true("'first_date'" in body and "'last_date'" in body, "RPC must return first/last dates")
    assert_true("'source'" in body, "RPC must return source")
    assert_true("rate_date <= v_month_end" in body.lower(), "RPC must cap the current month at p_to")
    assert_true(
        "grant execute on function public.finance_fx_monthly(date, date) to authenticated" in lower,
        "finance_fx_monthly must be executable by authenticated",
    )

    # --- daily cron ---------------------------------------------------------
    assert_true("'finance-fx-sync-daily'" in lower, "missing cron job finance-fx-sync-daily")
    assert_true("'15 2 * * *'" in lower, "cron must run daily at 02:15 UTC")
    assert_true("net.http_post" in lower, "cron must call the Edge Function with net.http_post")
    assert_true(
        "https://cxntbdvfsikwmitapony.supabase.co/functions/v1/finance-fx-sync" in lower,
        "cron must target the finance-fx-sync Edge Function",
    )
    assert_true(
        "finance_zalo_notification_config" in lower and "worker_secret" in lower,
        "cron must read the same worker secret as the existing finance cron",
    )

    # --- Edge Function ------------------------------------------------------
    function_ts = read(FUNCTION)
    rates_ts = read(RATES)
    edge = f"{function_ts}\n{rates_ts}"

    assert_true(
        "https://www.vietcombank.com.vn/api/exchangerates" in edge,
        "Edge Function must call the Vietcombank exchangerates API",
    )
    assert_true("currencyCode" in rates_ts and '"USD"' in rates_ts, "parser must select currencyCode USD")
    assert_true("transfer" in rates_ts, "parser must read the transfer rate")
    assert_true("15_000" in rates_ts, "parser must enforce the lower USD bound (15000)")
    assert_true("40_000" in rates_ts, "parser must enforce the upper USD bound (40000)")
    assert_true("MAX_SYNC_DAYS = 400" in rates_ts, "backfill must be capped at 400 days")
    assert_true("DEFAULT_SYNC_DAYS = 8" in rates_ts, "default sync must cover today + previous 7 days")

    assert_true("SUPABASE_SERVICE_ROLE_KEY" in function_ts, "Edge Function must require a service role key")
    assert_true("timingSafeEqual" in function_ts, "Edge Function must compare secrets safely")
    assert_true('"x-cron-secret"' in function_ts, "Edge Function must accept the cron secret")
    assert_true('"x-worker-secret"' in function_ts, "Edge Function must accept the cron worker secret")
    assert_true('"unauthorized"' in function_ts and "401" in function_ts, "Edge Function must reject unauthenticated calls")
    assert_true(
        'from("finance_fx_rates")' in function_ts and "upsert" in function_ts and 'onConflict: "rate_date"' in function_ts,
        "Edge Function must upsert finance_fx_rates by rate_date",
    )
    assert_true(
        "upserted" in function_ts and "skipped" in function_ts and "errors" in function_ts,
        "Edge Function must return {ok, upserted, skipped, errors}",
    )

    print("finance fx contract: OK")


if __name__ == "__main__":
    main()
