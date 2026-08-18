#!/usr/bin/env python3
"""Safely apply explicitly approved material reconciliation preview rows.

Default is dry-run. Real execution requires --apply and the exact production
acknowledgement. The script never emits direct DML; it calls only approved
controller RPCs through linked Supabase SQL SELECTs.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

APPLY_TIMEOUT_SECONDS = 45
ACK_TEXT = "I_ACKNOWLEDGE_PRODUCTION_TARGET"
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
ALLOWED_SOURCE_TABLES = {"kitchen_inventory_items", "product_skus"}
ALLOWED_EXACT_SOURCES = {"material_code", "normalized_canonical_name", "approved_supplier_alias", "approved_source_alias", "approved_global_alias"}
APPROVAL_ONLY_ROW_KEYS = {"approved", "approved_by", "reviewed_at", "approval_note"}


def stable_hash(value: Any) -> str:
    import hashlib
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def is_uuid(value: Any) -> bool:
    return isinstance(value, str) and bool(UUID_RE.match(value.strip()))


def sql_literal(value: Any, cast: str | None = None) -> str:
    if value is None:
        return f"null::{cast}" if cast else "null"
    text = str(value).replace("'", "''")
    return f"'{text}'::{cast}" if cast else f"'{text}'"


def json_sql(value: Any) -> str:
    return sql_literal(json.dumps(value or {}, ensure_ascii=False, sort_keys=True), "jsonb")


def strip_approval_metadata(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: strip_approval_metadata(item) for key, item in value.items() if key not in APPROVAL_ONLY_ROW_KEYS and key != "artifact_hash"}
    if isinstance(value, list):
        return [strip_approval_metadata(item) for item in value]
    return value


def recompute_artifact_hash(artifact: dict[str, Any]) -> str:
    return stable_hash(strip_approval_metadata(artifact))


def recompute_row_hash(row: dict[str, Any]) -> str:
    copy = {key: value for key, value in row.items() if key not in {"row_hash", *APPROVAL_ONLY_ROW_KEYS}}
    return stable_hash(copy)


def approved_rows(artifact: dict[str, Any]) -> list[dict[str, Any]]:
    rows = artifact.get("rows")
    if not isinstance(rows, list):
        raise ValueError("preview rows must be an array")
    return [row for row in rows if isinstance(row, dict) and row.get("approved") is True]


def validate_row(row: dict[str, Any]) -> None:
    if row.get("row_hash") != recompute_row_hash(row):
        raise ValueError("row tamper detected: row_hash mismatch")
    identity = row.get("source_identity") or {}
    raw = row.get("raw") or {}
    candidate = row.get("canonical_candidate") or {}
    unit = row.get("unit_compatibility") or {}
    if row.get("decision") != "auto_ready":
        raise ValueError("approved apply accepts only auto_ready rows")
    if identity.get("source_table") not in ALLOWED_SOURCE_TABLES:
        raise ValueError("source_table is not allowlisted")
    if not is_uuid(identity.get("source_id")):
        raise ValueError("source_id must be a UUID")
    if identity.get("supplier_id") is not None and not is_uuid(identity.get("supplier_id")):
        raise ValueError("supplier_id must be UUID or null")
    if not is_uuid(candidate.get("id")):
        raise ValueError("canonical candidate id must be a UUID")
    if unit.get("status") != "compatible":
        raise ValueError("unit compatibility must be compatible")
    if row.get("exact_match_source") not in ALLOWED_EXACT_SOURCES:
        raise ValueError("exact evidence is required; fuzzy suggestions cannot be applied")
    if identity.get("supplier_id") and not (row.get("supplier_product_evidence") or {}).get("id"):
        raise ValueError("supplier_product evidence is required for supplier-linked rows")
    if row.get("suggestions") and not row.get("exact_match_source"):
        raise ValueError("fuzzy-only rows cannot be applied")
    if not raw.get("name"):
        raise ValueError("raw_name is required")


def load_and_validate(path: Path, *, expected_source_hash: str, expected_artifact_hash: str) -> dict[str, Any]:
    artifact = json.loads(path.read_text(encoding="utf-8"))
    if artifact.get("schema_version") != "material_reconciliation_preview.v1":
        raise ValueError("unsupported preview schema_version")
    if not artifact.get("artifact_hash"):
        raise ValueError("artifact_hash is required")
    if artifact.get("artifact_hash") != expected_artifact_hash:
        raise ValueError("artifact hash tamper detected: immutable artifact hash mismatch")
    if recompute_artifact_hash(artifact) != artifact.get("artifact_hash"):
        raise ValueError("artifact hash tamper detected: immutable artifact hash mismatch")
    if artifact.get("source_hash") != expected_source_hash:
        raise ValueError("immutable source hash mismatch")
    rows = approved_rows(artifact)
    if not rows:
        raise ValueError("no explicitly approved rows found")
    for row in rows:
        validate_row(row)
    return artifact


def extract_rpc_value(stdout: str, key: str) -> dict[str, Any]:
    try:
        value = json.loads(stdout.strip() or "[]")
    except json.JSONDecodeError:
        return {}
    if isinstance(value, list) and value:
        first = value[0]
        if isinstance(first, dict):
            cell = first.get(key)
            return cell if isinstance(cell, dict) else first
    if isinstance(value, dict):
        cell = value.get(key)
        return cell if isinstance(cell, dict) else value
    return {}


def run_rpc(app_dir: Path, sql: str, key: str, actor_id: str) -> dict[str, Any]:
    # Linked Management API queries do not carry PostgREST JWT claims. Set the
    # same local service-role + actor claims used by the verified rollback smoke
    # so permission checks and reviewer/audit attribution are exercised. The
    # actor UUID is not a credential and is never printed.
    claimed_sql = (
        "select set_config('request.jwt.claim.role','service_role',true);"
        + "select set_config('request.jwt.claim.sub',"
        + sql_literal(actor_id)
        + ",true);"
        + sql
    )
    command = ["npx", "supabase", "db", "query", "--linked", "-o", "json", claimed_sql]
    try:
        completed = subprocess.run(command, cwd=str(app_dir), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=APPLY_TIMEOUT_SECONDS, check=False)
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError(f"RPC {key} timed out after {APPLY_TIMEOUT_SECONDS}s") from exc
    if completed.returncode != 0:
        raise RuntimeError(f"RPC {key} failed with code {completed.returncode}")
    return extract_rpc_value(completed.stdout, key)


def atomic_apply_sql(row: dict[str, Any]) -> str:
    i = row["source_identity"]
    r = row["raw"]
    candidate = row["canonical_candidate"]
    reason = f"Task3 approved exact reconciliation: {row.get('safe_reason')}"
    return "select public.apply_approved_material_reconciliation(" + ", ".join([
        sql_literal(i["source_type"]),
        sql_literal(i["source_table"]),
        sql_literal(i["source_id"], "uuid"),
        sql_literal(r.get("name")),
        sql_literal(r.get("code")),
        sql_literal(r.get("unit")),
        sql_literal(i.get("supplier_id"), "uuid"),
        sql_literal(candidate["id"], "uuid"),
        sql_literal(row.get("exact_match_source")),
        sql_literal(reason),
    ]) + ") as apply_approved_material_reconciliation;"


def require_uuid(value: Any, message: str) -> str:
    if not is_uuid(value):
        raise RuntimeError(message)
    return str(uuid.UUID(str(value)))


def validate_atomic_response(response: dict[str, Any], row: dict[str, Any]) -> tuple[str, str]:
    status = str(response.get("status") or "")
    if status not in {"linked", "linked_unchanged"}:
        raise RuntimeError(f"apply_approved_material_reconciliation returned malformed status: {status}")
    identity = row["source_identity"]
    request_id = require_uuid(response.get("request_id"), "apply_approved_material_reconciliation did not return request_id")
    if str(response.get("source_table") or "") != identity["source_table"]:
        raise RuntimeError("apply_approved_material_reconciliation returned source_table drift")
    if require_uuid(response.get("source_id"), "apply_approved_material_reconciliation did not return source_id") != identity["source_id"]:
        raise RuntimeError("apply_approved_material_reconciliation returned source_id drift")
    if require_uuid(response.get("material_id"), "apply_approved_material_reconciliation did not return material_id") != row["canonical_candidate"]["id"]:
        raise RuntimeError("apply_approved_material_reconciliation returned material_id drift")
    return status, request_id


def apply_rows(artifact: dict[str, Any], app_dir: Path, *, dry_run: bool, actor_id: str | None = None) -> dict[str, Any]:
    if not dry_run and not is_uuid(actor_id):
        raise ValueError("a valid --actor-id is required for audited production apply")
    summary = {"dry_run": dry_run, "source_hash": artifact.get("source_hash"), "approved_rows": len(approved_rows(artifact)), "linked": 0, "unchanged": 0, "errors": 0, "rows": []}
    for row in approved_rows(artifact):
        row_summary = {"source_identity": row["source_identity"], "canonical_material_id": row["canonical_candidate"]["id"], "status": "validated"}
        if dry_run:
            summary["rows"].append(row_summary)
            continue
        response = run_rpc(app_dir, atomic_apply_sql(row), "apply_approved_material_reconciliation", str(actor_id))
        status, request_id_text = validate_atomic_response(response, row)
        row_summary["status"] = status
        row_summary["request_id"] = request_id_text
        if status == "linked_unchanged":
            summary["unchanged"] += 1
        else:
            summary["linked"] += 1
        summary["rows"].append(row_summary)
    return summary


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Dry-run or apply approved material reconciliation rows via controller RPCs only.")
    parser.add_argument("--preview", type=Path, required=True)
    parser.add_argument("--allow-source-hash", required=True, help="Expected immutable preview source_hash.")
    parser.add_argument("--allow-artifact-hash", required=True, help="Expected immutable preview artifact_hash.")
    parser.add_argument("--apply", action="store_true", help="Perform linked RPC calls. Omit for dry-run.")
    parser.add_argument("--actor-id", help="Existing owner/admin auth user UUID for reviewer and audit attribution; required only with --apply.")
    parser.add_argument("--target-production-ack", help=f"Required exact value for --apply: {ACK_TEXT}")
    parser.add_argument("--app-dir", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args(argv)
    if args.apply and args.target_production_ack != ACK_TEXT:
        parser.error(f"--apply requires --target-production-ack {ACK_TEXT}")
    if args.apply and not is_uuid(args.actor_id):
        parser.error("--apply requires a valid --actor-id UUID")
    return args


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        artifact = load_and_validate(args.preview, expected_source_hash=args.allow_source_hash, expected_artifact_hash=args.allow_artifact_hash)
        summary = apply_rows(artifact, args.app_dir, dry_run=not args.apply, actor_id=args.actor_id)
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True, indent=2 if args.pretty else None))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
