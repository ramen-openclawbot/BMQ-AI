#!/usr/bin/env python3
"""Retired legacy KFM auto-upsert contract.

ProductionPlanning may still classify Kingfood/KFM POs for grouping/display, but
creating a production order must no longer call the historical daily KFM material
issue RPC or surface KFM-specific sync statuses. Task8B closes the old side
effect in favor of the Q7 per-order signed material issue workflow.
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

    kfm_token = re.compile(r"(^|[^a-z0-9])kfm([^a-z0-9]|$)", re.I)
    normalize = lambda value: re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", value.lower())).strip()
    positives = ["KFM", "[KFM] order", "KFM-PO"]
    false_positives = ["akfmart@example.com", "notkfmvendor", "prefixkfm"]
    assert all(kfm_token.search(normalize(case)) for case in positives), "KFM token examples must classify as Kingfood/KFM"
    assert not any(kfm_token.search(normalize(case)) for case in false_positives), "embedded KFM substrings must not classify as Kingfood/KFM"


def test_create_production_order_no_longer_carries_kfm_flag_or_calls_legacy_rpc():
    src = read_source()
    mutation = extract_balanced_block(src, "const createProductionOrderMutation")
    submit = extract_balanced_block(src, "const handleSubmitCreate")

    assert not re.search(r"isKingfood\s*:\s*boolean", src), "mutation input must not carry retired KFM side-effect flag"
    assert "isKingfood: isKingfoodPo(selectedPoForCreation)" not in submit
    assert "upsert_kfm_daily_material_issue" not in mutation, "production confirmation must not call retired KFM RPC"
    assert "mark_kfm_daily_material_issue_printed" not in src
    assert "KfmMaterialIssueResult" not in src and "KfmMaterialIssueStatus" not in src
    assert "return { order: newOrder } satisfies CreateProductionOrderResult" in mutation


def test_success_toast_is_generic_and_not_kfm_status_specific():
    src = read_source()
    success_start = src.index("onSuccess: ({ order })")
    success_end = src.index("onError:", success_start)
    success = src[success_start:success_end]

    assert "BOM/material issue integration is still required" in success, "generic production-order success behavior remains"
    assert "materialIssue" not in success
    assert "PXK NVL sync" not in success and "đồng bộ PXK NVL" not in success
    for status in ["generated", "refreshed", "printed_unchanged", "blocked_"]:
        assert status not in success, f"retired KFM status must not affect create success toast: {status}"

    success_toasts = re.findall(r"toast\.success\(", success)
    assert len(success_toasts) == 1, "confirmation must emit exactly one success toast"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
