#!/usr/bin/env python3
"""Static contract checks for the approved cost category tree.

These checks never connect to a database or Supabase and never run the
migration. They guard that 20261102350000_cost_category_tree.sql:
  * adds the nullable sushi_hint column;
  * upserts exactly four parents and their 24 leaves with the approved codes,
    parents, cost groups, product lines and hints;
  * keeps the six old codes but deactivates them, and deactivates the rules
    that point at an inactive category;
  * never deletes a category and never runs top-level DML on a business table;
  * exposes the 6-argument writer to service_role only, refuses parent codes and
    writes an explicit product line when it is one of the three approved values;
  * keeps manual_override / approved rows out of the candidate reader while
    re-asking inactive-category and pre-tree Sushi UNMAPPED_REVIEW rows.
"""
from __future__ import annotations

import pathlib
import re

MIGRATION = (
    pathlib.Path(__file__).resolve().parents[1]
    / "supabase"
    / "migrations"
    / "20261102350000_cost_category_tree.sql"
)

ALLOWED_GROUPS = {"cogs", "packaging", "opex", "capex", "kitchen_supply", "unmapped"}

PARENTS = {
    "A_COGS": ("Giá vốn hàng bán", "cogs", 100),
    "B_SELLING": ("Chi phí bán hàng", "opex", 200),
    "C_OPERATING": ("Chi phí vận hành, quản lý", "opex", 300),
    "D_INVESTMENT": ("Đầu tư (khấu hao)", "capex", 400),
}

# code: (parent, cost_group, allocation_rule, sort_order)
LEAVES = {
    "A1_BREAD_BOUGHT": ("A_COGS", "cogs", "direct", 101),
    "A2_MEAT_OFFAL": ("A_COGS", "cogs", "direct", 102),
    "A3_FLOSS_FILLING": ("A_COGS", "cogs", "direct", 103),
    "A4_DAIRY_EGG": ("A_COGS", "cogs", "direct", 104),
    "A5_DRY_SPICE": ("A_COGS", "cogs", "direct", 105),
    "A6_FRESH_PRODUCE": ("A_COGS", "cogs", "direct", 106),
    "A7_PACKAGING": ("A_COGS", "packaging", "manual", 107),
    "B1_DELIVERY": ("B_SELLING", "opex", "none", 201),
    "B2_KIOSK_RENT": ("B_SELLING", "opex", "none", 202),
    "B3_MARKETING": ("B_SELLING", "opex", "none", 203),
    "B4_PLATFORM_FEE": ("B_SELLING", "opex", "none", 204),
    "C1_WAREHOUSE_RENT": ("C_OPERATING", "opex", "none", 301),
    "C2_ELECTRICITY": ("C_OPERATING", "opex", "none", 302),
    "C3_WATER_WASTE": ("C_OPERATING", "opex", "none", 303),
    "C4_GAS": ("C_OPERATING", "opex", "none", 304),
    "C5_TELECOM": ("C_OPERATING", "opex", "none", 305),
    "C6_PAYROLL": ("C_OPERATING", "opex", "none", 306),
    "C7_SOCIAL_INSURANCE": ("C_OPERATING", "opex", "none", 307),
    "C8_REPAIR": ("C_OPERATING", "kitchen_supply", "none", 308),
    "C9_TOOLS_CLEANING": ("C_OPERATING", "kitchen_supply", "none", 309),
    "C10_ONE_OFF": ("C_OPERATING", "opex", "none", 310),
    "C11_BANK_TAX_OTHER": ("C_OPERATING", "opex", "none", 311),
    "D1_CONSTRUCTION": ("D_INVESTMENT", "capex", "none", 401),
    "D2_EQUIPMENT": ("D_INVESTMENT", "capex", "none", 402),
}

OLD_CODES = {
    "COGS_BMQ_BREAD",
    "COGS_SWEET_KITCHEN",
    "PACKAGING_SALES",
    "OPEX_GENERAL",
    "KITCHEN_SUPPLY_REPAIR",
    "CAPEX_ASSET_PROJECT",
}

BUSINESS_TABLES = {
    "cost_line_classifications",
    "payment_requests",
    "payment_request_items",
    "invoices",
    "invoice_items",
    "payments",
}


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def flatten(sql: str) -> str:
    return re.sub(r"\s+", " ", sql.lower())


def iter_tuples(text: str):
    """Yield the raw text inside each top-level (...) group, quote-aware."""
    depth = 0
    start = None
    in_quote = False
    index = 0
    while index < len(text):
        char = text[index]
        if in_quote:
            if char == "'":
                if index + 1 < len(text) and text[index + 1] == "'":
                    index += 2
                    continue
                in_quote = False
        else:
            if char == "'":
                in_quote = True
            elif char == "(":
                if depth == 0:
                    start = index + 1
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0 and start is not None:
                    yield text[start:index]
                    start = None
        index += 1


