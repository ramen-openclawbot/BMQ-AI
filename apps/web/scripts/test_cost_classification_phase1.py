#!/usr/bin/env python3
"""Deterministic offline checks for cost classification Phase 1."""

from __future__ import annotations

import pathlib
import subprocess
import sys
import unittest
import urllib.request
from decimal import Decimal
from unittest import mock

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from cost_classification_backfill import (  # noqa: E402
    Classification,
    FIXTURE_RULES,
    LineContext,
    MemoryClassificationStore,
    SupabaseRestStore,
    apply_classification,
    classification_payload,
    classify_line,
    fixture_lines,
    main,
    summarize,
)


class CostClassificationPhase1Tests(unittest.TestCase):
    def test_dry_run_does_not_write(self) -> None:
        store = MemoryClassificationStore()
        report = summarize(fixture_lines(), FIXTURE_RULES, store, dry_run=True)

        self.assertEqual(report["total_lines_scanned"], 6)
        self.assertEqual(store.rows, {})
        self.assertEqual(store.audit_logs, [])
        self.assertEqual(store.mutated_tables, [])
        self.assertIn("would_create", report["actions"])

    def test_capex_precedence_beats_cogs_keywords(self) -> None:
        result = classify_line(
            LineContext(
                source_type="payment_request_item",
                source_line_id="line-capex",
                product_name="Máy đánh bột phục vụ bánh mì que",
                supplier_name="Đơn vị thi công nhà xưởng",
                payment_request_id="pr-capex",
                line_total=Decimal("100000000"),
            ),
            FIXTURE_RULES,
        )

        self.assertEqual(result.category_code, "CAPEX_ASSET_PROJECT")
        self.assertEqual(result.product_line, "general")
        self.assertEqual(result.allocation_rule, "none")

    def test_packaging_is_shared_manual(self) -> None:
        result = classify_line(
            LineContext(
                source_type="payment_request_item",
                source_line_id="line-packaging",
                product_name="Hộp kraft và tem nhãn",
                supplier_name="Queen Pack",
                payment_request_id="pr-packaging",
            ),
            FIXTURE_RULES,
        )

        self.assertEqual(result.category_code, "PACKAGING_SALES")
        self.assertEqual(result.product_line, "shared")
        self.assertEqual(result.allocation_rule, "manual")

    def test_opex_general_is_not_product_allocated(self) -> None:
        result = classify_line(
            LineContext(
                source_type="invoice_item",
                source_line_id="line-opex",
                product_name="Tiền điện và internet tháng này",
                supplier_name="Nhà cung cấp vận hành",
                invoice_id="inv-opex",
            ),
            FIXTURE_RULES,
        )

        self.assertEqual(result.category_code, "OPEX_GENERAL")
        self.assertEqual(result.product_line, "general")
        self.assertEqual(result.allocation_rule, "none")

    def test_unknown_falls_back_to_review_queue(self) -> None:
        result = classify_line(
            LineContext(
                source_type="payment_request_item",
                source_line_id="line-unknown",
                product_name="Khoản chi chưa rõ nội dung",
                supplier_name="Khác",
                payment_request_id="pr-unknown",
            ),
            FIXTURE_RULES,
        )

        self.assertEqual(result.category_code, "UNMAPPED_REVIEW")
        self.assertEqual(result.review_status, "needs_review")
        self.assertEqual(result.confidence, 0.0)

    def test_idempotent_write_does_not_duplicate(self) -> None:
        store = MemoryClassificationStore()
        classification = classify_line(
            LineContext(
                source_type="payment_request_item",
                source_line_id="line-idempotent",
                product_name="Nạc vai heo",
                supplier_name="TT FOODS",
                payment_request_id="pr-idempotent",
            ),
            FIXTURE_RULES,
        )

        first = apply_classification(store, classification, dry_run=False, actor_id="actor")
        second = apply_classification(store, classification, dry_run=False, actor_id="actor")

        self.assertEqual(first, "created")
        self.assertEqual(second, "unchanged")
        self.assertEqual(len(store.rows), 1)
        self.assertEqual(len(store.audit_logs), 1)

    def test_manual_override_and_approved_are_preserved(self) -> None:
        existing_manual = {
            "source_type": "payment_request_item",
            "source_line_id": "line-manual",
            "classification_source": "manual_override",
            "review_status": "suggested",
            "category_code": "OPEX_GENERAL",
        }
        existing_approved = {
            "source_type": "invoice_item",
            "source_line_id": "line-approved",
            "classification_source": "rule",
            "review_status": "approved",
            "category_code": "OPEX_GENERAL",
        }
        store = MemoryClassificationStore([existing_manual, existing_approved])

        manual_result = apply_classification(
            store,
            Classification(
                source_type="payment_request_item",
                source_line_id="line-manual",
                payment_request_id="pr-manual",
                invoice_id=None,
                supplier_id=None,
                category_code="COGS_BMQ_BREAD",
                product_line="bmq_bread",
                revenue_channel=None,
                allocation_rule="direct",
                confidence=0.9,
                classification_source="rule",
                rule_id=FIXTURE_RULES[1].id,
                review_status="suggested",
            ),
            dry_run=False,
        )
        approved_result = apply_classification(
            store,
            Classification(
                source_type="invoice_item",
                source_line_id="line-approved",
                payment_request_id=None,
                invoice_id="inv-approved",
                supplier_id=None,
                category_code="COGS_BMQ_BREAD",
                product_line="bmq_bread",
                revenue_channel=None,
                allocation_rule="direct",
                confidence=0.9,
                classification_source="rule",
                rule_id=FIXTURE_RULES[1].id,
                review_status="suggested",
            ),
            dry_run=False,
        )

        self.assertEqual(manual_result, "preserved")
        self.assertEqual(approved_result, "preserved")
        self.assertEqual(store.get("payment_request_item", "line-manual")["category_code"], "OPEX_GENERAL")
        self.assertEqual(store.get("invoice_item", "line-approved")["category_code"], "OPEX_GENERAL")
        self.assertEqual(store.audit_logs, [])

    def test_no_approval_or_invoice_flow_dependency(self) -> None:
        base = LineContext(
            source_type="payment_request_item",
            source_line_id="line-no-dependency",
            product_name="Nạc đùi heo",
            supplier_name="TT FOODS",
            payment_request_id="pr-no-dependency",
        )
        with_extra_operational_fields = {
            **base.__dict__,
            "approval_status": "pending",
            "invoice_created": False,
            "invoice_payment_status": "unpaid",
        }

        result = classify_line(base, FIXTURE_RULES)

        self.assertEqual(result.category_code, "COGS_BMQ_BREAD")
        self.assertNotIn("approval_status", result.__dict__)
        self.assertNotIn("invoice_created", result.__dict__)
        self.assertNotIn("invoice_payment_status", result.__dict__)
        self.assertEqual(with_extra_operational_fields["approval_status"], "pending")

    def test_write_path_only_mutates_classification_tables(self) -> None:
        store = MemoryClassificationStore()
        classification = classify_line(
            LineContext(
                source_type="invoice_item",
                source_line_id="line-write-scope",
                product_name="Anchor cream cheese",
                supplier_name="Đại Tân Việt",
                invoice_id="inv-write-scope",
            ),
            FIXTURE_RULES,
        )

        apply_classification(store, classification, dry_run=False)

        self.assertEqual(
            set(store.mutated_tables),
            {"cost_line_classifications", "cost_classification_audit_logs"},
        )

    def test_fixture_command_is_dry_run(self) -> None:
        completed = subprocess.run(
            [sys.executable, str(SCRIPT_DIR / "cost_classification_backfill.py"), "--fixture", "--dry-run"],
            check=True,
            capture_output=True,
            text=True,
        )

        self.assertIn('"dry_run": true', completed.stdout)
        self.assertIn('"CAPEX_ASSET_PROJECT"', completed.stdout)

    def test_real_mode_loads_rules_and_lines_through_supabase_rest(self) -> None:
        requested_paths = []

        def fake_urlopen(request: urllib.request.Request, timeout: int = 30) -> FakeResponse:
            self.assertEqual(timeout, 30)
            path = request.full_url.split("/rest/v1/", 1)[1]
            requested_paths.append(path)
            table = path.split("?", 1)[0]
            payloads = {
                "cost_classification_rules": [
                    {
                        "id": "12345678-1234-4234-8234-123456789abc",
                        "priority": 1,
                        "rule_name": "DB sweet rule",
                        "keyword_pattern": "Anchor",
                        "match_scope": "keyword",
                        "category_code": "COGS_SWEET_KITCHEN",
                        "product_line": "sweet_kitchen",
                        "allocation_rule": "direct",
                        "confidence": 0.91,
                    }
                ],
                "payment_request_items": [
                    {
                        "id": "line-payment",
                        "payment_request_id": "payment-request-1",
                        "product_name": "Anchor bơ lạt",
                        "line_total": "120000",
                    }
                ],
                "invoice_items": [
                    {
                        "id": "line-invoice",
                        "invoice_id": "invoice-1",
                        "product_name": "Unknown invoice item",
                        "amount": "50000",
                    }
                ],
                "payment_requests": [{"id": "payment-request-1", "supplier_id": "supplier-1"}],
                "invoices": [{"id": "invoice-1", "supplier_id": "supplier-2"}],
                "suppliers": [
                    {"id": "supplier-1", "name": "Thành Nguyên"},
                    {"id": "supplier-2", "name": "Other Supplier"},
                ],
                "cost_line_classifications": [],
            }
            return FakeResponse(payloads[table])

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            store = SupabaseRestStore("https://example.supabase.co", "service-role")
            rules = store.load_active_rules()
            lines = store.load_line_contexts()
            report = summarize(lines, rules, store, dry_run=True)

        self.assertTrue(any(path.startswith("cost_classification_rules?select=*&active=eq.true") and "limit=1000" in path for path in requested_paths))
        self.assertTrue(any(path.startswith("payment_request_items?") and "limit=1000" in path for path in requested_paths))
        self.assertTrue(any(path.startswith("invoice_items?") and "limit=1000" in path for path in requested_paths))
        self.assertEqual(report["total_lines_scanned"], 2)
        self.assertEqual(classify_line(lines[0], rules).rule_id, "12345678-1234-4234-8234-123456789abc")

    def test_fixture_rules_are_deterministic_uuid_ids(self) -> None:
        first_store = MemoryClassificationStore()
        second_store = MemoryClassificationStore()

        first = summarize(fixture_lines(), FIXTURE_RULES, first_store, dry_run=True)
        second = summarize(fixture_lines(), FIXTURE_RULES, second_store, dry_run=True)

        self.assertEqual(first, second)
        self.assertTrue(all("rule-" not in rule.id for rule in FIXTURE_RULES))
        self.assertTrue(all(len(rule.id) == 36 for rule in FIXTURE_RULES))

    def test_low_confidence_rule_falls_back_to_review(self) -> None:
        weak_rule = [
            FIXTURE_RULES[0].__class__(
                "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                1,
                "Weak bread rule",
                "bánh mì que",
                "supplier_and_item",
                None,
                None,
                None,
                "COGS_BMQ_BREAD",
                "bmq_bread",
                None,
                "direct",
                0.5,
            )
        ]
        result = classify_line(
            LineContext("payment_request_item", "line-weak", "bánh mì que", payment_request_id="pr-weak"),
            weak_rule,
        )

        self.assertEqual(result.category_code, "UNMAPPED_REVIEW")
        self.assertEqual(result.review_status, "needs_review")

    def test_supplier_id_alone_does_not_override_line_item_text(self) -> None:
        supplier_only_rule = [
            FIXTURE_RULES[0].__class__(
                "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                1,
                "Supplier id only should not match",
                None,
                "supplier_and_item",
                "supplier-1",
                None,
                None,
                "COGS_BMQ_BREAD",
                "bmq_bread",
                None,
                "direct",
                0.95,
            )
        ]
        result = classify_line(
            LineContext(
                "payment_request_item",
                "line-supplier-only",
                "Khoản chi chưa rõ",
                supplier_id="supplier-1",
                supplier_name="Known Supplier",
                payment_request_id="pr-supplier-only",
            ),
            supplier_only_rule,
        )

        self.assertEqual(result.category_code, "UNMAPPED_REVIEW")

    def test_rest_write_uses_atomic_rpc_for_classification_and_audit(self) -> None:
        requested_paths = []

        def fake_urlopen(request: urllib.request.Request, timeout: int = 30) -> FakeResponse:
            path = request.full_url.split("/rest/v1/", 1)[1]
            requested_paths.append(path)
            if request.get_method() == "GET":
                return FakeResponse([])
            self.assertEqual(path, "rpc/upsert_cost_line_classification_with_audit")
            return FakeResponse({"id": "classification-1"})

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            store = SupabaseRestStore("https://example.supabase.co", "service-role")
            classification = classify_line(
                LineContext(
                    "invoice_item",
                    "00000000-0000-0000-0000-000000000123",
                    "Anchor bơ lạt",
                    supplier_name="Thành Nguyên",
                    invoice_id="20000000-0000-0000-0000-000000000123",
                ),
                FIXTURE_RULES,
            )
            result = apply_classification(store, classification, dry_run=False, actor_id="actor")

        self.assertEqual(result, "created")
        self.assertIn("rpc/upsert_cost_line_classification_with_audit", requested_paths)
        self.assertNotIn("cost_line_classifications?on_conflict=source_type,source_line_id", requested_paths)

    def test_rest_write_skips_rpc_when_existing_classification_is_unchanged(self) -> None:
        requested_paths = []
        classification = classify_line(
            LineContext(
                "invoice_item",
                "00000000-0000-0000-0000-000000000124",
                "Anchor bơ lạt",
                supplier_name="Thành Nguyên",
                invoice_id="20000000-0000-0000-0000-000000000124",
            ),
            FIXTURE_RULES,
        )
        existing = classification_payload(classification)
        existing["id"] = "classification-existing"

        def fake_urlopen(request: urllib.request.Request, timeout: int = 30) -> FakeResponse:
            path = request.full_url.split("/rest/v1/", 1)[1]
            requested_paths.append(path)
            self.assertEqual(request.get_method(), "GET")
            return FakeResponse([existing])

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            store = SupabaseRestStore("https://example.supabase.co", "service-role")
            result = apply_classification(store, classification, dry_run=False, actor_id="actor")

        self.assertEqual(result, "unchanged")
        self.assertFalse(any(path == "rpc/upsert_cost_line_classification_with_audit" for path in requested_paths))

    def test_rest_pagination_walks_all_pages(self) -> None:
        requested_paths = []

        def fake_urlopen(request: urllib.request.Request, timeout: int = 30) -> FakeResponse:
            path = request.full_url.split("/rest/v1/", 1)[1]
            requested_paths.append(path)
            if "offset=0" in path:
                return FakeResponse([{"id": str(index)} for index in range(1000)])
            if "offset=1000" in path:
                return FakeResponse([{"id": "1000"}])
            return FakeResponse([])

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            store = SupabaseRestStore("https://example.supabase.co", "service-role")
            rows = store._request_all("payment_request_items?select=*")

        self.assertEqual(len(rows), 1001)
        self.assertTrue(any("offset=0" in path for path in requested_paths))
        self.assertTrue(any("offset=1000" in path for path in requested_paths))

    def test_write_mode_requires_both_write_flags(self) -> None:
        self.assertEqual(main(["--write"]), 2)

    def test_rest_mutation_guard_blocks_source_tables(self) -> None:
        store = SupabaseRestStore("https://example.supabase.co", "service-role")

        with self.assertRaisesRegex(RuntimeError, "Refusing to mutate non-classification table"):
            store._request("POST", "payment_request_items", [])


class FakeResponse:
    def __init__(self, payload: object) -> None:
        self.payload = payload

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        return None

    def read(self) -> bytes:
        import json

        return json.dumps(self.payload).encode("utf-8")


if __name__ == "__main__":
    unittest.main(verbosity=2)
