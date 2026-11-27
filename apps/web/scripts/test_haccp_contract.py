#!/usr/bin/env python3
"""Static contract checks for the HACCP dossier data layer.

Run from apps/web:
    python3 scripts/test_haccp_contract.py

The repository has no local database in CI, so this test guards the properties
that must survive review: the seven schema tables, RLS + anon denial, manager
permissions, the private bucket, hash-only links, the service_role-only link
RPCs, the payroll projection with no salary columns, and the export/upload
contract. It exits non-zero on the first broken invariant.
"""

from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261128100000_haccp_dossier.sql"
CONFIG = ROOT / "supabase/config.toml"
SCHEMA = ROOT / "src/lib/haccp-schema.ts"
EXPORT = ROOT / "src/lib/haccp-export.ts"
API = ROOT / "src/lib/haccp-api.ts"
HOOK = ROOT / "src/hooks/useHaccp.ts"
HANDLER = ROOT / "supabase/functions/haccp-upload/handler.ts"
INDEX = ROOT / "supabase/functions/haccp-upload/index.ts"
TEMPLATE = ROOT / "src/assets/haccp/haccp-q7-template.xlsx"

TABLES = ["haccp_entries", "haccp_files", "haccp_upload_links"]
TABLE_IDS = ["suppliers", "team", "staff", "measure", "machines", "chemicals", "process"]
SECTIONS = ["suppliers", "people", "measure", "machines", "chemicals", "process", "layout"]
SHEETS = [
    "Thông tin NCC",
    "ĐỘI HACCP",
    "Danh sách thiết bị đo lường",
    "Danh mục máy móc thiết bị ",
    "Danh muc hoa chat",
    "Quy trình sản xuất",
    "Layout nhà xưởng",
]

failures: list[str] = []
checks = 0


def check(condition: bool, message: str) -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(message)


def read(path: Path) -> str:
    check(path.is_file(), f"missing file: {path.relative_to(ROOT)}")
    return path.read_text(encoding="utf-8") if path.is_file() else ""


sql = read(MIGRATION)
config = read(CONFIG)
schema = read(SCHEMA)
export = read(EXPORT)
api = read(API)
hook = read(HOOK)
handler = read(HANDLER)
index = read(INDEX)

# ---------------------------------------------------------------------------
# Seven dossier tables and their RLS/anon posture
# ---------------------------------------------------------------------------
for table in TABLES:
    check(
        re.search(rf"create table if not exists public\.{table}\b", sql) is not None,
        f"{table}: table is not created",
    )
    check(
        f"alter table public.{table} enable row level security;" in sql,
        f"{table}: RLS is not enabled",
    )
    check(
        f"revoke all on table public.{table} from public, anon, authenticated;" in sql,
        f"{table}: anon/authenticated direct grants are not revoked",
    )

check("create policy haccp_entries_select" in sql, "entries: missing select policy")
check("public.haccp_can_manage((select auth.uid()))" in sql, "policies: manager gate is missing")
check(
    "public.has_role(p_actor, 'owner') or public.kho_item_can_edit(p_actor)" in sql,
    "manager gate must be owner OR kho_item_can_edit",
)

# ---------------------------------------------------------------------------
# Value shape, length limits, source key uniqueness, soft delete, version
# ---------------------------------------------------------------------------
for table_id in TABLE_IDS:
    check(f"when '{table_id}' then" in sql, f"values guard: missing {table_id} key whitelist")

check('constraint haccp_entries_source_key_key unique (source_key)' in sql, "entries: source_key is not unique")
check('constraint haccp_entries_values_object_check check (jsonb_typeof("values") = \'object\')' in sql, "entries: values must be an object")
check("v_limit :=" in sql and "length(v_value #>> '{}') > v_limit" in sql, "entries: value length is not bounded")
check("new.version + 1" not in sql and "e.version + 1" in sql, "entries: version is not incremented on update")
check("and e.version = p_version" in sql, "entries: updates do not check the client version")
check("deleted_at" in sql and "coalesce(e.deleted_at, now())" in sql, "entries: soft delete is missing")
check("on conflict (source_key) do nothing" in sql, "prefill must not overwrite or duplicate a source row")