def split_fields(text: str) -> list[str]:
    fields: list[str] = []
    current: list[str] = []
    in_quote = False
    index = 0
    while index < len(text):
        char = text[index]
        if in_quote:
            current.append(char)
            if char == "'":
                if index + 1 < len(text) and text[index + 1] == "'":
                    current.append(text[index + 1])
                    index += 2
                    continue
                in_quote = False
        else:
            if char == "'":
                in_quote = True
                current.append(char)
            elif char == ",":
                fields.append("".join(current).strip())
                current = []
            else:
                current.append(char)
        index += 1
    if "".join(current).strip() != "":
        fields.append("".join(current).strip())
    return fields


def parse_value(raw: str):
    value = raw.strip()
    lowered = value.lower()
    if lowered == "null":
        return None
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    try:
        return int(value)
    except ValueError:
        return value


def category_rows(sql: str) -> dict[str, dict[str, object]]:
    rows: dict[str, dict[str, object]] = {}
    pattern = re.compile(
        r"insert\s+into\s+public\.cost_categories\s*\((.*?)\)\s*values\s*(.*?)\s*on\s+conflict",
        re.IGNORECASE | re.DOTALL,
    )
    for statement in pattern.finditer(sql):
        columns = [column.strip() for column in statement.group(1).split(",")]
        for tuple_text in iter_tuples(statement.group(2)):
            values = [parse_value(field) for field in split_fields(tuple_text)]
            assert_true(len(values) == len(columns), f"category row width: {tuple_text}")
            row = dict(zip(columns, values))
            code = str(row.get("code", ""))
            assert_true(code != "", f"category row without code: {tuple_text}")
            rows[code] = row
    return rows


def function_sql(sql: str, signature: str) -> str:
    start = sql.lower().index(signature.lower())
    end = sql.index("$$;", start) + len("$$;")
    return sql[start:end]


