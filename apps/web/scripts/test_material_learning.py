#!/usr/bin/env python3
"""Material Master learning workflow contracts (coverage, suggestion UI, edge).

These are source contracts for behavior exercised by the focused runtime tests:
- sme-data-platform/tests/test_bmq_payment.py (approved supplier mapping behavior)
- apps/web/supabase/functions/material-learning-suggest/*.test.ts (Deno core/transport/handler)
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "src/hooks/useMaterialMaster.ts"
PAGE = ROOT / "src/pages/material-master/MaterialMasterAdmin.tsx"
LIB = ROOT / "src/lib/material-name.ts"
CONTRACT = ROOT / "src/lib/material-learning-contract.ts"
FUNCTION_DIR = ROOT / "supabase/functions/material-learning-suggest"
CORE = FUNCTION_DIR / "material-suggest.ts"
FIXTURES = FUNCTION_DIR / "material-suggest.fixtures.ts"
JEV = FUNCTION_DIR / "material-jev.ts"
HANDLER = FUNCTION_DIR / "handler.ts"
INDEX = FUNCTION_DIR / "index.ts"


def read(path: Path) -> str:
    assert path.exists(), f"missing expected file: {path}"
    return path.read_text(encoding="utf-8")


def test_coverage_audit_uses_full_pagination_and_explicit_truncation():
    hook = read(HOOK)
    page = read(PAGE)

    assert "readTable" not in hook, "the silent limit(500) reader must be gone"
    assert "MAX_PAGES" in hook and "TRUNCATED:" in hook
    assert "vượt quá" in hook and "trang an toàn" in hook
    # Material, formulation, alias, supplier-product and resolution-request sections
    # all paginate; the unresolved source-name audit reads both source lines with a
    # null canonical id instead of capping the list.
    for table in ["sku_cogs_materials", "sku_cogs_material_aliases", "material_scoped_aliases",
                  "material_supplier_products", "material_unit_conversions",
                  "material_resolution_requests", "sku_formulations", "payment_request_items",
                  "invoice_items"]:
        assert f'"{table}"' in hook, table
    assert '["canonical_material_id"]' in hook
    assert "buildUnresolvedSourceNames" in hook and "unresolved_total" in hook
    assert "occurrence_count" in hook and "total_value" in hook
    assert "buildCoverage" in hook and "formulations_missing_canonical" in hook
    assert "coverage: MaterialCoverage" in hook
    assert "readAllTable<CogsMaterialLink>" in hook
    assert '{ column: "product_skus.sku_type", value: "finished_good" }' in hook

    assert "data-bmq-material-learning-coverage" in page
    assert "MaterialCoveragePanel" in page and "coverage={data.coverage}" in page
    assert "coverage.unresolved_total" in page and "coverage.unresolved.length" in page
    assert "Độ phủ chưa đầy đủ" in page and "Không tải được dữ liệu" in page
    assert "requests.slice(0, 80)" not in page and "slice(0, 80)" not in page
    assert "visibleRequests" in page and "Tải thêm dòng chưa xác nhận" in page
    assert "Đang hiển thị" in page


def test_explicit_request_bound_suggest_action_never_auto_selects_or_auto_saves():
    hook = read(HOOK)
    page = read(PAGE)
    contract = read(CONTRACT)

    # The hook invokes the endpoint with only the request id; the shared contract
    # module validates the server candidate shape before the UI can use it.
    assert 'functions.invoke<unknown>("material-learning-suggest"' in hook
    assert 'body: { request_id: requestId }' in hook
    assert "parseMaterialLearningSuggestion" in hook
    assert "raw.request_id !== requestId" in contract
    assert "suggested_material_id" in contract and "offered.has(suggested)" in contract
    assert "trùng material_id" in contract and "material_id" in contract
    assert "useMaterialLearningSuggestion" in page and "useMaterialResolutionRequest" in page
    assert "data-bmq-material-learning-suggest" in page
    assert "data-bmq-material-learning-suggestion-result" in page
    assert "chooseSuggestionCandidate" in page
    assert "suggestionMatchesSelection" in page
    assert "Cần anh xác nhận" in page and "AI đề xuất" in page
    assert "Độ tin cậy không phải sự thật" in page
    assert "không tự lưu" in page
    assert "Đơn vị chuẩn" in page and "Thương hiệu" in page and "Quy cách" in page
    assert "confirm_material_resolution" in hook
    assert "confirm.isPending" in page
    assert "Dòng này đã có đúng kết quả đã lưu" in page
    assert "classifyRecovery" in page and "recoveryBlocked" in page
    assert "suggestionFence" in page and "submitGate" in page

    chooser = re.search(r"const chooseSuggestionCandidate[\s\S]*?\n  \};", page)
    assert chooser is not None, "missing candidate chooser"
    body = chooser.group(0)
    assert "setMaterialId(candidate.material_id)" in body
    assert "mutate" not in body and "confirm." not in body, "choosing a suggestion must not write"


def test_learning_suggestion_edge_is_owner_only_read_only_and_zdr_bounded():
    core = read(CORE)
    jev = read(JEV)
    handler = read(HANDLER)
    index = read(INDEX)

    # The endpoint is owner-scoped, default off with a kill switch and no service role.
    assert "user_roles" in index and '"owner"' in index
    assert "BMQ_MATERIAL_LEARNING_ENABLED" in index
    assert "BMQ_MATERIAL_LEARNING_KILL_SWITCH" in index
    assert "SUPABASE_SERVICE_ROLE" not in index and "service_role" not in index
    assert "authorization.slice(7)" in index

    # The verified Gateway contract and zero-data-retention provider options are reused.
    assert "material-learning-suggest/material-jev" not in index
    assert "JEV_ENDPOINT" in jev and "zeroDataRetention: true" in jev
    assert 'only: ["typesafe-ai"]' in jev
    assert "MATERIAL_SUGGEST_MODEL" in jev
    assert "Authorization: `Bearer ${apiKey}`" in jev

    # The core is pure (no network/npm/Deno imports) and holds no write path.
    for forbidden in ["npm:", "https://", "Deno.", "createClient", "insert(", "update(", "rpc("]:
        assert forbidden not in core, f"pure core must not contain {forbidden}"
    assert "requires_review: true" in core
    assert "MATERIAL_SUGGEST_MIN_PROBABILITY" in core
    # Independent from the chat planner threshold: no import or reference of it.
    assert "JEV_PROBABILITY_THRESHOLD" not in core
    assert "JEV_PROBABILITY_THRESHOLD" not in jev
    # A returned id outside the offered set is refused and no-match/ambiguous are explicit.
    assert "offered.find((material) => material.id === evaluation.choice)" in core
    assert '"none"' in core and '"ambiguous"' in core
    assert "candidate_catalog_truncated" in core

    # Budget, timeout, abort, body limit and replay protection are enforced.
    assert "REQUEST_BUDGET_MS" in handler and "REQUEST_BODY_LIMIT" in handler
    assert "AbortSignal.timeout" in handler and "AbortSignal.any" in handler
    assert "signal.throwIfAborted()" in handler
    assert '"busy"' in handler and '"rate_limited"' in handler
    assert 'MaterialSuggestError("disabled", 503)' in handler
    assert "forbidden:" in handler and "unauthorized:" in handler

    # Synthetic labelled tune/holdout fixtures with an explicit no-real-benchmark,
    # no-fine-tuning claim. They exercise the deterministic matcher only.
    fixtures = read(FIXTURES)
    assert "MATERIAL_SUGGEST_FIXTURE_CLAIM" in fixtures
    assert "no real benchmark" in fixtures and "no fine-tuning" in fixtures
    assert "MATERIAL_SUGGEST_TUNE_FIXTURES" in fixtures
    assert "MATERIAL_SUGGEST_HOLDOUT_FIXTURES" in fixtures
    assert (FUNCTION_DIR / "material-suggest.fixtures.test.ts").exists()


def test_unknowngroup_and_disagreement_rules_are_present_in_both_layers():
    page = read(PAGE)
    assert "canonical_category_group" in page or "canonical_category_group" in read(CORE)
    # The UI labels the deterministic group/conflict outcomes without inventing a pick.
    assert "Nhiều NVL cùng khớp" in page
    # Browser-side display normalization mirrors the server fold.
    lib = read(LIB)
    assert "normalizeMaterialName" in lib
    assert 'replace(/[\\u0300-\\u036f]/g, "")' in lib
    assert 'replace(/[^a-z0-9\\s]/g, " ")' in lib
