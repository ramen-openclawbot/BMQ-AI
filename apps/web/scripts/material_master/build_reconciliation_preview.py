#!/usr/bin/env python3
"""Build deterministic Canonical NVL reconciliation preview artifacts.

Default mode is offline/local-export only. Linked Supabase reads require both
--linked and --allow-linked-read and are SELECT-only with bounded timeout. The
artifact is staging evidence only: it never mutates canonical, kitchen, SKU, Q7,
price, or historical ledger rows.
"""
from __future__ import annotations

import argparse
import csv
import difflib
import json
import re
import subprocess
import sys
import unicodedata
import uuid
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable, cast

SCHEMA_VERSION = "material_reconciliation_preview.v1"
DEFAULT_AS_OF_DATE = "2026-08-17"
LINKED_READ_TIMEOUT_SECONDS = 60
TABLES = (
    "sku_cogs_materials",
    "sku_cogs_material_aliases",
    "material_scoped_aliases",
    "material_unit_conversions",
    "kitchen_inventory_items",
    "product_skus",
    "supplier_product_aliases",
    "material_supplier_products",
)
LINKED_QUERIES = {table: f"select * from public.{table};" for table in TABLES}
APPROVED_GLOBAL_ALIAS_SOURCES = {"approved", "approved_global_alias", "approved_peerless_alias", "existing_cogs", "canonical_name"}
TRUE_VALUES = {"true", "1", "yes", "on"}
FALSE_VALUES = {"false", "0", "no", "off", ""}
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def normalize_vietnamese_key(value: Any) -> str:
    if value is None:
        return ""
    text = unicodedata.normalize("NFD", str(value))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.replace("đ", "d").replace("Đ", "D").lower()
    return " ".join("".join(ch if ch.isalnum() else " " for ch in text).split())


def normalized_unit(value: Any) -> str:
    return normalize_vietnamese_key(value)


def truthy_active(row: dict[str, Any], key: str = "active", default: bool = True) -> bool:
    if key not in row:
        return default
    value = row.get(key)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    if value is None:
        return False
    text = str(value).strip().lower()
    if text in TRUE_VALUES:
        return True
    if text in FALSE_VALUES:
        return False
    return False


def is_uuid(value: Any) -> bool:
    return isinstance(value, str) and bool(UUID_RE.match(value.strip()))


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
            missing_cell = object()
            reader = csv.DictReader(handle, restval=cast(str, missing_cell))
            rows: list[dict[str, Any]] = []
            for line_number, row in enumerate(reader, start=2):
                if None in row or any(value is missing_cell for value in row.values()):
                    raise ValueError(f"{table or path.stem}: ragged CSV row {line_number} in {path}")
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
    value = json.loads(output.strip() or "[]")
    rows = coerce_rows(value)
    if rows:
        return rows
    if isinstance(value, list) and value and isinstance(value[0], list):
        return [row for row in value[0] if isinstance(row, dict)]
    return []


def load_linked_data(app_dir: Path) -> dict[str, list[dict[str, Any]]]:
    dataset: dict[str, list[dict[str, Any]]] = {"__source_mode": "linked_read_only", "__warnings": []}  # type: ignore[dict-item]
    warnings: list[str] = []
    for table, sql in LINKED_QUERIES.items():
        command = ["npx", "supabase", "db", "query", "--linked", "-o", "json", sql]
        try:
            completed = subprocess.run(command, cwd=str(app_dir), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=LINKED_READ_TIMEOUT_SECONDS, check=False)
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(f"Linked read timed out after {LINKED_READ_TIMEOUT_SECONDS}s for {table}") from exc
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "").lower()
            if "42p01" in detail or "does not exist" in detail:
                dataset[table] = []
                warnings.append(f"{table}: missing table on linked database; reported as zero rows")
                continue
            raise RuntimeError(f"Linked read failed for {table}: Supabase CLI exited with code {completed.returncode}")
        dataset[table] = extract_supabase_json_rows(completed.stdout)
    dataset["__warnings"] = warnings  # type: ignore[assignment]
    return dataset


