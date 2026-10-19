"""Read-only Agent SDK tool for owner-written SQL over ``merchant_analysis``.

The owner chat model can compose one SELECT/WITH statement for procurement,
payment-request or goods-receipt questions that the direct tools do not cover.
The statement is checked and executed by ``BmqMerchantBackend`` through the
existing ``merchant_analysis_query`` RPC (read-only transaction, 5s timeout,
merchant_analyst role, bounded rows).  This module never writes and never adds a
second SQL path of its own.
"""

from __future__ import annotations

from typing import Any

from claude_agent_sdk import SdkMcpTool
from merchant_agent import MerchantSessionContext
from merchant_agent.changes import ChangeNotApplicable

from .config import Settings
from .supabase import SupabaseError
from .warehouse_tools import _compact_json, _error, _ok, _safe_tool

SQL_TOOL_NAME = "bmq_sql_query"
MAX_SQL_CHARS = 4000

SQL_TOOL_DESCRIPTION = (
    "Chạy một truy vấn SQL chỉ đọc trên schema merchant_analysis để trả lời câu "
    "hỏi dữ liệu mua hàng, đề nghị thanh toán, phiếu nhập hoặc nhà cung cấp mà "
    "các công cụ trực tiếp không phủ. Chỉ dùng SELECT/WITH, một câu lệnh, không "
    "dấu chấm phẩy; dùng tên view không kèm schema (search_path đã là "
    "merchant_analysis); ngày theo giờ Việt Nam (Asia/Ho_Chi_Minh); luôn thêm "
    "LIMIT (tối đa 1000 dòng). View và cột: "
    "dealer_orders_v(order_number, customer_id, customer_name, is_npp, status, "
    "requested_delivery_date, submitted_at, total_amount_vnd); "
    "dealer_order_lines_v(order_number, requested_delivery_date, customer_name, "
    "route_customer_name, sku_code, product_name, quantity, exchange_quantity, "
    "makeup_quantity, line_total_vnd); "
    "revenue_lines_v(revenue_date, channel, customer_name, product_name, quantity, "
    "gross_revenue, customer_payable); "
    "skus_v(id, sku_code, product_name, category, unit, selling_price, hidden, "
    "has_image); "
    "dealer_prices_v(id, customer_id, customer_name, sku_id, sku_code, "
    "price_vnd_per_unit, updated_at); "
    "purchase_orders_v(id, po_number, order_date, expected_date, status, "
    "total_amount, vat_amount, notes, supplier_id, created_at); "
    "purchase_order_lines_v(id, purchase_order_id, product_name, quantity, unit, "
    "unit_price, line_total, sku_id); "
    "suppliers_v(id, name, short_code, category, payment_terms_days, "
    "vat_included_in_price, default_receiving_location); "
    "payment_requests_v(id, request_number, title, status, payment_status, "
    "delivery_status, payment_method, payment_type, total_amount, vat_amount, "
    "paid_at, approved_at, purchase_order_id, goods_receipt_id, supplier_id, "
    "invoice_created, created_at); "
    "goods_receipts_v(id, receipt_number, receipt_date, status, payable_status, "
    "purchase_order_id, payment_request_id, supplier_id, receiving_location, "
    "total_quantity, finalized_at, created_at); "
    "goods_receipt_lines_v(id, goods_receipt_id, purchase_order_item_id, "
    "product_name, ordered_quantity, quantity, actual_quantity, unit, unit_price, "
    "line_status, variance_reason, sku_id)."
)

SQL_TOOL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "sql": {
            "type": "string",
            "description": "Một câu SELECT/WITH chỉ đọc, tối đa 4000 ký tự",
            "maxLength": MAX_SQL_CHARS,
        }
    },
    "required": ["sql"],
    "additionalProperties": False,
}


def _validate_sql(args: Any) -> str:
    if not isinstance(args, dict):
        raise ValueError("câu hỏi chưa đúng cú pháp: tham số không hợp lệ")
    unknown = set(args) - {"sql"}
    if unknown:
        raise ValueError(
            "câu hỏi chưa đúng cú pháp: trường không được hỗ trợ: "
            + ", ".join(sorted(unknown))
        )
    sql = args.get("sql")
    if not isinstance(sql, str) or not sql.strip():
        raise ValueError("câu hỏi chưa đúng cú pháp: thiếu sql")
    if len(sql) > MAX_SQL_CHARS:
        raise ValueError(
            f"truy vấn quá dài: tối đa {MAX_SQL_CHARS} ký tự, "
            f"nhận được {len(sql)}"
        )
    return sql


def _session_context(chat_session: Any) -> MerchantSessionContext:
    """Build the same context the host uses for other backend calls."""

    operator = getattr(chat_session, "operator", None) or getattr(
        chat_session, "owner_id", None
    )
    return MerchantSessionContext(
        session_id=str(getattr(chat_session, "session_id", "") or "chat"),
        merchant_id="bmq",
        operator=str(operator or "owner"),
    )


def build_sql_tools(
    chat_session: Any,
    settings: Settings,
) -> list[SdkMcpTool[Any]]:
    """Build the read-only owner-SQL tool for one chat session."""

    del settings  # Kept for the shared tool-factory signature.

    @_safe_tool(SQL_TOOL_NAME, SQL_TOOL_DESCRIPTION, SQL_TOOL_SCHEMA)
    async def sql_query_tool(args: dict[str, Any]) -> dict[str, Any]:
        try:
            sql = _validate_sql(args)
        except ValueError as exc:
            return _error(str(exc))

        try:
            table = await chat_session.backend.execute_analysis_query(
                _session_context(chat_session), sql
            )
        except ChangeNotApplicable as exc:
            return _error(f"Truy vấn bị từ chối: {exc}")
        except SupabaseError as exc:
            return _error(f"Lỗi cơ sở dữ liệu khi chạy truy vấn: {exc}")

        columns = list(table.columns) if table is not None else []
        rows = list(table.rows) if table is not None else []
        row_count = int(table.row_count) if table is not None else 0
        return _ok(
            _compact_json(
                {
                    "columns": columns,
                    "rows": rows,
                    "row_count": row_count,
                }
            )
        )

    return [sql_query_tool]
