#!/usr/bin/env python3
"""
Read-only Kingfood T5 dispatch revenue audit pack.

This script only sends Supabase REST GET requests and writes local report files.
It does not rewrite revenue ledger rows, apply migrations, or perform DB writes.
"""

from __future__ import annotations

import csv
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any


PERIOD = os.environ.get("BMQ_AUDIT_PERIOD", "2026-05")
OUT_DIR = Path(os.environ.get("BMQ_AUDIT_OUT_DIR", f"/tmp/bmq_kingfood_t5_audit_{date.today():%Y%m%d}"))


def env(name: str) -> str | None:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else None


def supabase_get(url: str, key: str, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
    query = urllib.parse.urlencode(params, safe="(),.*->")
    request = urllib.request.Request(
        f"{url.rstrip('/')}/rest/v1/{table}?{query}",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_all(url: str, key: str, table: str, params: dict[str, str], page_size: int = 1000) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    start = 0
    while True:
        page_params = dict(params)
        page_params["limit"] = str(page_size)
        page_params["offset"] = str(start)
        batch = supabase_get(url, key, table, page_params)
        rows.extend(batch)
        if len(batch) < page_size:
            return rows
        start += page_size


def text_blob(row: dict[str, Any]) -> str:
    raw = row.get("raw_payload") if isinstance(row.get("raw_payload"), dict) else {}
    values = [
        row.get("from_email"),
        row.get("from_name"),
        row.get("email_subject"),
        row.get("customer_name"),
        row.get("invoice_no"),
        row.get("source_tab"),
        raw.get("from_email"),
        raw.get("email_subject"),
        raw.get("automation_rule"),
        raw.get("raw_parse_channel"),
    ]
    return " ".join(str(value or "") for value in values).lower()


def is_kingfood(row: dict[str, Any]) -> bool:
    blob = text_blob(row)
    return "kingfood" in blob or "kfm" in blob or "dathang@kingfoodmart.com" in blob


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field) for field in fields})


def main() -> int:
    url = env("SUPABASE_URL")
    key = env("SUPABASE_SERVICE_ROLE_KEY") or env("SUPABASE_ANON_KEY")
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY to run the read-only audit.", file=sys.stderr)
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    month_start = f"{PERIOD}-01"
    year, month = PERIOD.split("-")
    next_month = f"{int(year) + (1 if month == '12' else 0):04d}-{(int(month) % 12) + 1:02d}-01"

    po_rows = fetch_all(url, key, "customer_po_inbox", {
        "select": "id,po_number,received_at,delivery_date,from_email,from_name,email_subject,total_amount,subtotal_amount,vat_amount,production_items,raw_payload",
        "or": f"(received_at.gte.{month_start},delivery_date.gte.{month_start})",
        "order": "received_at.asc",
    })
    po_rows = [row for row in po_rows if is_kingfood(row) and (str(row.get("received_at") or row.get("delivery_date") or "") < next_month)]

    ledger_rows = fetch_all(url, key, "revenue_ledger_lines", {
        "select": "id,source_document_id,source_row_number,period,revenue_date,invoice_no,customer_name,product_name,quantity,gross_revenue,review_status,audit_status,raw_payload",
        "period": f"eq.{PERIOD}",
        "order": "revenue_date.asc",
    })
    ledger_rows = [row for row in ledger_rows if is_kingfood(row)]

    confirmation_rows = fetch_all(url, key, "po_dispatch_revenue_confirmations", {
        "select": "id,customer_po_inbox_id,warehouse_dispatch_id,po_number,revenue_date,dispatch_date,status,amount_status,ordered_qty_total,produced_qty_total,defect_qty_total,dispatched_qty_total,billable_qty_total,temporary_revenue_amount_vat_included,confirmed_revenue_amount_vat_included",
        "revenue_date": f"gte.{month_start}",
        "order": "revenue_date.asc",
    })
    po_ids = {row["id"] for row in po_rows}
    confirmation_rows = [row for row in confirmation_rows if row.get("customer_po_inbox_id") in po_ids]

    write_csv(OUT_DIR / "kingfood_t5_po_rows.csv", po_rows, [
        "id", "po_number", "received_at", "delivery_date", "from_email", "from_name", "email_subject", "total_amount", "subtotal_amount", "vat_amount",
    ])
    write_csv(OUT_DIR / "kingfood_t5_ledger_rows.csv", ledger_rows, [
        "id", "source_document_id", "source_row_number", "period", "revenue_date", "invoice_no", "customer_name", "product_name", "quantity", "gross_revenue", "review_status", "audit_status",
    ])
    write_csv(OUT_DIR / "kingfood_t5_dispatch_confirmations.csv", confirmation_rows, [
        "id", "customer_po_inbox_id", "warehouse_dispatch_id", "po_number", "revenue_date", "dispatch_date", "status", "amount_status", "ordered_qty_total", "produced_qty_total", "defect_qty_total", "dispatched_qty_total", "billable_qty_total", "temporary_revenue_amount_vat_included", "confirmed_revenue_amount_vat_included",
    ])

    po_total = sum(float(row.get("total_amount") or 0) for row in po_rows)
    ledger_total = sum(float(row.get("gross_revenue") or 0) for row in ledger_rows)
    confirmed_total = sum(float(row.get("confirmed_revenue_amount_vat_included") or 0) for row in confirmation_rows)
    needs_allocation = sum(1 for row in confirmation_rows if row.get("amount_status") == "needs_sku_allocation")

    markdown = OUT_DIR / "README.md"
    markdown.write_text(
        "\n".join([
            "# Kingfood T5 Dispatch Revenue Audit Pack",
            "",
            "**READ ONLY:** This report was generated with Supabase REST GET requests only. It does not rewrite ledger rows.",
            "",
            f"- Period: `{PERIOD}`",
            f"- Kingfood PO rows: `{len(po_rows)}`",
            f"- Kingfood ledger rows: `{len(ledger_rows)}`",
            f"- Dispatch confirmations: `{len(confirmation_rows)}`",
            f"- Confirmations needing SKU allocation: `{needs_allocation}`",
            f"- PO VAT-included total: `{po_total:,.0f}`",
            f"- Ledger gross revenue total: `{ledger_total:,.0f}`",
            f"- Confirmed dispatch revenue total: `{confirmed_total:,.0f}`",
            "",
            "Files:",
            "- `kingfood_t5_po_rows.csv`",
            "- `kingfood_t5_ledger_rows.csv`",
            "- `kingfood_t5_dispatch_confirmations.csv`",
            "",
            "Next step requires owner approval before any full-customer/month ledger revision.",
        ])
    )

    print(f"Read-only Kingfood T5 audit pack written to {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