# ---------------------------------------------------------------------------
# Private bucket + storage policies
# ---------------------------------------------------------------------------
check("'haccp-docs'" in sql, "missing haccp-docs bucket")
check(re.search(r"'haccp-docs',\s*\n\s*'haccp-docs',\s*\n\s*false,", sql) is not None, "haccp-docs bucket must be private")
check("10485760" in sql, "bucket size limit must be 10 MB")
check("create policy haccp_docs_select" in sql and "create policy haccp_docs_insert" in sql, "missing storage policies")
check("to anon" not in sql, "storage policies must not grant anon")

# ---------------------------------------------------------------------------
# Link security: 32 random bytes, SHA-256 only, 7/30/90 days, revoke
# ---------------------------------------------------------------------------
check("gen_random_bytes(32)" in sql, "link token must be 32 random bytes")
check("extensions.digest(convert_to(v_token, 'UTF8'), 'sha256')" in sql, "link token must be hashed with SHA-256")
check("token_hash text not null unique" in sql and "token_hash ~ '^[0-9a-f]{64}$'" in sql, "only the 64-char hash may be stored")
check("check (days in (7, 30, 90))" in sql, "link lifetime must be 7/30/90 days")
check("revoked_at" in sql and "l.revoked_at is null and l.expires_at > now()" in sql, "revocation/expiry gate is missing")
check("if v_link.expires_at <= now() then" in sql, "link access does not check expiry")
check("if v_link.revoked_at is not null then" in sql, "link access does not check revocation")
check("request_id uuid unique" in sql, "link creation is not idempotent by request_id")
check("perform pg_advisory_xact_lock(hashtext('haccp:' || p_request_id::text))" in sql, "write RPCs must serialize a request_id")

for function in [
    "haccp_link_access",
    "haccp_link_require",
    "haccp_link_snapshot",
    "haccp_link_save_entry",
    "haccp_link_delete_entry",
    "haccp_link_add_file",
    "haccp_link_delete_file",
]:
    grant = re.search(
        rf"grant execute on function public\.{function}\([^)]*\) to ([^;]+);",
        sql,
    )
    check(grant is not None and "service_role" in grant.group(1), f"{function}: must be service_role-only")
    check(grant is not None and "authenticated" not in grant.group(1), f"{function}: must not be granted to authenticated")

# ---------------------------------------------------------------------------
# Prefill: supplier facts, payroll name/department only, cleaning chemicals
# ---------------------------------------------------------------------------
check("p_table_id = 'suppliers'" in sql, "prefill: suppliers branch missing")
check("gr.status in ('confirmed', 'received')" in sql, "prefill: supplier receipts must be confirmed/received")
check("gr.receipt_date >= current_date - 180" in sql, "prefill: supplier window must be 180 days")
check("coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao') = 'q7'" in sql, "prefill: legacy Q7 receipts missing")
check("q7_item.pastry_q7 = true" in sql, "prefill: central receipts for pastry_q7 items must count as Q7 supply")
check("q7_item.id = public.kho_receipt_line_item(gri.id)" in sql, "prefill: receipt lines must resolve to the kitchen item")
check("gri.product_name" in sql, "prefill: supplier item names missing")
check("s.phone" in sql and "s.address" in sql and "s.contact_name" in sql, "prefill: supplier phone/address/contact missing")

supplier_block = re.search(r"if p_table_id = 'suppliers' then(.*?)elsif p_table_id = 'staff' then", sql, re.S)
check(supplier_block is not None, "prefill: cannot isolate the supplier branch")
if supplier_block:
    block = supplier_block.group(1)
    check("left(coalesce(n.name, ''), 1000)" in block, "prefill suppliers: name is not truncated")
    check("left(coalesce(n.items, ''), 1000)" in block, "prefill suppliers: items is not truncated")
    check("left(coalesce(n.phone, ''), 40)" in block, "prefill suppliers: phone is not truncated")
    check("left(coalesce(n.address, ''), 1000)" in block, "prefill suppliers: address is not truncated")
    check("left(coalesce(n.contact_name, ''), 1000)" in block, "prefill suppliers: contact is not truncated")

