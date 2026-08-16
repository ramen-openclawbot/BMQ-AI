#!/usr/bin/env python3
"""Task8B contracts for retiring ProductionPlanning legacy KFM side effects.

The Q7 production order flow must not invoke the legacy daily Kingfood/KFM
material issue RPC when creating production orders. Historical KFM tables/data
remain intact, but follow-up SQL must revoke the retired RPCs from every role so
old code cannot call them accidentally.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "src/pages/ProductionPlanning.tsx"
MIGRATION_DIR = ROOT / "supabase/migrations"
RETIRE_MIGRATION = MIGRATION_DIR / "20260816215000_retire_legacy_kfm_daily_material_issue.sql"
Q7_PDF_TEST = ROOT / "scripts/test_q7_material_issue_pdf_contracts.py"

LEGACY_RPC_TOKENS = (
    "upsert_kfm_daily_material_issue",
    "mark_kfm_daily_material_issue_printed",
    "KfmMaterialIssueResult",
    "KfmMaterialIssueStatus",
    "materialIssueAttempted",
    "materialIssueError",
    "materialIssue:",
    "PXK NVL sync",
    "đồng bộ PXK NVL",
    "printed_unchanged",
)


def read(path: Path) -> str:
    assert path.exists(), f"missing required file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def compact_sql(sql: str) -> str:
    sql = re.sub(r"--.*", "", sql)
    return re.sub(r"\s+", " ", sql.lower()).strip()


def test_production_planning_creation_has_no_legacy_kfm_rpc_result_or_status_branch() -> None:
    src = read(UI)
    mutation_start = src.index("const createProductionOrderMutation")
    mutation_end = src.index("const updateProductionOrderMutation", mutation_start)
    mutation = src[mutation_start:mutation_end]
    submit_start = src.index("const handleSubmitCreate")
    submit_end = src.index("const changePlannedQty", submit_start)
    submit = src[submit_start:submit_end]

    for token in LEGACY_RPC_TOKENS:
        assert token not in src, f"ProductionPlanning must retire legacy KFM token: {token}"

    assert "type CreateProductionOrderResult" in src, "create mutation should keep an explicit result contract"
    result_block = src[src.index("type CreateProductionOrderResult"):src.index("type Q7MaterialIssuePdfResult")]
    assert "order: ProductionOrder" in result_block
    assert "materialIssue" not in result_block and "Kfm" not in result_block

    assert "return { order: newOrder } satisfies CreateProductionOrderResult" in mutation
    assert "onSuccess: ({ order })" in mutation
    assert "toast.success(successMessage)" in mutation
    assert "BOM/material issue integration is still required" in mutation, "generic order-created success copy remains"
    assert "blocked_" not in mutation and "PXK NVL" not in mutation, "create success branch must not retain legacy KFM statuses"
    assert "isKingfood:" not in submit, "create mutation input must not carry retired KFM side-effect flags"


def test_q7_per_order_pdf_action_flow_remains_in_production_planning() -> None:
    src = read(UI)
    for token in (
        "Q7MaterialIssuePdfResult",
        "canGenerateQ7MaterialIssuePdf",
        "openQ7MaterialIssuePdf",
        "production-material-issue-pdf",
        "production_order_id: order.id",
        "data-testid={`q7-material-issue-pdf-${order.id}`}",
        "Phiếu NVL",
        "download_url",
    ):
        assert token in src, f"Q7 per-order PDF flow must remain: {token}"

    assert Q7_PDF_TEST.exists(), "existing Q7 PDF contract test must remain available"


def test_followup_migration_revokes_retired_kfm_rpcs_for_all_roles_without_data_changes() -> None:
    sql = read(RETIRE_MIGRATION)
    assert "retire" in sql.lower() and "legacy" in sql.lower() and "kfm" in sql.lower()
    compact = compact_sql(sql)

    assert "drop table" not in compact and "drop function" not in compact, "retirement must preserve historical objects"

    forbidden_dml = (
        "insert into",
        "update public.",
        "delete from",
        "truncate",
        "grant execute",
        "grant all",
    )
    for token in forbidden_dml:
        assert token not in compact, f"retirement migration must not contain {token!r}"

    for signature in (
        "public.upsert_kfm_daily_material_issue(date)",
        "public.mark_kfm_daily_material_issue_printed(uuid)",
    ):
        for role in ("public", "anon", "authenticated", "service_role"):
            pattern = rf"revoke\s+(?:all|execute)\s+on\s+function\s+{re.escape(signature)}\s+from\s+{role}\b"
            assert re.search(pattern, compact), f"missing revoke for {signature} from {role}"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