def main() -> None:
    assert_true(MIGRATION.exists(), "migration 20261102350000_cost_category_tree.sql must exist")
    sql = MIGRATION.read_text(encoding="utf-8")
    flat = flatten(sql)

    # --- 1. hint column ---
    assert_true(
        "add column if not exists sushi_hint text" in flat,
        "cost_categories.sushi_hint must be added as a nullable text column",
    )

    rows = category_rows(sql)
    assert_true(len(PARENTS) == 4, "the contract expects four parents")
    assert_true(len(LEAVES) == 24, "the contract expects 24 leaves")

    # --- 2. parents ---
    for code, (label, cost_group, sort_order) in PARENTS.items():
        assert_true(code in rows, f"parent {code} must be upserted")
        row = rows[code]
        assert_true(row["label"] == label, f"{code} label: {row['label']!r}")
        assert_true(row["parent_code"] is None, f"{code} must have no parent")
        assert_true(row["cost_group"] == cost_group, f"{code} cost_group: {row['cost_group']!r}")
        assert_true(row["product_line"] == "shared", f"{code} product_line must be shared")
        assert_true(row["allocation_rule"] == "none", f"{code} allocation_rule must be none")
        assert_true(row["sushi_hint"] is None, f"{code} parent must not carry a leaf hint")
        assert_true(row["is_active"] is True, f"{code} must be active")
        assert_true(row["sort_order"] == sort_order, f"{code} sort_order: {row['sort_order']!r}")

    # --- 3. leaves ---
    inserted_leaf_codes = set(rows) - set(PARENTS)
    assert_true(inserted_leaf_codes == set(LEAVES), f"leaf codes: {sorted(inserted_leaf_codes)}")
    for code, (parent, cost_group, allocation_rule, sort_order) in LEAVES.items():
        row = rows[code]
        assert_true(row["parent_code"] == parent, f"{code} parent: {row['parent_code']!r}")
        assert_true(row["cost_group"] == cost_group, f"{code} cost_group: {row['cost_group']!r}")
        assert_true(
            row["cost_group"] in ALLOWED_GROUPS,
            f"{code} cost_group {row['cost_group']!r} is not in the live check list",
        )
        assert_true(row["product_line"] == "shared", f"{code} product_line must be shared")
        assert_true(
            row["allocation_rule"] == allocation_rule,
            f"{code} allocation_rule: {row['allocation_rule']!r}",
        )
        assert_true(row["is_active"] is True, f"{code} must be active")
        assert_true(row["sort_order"] == sort_order, f"{code} sort_order: {row['sort_order']!r}")
        hint = row["sushi_hint"]
        assert_true(isinstance(hint, str) and hint.strip() != "", f"{code} needs a non-empty sushi_hint")

    # --- 4. old codes: deactivated, never deleted ---
    for code in OLD_CODES:
        assert_true(code not in rows, f"{code} is an old code and must not be re-upserted")
    deactivate = re.search(
        r"update\s+public\.cost_categories\s+set\s+.*?where\s+code\s+in\s*\((.*?)\)",
        sql,
        re.IGNORECASE | re.DOTALL,
    )
    assert_true(deactivate is not None, "the six old codes must be deactivated")
    assert_true("is_active = false" in deactivate.group(0).lower(), "old codes must set is_active = false")
    deactivated = {value.strip().strip("'") for value in deactivate.group(1).split(",")}
    assert_true(deactivated == OLD_CODES, f"deactivated old codes: {sorted(deactivated)}")
    assert_true("unmapped_review" not in flat.split("where code in (", 1)[-1].split(")", 1)[0],
                "UNMAPPED_REVIEW must stay active")
    assert_true("delete from public.cost_categories" not in flat, "categories must never be deleted")

    # --- 5. rules on inactive categories ---
    assert_true(
        "update public.cost_classification_rules r set active = false" in flat,
        "rules on inactive codes must be deactivated",
    )
    rules_update = flat[flat.index("update public.cost_classification_rules") :]
    rules_update = rules_update[: rules_update.index(";")]
    for fragment in ("set active = false", "from public.cost_categories cc", "cc.code = r.category_code",
                     "cc.is_active = false"):
        assert_true(fragment in rules_update, f"rule deactivation must contain {fragment}")

    # --- 6. no top-level DML on a business table ---
    without_functions = re.sub(
        r"create\s+or\s+replace\s+function\s+public\.\w+\s*\(.*?\n\$\$;",
        "",
        sql,
        flags=re.IGNORECASE | re.DOTALL,
    )
    top_level_targets = {
        match.group(1).lower()
        for match in re.finditer(
            r"\b(?:insert\s+into|update|delete\s+from)\s+public\.(\w+)",
            without_functions,
            re.IGNORECASE,
        )
    }
    forbidden = top_level_targets & BUSINESS_TABLES
    assert_true(not forbidden, f"top-level DML must not touch business tables, got {sorted(forbidden)}")
    assert_true(
        top_level_targets <= {"cost_categories", "cost_classification_rules"},
        f"top-level DML targets: {sorted(top_level_targets)}",
    )

    # --- 7. the new writer ---
    assert_true(
        "drop function if exists public.robot_apply_cost_classification(text, uuid, text, numeric, text);" in flat,
        "the 5-argument writer must be dropped first",
    )
    apply_sql = function_sql(sql, "create or replace function public.robot_apply_cost_classification(")
    apply_flat = flatten(apply_sql)
    for fragment in (
        "p_product_line text default null",
        "security definer",
        "set search_path = public, pg_temp",
        "auth.role()",
        "'service_role'",
        "child.parent_code = v_category.code",
        "child.is_active",
        "'invalid_category'",
        "p_product_line in ('bmq_bread', 'sweet_kitchen', 'shared')",
        "v_category.product_line",
        "product_line = v_product_line",
        "manual_override",
        "review_status = 'approved'",
        "for update",
        "'cap_reached'",
        "insert into public.cost_classification_audit_logs",
        "insert into public.robot_auto_actions",
        "classification_source = 'sushi'",
    ):
        assert_true(fragment in apply_flat, f"apply RPC must contain {fragment}")

    signature = "public.robot_apply_cost_classification(text, uuid, text, numeric, text, text)"
    assert_true(
        f"revoke all on function {signature} from public, anon, authenticated;" in flat,
        "the new apply RPC must be revoked from public/anon/authenticated",
    )
    assert_true(
        f"grant execute on function {signature} to service_role;" in flat,
        "the new apply RPC must grant execute to service_role",
    )
    assert_true(
        f"grant execute on function {signature} to authenticated;" not in flat,
        "the new apply RPC must never be granted to authenticated",
    )
    assert_true(
        f"grant execute on function {signature} to anon;" not in flat,
        "the new apply RPC must never be granted to anon",
    )

    # --- 8. the candidate reader ---
    candidates_sql = function_sql(sql, "create or replace function public.cost_classify_sushi_candidates(")
    candidates_flat = flatten(candidates_sql)
    for fragment in (
        "security definer",
        "set search_path = public, pg_temp",
        "auth.role()",
        "clc.id is null",
        "clc.classification_source <> 'manual_override'",
        "clc.review_status <> 'approved'",
        "cc.is_active = false",
        "clc.classification_source in ('fallback', 'rule')",
        "clc.classification_source = 'sushi'",
        "clc.updated_at <",
        "max(greatest(cc2.created_at, cc2.updated_at))",
        "left join public.cost_categories cc on cc.code = clc.category_code",
        "order by c.document_date desc nulls last",
        "limit greatest(1, least(coalesce(p_limit, 50), 50))",
    ):
        assert_true(fragment in candidates_flat, f"candidate reader must contain {fragment}")
    assert_true(
        "revoke all on function public.cost_classify_sushi_candidates(int) from public, anon, authenticated;" in flat,
        "candidate reader must be revoked from public/anon/authenticated",
    )
    assert_true(
        "grant execute on function public.cost_classify_sushi_candidates(int) to service_role;" in flat,
        "candidate reader must grant execute to service_role only",
    )

    # --- 9. the paid-PR rule pass skips Sushi rows ---
    paid_sql = function_sql(sql, "create or replace function public.classify_paid_payment_request(")
    paid_flat = flatten(paid_sql)
    assert_true(
        "existing_row.classification_source = 'manual_override' or existing_row.classification_source = 'sushi' or existing_row.review_status = 'approved'"
        in paid_flat,
        "classify_paid_payment_request must skip sushi rows as well as manual/approved",
    )

    print("cost_category_tree contract: OK")


if __name__ == "__main__":
    main()
