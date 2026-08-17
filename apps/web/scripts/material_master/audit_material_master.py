#!/usr/bin/env python3
"""Read-only Canonical NVL/material-master inventory audit utility.

Default mode reads local Supabase SQL JSON exports only and does not touch the
network. Linked Supabase reads require both --linked and --allow-linked-read.

Directory name note: this module lives under scripts/material_master/ rather
than scripts/material-master/ so Python tests and future callers can import it
without importlib path hacks caused by a hyphenated package segment.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, cast

TABLES = (
    "sku_cogs_materials",
    "sku_cogs_material_aliases",
    "sku_formulations",
    "sku_cogs_version_formulations",
    "kitchen_inventory_items",
    "product_skus",
    "supplier_product_aliases",
    "purchase_order_items",
    "payment_request_items",
    "goods_receipt_items",
    "invoice_items",
    "production_material_issue_items",
    "kfm_daily_material_issue_items",
)

SAFE_EXAMPLE_KEYS = (
    "id",
    "material_code",
    "item_code",
    "sku_code",
    "code",
    "source",
    "table",
    "canonical_name",
    "name",
    "product_name",
    "ingredient_name",
    "unit",
    "default_unit",
    "active",
)

# Use table-wide SELECTs for linked diagnostics because Task 2 intentionally has
# not added all future columns yet. The summary renderer redacts to safe example
# keys and never prints raw row payloads or secrets.
LINKED_QUERIES = {table: f"select * from public.{table};" for table in TABLES}
LINKED_READ_TIMEOUT_SECONDS = 60
LINKED_COMMAND_LABEL = "npx supabase db query --linked -o json"

TRUE_ACTIVE_VALUES = {"true", "1", "yes", "on"}
FALSE_ACTIVE_VALUES = {"false", "0", "no", "off", ""}


def normalize_vietnamese_key(value: Any) -> str:
    """Accent-insensitive deterministic Vietnamese text key for grouping."""
    if value is None:
        return ""
    text = unicodedata.normalize("NFD", str(value))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.replace("đ", "d").replace("Đ", "D").lower()
    out_chars = [ch if ch.isalnum() else " " for ch in text]
    return " ".join("".join(out_chars).split())


def truthy_active(row: dict[str, Any]) -> bool:
    if "active" not in row:
        return True
    value = row.get("active")
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    if value is None:
        return False
    text = str(value).strip().lower()
    if text in TRUE_ACTIVE_VALUES:
        return True
    if text in FALSE_ACTIVE_VALUES:
        return False
    return False


def first_present_number(row: dict[str, Any], keys: tuple[str, ...]) -> float:
    for key in keys:
        if key in row and row.get(key) is not None and str(row.get(key)).strip() != "":
            return number_value(row.get(key))
    return 0.0


def number_value(value: Any) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if value is None:
        return 0.0
    text = str(value).strip().replace(" ", "")
    if not text:
        return 0.0
    if "," in text and "." in text:
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif "," in text:
        text = text.replace(".", "").replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return 0.0


def safe_example(row: dict[str, Any]) -> dict[str, Any]:
    return {key: row.get(key) for key in SAFE_EXAMPLE_KEYS if key in row and row.get(key) not in (None, "")}


def limited_examples(rows: Iterable[dict[str, Any]], limit: int = 10) -> list[dict[str, Any]]:
    return [safe_example(row) for row in list(rows)[:limit]]


def identity_example(row: dict[str, Any], *, source: str, table: str, name_key: str, code_key: str | None) -> dict[str, Any]:
    example = {
        "source": source,
        "table": table,
        "id": row.get("id"),
        "name": row.get(name_key),
    }
    if code_key and row.get(code_key):
        example["code"] = row.get(code_key)
    if "unit" in row and row.get("unit"):
        example["unit"] = row.get("unit")
    if "default_unit" in row and row.get("default_unit"):
        example["default_unit"] = row.get("default_unit")
    return {key: value for key, value in example.items() if value not in (None, "")}


def coverage(rows: list[dict[str, Any]], key: str = "canonical_material_id") -> dict[str, Any]:
    total = len(rows)
    mapped = sum(1 for row in rows if row.get(key))
    missing = total - mapped
    percent = round(mapped * 100 / total, 2) if total else 100.0
    return {"mapped": mapped, "missing": missing, "percent": percent}


def active_count(rows: list[dict[str, Any]]) -> int:
    return sum(1 for row in rows if truthy_active(row))


def duplicate_identity_groups(entries: Iterable[tuple[str, dict[str, Any]]], limit: int = 10) -> dict[str, Any]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for key, example in entries:
        normalized = normalize_vietnamese_key(key)
        if normalized:
            groups[normalized].append(example)
    duplicates = [
        {"normalized_name": key, "count": len(rows), "examples": rows[:5]}
        for key, rows in sorted(groups.items())
        if len(rows) > 1
    ]
    return {"count": len(duplicates), "examples": duplicates[:limit]}


def combined_identity_duplicate_groups(
    materials: list[dict[str, Any]],
    kitchen_items: list[dict[str, Any]],
    raw_skus: list[dict[str, Any]],
    limit: int = 10,
) -> dict[str, Any]:
    """Find same-name identity fragmentation across root, kitchen, and raw SKU registries.

    Approved sku_cogs_material_aliases are deliberately excluded: aliases point at
    an existing canonical material and are not independent identity records.
    """
    entries: list[tuple[str, dict[str, Any]]] = []
    for row in materials:
        entries.append((
            row.get("canonical_name") or row.get("name") or "",
            identity_example(row, source="canonical_material", table="sku_cogs_materials", name_key="canonical_name", code_key="material_code"),
        ))
    for row in kitchen_items:
        entries.append((
            row.get("name") or row.get("canonical_name") or "",
            identity_example(row, source="kitchen_inventory_item", table="kitchen_inventory_items", name_key="name", code_key="item_code"),
        ))
    for row in raw_skus:
        entries.append((
            row.get("product_name") or row.get("name") or "",
            identity_example(row, source="raw_product_sku", table="product_skus", name_key="product_name", code_key="sku_code"),
        ))
    return duplicate_identity_groups(entries, limit=limit)


def kitchen_duplicate_name_groups(kitchen_items: list[dict[str, Any]], limit: int = 10) -> dict[str, Any]:
    entries = [
        (
            row.get("name") or row.get("canonical_name") or "",
            identity_example(row, source="kitchen_inventory_item", table="kitchen_inventory_items", name_key="name", code_key="item_code"),
        )
        for row in kitchen_items
    ]
    return duplicate_identity_groups(entries, limit=limit)


def raw_sku_rows(product_skus: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for row in product_skus:
        sku_type = normalize_vietnamese_key(row.get("sku_type"))
        category = normalize_vietnamese_key(row.get("category"))
        code = normalize_vietnamese_key(row.get("sku_code"))
        if sku_type in {"raw_material", "raw material", "raw", "material"} or "raw" in sku_type or "nvl" in category or code.startswith("nvl"):
            rows.append(row)
    return rows


Q7_ITEM_CODE_RE = re.compile(r"^q7(?:[-_]?\d+|[-_][a-z0-9][a-z0-9_-]*)$", re.IGNORECASE)


def is_q7_item(row: dict[str, Any]) -> bool:
    normalized_key = str(row.get("normalized_key") or "").strip().lower()
    if normalized_key.startswith("q7-material:"):
        return True
    item_code = str(row.get("item_code") or row.get("material_code") or "").strip()
    return bool(Q7_ITEM_CODE_RE.match(item_code))


def build_summary(dataset: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    materials = dataset.get("sku_cogs_materials", [])
    aliases = dataset.get("sku_cogs_material_aliases", [])
    formulations = dataset.get("sku_formulations", [])
    version_formulations = dataset.get("sku_cogs_version_formulations", [])
    kitchen_items = dataset.get("kitchen_inventory_items", [])
    product_skus = dataset.get("product_skus", [])
    raw_skus = raw_sku_rows(product_skus)
    supplier_aliases = dataset.get("supplier_product_aliases", [])

    kitchen_link_gap_rows = [row for row in kitchen_items if not (row.get("product_sku_id") or row.get("inventory_item_id") or row.get("canonical_material_id"))]
    zero_cost_rows = [row for row in kitchen_items if first_present_number(row, ("standard_unit_cost", "unit_cost", "unit_price")) == 0]

    operational_tables: dict[str, dict[str, Any]] = {}
    for table in ("purchase_order_items", "payment_request_items", "goods_receipt_items", "invoice_items"):
        rows = dataset.get(table, [])
        operational_tables[table] = {"total": len(rows), "canonical_coverage": coverage(rows)}

    historical_snapshot_tables: dict[str, dict[str, Any]] = {}
    for table in ("sku_cogs_version_formulations", "production_material_issue_items", "kfm_daily_material_issue_items"):
        rows = dataset.get(table, [])
        historical_snapshot_tables[table] = {"total": len(rows), "canonical_coverage": coverage(rows)}

    summary = {
        "source": {
            "mode": dataset.get("__source_mode", "local_or_in_memory"),
            "tables_loaded": sorted(k for k in dataset.keys() if not k.startswith("__")),
            "warnings": dataset.get("__warnings", []),
        },
        "canonical_materials": {"total": len(materials), "active": active_count(materials)},
        "active_aliases": active_count(aliases),
        "formulations": {"total": len(formulations), "canonical_coverage": coverage(formulations)},
        "versioned_formulations": {"total": len(version_formulations), "canonical_coverage": coverage(version_formulations)},
        "historical_snapshot_tables": historical_snapshot_tables,
        "kitchen_items": {
            "total": len(kitchen_items),
            "active": active_count(kitchen_items),
            "q7": sum(1 for row in kitchen_items if is_q7_item(row)),
            "non_q7": sum(1 for row in kitchen_items if not is_q7_item(row)),
        },
        "combined_identity_duplicate_name_groups": combined_identity_duplicate_groups(materials, kitchen_items, raw_skus),
        "kitchen_duplicate_name_groups": kitchen_duplicate_name_groups(kitchen_items),
        "kitchen_link_gaps": len(kitchen_link_gap_rows),
        "kitchen_link_gap_examples": limited_examples(kitchen_link_gap_rows),
        "zero_cost_items": {"count": len(zero_cost_rows), "examples": limited_examples(zero_cost_rows)},
        "raw_skus": {
            "total": len(raw_skus),
            "with_supplier": sum(1 for row in raw_skus if row.get("supplier_id")),
            "without_supplier": sum(1 for row in raw_skus if not row.get("supplier_id")),
        },
        "supplier_alias_count": active_count(supplier_aliases),
        "operational_line_tables": operational_tables,
    }
    return summary


def coerce_rows(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict):
        for key in ("data", "rows", "result"):
            if isinstance(value.get(key), list):
                return [row for row in value[key] if isinstance(row, dict)]
    return []


def read_jsonish(path: Path, *, table: str | None = None) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8") as handle:
            rows: list[dict[str, Any]] = []
            missing_cell = object()
            reader = csv.DictReader(handle, restval=cast(str, missing_cell))
            for line_number, row in enumerate(reader, start=2):
                if None in row or any(value is missing_cell for value in row.values()):
                    table_label = table or path.stem
                    raise ValueError(f"{table_label}: ragged CSV row {line_number} in {path}")
                rows.append(row)
            return rows
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return []
    if path.suffix.lower() == ".jsonl":
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    return coerce_rows(json.loads(text))


def load_export_dir(export_dir: Path) -> dict[str, list[dict[str, Any]]]:
    if not export_dir.exists() or not export_dir.is_dir():
        raise FileNotFoundError(f"Export directory does not exist: {export_dir}")
    dataset: dict[str, list[dict[str, Any]]] = {"__source_mode": "local_json_export"}  # type: ignore[dict-item]
    for table in TABLES:
        rows: list[dict[str, Any]] = []
        for suffix in (".json", ".jsonl", ".csv"):
            path = export_dir / f"{table}{suffix}"
            if path.exists():
                rows = read_jsonish(path, table=table)
                break
        dataset[table] = rows
    return dataset


def extract_supabase_json_rows(output: str) -> list[dict[str, Any]]:
    text = output.strip()
    if not text:
        return []
    value = json.loads(text)
    rows = coerce_rows(value)
    if rows:
        return rows
    if isinstance(value, list) and value and isinstance(value[0], list):
        return [row for row in value[0] if isinstance(row, dict)]
    return []


def linked_error_message(table: str, message: str) -> str:
    safe_message = " ".join(message.split())[:160]
    if safe_message:
        return f"Linked read failed for {table} via {LINKED_COMMAND_LABEL}: {safe_message}"
    return f"Linked read failed for {table} via {LINKED_COMMAND_LABEL}"


def load_linked_data(app_dir: Path) -> dict[str, list[dict[str, Any]]]:
    dataset: dict[str, list[dict[str, Any]]] = {"__source_mode": "linked_read_only", "__warnings": []}  # type: ignore[dict-item]
    warnings: list[str] = []
    for table, sql in LINKED_QUERIES.items():
        command = ["npx", "supabase", "db", "query", "--linked", "-o", "json", sql]
        try:
            completed = subprocess.run(
                command,
                cwd=str(app_dir),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=LINKED_READ_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(f"Linked read timed out after {LINKED_READ_TIMEOUT_SECONDS}s for {table} via {LINKED_COMMAND_LABEL}") from exc
        if completed.returncode != 0:
            detail = completed.stderr.strip() or completed.stdout.strip()
            if "42P01" in detail or "does not exist" in detail:
                dataset[table] = []
                warnings.append(f"{table}: missing table on linked database; reported as zero rows")
                continue
            raise RuntimeError(linked_error_message(table, f"Supabase CLI exited with code {completed.returncode}"))
        dataset[table] = extract_supabase_json_rows(completed.stdout)
    dataset["__warnings"] = warnings  # type: ignore[assignment]
    return dataset


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read-only BMQ Canonical NVL/material-master inventory audit.")
    parser.add_argument("--export-dir", type=Path, help="Directory containing table JSON/JSONL/CSV exports named <table>.json.")
    parser.add_argument("--linked", action="store_true", help="Read live linked Supabase using npx supabase db query --linked -o json (requires --allow-linked-read).")
    parser.add_argument("--allow-linked-read", action="store_true", help="Explicit safety confirmation for --linked network reads; still read-only SELECTs.")
    parser.add_argument("--app-dir", type=Path, default=Path(__file__).resolve().parents[2], help="apps/web directory for Supabase CLI linked reads.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    args = parser.parse_args(argv)
    if args.linked and not args.allow_linked_read:
        parser.error("--linked touches the network and requires explicit --allow-linked-read")
    if args.linked and args.export_dir:
        parser.error("Choose either --export-dir or --linked, not both")
    if not args.linked and not args.export_dir:
        parser.error("Default mode is offline; provide --export-dir, or use --linked --allow-linked-read explicitly")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.linked:
            dataset = load_linked_data(args.app_dir)
        else:
            dataset = load_export_dir(args.export_dir)
        summary = build_summary(dataset)
        print(json.dumps(summary, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=True))
        return 0
    except Exception as exc:  # pragma: no cover - CLI safety path
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