check("p_table_id = 'staff'" in sql, "prefill: staff branch missing")
check("p.date_to desc" in sql and "limit 1" in sql, "prefill: latest payroll period missing")
check("e.group_name = 'Bếp bánh'" in sql, "prefill: staff must be the Bếp bánh group")
check("p_table_id = 'chemicals'" in sql, "prefill: chemicals branch missing")
check("kii.active = true" in sql, "prefill: chemicals must be active stock items")
check("tẩy rửa" in sql and "cồn" in sql and "khử trùng" in sql, "prefill: cleaning-chemical name matcher missing")

staff_block = re.search(r"elsif p_table_id = 'staff' then(.*?)elsif p_table_id = 'chemicals' then", sql, re.S)
check(staff_block is not None, "prefill: cannot isolate the staff branch")
if staff_block:
    block = staff_block.group(1)
    for forbidden in ["monthly_salary", "daily_rate", "hourly_rate", "allowance", "phone", "salary"]:
        check(forbidden not in block, f"prefill staff branch leaks forbidden payroll field: {forbidden}")
    check("e.employee_name" in block, "prefill staff branch must select the employee name")
    check("e.group_name" in block, "prefill staff branch must select the department")
    check("left(coalesce(p.employee_name, ''), 1000)" in block, "prefill staff: name is not truncated")
    check("left(coalesce(p.department, ''), 1000)" in block, "prefill staff: department is not truncated")

chemicals_block = re.search(r"elsif p_table_id = 'chemicals' then(.*?)else\n\s*raise exception 'invalid_table_id'", sql, re.S)
check(chemicals_block is not None, "prefill: cannot isolate the chemicals branch")
if chemicals_block:
    check("left(coalesce(m.name, ''), 1000)" in chemicals_block.group(1), "prefill chemicals: name is not truncated")

# Deleting must name the acting person, not the original editor/uploader.
check("p_who text default null" in sql, "delete RPCs must accept the acting name")
check("v_who text := coalesce(" in sql, "delete RPCs must resolve the acting name")
check("return public.haccp_delete_entry(p_id, p_version, p_request_id, p_who)" in sql, "link delete row drops the acting name")
check("return public.haccp_delete_file(p_file_id, p_request_id, p_who)" in sql, "link delete file drops the acting name")
check("v_file.uploaded_by_name" not in sql, "delete_file still logs the uploader")

# Attachment changes must bump the entry version so an older dialog cannot
# silently delete a photo another person just added.
add_file_block = re.search(r"create or replace function public\.haccp_add_file(.*?)create or replace function public\.haccp_delete_file", sql, re.S)
check(add_file_block is not None, "cannot isolate haccp_add_file")
if add_file_block:
    check("set version = e.version + 1" in add_file_block.group(1), "add_file does not bump the entry version")
delete_file_block = re.search(r"create or replace function public\.haccp_delete_file(.*?)-- 10\. Prefill", sql, re.S)
check(delete_file_block is not None, "cannot isolate haccp_delete_file")
if delete_file_block:
    check("set version = e.version + 1" in delete_file_block.group(1), "delete_file does not bump the entry version")

# The migration must never write to source systems.
for statement in ["insert into public.suppliers", "update public.suppliers", "delete from public.suppliers",
                  "insert into public.goods_receipts", "update public.goods_receipts", "delete from public.goods_receipts",
                  "insert into public.kitchen_inventory_items", "update public.kitchen_inventory_items",
                  "insert into public.payroll_bn_period_employees", "update public.payroll_bn_period_employees"]:
    check(statement not in sql, f"migration must not write source data: {statement}")

# ---------------------------------------------------------------------------
# Edge config + handler contract
# ---------------------------------------------------------------------------
check("[functions.haccp-upload]" in config, "config.toml lacks haccp-upload")
upload_config = re.search(r"\[functions\.haccp-upload\](.*?)(?:\n\[|\Z)", config, re.S)
check(upload_config is not None and "verify_jwt = false" in upload_config.group(1), "haccp-upload must set verify_jwt=false")

