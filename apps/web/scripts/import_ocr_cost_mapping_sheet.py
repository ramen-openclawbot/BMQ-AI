#!/usr/bin/env python3
"""Import reviewed OCR cost mappings from the owner Google Sheet.

Default mode is preview-only. The script can also emit an idempotent SQL seed
file for later application after the Phase 1 migration is approved/applied.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import unicodedata
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable


DEFAULT_SHEET_CSV_URL = (
    "https://docs.google.com/spreadsheets/d/"
    "1u3J6q87Svdr4IqMcP6JYPRk-p-xyBXi7egryWCPU3yA/export?format=csv&gid=0"
)
DEFAULT_SHEET_URL = (
    "https://docs.google.com/spreadsheets/d/"
    "1u3J6q87Svdr4IqMcP6JYPRk-p-xyBXi7egryWCPU3yA/edit?gid=0#gid=0"
)

COL_CATEGORY = "Phân loại chi phí"
COL_SOURCE_NAME = "Tên ingredient đã mua T5"
COL_RECOMMENDATION = "AI recommend match NVL trong COGS"
COL_SKUS = "Tên SKU có sử dụng NVL này"
COL_REVIEW = "Review"


@dataclass
class MappingDecision:
    row_number: int
    source_name: str
    source_name_key: str
    standard_cost_code_type: str | None
    standard_cost_code: str | None
    canonical_cost_item_name: str | None
    category_code: str
    product_line: str
    allocation_rule: str
    unit_conversion_note: str | None
    matched_finished_skus: list[str]
    source_review_note: str | None
    mapping_status: str
    source_sheet_url: str
    reason: str


def strip_accents(value: str) -> str:
    value = value.replace("đ", "d").replace("Đ", "D")
    normalized = unicodedata.normalize("NFD", value)
    return "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")


def collapse_ws(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def normalize_key(value: str) -> str:
    return collapse_ws(strip_accents(value).lower())


def build_code(prefix: str, name: str, fallback: str = "CHUA-DAT-TEN") -> str:
    slug = strip_accents(name or "").upper()
    slug = re.sub(r"[^A-Z0-9]+", "-", slug)
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return f"{prefix}-{slug or fallback}"


def build_material_code(name: str) -> str:
    return build_code("NVL", name)


def split_aliases(source_name: str) -> list[str]:
    aliases = []
    seen = set()
    for part in re.split(r"[;\n]+", source_name or ""):
        alias = collapse_ws(part)
        key = normalize_key(alias)
        if alias and key not in seen:
            aliases.append(alias)
            seen.add(key)
    return aliases or [collapse_ws(source_name)]


def split_skus(value: str) -> list[str]:
    raw = collapse_ws(value)
    if not raw or raw.upper() in {"N/A", "NA", "KHONG", "KHÔNG"}:
        return []
    return [collapse_ws(x) for x in re.split(r"[;\n]+", raw) if collapse_ws(x)]


def parse_canonical_recommendation(value: str) -> str | None:
    text = collapse_ws(value)
    if not text:
        return None
    upper = normalize_key(text).upper()
    if "CAN REVIEW" in upper or "CHUA MATCH" in upper or "KHONG LIEN QUAN COGS" in upper:
        return None
    if upper.startswith("REVIEW SUBSTITUTE"):
        return None
    text = re.split(r"\s*\(", text, maxsplit=1)[0]
    text = re.sub(r"^\[.*?\]\s*", "", text).strip()
    return text or None


def parse_unit_note(review_text: str, recommendation: str) -> str | None:
    combined = " ".join(x for x in [collapse_ws(review_text), collapse_ws(recommendation)] if x)
    lowered = normalize_key(combined)
    if any(token in lowered for token in ["quy doi", "1 thung", "kg", "gram", "lit", "20l", "don vi"]):
        return combined
    return None


def category_defaults(category_label: str) -> tuple[str, str, str]:
    key = normalize_key(category_label)
    if "banh mi que" in key or "banh mi lon" in key:
        return "COGS_BMQ_BREAD", "bmq_bread", "direct"
    if "bep banh ngot" in key:
        return "COGS_SWEET_KITCHEN", "sweet_kitchen", "direct"
    if "bao bi" in key or "tem nhan" in key or "vat tu ban hang" in key:
        return "PACKAGING_SALES", "shared", "manual"
    if "van hanh chung" in key:
        return "OPEX_GENERAL", "general", "none"
    if "ccdc" in key or "ve sinh" in key or "sua chua" in key or "kho bep" in key:
        return "KITCHEN_SUPPLY_REPAIR", "general", "none"
    return "UNMAPPED_REVIEW", "general", "manual"


def is_non_cogs(recommendation: str, review_text: str) -> bool:
    combined = normalize_key(f"{recommendation} {review_text}").upper()
    return any(
        token in combined
        for token in [
            "KHONG LIEN QUAN COGS",
            "KHONG DUNG DE UPDATE COGS",
            "KHONG CO TRONG COGS",
        ]
    )


def is_unresolved(recommendation: str, review_text: str) -> bool:
    combined = normalize_key(f"{recommendation} {review_text}").upper()
    unresolved_tokens = [
        "CAN REVIEW",
        "CHUA MATCH",
        "CHUA CO NVL",
        "DANG TEST",
        "KE TOAN CHECK",
        "KE TOAN REVIEW",
        "CHECK LAI",
        "REVIEW LAI",
    ]
    return any(token in combined for token in unresolved_tokens)


def canonical_from_review(review_text: str) -> str | None:
    match = re.search(r"t[eê]n\s+nvl\s+l[aà]\s+([^.;]+)", review_text or "", flags=re.IGNORECASE)
    if match:
        return collapse_ws(match.group(1))
    return None


def standard_type_for_non_cogs(category_code: str) -> str:
    return "OPEX" if category_code == "OPEX_GENERAL" else "OTHER"


def decide_row(row: dict[str, str], row_number: int, sheet_url: str) -> list[MappingDecision]:
    category_label = row.get(COL_CATEGORY, "")
    source_name = collapse_ws(row.get(COL_SOURCE_NAME, ""))
    recommendation = collapse_ws(row.get(COL_RECOMMENDATION, ""))
    review_text = collapse_ws(row.get(COL_REVIEW, ""))
    category_code, product_line, allocation_rule = category_defaults(category_label)
    skus = split_skus(row.get(COL_SKUS, ""))
    unit_note = parse_unit_note(review_text, recommendation)

    aliases = split_aliases(source_name)
    decisions: list[MappingDecision] = []

    if not source_name:
        return decisions

    if is_unresolved(recommendation, review_text):
        canonical = source_name
        code_type = None
        code = None
        category_code = "UNMAPPED_REVIEW"
        product_line = "general"
        allocation_rule = "manual"
        status = "needs_review"
        reason = "unresolved owner review/comment"
    elif is_non_cogs(recommendation, review_text):
        canonical = canonical_from_review(review_text) or source_name
        code_type = standard_type_for_non_cogs(category_code)
        code = build_code(code_type, canonical)
        status = "approved"
        reason = "owner-reviewed non-COGS mapping"
    else:
        canonical = parse_canonical_recommendation(recommendation)
        if canonical:
            code_type = "NVL"
            code = build_material_code(canonical)
            status = "approved"
            reason = "approved NVL recommendation"
        else:
            canonical = source_name
            code_type = None
            code = None
            category_code = "UNMAPPED_REVIEW"
            product_line = "general"
            allocation_rule = "manual"
            status = "needs_review"
            reason = "no deterministic standard code"

    for alias in aliases:
        decisions.append(
            MappingDecision(
                row_number=row_number,
                source_name=alias,
                source_name_key=normalize_key(alias),
                standard_cost_code_type=code_type,
                standard_cost_code=code,
                canonical_cost_item_name=canonical,
                category_code=category_code,
                product_line=product_line,
                allocation_rule=allocation_rule,
                unit_conversion_note=unit_note,
                matched_finished_skus=skus,
                source_review_note=review_text or None,
                mapping_status=status,
                source_sheet_url=sheet_url,
                reason=reason,
            )
        )

    return decisions


def fetch_csv(url: str) -> list[dict[str, str]]:
    with urllib.request.urlopen(url, timeout=30) as response:
        content = response.read().decode("utf-8-sig")
    return list(csv.DictReader(content.splitlines()))


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def summarize(rows: list[dict[str, str]], decisions: list[MappingDecision]) -> dict[str, object]:
    approved = [d for d in decisions if d.mapping_status == "approved"]
    needs_review = [d for d in decisions if d.mapping_status == "needs_review"]
    return {
        "source_rows": len(rows),
        "blank_review_rows": sum(1 for row in rows if not collapse_ws(row.get(COL_REVIEW, ""))),
        "comment_review_rows": sum(1 for row in rows if collapse_ws(row.get(COL_REVIEW, ""))),
        "alias_decisions": len(decisions),
        "approved_aliases": len(approved),
        "needs_review_aliases": len(needs_review),
        "approved_by_type": {
            code_type: sum(1 for d in approved if d.standard_cost_code_type == code_type)
            for code_type in sorted({d.standard_cost_code_type for d in approved if d.standard_cost_code_type})
        },
    }


def sql_literal(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, list):
        return "array[" + ", ".join(sql_literal(x) for x in value) + "]::text[]"
    return "'" + str(value).replace("'", "''") + "'"


def render_seed_sql(decisions: Iterable[MappingDecision]) -> str:
    rows = [d for d in decisions if d.mapping_status == "approved"]
    columns = [
        "source_name",
        "source_name_key",
        "standard_cost_code_type",
        "standard_cost_code",
        "canonical_cost_item_name",
        "category_code",
        "product_line",
        "allocation_rule",
        "unit_conversion_note",
        "matched_finished_skus",
        "source_sheet_url",
        "source_review_note",
        "mapping_status",
        "active",
    ]
    lines = [
        "-- Generated by apps/web/scripts/import_ocr_cost_mapping_sheet.py",
        "-- Preview-only artifact. Review before applying to Supabase.",
        "insert into public.cost_item_alias_mappings (",
        "  " + ",\n  ".join(columns),
        ") values",
    ]
    value_lines = []
    for d in rows:
        values = [
            d.source_name,
            d.source_name_key,
            d.standard_cost_code_type,
            d.standard_cost_code,
            d.canonical_cost_item_name,
            d.category_code,
            d.product_line,
            d.allocation_rule,
            d.unit_conversion_note,
            d.matched_finished_skus,
            d.source_sheet_url,
            d.source_review_note,
            d.mapping_status,
            "true",
        ]
        rendered = []
        for column, value in zip(columns, values):
            if column == "active":
                rendered.append("true")
            elif column == "matched_finished_skus":
                rendered.append(sql_literal(value))
            else:
                rendered.append(sql_literal(value))
        value_lines.append("  (" + ", ".join(rendered) + ")")
    lines.append(",\n".join(value_lines) + "\n" if value_lines else "")
    lines.append(
        "on conflict (source_name_key, coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid), standard_cost_code_type, standard_cost_code)"
    )
    lines.append("where active")
    lines.append("do update set")
    lines.append("  source_name = excluded.source_name,")
    lines.append("  canonical_cost_item_name = excluded.canonical_cost_item_name,")
    lines.append("  category_code = excluded.category_code,")
    lines.append("  product_line = excluded.product_line,")
    lines.append("  allocation_rule = excluded.allocation_rule,")
    lines.append("  unit_conversion_note = excluded.unit_conversion_note,")
    lines.append("  matched_finished_skus = excluded.matched_finished_skus,")
    lines.append("  source_sheet_url = excluded.source_sheet_url,")
    lines.append("  source_review_note = excluded.source_review_note,")
    lines.append("  mapping_status = excluded.mapping_status,")
    lines.append("  active = excluded.active;")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, help="Read a local CSV instead of fetching the Google Sheet.")
    parser.add_argument("--sheet-csv-url", default=DEFAULT_SHEET_CSV_URL)
    parser.add_argument("--sheet-url", default=DEFAULT_SHEET_URL)
    parser.add_argument("--json-out", type=Path, help="Write preview JSON.")
    parser.add_argument("--sql-out", type=Path, help="Write approved-mapping SQL seed preview.")
    parser.add_argument("--limit-examples", type=int, default=10)
    args = parser.parse_args()

    rows = read_csv(args.csv) if args.csv else fetch_csv(args.sheet_csv_url)
    decisions = []
    for index, row in enumerate(rows, start=2):
        decisions.extend(decide_row(row, index, args.sheet_url))

    summary = summarize(rows, decisions)
    preview = {
        "summary": summary,
        "approved_examples": [asdict(d) for d in decisions if d.mapping_status == "approved"][: args.limit_examples],
        "needs_review_examples": [asdict(d) for d in decisions if d.mapping_status == "needs_review"][: args.limit_examples],
        "approved_mappings": [asdict(d) for d in decisions if d.mapping_status == "approved"],
        "needs_review": [asdict(d) for d in decisions if d.mapping_status == "needs_review"],
    }

    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(preview, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.sql_out:
        args.sql_out.parent.mkdir(parents=True, exist_ok=True)
        args.sql_out.write_text(render_seed_sql(decisions), encoding="utf-8")

    json.dump(summary, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
