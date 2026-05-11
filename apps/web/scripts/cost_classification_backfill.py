#!/usr/bin/env python3
"""Offline-first Phase 1 cost classification preview/backfill.

Dry run is the default. Write mode is intentionally double-guarded and writes
only cost classification tables with idempotent upsert semantics.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Tuple


CATEGORY_FALLBACK = "UNMAPPED_REVIEW"
MIN_RULE_CONFIDENCE = 0.7
PRESERVED_REVIEW_STATUSES = {"approved"}
PRESERVED_SOURCES = {"manual_override"}
WRITABLE_TABLES = {"cost_line_classifications", "cost_classification_audit_logs", "rpc/upsert_cost_line_classification_with_audit"}


@dataclass(frozen=True)
class Rule:
    id: str
    priority: int
    rule_name: str
    keyword_pattern: Optional[str]
    match_scope: str
    supplier_id: Optional[str]
    inventory_item_id: Optional[str]
    sku_id: Optional[str]
    category_code: str
    product_line: str
    revenue_channel: Optional[str]
    allocation_rule: str
    confidence: float
    source: str = "rule"


@dataclass(frozen=True)
class LineContext:
    source_type: str
    source_line_id: str
    product_name: str
    product_code: Optional[str] = None
    unit: Optional[str] = None
    quantity: Decimal = Decimal("1")
    unit_price: Decimal = Decimal("0")
    line_total: Optional[Decimal] = None
    supplier_id: Optional[str] = None
    supplier_name: Optional[str] = None
    supplier_category: Optional[str] = None
    sku_id: Optional[str] = None
    inventory_item_id: Optional[str] = None
    payment_request_id: Optional[str] = None
    invoice_id: Optional[str] = None

    @property
    def amount(self) -> Decimal:
        if self.line_total is not None:
            return self.line_total
        return self.quantity * self.unit_price


@dataclass(frozen=True)
class Classification:
    source_type: str
    source_line_id: str
    payment_request_id: Optional[str]
    invoice_id: Optional[str]
    supplier_id: Optional[str]
    category_code: str
    product_line: str
    revenue_channel: Optional[str]
    allocation_rule: str
    confidence: float
    classification_source: str
    rule_id: Optional[str]
    review_status: str
    note: Optional[str] = None


FIXTURE_RULES: List[Rule] = [
    Rule("11111111-1111-4111-8111-111111111111", 10, "CAPEX keywords", r"thi công|cọc thi công|nhà xưởng|tủ ủ bột|máy đánh bột|máy móc|tài sản|đợt 3 thi công", "keyword", None, None, None, "CAPEX_ASSET_PROJECT", "general", None, "none", 0.98),
    Rule("22222222-2222-4222-8222-222222222222", 100, "BMQ bread keywords", r"Tuyết Anh|Vietjet|bánh mì que|bánh mì lớn|bánh mì thịt nguội|pate|chà bông|jambon|giò lụa|chả lụa|mỡ cắt heo|nạc đùi heo|nạc vai heo", "keyword", None, None, None, "COGS_BMQ_BREAD", "bmq_bread", None, "direct", 0.90),
    Rule("33333333-3333-4333-8333-333333333333", 110, "TT FOODS meat items", r"TT FOODS.*(mỡ cắt heo|nạc đùi heo|nạc vai heo|thịt|heo)|(mỡ cắt heo|nạc đùi heo|nạc vai heo|thịt|heo).*TT FOODS", "keyword", None, None, None, "COGS_BMQ_BREAD", "bmq_bread", None, "direct", 0.93),
    Rule("44444444-4444-4444-8444-444444444444", 120, "Thiên An Sinh BMQ fillings", r"Thiên An Sinh.*(chà bông|jambon|giò|chả)|(chà bông|jambon|giò|chả).*Thiên An Sinh", "keyword", None, None, None, "COGS_BMQ_BREAD", "bmq_bread", None, "direct", 0.93),
    Rule("55555555-5555-4555-8555-555555555555", 200, "Sweet kitchen ingredients", r"bơ lạt|Anchor|TH true Butter|cream cheese|creamcheese|phô mai|bột mì|whipping|socola|chocolate|trứng muối|hạnh nhân|nho khô", "keyword", None, None, None, "COGS_SWEET_KITCHEN", "sweet_kitchen", None, "direct", 0.90),
    Rule("66666666-6666-4666-8666-666666666666", 210, "Sweet kitchen supplier context", r"(Đại Tân Việt|Hoàng Minh|Thành Nguyên|Nguyên Hà).*(bơ|Anchor|cream|phô mai|whipping|socola|chocolate)|(bơ|Anchor|cream|phô mai|whipping|socola|chocolate).*(Đại Tân Việt|Hoàng Minh|Thành Nguyên|Nguyên Hà)", "keyword", None, None, None, "COGS_SWEET_KITCHEN", "sweet_kitchen", None, "direct", 0.92),
    Rule("77777777-7777-4777-8777-777777777777", 300, "Packaging shared keywords", r"hộp|khay|tem|nhãn|túi|OPP|kraft|cuộn PE|bao bì", "keyword", None, None, None, "PACKAGING_SALES", "shared", None, "manual", 0.90),
    Rule("88888888-8888-4888-8888-888888888888", 310, "Packaging supplier context", r"(Queen Pack|Siêu Thành|Mỹ Toàn|Ngọc Trân|Cô Trang).*(hộp|khay|tem|nhãn|túi|OPP|kraft|cuộn PE|bao bì)|(hộp|khay|tem|nhãn|túi|OPP|kraft|cuộn PE|bao bì).*(Queen Pack|Siêu Thành|Mỹ Toàn|Ngọc Trân|Cô Trang)", "keyword", None, None, None, "PACKAGING_SALES", "shared", None, "manual", 0.92),
    Rule("99999999-9999-4999-8999-999999999999", 320, "Hoàng Tuấn label materials", r"Hoàng Tuấn.*(tem|nhãn)|(tem|nhãn).*Hoàng Tuấn", "keyword", None, None, None, "PACKAGING_SALES", "shared", None, "manual", 0.92),
    Rule("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 400, "OPEX operation keywords", r"điện|nước|gas|thuê kho|mặt bằng|rác|kiểm toán|vận chuyển|xe|internet", "keyword", None, None, None, "OPEX_GENERAL", "general", None, "none", 0.88),
    Rule("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 500, "Kitchen supply and repair", r"vệ sinh máy lạnh|bảo trì tủ lạnh|nước rửa chén|sửa|bảo trì|CCDC|dụng cụ|văn phòng phẩm bếp/kho", "keyword", None, None, None, "KITCHEN_SUPPLY_REPAIR", "general", None, "none", 0.86),
]


def normalize_text(value: Optional[str]) -> str:
    return " ".join(str(value or "").split())


def rule_matches_line(rule: Rule, line: LineContext, haystack: str) -> bool:
    item_text = normalize_text(" ".join([line.product_name or "", line.product_code or "", line.unit or ""]))
    supplier_text = normalize_text(" ".join([line.supplier_name or "", line.supplier_category or ""]))

    if rule.confidence < MIN_RULE_CONFIDENCE:
        return False
    if rule.match_scope == "sku":
        return bool(rule.sku_id and rule.sku_id == line.sku_id)
    if rule.match_scope == "inventory_item":
        return bool(rule.inventory_item_id and rule.inventory_item_id == line.inventory_item_id)
    if rule.match_scope == "supplier_name":
        return bool(rule.keyword_pattern and re.search(rule.keyword_pattern, supplier_text, flags=re.IGNORECASE))
    if rule.match_scope == "item_text":
        return bool(rule.keyword_pattern and re.search(rule.keyword_pattern, item_text, flags=re.IGNORECASE))
    if rule.match_scope == "supplier_and_item":
        return bool(rule.keyword_pattern and re.search(rule.keyword_pattern, haystack, flags=re.IGNORECASE))
    return bool(rule.keyword_pattern and re.search(rule.keyword_pattern, item_text, flags=re.IGNORECASE))


def classify_line(line: LineContext, rules: Iterable[Rule]) -> Classification:
    haystack = normalize_text(
        " ".join(
            [
                line.supplier_name or "",
                line.supplier_category or "",
                line.product_name or "",
                line.product_code or "",
                line.unit or "",
            ]
        )
    )

    for rule in sorted(rules, key=lambda item: item.priority):
        if rule_matches_line(rule, line, haystack):
            return Classification(
                source_type=line.source_type,
                source_line_id=line.source_line_id,
                payment_request_id=line.payment_request_id,
                invoice_id=line.invoice_id,
                supplier_id=line.supplier_id,
                category_code=rule.category_code,
                product_line=rule.product_line,
                revenue_channel=rule.revenue_channel,
                allocation_rule=rule.allocation_rule,
                confidence=rule.confidence,
                classification_source=rule.source,
                rule_id=rule.id,
                review_status="suggested",
            )

    return Classification(
        source_type=line.source_type,
        source_line_id=line.source_line_id,
        payment_request_id=line.payment_request_id,
        invoice_id=line.invoice_id,
        supplier_id=line.supplier_id,
        category_code=CATEGORY_FALLBACK,
        product_line="general",
        revenue_channel=None,
        allocation_rule="none",
        confidence=0.0,
        classification_source="fallback",
        rule_id=None,
        review_status="needs_review",
    )


def should_preserve(existing: Optional[Dict[str, Any]]) -> bool:
    if not existing:
        return False
    return (
        existing.get("classification_source") in PRESERVED_SOURCES
        or existing.get("review_status") in PRESERVED_REVIEW_STATUSES
    )


def classification_payload(classification: Classification) -> Dict[str, Any]:
    return {key: value for key, value in asdict(classification).items() if value is not None}


def payload_changes(existing: Optional[Dict[str, Any]], payload: Dict[str, Any]) -> bool:
    if not existing:
        return True
    return any(str(existing.get(key)) != str(value) for key, value in payload.items())


class MemoryClassificationStore:
    def __init__(self, existing: Optional[Iterable[Dict[str, Any]]] = None) -> None:
        self.rows: Dict[Tuple[str, str], Dict[str, Any]] = {}
        self.audit_logs: List[Dict[str, Any]] = []
        self.mutated_tables: List[str] = []
        for row in existing or []:
            self.rows[(row["source_type"], row["source_line_id"])] = dict(row)

    def get(self, source_type: str, source_line_id: str) -> Optional[Dict[str, Any]]:
        row = self.rows.get((source_type, source_line_id))
        return dict(row) if row else None

    def upsert_classification(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        self.mutated_tables.append("cost_line_classifications")
        key = (payload["source_type"], payload["source_line_id"])
        existing = self.rows.get(key, {})
        next_row = {**existing, **payload}
        next_row.setdefault("id", f"cls-{payload['source_line_id']}")
        self.rows[key] = next_row
        return dict(next_row)

    def insert_audit_log(self, payload: Dict[str, Any]) -> None:
        self.mutated_tables.append("cost_classification_audit_logs")
        self.audit_logs.append(dict(payload))


class SupabaseRestStore:
    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _request(self, method: str, path: str, body: Optional[Any] = None, prefer: Optional[str] = None) -> Any:
        table = path.split("?", 1)[0].strip("/")
        if method.upper() != "GET" and table not in WRITABLE_TABLES:
            raise RuntimeError(f"Refusing to mutate non-classification table: {table}")

        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {
            "apikey": self.api_key,
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        req = urllib.request.Request(f"{self.base_url}/rest/v1/{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                content = response.read().decode("utf-8")
                return json.loads(content) if content else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8")
            raise RuntimeError(f"Supabase request failed: {exc.code} {detail}") from exc

    def load_active_rules(self) -> List[Rule]:
        rows = self._request_all(
            "cost_classification_rules?select=*&active=eq.true&order=priority.asc",
        )
        return [rule_from_row(row) for row in rows or []]

    def _request_all(self, path: str, page_size: int = 1000) -> List[Dict[str, Any]]:
        rows: List[Dict[str, Any]] = []
        separator = "&" if "?" in path else "?"
        offset = 0
        while True:
            page = self._request("GET", f"{path}{separator}limit={page_size}&offset={offset}") or []
            if not isinstance(page, list):
                raise RuntimeError(f"Expected list response for paginated request: {path}")
            rows.extend(page)
            if len(page) < page_size:
                break
            offset += page_size
        return rows

    def load_line_contexts(self) -> List[LineContext]:
        payment_items = self._request_all("payment_request_items?select=*")
        invoice_items = self._request_all("invoice_items?select=*")

        payment_request_ids = sorted({row.get("payment_request_id") for row in payment_items if row.get("payment_request_id")})
        invoice_ids = sorted({row.get("invoice_id") for row in invoice_items if row.get("invoice_id")})
        payment_requests = rows_by_id(self._get_by_ids("payment_requests", payment_request_ids))
        invoices = rows_by_id(self._get_by_ids("invoices", invoice_ids))

        supplier_ids = sorted(
            {
                supplier_id
                for supplier_id in [
                    *(first_present(row, ["supplier_id", "vendor_id"]) for row in payment_items),
                    *(first_present(row, ["supplier_id", "vendor_id"]) for row in invoice_items),
                    *(first_present(row, ["supplier_id", "vendor_id"]) for row in payment_requests.values()),
                    *(first_present(row, ["supplier_id", "vendor_id"]) for row in invoices.values()),
                ]
                if supplier_id
            }
        )
        suppliers = rows_by_id(self._get_by_ids("suppliers", supplier_ids))

        lines: List[LineContext] = []
        for row in payment_items:
            parent = payment_requests.get(row.get("payment_request_id"), {})
            supplier = suppliers.get(first_present(row, ["supplier_id", "vendor_id"]) or first_present(parent, ["supplier_id", "vendor_id"]) or "", {})
            lines.append(line_from_row("payment_request_item", row, parent, supplier))
        for row in invoice_items:
            parent = invoices.get(row.get("invoice_id"), {})
            supplier = suppliers.get(first_present(row, ["supplier_id", "vendor_id"]) or first_present(parent, ["supplier_id", "vendor_id"]) or "", {})
            lines.append(line_from_row("invoice_item", row, parent, supplier))
        return lines

    def _get_by_ids(self, table: str, ids: Iterable[str]) -> List[Dict[str, Any]]:
        id_list = [str(item) for item in ids if item]
        if not id_list:
            return []
        encoded_ids = ",".join(urllib.parse.quote(item, safe="-") for item in id_list)
        return self._request("GET", f"{table}?select=*&id=in.({encoded_ids})") or []

    def get(self, source_type: str, source_line_id: str) -> Optional[Dict[str, Any]]:
        rows = self._request(
            "GET",
            "cost_line_classifications?select=*&source_type=eq."
            f"{source_type}&source_line_id=eq.{source_line_id}&limit=1",
        )
        return rows[0] if rows else None

    def upsert_classification_with_audit(
        self,
        payload: Dict[str, Any],
        existing: Optional[Dict[str, Any]],
        *,
        action: str,
        actor_id: Optional[str],
    ) -> Dict[str, Any]:
        rows = self._request(
            "POST",
            "rpc/upsert_cost_line_classification_with_audit",
            {
                "_classification": payload,
                "_before": existing,
                "_action": action,
                "_actor_id": actor_id,
            },
        )
        return rows[0] if isinstance(rows, list) else rows

    def upsert_classification(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        rows = self._request(
            "POST",
            "cost_line_classifications?on_conflict=source_type,source_line_id",
            [payload],
            prefer="resolution=merge-duplicates,return=representation",
        )
        return rows[0]

    def insert_audit_log(self, payload: Dict[str, Any]) -> None:
        self._request("POST", "cost_classification_audit_logs", [payload], prefer="return=minimal")


def apply_classification(
    store: Any,
    classification: Classification,
    *,
    dry_run: bool,
    actor_id: Optional[str] = None,
) -> str:
    existing = store.get(classification.source_type, classification.source_line_id)
    if should_preserve(existing):
        return "preserved"

    if dry_run:
        return "would_create" if not existing else "would_update"

    payload = classification_payload(classification)
    changed = payload_changes(existing, payload)
    if not changed:
        return "unchanged"

    action = "created_by_backfill" if not existing else "updated_by_rule_refresh"
    if hasattr(store, "upsert_classification_with_audit"):
        store.upsert_classification_with_audit(payload, existing, action=action, actor_id=actor_id)
        return "created" if not existing else "updated"

    written = store.upsert_classification(payload)
    store.insert_audit_log(
            {
                "classification_id": written.get("id"),
                "source_type": classification.source_type,
                "source_line_id": classification.source_line_id,
                "action": "created_by_backfill" if not existing else "updated_by_rule_refresh",
                "before": existing,
                "after": payload,
                "reason": "cost_classification_phase1_backfill",
                "actor_id": actor_id,
            }
        )
    return "created" if not existing else ("updated" if changed else "unchanged")


def fixture_lines() -> List[LineContext]:
    return [
        LineContext("payment_request_item", "00000000-0000-0000-0000-000000000001", "Máy đánh bột cho bánh mì que", supplier_name="Nhà thầu thi công", payment_request_id="10000000-0000-0000-0000-000000000001", line_total=Decimal("120000000")),
        LineContext("payment_request_item", "00000000-0000-0000-0000-000000000002", "Nạc vai heo", supplier_name="TT FOODS", payment_request_id="10000000-0000-0000-0000-000000000002", line_total=Decimal("25000000")),
        LineContext("payment_request_item", "00000000-0000-0000-0000-000000000003", "Anchor bơ lạt", supplier_name="Thành Nguyên", payment_request_id="10000000-0000-0000-0000-000000000003", line_total=Decimal("18000000")),
        LineContext("payment_request_item", "00000000-0000-0000-0000-000000000004", "Hộp kraft và tem nhãn", supplier_name="Queen Pack", payment_request_id="10000000-0000-0000-0000-000000000004", line_total=Decimal("9000000")),
        LineContext("payment_request_item", "00000000-0000-0000-0000-000000000005", "Tiền điện xưởng", supplier_name="EVN", payment_request_id="10000000-0000-0000-0000-000000000005", line_total=Decimal("7000000")),
        LineContext("invoice_item", "00000000-0000-0000-0000-000000000006", "Chi phí lặt vặt", supplier_name="Khác", invoice_id="20000000-0000-0000-0000-000000000006", line_total=Decimal("3000000")),
    ]


def first_present(row: Dict[str, Any], keys: Iterable[str]) -> Optional[Any]:
    for key in keys:
        value = row.get(key)
        if value is not None and value != "":
            return value
    return None


def decimal_from_row(row: Dict[str, Any], keys: Iterable[str], default: str) -> Decimal:
    value = first_present(row, keys)
    return Decimal(str(value if value is not None else default))


def rows_by_id(rows: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {str(row["id"]): row for row in rows if row.get("id")}


def rule_from_row(row: Dict[str, Any]) -> Rule:
    return Rule(
        id=str(row["id"]),
        priority=int(row.get("priority") or 0),
        rule_name=str(row.get("rule_name") or row.get("name") or row["id"]),
        keyword_pattern=first_present(row, ["keyword_pattern", "pattern"]),
        match_scope=str(row.get("match_scope") or "keyword"),
        supplier_id=first_present(row, ["supplier_id"]),
        inventory_item_id=first_present(row, ["inventory_item_id"]),
        sku_id=first_present(row, ["sku_id"]),
        category_code=str(row["category_code"]),
        product_line=str(row.get("product_line") or "general"),
        revenue_channel=first_present(row, ["revenue_channel"]),
        allocation_rule=str(row.get("allocation_rule") or "none"),
        confidence=float(row.get("confidence") or 0),
    )


def line_from_row(source_type: str, row: Dict[str, Any], parent: Dict[str, Any], supplier: Dict[str, Any]) -> LineContext:
    supplier_id = first_present(row, ["supplier_id", "vendor_id"]) or first_present(parent, ["supplier_id", "vendor_id"])
    return LineContext(
        source_type=source_type,
        source_line_id=str(row["id"]),
        product_name=str(first_present(row, ["product_name", "item_name", "description", "name"]) or ""),
        product_code=first_present(row, ["product_code", "item_code", "sku_code", "code"]),
        unit=first_present(row, ["unit", "unit_name", "uom"]),
        quantity=decimal_from_row(row, ["quantity", "qty"], "1"),
        unit_price=decimal_from_row(row, ["unit_price", "price"], "0"),
        line_total=(
            decimal_from_row(row, ["line_total", "total_amount", "amount"], "0")
            if first_present(row, ["line_total", "total_amount", "amount"]) is not None
            else None
        ),
        supplier_id=str(supplier_id) if supplier_id else None,
        supplier_name=first_present(supplier, ["name", "supplier_name", "company_name"]) or first_present(parent, ["supplier_name", "vendor_name"]),
        supplier_category=first_present(supplier, ["category", "supplier_category"]),
        sku_id=first_present(row, ["sku_id"]),
        inventory_item_id=first_present(row, ["inventory_item_id"]),
        payment_request_id=str(row.get("payment_request_id")) if source_type == "payment_request_item" and row.get("payment_request_id") else None,
        invoice_id=str(row.get("invoice_id")) if source_type == "invoice_item" and row.get("invoice_id") else None,
    )


def summarize(
    lines: Iterable[LineContext],
    rules: Iterable[Rule],
    store: Any,
    dry_run: bool,
    actor_id: Optional[str] = None,
) -> Dict[str, Any]:
    summary: Dict[str, Any] = {
        "dry_run": dry_run,
        "total_lines_scanned": 0,
        "by_category": {},
        "actions": {},
        "top_unmapped": [],
        "capex_examples": [],
    }
    unmapped: List[Dict[str, Any]] = []

    for line in lines:
        classification = classify_line(line, rules)
        action = apply_classification(store, classification, dry_run=dry_run, actor_id=actor_id)
        category = summary["by_category"].setdefault(
            classification.category_code,
            {"line_count": 0, "total_amount": Decimal("0")},
        )
        category["line_count"] += 1
        category["total_amount"] += line.amount
        summary["actions"][action] = summary["actions"].get(action, 0) + 1
        summary["total_lines_scanned"] += 1

        if classification.category_code == CATEGORY_FALLBACK:
            unmapped.append({"source_line_id": line.source_line_id, "item": line.product_name, "amount": line.amount})
        if classification.category_code == "CAPEX_ASSET_PROJECT":
            summary["capex_examples"].append({"source_line_id": line.source_line_id, "item": line.product_name, "amount": line.amount})

    summary["top_unmapped"] = sorted(unmapped, key=lambda row: row["amount"], reverse=True)[:50]
    for data in summary["by_category"].values():
        data["total_amount"] = str(data["total_amount"])
    for row in summary["top_unmapped"]:
        row["amount"] = str(row["amount"])
    for row in summary["capex_examples"]:
        row["amount"] = str(row["amount"])
    return summary


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="BMQ cost classification Phase 1 backfill")
    parser.add_argument("--fixture", action="store_true", help="Use deterministic in-memory fixture data")
    parser.add_argument("--dry-run", action="store_true", default=True, help="Preview only; this is the default")
    parser.add_argument("--write", action="store_true", help="Enable guarded writes to classification tables")
    parser.add_argument("--confirm-classification-write", action="store_true", help="Required with --write")
    parser.add_argument("--actor-id", help="Actor UUID for audit logs in write mode")
    return parser.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    dry_run = not args.write
    if args.write and not args.confirm_classification_write:
        print("Refusing write mode without --confirm-classification-write", file=sys.stderr)
        return 2

    if args.fixture:
        store: Any = MemoryClassificationStore()
        lines = fixture_lines()
        rules = FIXTURE_RULES
    else:
        url = os.environ.get("SUPABASE_URL")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            print("Supabase mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.", file=sys.stderr)
            return 2
        store = SupabaseRestStore(url, key)
        rules = store.load_active_rules()
        if not rules:
            print("No active cost classification rules were loaded from Supabase.", file=sys.stderr)
            return 2
        lines = store.load_line_contexts()

    report = summarize(lines, rules, store, dry_run=dry_run, actor_id=args.actor_id)
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
