from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from bmq_merchant.backend import BmqMerchantBackend
from bmq_merchant.config import Settings
from bmq_merchant.sql_tools import (
    MAX_SQL_CHARS,
    SQL_TOOL_DESCRIPTION,
    build_sql_tools,
)
from bmq_merchant.supabase import SupabaseError

ANALYSIS_VIEWS = (
    "dealer_orders_v",
    "dealer_order_lines_v",
    "revenue_lines_v",
    "skus_v",
    "dealer_prices_v",
    "purchase_orders_v",
    "purchase_order_lines_v",
    "suppliers_v",
    "payment_requests_v",
    "goods_receipts_v",
    "goods_receipt_lines_v",
)


def _chat_session(backend: Any) -> SimpleNamespace:
    return SimpleNamespace(
        owner_token="",
        pending_ui=[],
        backend=backend,
        session_id="session-sql",
        owner_id="owner@bmq.vn",
    )


def _tool(backend: Any, settings: Settings) -> Any:
    return build_sql_tools(_chat_session(backend), settings)[0]


def _text(result: dict[str, Any]) -> str:
    return result["content"][0]["text"]


class FakeTable:
    columns = ["po_number", "total_amount"]
    rows = [["PO-1", 100], ["PO-2", 250]]
    row_count = 2


class FakeBackend:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, str]] = []

    async def execute_analysis_query(self, session: Any, sql: str) -> FakeTable:
        self.calls.append((session, sql))
        return FakeTable()


class NoRpcSupabase:
    """The guard must refuse the statement before any RPC is attempted."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    async def rpc(self, function: str, payload: Any = None) -> Any:
        self.calls.append((function, payload))
        raise AssertionError("RPC must not run for a refused statement")


class RpcErrorSupabase:
    async def rpc(self, function: str, payload: Any = None) -> Any:
        raise SupabaseError('Supabase 400: column "po_nuber" does not exist')


class UnexpectedBackend:
    def __init__(self) -> None:
        self.called = False

    async def execute_analysis_query(self, session: Any, sql: str) -> Any:
        self.called = True
        raise AssertionError("invalid input must not reach the backend")


def test_description_lists_every_analysis_view() -> None:
    for view in ANALYSIS_VIEWS:
        assert view in SQL_TOOL_DESCRIPTION


async def test_successful_query_returns_columns_rows_and_count(
    settings: Settings,
) -> None:
    backend = FakeBackend()
    sql = (
        "select po_number, total_amount from purchase_orders_v "
        "order by order_date desc limit 10"
    )

    result = await _tool(backend, settings).handler({"sql": sql})

    assert "is_error" not in result
    assert json.loads(_text(result)) == {
        "columns": ["po_number", "total_amount"],
        "rows": [["PO-1", 100], ["PO-2", 250]],
        "row_count": 2,
    }
    assert len(backend.calls) == 1
    session, called_sql = backend.calls[0]
    assert called_sql == sql
    assert session.session_id == "session-sql"
    assert session.merchant_id == "bmq"
    assert session.operator == "owner@bmq.vn"


@pytest.mark.parametrize(
    "sql",
    [
        "insert into purchase_orders_v (po_number) values ('PO-X')",
        "update purchase_orders_v set status = 'cancelled'",
        "delete from purchase_orders_v",
    ],
)
async def test_write_statement_is_refused_by_the_real_guard(
    settings: Settings, sql: str
) -> None:
    supabase = NoRpcSupabase()
    backend = BmqMerchantBackend(supabase, settings.merchant_config())

    result = await _tool(backend, settings).handler({"sql": sql})

    assert result["is_error"] is True
    assert "Truy vấn không hợp lệ" in _text(result)
    assert supabase.calls == []


async def test_rpc_error_surfaces_with_the_database_message(
    settings: Settings,
) -> None:
    backend = BmqMerchantBackend(RpcErrorSupabase(), settings.merchant_config())

    result = await _tool(backend, settings).handler(
        {"sql": "select po_nuber from purchase_orders_v limit 5"}
    )

    assert result["is_error"] is True
    assert 'column "po_nuber" does not exist' in _text(result)


async def test_sql_longer_than_limit_is_rejected(settings: Settings) -> None:
    backend = UnexpectedBackend()
    sql = "select * from purchase_orders_v limit 1 -- " + ("x" * MAX_SQL_CHARS)

    result = await _tool(backend, settings).handler({"sql": sql})

    assert result["is_error"] is True
    assert str(MAX_SQL_CHARS) in _text(result)
    assert backend.called is False
