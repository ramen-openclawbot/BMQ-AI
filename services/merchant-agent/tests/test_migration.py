from __future__ import annotations

import re
from pathlib import Path

MIGRATION = (
    Path(__file__).resolve().parents[3]
    / "apps"
    / "web"
    / "supabase"
    / "migrations"
    / "20261102170000_merchant_agent.sql"
)


def migration_sql() -> str:
    return MIGRATION.read_text(encoding="utf-8").lower()


def test_staged_changes_has_rls_and_owner_policy() -> None:
    sql = migration_sql()
    assert "alter table public.merchant_staged_changes enable row level security" in sql
    assert "merchant_staged_changes_owner_select" in sql
    assert "public.has_role(auth.uid(), 'owner')" in sql


def test_three_rpcs_are_service_role_only() -> None:
    sql = migration_sql()
    for signature in (
        "public.merchant_analysis_query(text, integer)",
        "public.merchant_apply_price_change(uuid)",
        "public.merchant_apply_announcement(uuid)",
    ):
        assert f"revoke all on function {signature}" in sql
        assert f"grant execute on function {signature}" in sql
    assert sql.count("to service_role;") >= 3
    assert "grant execute on function public.merchant_analysis_query" in sql
    assert "to anon" not in sql.replace("from public, anon, authenticated", "")


def test_merchant_analyst_is_limited_to_analysis_schema() -> None:
    sql = migration_sql()
    assert "create role merchant_analyst nologin" in sql
    assert "revoke all on schema public from merchant_analyst" in sql
    assert "revoke all on all tables in schema public from merchant_analyst" in sql
    assert "grant usage on schema merchant_analysis to merchant_analyst" in sql
    for view in (
        "dealer_orders_v",
        "dealer_order_lines_v",
        "revenue_lines_v",
        "skus_v",
        "dealer_prices_v",
    ):
        assert f"grant select on merchant_analysis.{view} to merchant_analyst" in sql
    assert "set local role merchant_analyst" in sql
    assert "set local search_path = merchant_analysis" in sql


def test_analysis_query_is_read_only_and_bounded() -> None:
    sql = migration_sql()
    assert "set local transaction_read_only = on" in sql
    assert "set local statement_timeout = '5s'" in sql
    assert "least(greatest(coalesce(p_max_rows, 200), 1), 1000)" in sql
    assert "information_schema" in sql
    assert "pg_" in sql
    assert "position(';' in v_body) > 0" in sql


def test_views_filter_test_and_cancelled_orders() -> None:
    sql = migration_sql()
    assert sql.count("d.is_test = false") >= 2
    assert sql.count("d.status <> 'cancelled'") >= 2
    assert "r.approval_status = 'approved'" in sql


def test_apply_rpcs_lock_and_are_idempotent() -> None:
    sql = migration_sql()
    assert sql.count("for update") >= 2
    assert sql.count("if v_change.status = 'applied' then") >= 2
    assert "merchant_apply_price_change" in sql
    assert "mini_crm_customer_price_list" in sql
    assert "dealer_announcements" in sql