check("from \"../_shared/cors.ts\"" in handler, "handler must use the shared CORS helper")
check("https://esm.sh" not in handler and "npm:" not in handler, "handler must not import from remote")
check("HACCP_MAX_BYTES = 10 * 1024 * 1024" in handler, "handler must cap files at 10 MB")
check("HACCP_TOKEN_PATTERN = /^[0-9a-f]{64}$/" in handler, "handler must require a 32-byte hex token")
check("sha256Hex" in handler and "resolveLink" in handler, "handler must hash the token and resolve it")
check("detectFileKind" in handler and "mimeMatchesKind" in handler, "handler must check leading file bytes")
for mime in ["image/jpeg", "image/png", "image/webp", "application/pdf", "wordprocessingml", "spreadsheetml"]:
    check(mime in handler, f"handler: missing accepted type {mime}")
check("writesPerHour" in handler and "readsPer15Minutes" in handler, "handler: rate limit missing")
check("options.writesPerHour ?? 600" in handler, "handler: bulk-entry write limit is too low")
check("Cache-Control\": \"no-store\"" in handler, "handler: no-store header missing")
check("key === \"phone\" ? 40 : 1000" in handler, "handler: supplier phone limit must be 40")
check('"invalid_values"' in handler, "handler: invalid_values must be a clear error")
check("path: file.path" in handler or "path," in handler, "index should pass storage paths to the handler")
check("haccp_link_save_entry" in index and "haccp_link_snapshot" in index, "index must call the link RPCs")
check(index.count("p_who: input.who") >= 2, "index must pass the acting name on both delete RPCs")

check("replace(/\\.{2,}/g, \".\")" in api, "manager upload path must collapse consecutive dots")
check("readStaffName" in api and "bmq-haccp-staff-name" in api, "link deletes must fall back to the staff name")
check("validateValues" in api and "40" in api, "manager save must validate the supplier phone limit")
check("fetchQuery" in hook and "attachment_missing" in hook, "ZIP export must refetch and fail on missing files")

# ---------------------------------------------------------------------------
# Export + schema contract
# ---------------------------------------------------------------------------
for table_id in TABLE_IDS:
    check(f'"{table_id}"' in schema, f"schema: missing table id {table_id}")
check("HaccpFile" in schema and "file?: File" in schema, "schema: HaccpFile.file is missing")
check("version?: number" in schema, "schema: HaccpRow.version is missing")

for section in SECTIONS:
    check(f'"{section}"' in schema, f"schema: missing section {section}")
check("HACCP_ZIP_FOLDERS" in export, "export: ZIP folder map missing")
check("sanitizeCellValue" in export and "shared-string" in export, "export: text cells must stay strings, not formulas")
check("'${text}" not in export, "export: a literal apostrophe must not be prefixed")
check("duplicateRow" in export, "export: overflow rows are not cloned")
check("buildHaccpZip" in export and "buildHaccpWorkbook" in export, "export: Excel/ZIP builders missing")
check("sheetFor(wb, 6" in export, "export: layout sheet not filled")
check("writeSideTables" in export, "export: the two side-by-side HACCP tables are not handled")

try:
    with zipfile.ZipFile(TEMPLATE) as workbook:
        workbook_xml = workbook.read("xl/workbook.xml").decode("utf-8")
    names = re.findall(r'<sheet[^>]*name="([^"]+)"', workbook_xml)
    check(len(names) == 7, f"template: expected 7 sheets, found {len(names)}")
    for name in SHEETS:
        check(name in names, f"template: missing sheet {name!r}")
except (FileNotFoundError, KeyError, zipfile.BadZipFile) as error:
    failures.append(f"template workbook is unreadable: {error}")

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
if failures:
    print("HACCP CONTRACT: FAIL")
    for failure in failures:
        print(f"  - {failure}")
    sys.exit(1)

print(f"HACCP CONTRACT: PASS ({checks} checks)")
