#!/usr/bin/env python3
"""Validate or import the trusted April 2026 revenue ledger.

Default mode is validation only. Use --apply with Supabase service-role env vars
after review/deploy to upsert one trusted source document and idempotent ledger
lines keyed by (source_document_id, source_row_number).
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Iterable

DEFAULT_FILE = Path("/tmp/bmq_trusted_april_2026/trusted_april_revenue_ledger_lines.csv")
DEFAULT_PERIOD = "2026-04"
EXPECTED_SHA256 = "408479157dc98965465f43a4cb9307a52a3377d5e6d92de9b730f8094e2c456e"
EXPECTED_CHANNEL_TOTALS = {
    "ĐẠI LÝ": Decimal("412510000"),
    "BÁNH NGỌT": Decimal("229613570"),
    "Retail Kiosk": Decimal("164274000"),
    "B2B BMQ": Decimal("130108000"),
}
REQUIRED_HEADERS = {
    "source_row_number",
    "period",
    "revenue_date",
    "sales_channel_raw",
    "invoice_no",
    "customer_code",
    "customer_name",
    "note",
    "invoice_goods_total",
    "invoice_discount",
    "customer_payable",
    "product_name",
    "quantity",
    "unit_price",
    "gross_revenue",
    "source_type",
    "approval_status",
    "source_document",
    "channel",
    "subchannel",
    "line_check_diff",
}


@dataclass(frozen=True)
class ValidationSummary:
    rows: int
    quantity: Decimal
    gross: Decimal
    checksum: str
    channel_totals: dict[str, Decimal]
    source_document_name: str


def decimal_value(row: dict[str, str], key: str) -> Decimal:
    raw = (row.get(key) or "0").strip()
    return Decimal(raw or "0")


def read_rows(path: Path) -> tuple[list[dict[str, str]], str]:
    content = path.read_bytes()
    checksum = hashlib.sha256(content).hexdigest()
    text = content.decode("utf-8-sig")
    reader = csv.DictReader(text.splitlines())
    missing = REQUIRED_HEADERS.difference(reader.fieldnames or [])
    if missing:
        raise ValueError(f"CSV missing required headers: {', '.join(sorted(missing))}")
    return list(reader), checksum


def validate_rows(
    rows: list[dict[str, str]],
    checksum: str,
    *,
    period: str,
    expected_rows: int,
    expected_gross: Decimal,
    expected_checksum: str,
) -> ValidationSummary:
    if checksum != expected_checksum:
        raise ValueError(f"Checksum mismatch: got {checksum}, expected {expected_checksum}")
    if len(rows) != expected_rows:
        raise ValueError(f"Row count mismatch: got {len(rows)}, expected {expected_rows}")

    gross = Decimal("0")
    quantity = Decimal("0")
    channel_totals: dict[str, Decimal] = {}
    source_documents = set()
    source_row_numbers = set()

    for idx, row in enumerate(rows, start=2):
      row_period = (row.get("period") or "").strip()
      if row_period != period:
          raise ValueError(f"Row {idx} period mismatch: {row_period!r} != {period!r}")
      if (row.get("source_type") or "").strip() != "trusted_accounting_xlsx":
          raise ValueError(f"Row {idx} source_type must remain trusted_accounting_xlsx in raw CSV")
      if (row.get("approval_status") or "").strip() != "approved":
          raise ValueError(f"Row {idx} approval_status must be approved")
      row_no = int(decimal_value(row, "source_row_number"))
      if row_no in source_row_numbers:
          raise ValueError(f"Duplicate source_row_number: {row_no}")
      source_row_numbers.add(row_no)
      line_diff = decimal_value(row, "line_check_diff")
      if line_diff != 0:
          raise ValueError(f"Row {idx} line_check_diff must be zero, got {line_diff}")

      line_gross = decimal_value(row, "gross_revenue")
      line_qty = decimal_value(row, "quantity")
      gross += line_gross
      quantity += line_qty
      channel = (row.get("channel") or "unknown").strip()
      channel_totals[channel] = channel_totals.get(channel, Decimal("0")) + line_gross
      source_documents.add((row.get("source_document") or "").strip())

    if gross != expected_gross:
        raise ValueError(f"Gross mismatch: got {gross}, expected {expected_gross}")
    for channel, expected in EXPECTED_CHANNEL_TOTALS.items():
        actual = channel_totals.get(channel, Decimal("0"))
        if actual != expected:
            raise ValueError(f"Channel {channel} mismatch: got {actual}, expected {expected}")
    if len(source_documents) != 1:
        raise ValueError(f"Expected one source document, got {sorted(source_documents)}")

    return ValidationSummary(
        rows=len(rows),
        quantity=quantity,
        gross=gross,
        checksum=checksum,
        channel_totals=channel_totals,
        source_document_name=next(iter(source_documents)),
    )


def supabase_request(url: str, key: str, method: str, path: str, payload: object | None = None) -> object:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        f"{url.rstrip('/')}/rest/v1/{path}",
        data=body,
        method=method,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Prefer": "return=representation,resolution=merge-duplicates",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            text = response.read().decode("utf-8")
            return json.loads(text) if text else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase {method} {path} failed ({exc.code}): {detail}") from exc


def get_or_upsert_source_document(url: str, key: str, actor_id: str, summary: ValidationSummary, period: str) -> str:
    query = urllib.parse.urlencode({
        "source_type": "eq.csv_audit",
        "period": f"eq.{period}",
        "checksum": f"eq.{summary.checksum}",
        "select": "id",
    })
    existing = supabase_request(url, key, "GET", f"revenue_source_documents?{query}")
    if isinstance(existing, list) and existing:
        return str(existing[0]["id"])

    payload = {
        "source_type": "csv_audit",
        "source_name": f"Trusted April 2026 revenue ledger - {summary.source_document_name}",
        "period": period,
        "status": "trusted",
        "source_uri": str(DEFAULT_FILE),
        "checksum": summary.checksum,
        "summary": {
            "trusted_source_type": "trusted_accounting_xlsx",
            "rows": summary.rows,
            "quantity": str(summary.quantity),
            "gross_revenue": str(summary.gross),
            "channel_totals": {k: str(v) for k, v in sorted(summary.channel_totals.items())},
        },
        "imported_by": actor_id,
    }
    inserted = supabase_request(url, key, "POST", "revenue_source_documents", payload)
    if not isinstance(inserted, list) or not inserted:
        raise RuntimeError("Source document upsert returned no rows")
    return str(inserted[0]["id"])


def map_ledger_line(row: dict[str, str], source_document_id: str) -> dict[str, object]:
    original_payload = dict(row)
    return {
        "source_document_id": source_document_id,
        "source_row_number": int(decimal_value(row, "source_row_number")),
        "period": row["period"],
        "revenue_date": row["revenue_date"],
        "channel": row["channel"],
        "source_tab": row.get("subchannel") or None,
        "branch": row.get("sales_channel_raw") or None,
        "invoice_no": row.get("invoice_no") or None,
        "customer_code": row.get("customer_code") or None,
        "customer_name": row["customer_name"],
        "product_name": row.get("product_name") or None,
        "item_note": row.get("note") or None,
        "quantity": float(decimal_value(row, "quantity")),
        "unit_price": float(decimal_value(row, "unit_price")),
        "gross_revenue": float(decimal_value(row, "gross_revenue")),
        "order_gross": float(decimal_value(row, "invoice_goods_total")),
        "order_discount": float(decimal_value(row, "invoice_discount")),
        "customer_payable": float(decimal_value(row, "customer_payable")),
        "source_type": "csv_audit",
        "approval_status": "approved",
        "audit_status": "tied",
        "confidence_status": "trusted",
        "review_status": "not_required",
        "reconciliation_status": "csv_only",
        "source_ref": row.get("source_document") or None,
        "raw_payload": {
            "trusted_accounting_source": True,
            "original_source_type": row.get("source_type"),
            "source_document": row.get("source_document"),
            "sales_channel_raw": row.get("sales_channel_raw"),
            "subchannel": row.get("subchannel"),
            "vat": row.get("vat"),
            "line_check_diff": row.get("line_check_diff"),
            "csv_row": original_payload,
        },
    }


def chunks(values: list[dict[str, object]], size: int) -> Iterable[list[dict[str, object]]]:
    for idx in range(0, len(values), size):
        yield values[idx:idx + size]


def apply_import(rows: list[dict[str, str]], summary: ValidationSummary, period: str) -> None:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    actor_id = os.environ.get("SUPABASE_IMPORT_ACTOR_ID")
    missing = [name for name, value in {
        "SUPABASE_URL": url,
        "SUPABASE_SERVICE_ROLE_KEY": key,
        "SUPABASE_IMPORT_ACTOR_ID": actor_id,
    }.items() if not value]
    if missing:
        raise RuntimeError(f"--apply requires env vars: {', '.join(missing)}")

    document_id = get_or_upsert_source_document(url or "", key or "", actor_id or "", summary, period)
    lines = [map_ledger_line(row, document_id) for row in rows]
    for batch in chunks(lines, 500):
        supabase_request(
            url or "",
            key or "",
            "POST",
            "revenue_ledger_lines?on_conflict=source_document_id,source_row_number",
            batch,
        )
    print(f"Imported/upserted {len(lines)} trusted ledger lines into source_document_id={document_id}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, default=DEFAULT_FILE)
    parser.add_argument("--period", default=DEFAULT_PERIOD)
    parser.add_argument("--expected-rows", type=int, default=1407)
    parser.add_argument("--expected-gross", type=Decimal, default=Decimal("936505570"))
    parser.add_argument("--expected-checksum", default=EXPECTED_SHA256)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    rows, checksum = read_rows(args.file)
    summary = validate_rows(
        rows,
        checksum,
        period=args.period,
        expected_rows=args.expected_rows,
        expected_gross=args.expected_gross,
        expected_checksum=args.expected_checksum,
    )
    print(
        json.dumps(
            {
                "ok": True,
                "mode": "apply" if args.apply else "validate",
                "rows": summary.rows,
                "quantity": str(summary.quantity),
                "gross_revenue": str(summary.gross),
                "checksum": summary.checksum,
                "channel_totals": {k: str(v) for k, v in sorted(summary.channel_totals.items())},
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    if args.apply:
        apply_import(rows, summary, args.period)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
