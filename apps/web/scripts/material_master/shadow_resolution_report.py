#!/usr/bin/env python3
"""Render the Task9 rollout dashboard without exposing raw queue payloads.

Offline JSON export is the default. Linked reads require all three explicit flags.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

DASHBOARD_FILE = "material_master_shadow_rollout_dashboard.json"
LINKED_READ_TIMEOUT_SECONDS = 60
LINKED_SQL = "select * from public.get_material_master_rollout_dashboard();"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Render the material-master shadow rollout dashboard")
    parser.add_argument("--export-dir", type=Path, default=Path("."))
    parser.add_argument("--format", choices=("json", "markdown"), default="markdown")
    parser.add_argument("--linked", action="store_true")
    parser.add_argument("--allow-linked-read", action="store_true")
    parser.add_argument("--i-understand-linked-read", action="store_true")
    args = parser.parse_args(argv)
    if args.linked and not (args.allow_linked_read and args.i_understand_linked_read):
        parser.error("--linked requires both --allow-linked-read and --i-understand-linked-read")
    if (args.allow_linked_read or args.i_understand_linked_read) and not args.linked:
        parser.error("linked-read acknowledgement flags are only valid with --linked")
    return args


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def sanitize_row(row: dict[str, Any]) -> dict[str, Any]:
    raw_queue = row.get("queue_buckets")
    queue: dict[str, Any] = raw_queue if isinstance(raw_queue, dict) else {}
    raw_blockers = row.get("blockers")
    blockers = (
        [str(item) for item in raw_blockers]
        if isinstance(raw_blockers, list)
        else ([str(raw_blockers).strip()] if isinstance(raw_blockers, str) and raw_blockers.strip() else [])
    )
    return {
        "source_type": str(row.get("source_type") or ""),
        "mode": str(row.get("mode") or ""),
        "queue_total_count": _int(row.get("queue_total_count")),
        "queue_pending_count": _int(row.get("queue_pending_count")),
        "queue_resolved_count": _int(row.get("queue_resolved_count")),
        "queue_blocked_count": _int(row.get("queue_blocked_count")),
        "queue_buckets": {str(key): _int(value) for key, value in sorted(queue.items())},
        "oldest_queue_created_at": row.get("oldest_queue_created_at") or None,
        "latest_queue_created_at": row.get("latest_queue_created_at") or None,
        "ready_for_enforcement": bool(row.get("ready_for_enforcement")),
        "blockers": blockers,
        "mode_updated_at": row.get("mode_updated_at") or None,
    }


def sanitize_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [sanitize_row(row) for row in rows]


def load_local_dashboard(export_dir: Path) -> list[dict[str, Any]]:
    path = export_dir / DASHBOARD_FILE
    if not path.exists():
        raise FileNotFoundError(f"Missing local dashboard export: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list) or not all(isinstance(row, dict) for row in data):
        raise ValueError(f"{DASHBOARD_FILE} must contain an array of objects")
    return data


def load_linked_dashboard(_cache_dir: Path | None = None) -> list[dict[str, Any]]:
    command = ["npx", "supabase", "db", "query", "--linked", "-o", "json", LINKED_SQL]
    try:
        result = subprocess.run(
            command,
            text=True,
            capture_output=True,
            timeout=LINKED_READ_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError(
            f"material master rollout linked read timed out after {LINKED_READ_TIMEOUT_SECONDS}s"
        ) from exc
    if result.returncode != 0:
        raise RuntimeError(f"Supabase CLI exited with code {result.returncode} while reading rollout dashboard")
    try:
        data = json.loads(result.stdout or "[]")
    except json.JSONDecodeError as exc:
        raise RuntimeError("Supabase CLI returned non-JSON rollout dashboard output") from exc
    if not isinstance(data, list) or not all(isinstance(row, dict) for row in data):
        raise RuntimeError("Supabase CLI returned an unexpected rollout dashboard shape")
    return data


def render_json(rows: list[dict[str, Any]]) -> str:
    return json.dumps(rows, ensure_ascii=False, indent=2, sort_keys=True)


def render_markdown(rows: list[dict[str, Any]]) -> str:
    lines = [
        "# Material master shadow rollout",
        "",
        "| source_type | mode | ready_for_enforcement | oldest_queue_created_at | latest_queue_created_at | queue_buckets | blockers |",
        "|---|---|:---:|---|---|---|---|",
    ]
    for row in rows:
        queue = ", ".join(f"{key}={value}" for key, value in row["queue_buckets"].items()) or "-"
        blockers = ", ".join(row["blockers"]) or "-"
        lines.append(
            f"| {row['source_type']} | {row['mode']} | "
            f"{'yes' if row['ready_for_enforcement'] else 'no'} | "
            f"{row['oldest_queue_created_at'] or '-'} | {row['latest_queue_created_at'] or '-'} | "
            f"{queue} | {blockers} |"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    rows = load_linked_dashboard(args.export_dir) if args.linked else load_local_dashboard(args.export_dir)
    safe_rows = sanitize_rows(rows)
    print(render_json(safe_rows) if args.format == "json" else render_markdown(safe_rows))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"shadow_resolution_report failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
