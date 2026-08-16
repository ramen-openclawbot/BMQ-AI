#!/usr/bin/env python3
"""Contract guard for KFM PXK NVL auto-upsert after production confirmation.

The production confirmation flow owns only the frontend integration:
- create production_order header
- insert all production_order_items successfully
- then, for Kingfood/KFM source POs only, call the daily KFM material issue RPC
- never roll back the already-created production order if the RPC blocks/fails
- surface one fail-soft operator message on success, with status-specific copy
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src/pages/ProductionPlanning.tsx"


def read_source() -> str:
    return SOURCE.read_text(encoding="utf-8")


def extract_balanced_block(source: str, marker: str) -> str:
    start = source.index(marker)
    brace_start = source.index("{", start)
    depth = 0
    for index in range(brace_start, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[brace_start : index + 1]
    raise AssertionError(f"could not extract block for {marker!r}")


def test_kingfood_detector_matches_kfm_only_as_normalized_token_not_substring():
    src = read_source()
    detector = extract_balanced_block(src, "const isKingfoodPo")

    assert 'includes("kingfoodmart")' in detector, "explicit kingfoodmart marker must remain supported"
    assert 'includes("kingfood")' in detector, "explicit kingfood marker must remain supported"
    assert 'includes("kfm")' not in detector, "raw KFM substring matching creates false positives"
    assert "kfmTokenPattern" in src, "KFM abbreviation must use an explicit token/boundary contract"
    assert re.search(r"\[\^a-z0-9\].*kfm.*\[\^a-z0-9\]", src, re.I | re.S), (
        "KFM abbreviation must match only at normalized alnum boundaries"
    )
    assert "akfmart@example.com" in src and "notkfmvendor" in src and "prefixkfm" in src, (
        "false-positive examples must remain documented beside the detector"
    )
    assert "[KFM] order" in src and "KFM-PO" in src, "positive KFM token examples must remain documented beside the detector"

    # Behavior cases from the Task 4 review contract, mirrored against the source regex semantics.
    kfm_token = re.compile(r"(^|[^a-z0-9])kfm([^a-z0-9]|$)", re.I)
    normalize = lambda value: re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", value.lower())).strip()
    positives = ["KFM", "[KFM] order", "KFM-PO"]
    false_positives = ["akfmart@example.com", "notkfmvendor", "prefixkfm"]
    assert all(kfm_token.search(normalize(case)) for case in positives), "KFM token examples must classify as Kingfood/KFM"
    assert not any(kfm_token.search(normalize(case)) for case in false_positives), "embedded KFM substrings must not classify as Kingfood/KFM"


def test_kfm_rpc_runs_only_after_all_items_insert_for_kingfood_source_using_production_date():
    src = read_source()
    mutation = extract_balanced_block(src, "const createProductionOrderMutation")
    submit = extract_balanced_block(src, "const handleSubmitCreate")

    assert re.search(r"isKingfood\s*:\s*boolean", src), "mutation input must carry whether the selected source PO is Kingfood/KFM"
    assert "isKingfood: isKingfoodPo(selectedPoForCreation)" in submit, "source PO must be classified with existing isKingfoodPo at submit time"

    item_insert_pos = mutation.index('.from("production_order_items")')
    items_error_guard_pos = mutation.index("if (itemsError)")
    rpc_pos = mutation.index("upsert_kfm_daily_material_issue")
    assert item_insert_pos < items_error_guard_pos < rpc_pos, "KFM RPC must occur only after production_order_items insert succeeds"

    assert re.search(r"if\s*\(input\.isKingfood\)\s*{[\s\S]*\.rpc\(\s*\"upsert_kfm_daily_material_issue\"", mutation), (
        "KFM RPC must be guarded so non-KFM production confirmations keep the old flow"
    )
    assert re.search(r"p_issue_date\s*:\s*productionDateIso", mutation), "RPC must use normalized productionDateIso, not browser UTC/current date"


def test_kfm_rpc_failure_or_blocker_does_not_delete_or_fail_successful_production_order():
    src = read_source()
    mutation = extract_balanced_block(src, "const createProductionOrderMutation")
    assert "upsert_kfm_daily_material_issue" in mutation, "mutation must call the daily KFM material issue RPC"
    after_rpc = mutation[mutation.index("upsert_kfm_daily_material_issue") :]

    assert "materialIssue" in mutation and "materialIssueError" in mutation, "mutation result must be enriched with PXK NVL state"
    assert re.search(r"catch\s*\([^)]*\)\s*{[\s\S]*materialIssueError\s*=", mutation), "RPC/network errors must be caught fail-soft inside the mutation"
    assert ".from(\"production_orders\").delete()" not in after_rpc, "do not roll back/delete the order after RPC failure or blocker"
    assert re.search(r"return\s*{\s*order\s*:\s*newOrder", mutation), "successful item insertion must still return the created order"


def test_success_toast_distinguishes_kfm_statuses_without_duplicate_success_messages():
    src = read_source()
    success_start = src.index("onSuccess: ({ order, materialIssue")
    success_end = src.index("onError:", success_start)
    success = src[success_start:success_end]

    assert "materialIssueAttempted" in success, "onSuccess must know whether a KFM RPC was attempted"
    for status in ["generated", "refreshed", "printed_unchanged", "blocked_"]:
        assert status in success, f"onSuccess toast must distinguish KFM material issue status {status}"
    assert "materialIssueError" in success, "onSuccess toast must distinguish KFM RPC/network failures"
    assert "unexpected" in success.lower() and "retry" in success.lower(), (
        "KFM null/unknown RPC payloads must warn order-created but PXK sync was unexpected and retryable"
    )
    assert re.search(r"materialIssueAttempted[\s\S]*!\[\s*\"generated\"[\s\S]*\"refreshed\"[\s\S]*\"printed_unchanged\"", success), (
        "KFM unknown statuses must not fall through to the legacy non-KFM success/BOM message"
    )
    assert "PXK NVL" in success, "operator toast should mention PXK NVL outcome for KFM confirmations"

    success_toasts = re.findall(r"toast\.success\(", success)
    assert len(success_toasts) == 1, "confirmation must emit exactly one success toast, not a generic plus KFM toast"
    assert "BOM/material issue integration is still required" in success, "non-KFM confirmations must retain the old success behavior"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