def raw_sku_rows(product_skus: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in product_skus:
        sku_type = normalize_vietnamese_key(row.get("sku_type"))
        category = normalize_vietnamese_key(row.get("category"))
        code = normalize_vietnamese_key(row.get("sku_code") or row.get("product_code"))
        if sku_type in {"raw_material", "raw material", "raw", "material"} or "raw" in sku_type or "nvl" in category or code.startswith("nvl"):
            rows.append(row)
    return rows


def safe_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def safe_uuid(value: Any) -> str | None:
    text = safe_str(value)
    if text and is_uuid(text):
        return str(uuid.UUID(text))
    return None


def current_on_date(row: dict[str, Any], as_of_date: str) -> bool:
    start = safe_str(row.get("effective_from"))
    end = safe_str(row.get("effective_to"))
    if start and start > as_of_date:
        return False
    if end and end < as_of_date:
        return False
    return True


def canonical_materials(dataset: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    materials = []
    for row in dataset.get("sku_cogs_materials", []):
        mid = safe_uuid(row.get("id"))
        if not mid:
            continue
        name = safe_str(row.get("canonical_name") or row.get("name"))
        code = safe_str(row.get("material_code") or row.get("code"))
        unit = safe_str(row.get("default_unit") or row.get("unit"))
        materials.append({
            "id": mid,
            "code": code,
            "name": name,
            "normalized_name": normalize_vietnamese_key(row.get("normalized_name") or name),
            "unit": unit,
            "active": truthy_active(row),
        })
    return sorted(materials, key=lambda row: (row.get("code") or "", row.get("name") or "", row["id"]))


def material_indexes(dataset: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    materials = canonical_materials(dataset)
    by_id = {row["id"]: row for row in materials}
    code: dict[str, list[tuple[str, dict[str, Any]]]] = defaultdict(list)
    name: dict[str, list[tuple[str, dict[str, Any]]]] = defaultdict(list)
    alias: dict[str, list[tuple[str, dict[str, Any]]]] = defaultdict(list)
    supplier_alias: dict[tuple[str, str], list[tuple[str, dict[str, Any]]]] = defaultdict(list)
    source_alias: dict[tuple[str, str], list[tuple[str, dict[str, Any]]]] = defaultdict(list)
    for material in materials:
        if material["active"] and material.get("code"):
            code[material["code"].strip().lower()].append(("material_code", material))
        if material["active"] and material.get("normalized_name"):
            name[material["normalized_name"]].append(("normalized_canonical_name", material))
    for row in dataset.get("sku_cogs_material_aliases", []):
        mid = safe_uuid(row.get("material_id"))
        material = by_id.get(mid or "")
        if not material or not material["active"] or not truthy_active(row):
            continue
        source = str(row.get("source") or "").strip().lower()
        if source and source not in APPROVED_GLOBAL_ALIAS_SOURCES:
            continue
        norm = normalize_vietnamese_key(row.get("normalized_alias") or row.get("alias_name"))
        if norm:
            alias[norm].append(("approved_global_alias", material))
    for row in dataset.get("material_scoped_aliases", []):
        mid = safe_uuid(row.get("material_id"))
        material = by_id.get(mid or "")
        if not material or not material["active"] or not truthy_active(row) or not truthy_active(row, "approved", False):
            continue
        norm = normalize_vietnamese_key(row.get("normalized_alias") or row.get("alias_name"))
        supplier_id = safe_uuid(row.get("supplier_id"))
        source_type = normalize_vietnamese_key(row.get("source_type"))
        if norm and supplier_id:
            supplier_alias[(supplier_id, norm)].append(("approved_supplier_alias", material))
        if norm and source_type and not supplier_id:
            source_alias[(source_type, norm)].append(("approved_source_alias", material))
    return {"materials": materials, "by_id": by_id, "code": code, "name": name, "alias": alias, "supplier_alias": supplier_alias, "source_alias": source_alias}


def conversion_pairs(dataset: dict[str, list[dict[str, Any]]], as_of_date: str) -> set[tuple[str, str, str]]:
    pairs: set[tuple[str, str, str]] = set()
    for row in dataset.get("material_unit_conversions", []):
        mid = safe_uuid(row.get("material_id"))
        if not mid or not truthy_active(row) or not truthy_active(row, "approved", False) or not current_on_date(row, as_of_date):
            continue
        pairs.add((mid, normalized_unit(row.get("from_unit")), normalized_unit(row.get("to_unit"))))
    return pairs


def supplier_product_candidates(dataset: dict[str, list[dict[str, Any]]], row: dict[str, Any], material: dict[str, Any] | None, as_of_date: str) -> list[dict[str, Any]]:
    if not material or not row.get("supplier_id"):
        return []
    raw_name = normalize_vietnamese_key(row.get("raw_name"))
    raw_code = normalize_vietnamese_key(row.get("raw_code"))
    raw_unit = normalized_unit(row.get("raw_unit"))
    canonical_unit = normalized_unit(material.get("unit"))
    matches: list[dict[str, Any]] = []
    for sp in dataset.get("material_supplier_products", []):
        if safe_uuid(sp.get("material_id")) != material["id"] or safe_uuid(sp.get("supplier_id")) != row.get("supplier_id"):
            continue
        if not truthy_active(sp) or not truthy_active(sp, "approved", False) or not current_on_date(sp, as_of_date):
            continue
        sp_name = normalize_vietnamese_key(sp.get("normalized_supplier_product_name") or sp.get("supplier_product_name"))
        sp_code = normalize_vietnamese_key(sp.get("supplier_product_code"))
        name_match = bool(raw_name and sp_name and raw_name == sp_name)
        code_match = bool(raw_code and sp_code and raw_code == sp_code)
        if raw_name and raw_code:
            if not (name_match and code_match):
                continue
        elif not (name_match or code_match):
            continue
        units = {normalized_unit(sp.get("purchase_unit")), normalized_unit(sp.get("base_unit")), canonical_unit}
        if raw_unit and raw_unit not in units:
            continue
        matches.append({
            "id": safe_uuid(sp.get("id")),
            "match": "code" if code_match else "name",
            "supplier_product_code": safe_str(sp.get("supplier_product_code")),
            "supplier_product_name": safe_str(sp.get("supplier_product_name")),
            "purchase_unit": safe_str(sp.get("purchase_unit")),
            "base_unit": safe_str(sp.get("base_unit")),
        })
    return sorted(matches, key=lambda r: (r.get("match") or "", r.get("id") or ""))


def source_rows(dataset: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for row in dataset.get("kitchen_inventory_items", []):
        sid = safe_uuid(row.get("id"))
        if not sid:
            continue
        rows.append({
            "source_table": "kitchen_inventory_items",
            "source_type": "kitchen_inventory",
            "source_id": sid,
            "supplier_id": None,
            "raw_name": safe_str(row.get("name") or row.get("canonical_name") or row.get("ingredient_name")),
            "raw_code": safe_str(row.get("item_code") or row.get("material_code") or row.get("code")),
            "raw_unit": safe_str(row.get("unit") or row.get("default_unit") or row.get("base_unit")),
            "existing_canonical_material_id": safe_uuid(row.get("canonical_material_id")),
            "active": truthy_active(row),
        })
    for row in raw_sku_rows(dataset.get("product_skus", [])):
        sid = safe_uuid(row.get("id"))
        if not sid:
            continue
        rows.append({
            "source_table": "product_skus",
            "source_type": "product_skus",
            "source_id": sid,
            "supplier_id": safe_uuid(row.get("supplier_id")),
            "raw_name": safe_str(row.get("product_name") or row.get("name") or row.get("ingredient_name")),
            "raw_code": safe_str(row.get("sku_code") or row.get("product_code") or row.get("code")),
            "raw_unit": safe_str(row.get("unit") or row.get("default_unit") or row.get("base_unit")),
            "existing_canonical_material_id": safe_uuid(row.get("canonical_material_id")),
            "active": truthy_active(row),
        })
    return sorted(rows, key=lambda row: (row["source_table"], row["source_id"]))


def unique_match(candidates: list[tuple[str, dict[str, Any]]]) -> tuple[str | None, dict[str, Any] | None, bool]:
    material_ids = {material["id"] for _, material in candidates}
    if len(material_ids) == 1 and candidates:
        return candidates[0][0], candidates[0][1], False
    if len(material_ids) > 1:
        return None, None, True
    return None, None, False


def find_exact(row: dict[str, Any], indexes: dict[str, Any]) -> tuple[str | None, dict[str, Any] | None, list[str]]:
    blockers: list[str] = []
    raw_code = safe_str(row.get("raw_code"))
    if raw_code:
        source, material, ambiguous = unique_match(indexes["code"].get(raw_code.strip().lower(), []))
        if ambiguous:
            return None, None, ["ambiguous_exact_code"]
        if material:
            return source, material, []
    norm = normalize_vietnamese_key(row.get("raw_name"))
    if norm:
        if row.get("supplier_id"):
            source, material, ambiguous = unique_match(indexes["supplier_alias"].get((row["supplier_id"], norm), []))
            if ambiguous:
                return None, None, ["ambiguous_exact_alias"]
            if material:
                return source, material, []
        source, material, ambiguous = unique_match(indexes["source_alias"].get((normalize_vietnamese_key(row.get("source_type")), norm), []))
        if ambiguous:
            return None, None, ["ambiguous_exact_alias"]
        if material:
            return source, material, []
        source, material, ambiguous = unique_match(indexes["name"].get(norm, []))
        if ambiguous:
            return None, None, ["ambiguous_exact_name"]
        if material:
            return source, material, []
        source, material, ambiguous = unique_match(indexes["alias"].get(norm, []))
        if ambiguous:
            return None, None, ["ambiguous_exact_alias"]
        if material:
            return source, material, []
    return None, None, blockers


def unit_compatibility(row: dict[str, Any], material: dict[str, Any] | None, conversions: set[tuple[str, str, str]]) -> dict[str, Any]:
    source_unit = safe_str(row.get("raw_unit"))
    canonical_unit = safe_str(material.get("unit") if material else None)
    if not source_unit or not canonical_unit:
        return {"status": "unmapped", "source_unit": source_unit, "canonical_unit": canonical_unit, "evidence": "missing_unit"}
    from_unit = normalized_unit(source_unit)
    to_unit = normalized_unit(canonical_unit)
    if from_unit == to_unit:
        return {"status": "compatible", "source_unit": source_unit, "canonical_unit": canonical_unit, "evidence": "exact_unit"}
    if material and (material["id"], from_unit, to_unit) in conversions:
        return {"status": "compatible", "source_unit": source_unit, "canonical_unit": canonical_unit, "evidence": "approved_unit_conversion"}
    return {"status": "unmapped", "source_unit": source_unit, "canonical_unit": canonical_unit, "evidence": "unit_conversion_required"}


def fuzzy_suggestions(row: dict[str, Any], materials: list[dict[str, Any]], limit: int = 3) -> list[dict[str, Any]]:
    norm = normalize_vietnamese_key(row.get("raw_name"))
    if not norm:
        return []
    scored = []
    for material in materials:
        score = difflib.SequenceMatcher(None, norm, material.get("normalized_name") or "").ratio()
        if score >= 0.72:
            scored.append((score, material))
    return [
        {"candidate_source": "fuzzy_name_suggestion", "score": round(score, 4), "id": material["id"], "code": material.get("code"), "name": material.get("name")}
        for score, material in sorted(scored, key=lambda item: (-item[0], item[1]["id"]))[:limit]
    ]


def safe_source_projection(dataset: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    return {
        "sku_cogs_materials": [
            {"id": m["id"], "code": m.get("code"), "name": m.get("name"), "normalized_name": m.get("normalized_name"), "unit": m.get("unit"), "active": m.get("active")}
            for m in canonical_materials(dataset)
        ],
        "sources": source_rows(dataset),
        "global_aliases": [
            {"material_id": safe_uuid(r.get("material_id")), "alias": normalize_vietnamese_key(r.get("normalized_alias") or r.get("alias_name")), "active": truthy_active(r), "source": safe_str(r.get("source"))}
            for r in dataset.get("sku_cogs_material_aliases", [])
        ],
        "scoped_aliases": [
            {"material_id": safe_uuid(r.get("material_id")), "supplier_id": safe_uuid(r.get("supplier_id")), "source_type": normalize_vietnamese_key(r.get("source_type")), "alias": normalize_vietnamese_key(r.get("normalized_alias") or r.get("alias_name")), "active": truthy_active(r), "approved": truthy_active(r, "approved", False)}
            for r in dataset.get("material_scoped_aliases", [])
        ],
        "unit_conversions": [
            {"material_id": safe_uuid(r.get("material_id")), "from_unit": normalized_unit(r.get("from_unit")), "to_unit": normalized_unit(r.get("to_unit")), "active": truthy_active(r), "approved": truthy_active(r, "approved", False), "effective_from": safe_str(r.get("effective_from")), "effective_to": safe_str(r.get("effective_to"))}
            for r in dataset.get("material_unit_conversions", [])
        ],
        "supplier_products": [
            {"id": safe_uuid(r.get("id")), "material_id": safe_uuid(r.get("material_id")), "supplier_id": safe_uuid(r.get("supplier_id")), "code": normalize_vietnamese_key(r.get("supplier_product_code")), "name": normalize_vietnamese_key(r.get("normalized_supplier_product_name") or r.get("supplier_product_name")), "purchase_unit": normalized_unit(r.get("purchase_unit")), "base_unit": normalized_unit(r.get("base_unit")), "active": truthy_active(r), "approved": truthy_active(r, "approved", False), "effective_from": safe_str(r.get("effective_from")), "effective_to": safe_str(r.get("effective_to"))}
            for r in dataset.get("material_supplier_products", [])
        ],
    }


def stable_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    import hashlib
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def row_for_source(row: dict[str, Any], indexes: dict[str, Any], conversions: set[tuple[str, str, str]], dataset: dict[str, list[dict[str, Any]]], as_of_date: str) -> dict[str, Any]:
    match_source, material, exact_blockers = find_exact(row, indexes)
    blockers = list(exact_blockers)
    unit = unit_compatibility(row, material, conversions) if material else {"status": "unmapped", "source_unit": safe_str(row.get("raw_unit")), "canonical_unit": None, "evidence": "missing_candidate"}
    supplier_matches = supplier_product_candidates(dataset, row, material, as_of_date)
    supplier_product_evidence = supplier_matches[0] if len(supplier_matches) == 1 else None
    if row.get("supplier_id") and material:
        if not supplier_matches:
            blockers.append("supplier_unmapped")
        elif len(supplier_matches) > 1:
            blockers.append("supplier_unmapped")
            blockers.append("ambiguous_supplier_product")
    suggestions = [] if material else fuzzy_suggestions(row, indexes["materials"])
    decision = "blocked"
    safe_reason = "missing exact canonical evidence; fail closed"
    if material and unit["status"] == "compatible" and not blockers:
        decision = "auto_ready"
        safe_reason = f"exact {match_source.replace('_', ' ') if match_source else 'canonical'} match with compatible unit"
        if match_source == "normalized_canonical_name":
            safe_reason = "exact normalized canonical material match with compatible unit"
    elif material and unit["status"] != "compatible":
        decision = "review"
        blockers.append("unit_unmapped" if unit["evidence"] == "missing_unit" else "unit_conversion_required")
        safe_reason = "exact material evidence found but unit requires review"
    elif blockers:
        decision = "blocked"
        safe_reason = "ambiguous exact evidence; fail closed"
    elif suggestions:
        decision = "review"
        blockers.append("fuzzy_suggestion_only")
        safe_reason = "fuzzy suggestion only; never auto approved"
    else:
        blockers.append("not_found")
    out = {
        "source_identity": {
            "source_type": row["source_type"],
            "source_table": row["source_table"],
            "source_id": row["source_id"],
            "supplier_id": row.get("supplier_id"),
        },
        "raw": {"name": row.get("raw_name"), "code": row.get("raw_code"), "unit": row.get("raw_unit")},
        "existing_canonical_material_id": row.get("existing_canonical_material_id"),
        "exact_match_source": match_source,
        "canonical_candidate": ({"id": material["id"], "code": material.get("code"), "name": material.get("name")} if material else None),
        "unit_compatibility": unit,
        "supplier_product_evidence": supplier_product_evidence,
        "decision": decision,
        "blockers": sorted(set(blockers)),
        "safe_reason": safe_reason,
        "suggestions": suggestions[:3],
    }
    out["row_hash"] = stable_hash(out)
    return out


def build_preview(dataset: dict[str, list[dict[str, Any]]], as_of_date: str = DEFAULT_AS_OF_DATE) -> dict[str, Any]:
    indexes = material_indexes(dataset)
    conversions = conversion_pairs(dataset, as_of_date)
    rows = [row_for_source(row, indexes, conversions, dataset, as_of_date) for row in source_rows(dataset)]
    counts_by_source = Counter(row["source_identity"]["source_table"] for row in rows)
    artifact = {
        "schema_version": SCHEMA_VERSION,
        "as_of_date": as_of_date,
        "source": {"mode": dataset.get("__source_mode", "in_memory"), "warnings": dataset.get("__warnings", [])},
        "source_hash": stable_hash(safe_source_projection(dataset)),
        "counts": {
            "canonical_materials": len(indexes["materials"]),
            "sources": dict(sorted(counts_by_source.items())),
            "decisions": dict(sorted(Counter(row["decision"] for row in rows).items())),
        },
        "rows": rows,
    }
    artifact["artifact_hash"] = stable_hash(artifact)
    return artifact


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build deterministic read-only material reconciliation preview.")
    parser.add_argument("--export-dir", type=Path, help="Offline directory with <table>.json/.jsonl/.csv exports.")
    parser.add_argument("--linked", action="store_true", help="Read linked Supabase SELECTs; requires --allow-linked-read.")
    parser.add_argument("--allow-linked-read", action="store_true", help="Explicit confirmation for linked read-only network access.")
    parser.add_argument("--app-dir", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path, help="Write preview artifact JSON to this path.")
    parser.add_argument("--as-of-date", default=DEFAULT_AS_OF_DATE, help="Deterministic ISO date for current effective conversion/supplier evidence checks.")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args(argv)
    if args.linked and not args.allow_linked_read:
        parser.error("--linked requires explicit --allow-linked-read")
    if args.linked and args.export_dir:
        parser.error("Choose either --linked or --export-dir, not both")
    if not args.linked and not args.export_dir:
        parser.error("Default is offline; provide --export-dir or explicit --linked --allow-linked-read")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        dataset = load_linked_data(args.app_dir) if args.linked else load_export_dir(args.export_dir)
        artifact = build_preview(dataset, as_of_date=args.as_of_date)
        text = json.dumps(artifact, ensure_ascii=False, sort_keys=True, indent=2 if args.pretty else None)
        if args.output:
            args.output.write_text(text + "\n", encoding="utf-8")
        else:
            print(text)
        return 0
    except Exception as exc:  # pragma: no cover
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
