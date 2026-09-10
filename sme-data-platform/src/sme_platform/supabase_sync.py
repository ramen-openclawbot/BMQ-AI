"""Fixed-project, read-only raw replication. No arbitrary SQL or model invocation.

Uses Supabase CLI's existing host-managed login; never reads/exports credentials.
Small-source V1: consistent full source scan; only changed rows create revisions.
A missing row means absent at observation time, not a known source deletion date.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

from .config import Settings, safe_path
from .warehouse import Warehouse, atomic_json

PROJECT = 'cxntbdvfsikwmitapony'
TENANT = PROJECT + '.supabase.co'
VERSION = 'bmq-supabase-raw-v10'
MAX_ROWS = 50000
MAX_BYTES = 128 * 1024 * 1024
# Explicit field projections: no auth/OTP/session tokens, contact snapshots,
# arbitrary JSON, signed document URLs, bank data or staff phone/salary.
FIELDS = {
    # R7 transport only: PO/drafts, shift actuals and dispatch confirmations
    # remain separate evidence, never additional posted revenue.
    'customer_po_inbox': 'id received_at matched_customer_id match_status parsed_po_number parsed_total_amount revenue_channel reviewed_at created_at updated_at po_number delivery_date subtotal_amount vat_amount total_amount posted_to_revenue posted_to_revenue_at',
    'po_dispatch_revenue_confirmation_lines': 'id confirmation_id source_line_key sku product_name ordered_qty produced_qty defect_qty dispatched_qty billable_qty unit_price_vat_included source_line_amount_vat_included temporary_revenue_amount_vat_included confirmed_revenue_amount_vat_included shortage_reason_code created_at',
    'po_dispatch_revenue_confirmations': 'id customer_po_inbox_id warehouse_dispatch_id production_order_id customer_id po_number revenue_date dispatch_date status ordered_qty_total produced_qty_total defect_qty_total dispatched_qty_total billable_qty_total po_total_vat_included temporary_revenue_amount_vat_included confirmed_revenue_amount_vat_included amount_status amount_basis confirmed_at created_at updated_at',
    'production_location_sku_settings': 'id location_code sku_id is_enabled created_at updated_at',
    'production_shift_items': 'id production_shift_id production_order_item_id sku_id planned_qty actual_qty unit created_at',
    'production_shifts': 'id shift_code production_order_id shift_date shift_type status started_at completed_at created_at updated_at',
    'revenue_drafts': 'id sales_po_doc_id customer_id po_number po_order_date delivery_date subtotal_amount vat_amount total_amount revenue_channel product_group status approved_at rejected_at created_at updated_at production_order_id source',
    'sales_po_documents': 'id inbox_row_id customer_id po_number po_order_date delivery_date subtotal_amount vat_amount total_amount revenue_channel parse_source status created_at updated_at',
    'warehouse_dispatch_items': 'id dispatch_id sku_id product_name quantity unit batch_id created_at',


    # R6 transport only: effective-dated costs and checked actual quantities
    # are not certified COGS or posted stock. Retain every revision/status.
    'sku_cogs_materials': 'id material_code canonical_name normalized_name default_unit ingredient_sku_id active created_at updated_at category brand specification version',
    'sku_cogs_material_aliases': 'id material_id alias_name normalized_alias source active created_at',
    'material_scoped_aliases': 'id material_id supplier_id source_type alias_name normalized_alias approved approved_at active created_at',
    'material_supplier_products': 'id material_id supplier_id product_sku_id supplier_product_code supplier_product_name normalized_supplier_product_name purchase_unit package_quantity package_unit base_quantity base_unit approved approved_at active created_at updated_at',
    'material_price_history': 'id material_id supplier_product_id price_type price price_unit normalized_base_unit_price effective_from effective_to source_type source_id approved approved_at created_at',
    'material_unit_conversions': 'id material_id from_unit to_unit factor effective_from effective_to source_type source_id approved approved_at active created_at updated_at',
    'sku_formulations': 'id sku_id ingredient_name unit unit_price dosage_qty wastage_percent sort_order created_at updated_at ingredient_sku_id material_code canonical_material_id effective_from material_resolution_status material_resolution_request_id canonical_default_unit standard_unit_price standard_price_id',
    'sku_cogs_versions': 'id sku_id version_no effective_from effective_to created_at',
    'sku_cogs_version_formulations': 'id version_id source_formulation_id canonical_material_id ingredient_sku_id ingredient_name material_code unit unit_price dosage_qty wastage_percent sort_order created_at',
    'production_material_issues': 'id issue_number production_order_id source_po_inbox_id revenue_draft_id sales_po_doc_id issue_date status total_amount created_at updated_at location_code revision signed_uploaded_at check_status checked_at confirmed_at posted_at is_current superseded_by_issue_id',
    'production_material_issue_items': 'id material_issue_id production_order_item_id finished_sku_id ingredient_sku_id kitchen_inventory_item_id ingredient_name planned_finished_qty dosage_qty wastage_percent required_qty unit unit_cost amount created_at updated_at material_code canonical_material_id q7_mapping_id source_unit source_required_qty conversion_factor',
    'production_material_issue_checks': 'id issue_id attempt_no status checked_at created_at',
    'production_material_issue_check_actuals': 'id check_id issue_item_id planned_qty actual_qty difference_qty unit evidence_kind confidence created_at',

    # R5 transport only: Q7 usage is a positive quantity, not a signed delta.
    # Opening/count/close and planned KFM issue are distinct evidence.
    'kitchen_inventory_items': 'id item_code item_type name unit standard_unit_cost active inventory_item_id product_sku_id created_at updated_at canonical_material_id material_resolution_status',
    'kitchen_inventory_movements': 'id movement_date period_month item_id movement_type quantity unit unit_cost amount source source_ref_id created_at updated_at location_code',
    'kitchen_inventory_monthly_closings': 'id period_month item_id opening_qty purchase_qty usage_qty adjustment_qty system_ending_qty counted_ending_qty variance_qty unit_cost usage_amount status closed_at created_at updated_at',
    'q7_inventory_openings': 'id kitchen_inventory_item_id effective_date opening_qty unit physical_count_qty physical_count_date created_at updated_at q7_mapping_id canonical_material_id',
    'q7_inventory_movements': 'id kitchen_inventory_item_id movement_date movement_type quantity unit source source_ref_id source_issue_id source_issue_item_id created_at q7_mapping_id canonical_material_id',
    'q7_material_issue_material_mappings': 'id canonical_material_id source_unit kitchen_inventory_item_id kitchen_unit conversion_factor approval_status approved_at created_at updated_at',
    'kfm_daily_material_issues': 'id issue_number issue_date revision status total_amount printed_at created_at updated_at',
    'kfm_daily_material_issue_items': 'id issue_id canonical_material_id material_code ingredient_name required_qty unit unit_cost amount sort_order created_at',
    'kfm_daily_material_issue_sources': 'id issue_id production_order_id source_po_inbox_id production_number po_number created_at',
    # R4 transport only: signed movements, balances and reservations remain
    # separate facts; never sum different units or infer customer delivery.
    'goods_receipt_items': 'id goods_receipt_id sku_id product_name quantity unit inventory_item_id created_at expiry_date purchase_order_item_id ordered_quantity actual_quantity unit_price line_status canonical_material_id material_resolution_status',
    'inventory_batches': 'id inventory_item_id sku_id goods_receipt_id batch_number quantity unit received_date manufacture_date expiry_date created_at updated_at goods_receipt_item_id expiry_edit_count expiry_last_edited_at',
    'inventory_movements': 'id movement_type sku_id inventory_item_id batch_id quantity unit reference_type reference_id movement_date created_at',
    'goods_receipt_auto_issues': 'id issue_number goods_receipt_id issue_date status source total_quantity created_at',
    'goods_receipt_auto_issue_items': 'id auto_issue_id goods_receipt_item_id inventory_item_id sku_id batch_id product_name quantity unit unit_cost amount created_at',
    'tan_tao_warehouse_documents': 'id document_number location_code sku_id sku_code_snapshot document_type status quantity ordered_quantity exchange_quantity makeup_quantity physical_quantity source_authority source_document_id reference_type reference_id created_at supplier_billable_quantity supplier_credit_quantity supplier_exchange_quantity supplier_makeup_quantity',
    'tan_tao_warehouse_movements': 'id document_id location_code sku_id sku_code_snapshot movement_type quantity created_at',
    'tan_tao_warehouse_reservations': 'id document_id location_code sku_id sku_code_snapshot quantity status source_type source_id released_at dispatched_at created_at',
    # R3 raw evidence only: supplier payments are not customer receipts;
    # empty adjustments are not zero balances; close attempts are not payments.
    'ceo_daily_closing_declarations': 'id closing_date unc_total_declared cash_fund_topup_amount qtm_extracted_amount unc_extracted_amount created_at updated_at',
    'customer_debt_period_adjustments': 'id customer_id period_from period_to opening_balance_vnd amount_collected_vnd payment_due_date created_at updated_at',
    'daily_reconciliations': 'id closing_date unc_detail_amount unc_declared_amount cash_fund_topup_amount variance_amount status tolerance_amount qtm_spent_from_folder qtm_variance_amount unc_status qtm_status matched_at created_at updated_at',
    'finance_daily_close_runs': 'id closing_date mode status decision blocker_count match_count approved_count started_at finished_at created_at updated_at',
    'finance_payment_auto_approval_matches': 'id run_id payment_request_id evidence_source evidence_amount evidence_confidence supplier_id match_strategy match_status created_at updated_at',
    'invoice_items': 'id invoice_id product_code product_name unit quantity unit_price line_total inventory_item_id canonical_material_id created_at',
    'invoices': 'id invoice_number invoice_date supplier_id subtotal vat_amount total_amount payment_request_id purchase_order_id goods_receipt_id created_at updated_at',
    'payment_request_items': 'id payment_request_id product_code product_name quantity unit unit_price line_total inventory_item_id sku_id purchase_order_item_id canonical_material_id created_at',
    'payments': 'id payment_number supplier_id payment_date amount payment_method created_at updated_at',
    'revenue_source_documents': 'id source_type period status created_at updated_at',
    'payment_requests': 'id request_number supplier_id total_amount status delivery_status payment_status created_at updated_at payment_method invoice_id vat_amount goods_receipt_id payment_type purchase_order_id paid_at',
    'payment_allocations': 'id payment_id payment_request_id amount created_at updated_at',
    'production_orders': 'id production_number customer_id status planned_start_date planned_end_date completed_at created_at updated_at location_code',
    'production_order_items': 'id production_order_id sku_id product_name ordered_qty planned_qty actual_qty unit delivery_date created_at',
    'goods_receipts': 'id receipt_number supplier_id receipt_date status total_quantity purchase_order_id created_at updated_at payment_request_id payable_status finalized_at',
    'warehouse_dispatches': 'id dispatch_number customer_id production_order_id status dispatch_date delivered_date created_at updated_at',
    'mini_crm_customer_contracts': 'id customer_id file_name file_size mime_type is_active created_at',
    'mini_crm_customers': 'id customer_code customer_name customer_group is_active created_at updated_at product_group is_npp supplied_by_npp_customer_id is_tier1 npp_management_fee_vnd',
    'product_skus': 'id sku_code product_name unit unit_price supplier_id category created_at updated_at base_unit sku_type hide_from_dealer_portal canonical_material_id selling_price',
    'mini_crm_customer_price_list': 'id customer_id sku_id price_vnd_per_unit currency is_active created_at updated_at',
    'dealer_orders': 'id order_number customer_id status currency subtotal_amount_vnd total_amount_vnd requested_delivery_date submitted_at created_at updated_at is_test',
    'dealer_order_items': 'id order_id sku_id sku_code product_name unit quantity unit_price_vnd line_total_vnd price_source created_at route_customer_id ordered_quantity exchange_quantity makeup_quantity physical_quantity route_customer_name',
    # Audit coverage only: missing cancellation events do not imply an active
    # order; confirmation "sent" is delivery state, not approval/payment.
    'dealer_order_cancellation_events': 'id order_id customer_id source previous_status created_at',
    'dealer_customer_order_confirmations': 'id order_id channel status sent_at created_at updated_at',
    'kiosk_report_locations': 'id location_code location_name active created_at updated_at',
    'kiosk_report_products': 'code product_name unit display_order active created_at updated_at sale_allowed breadstick_consumption_ratio',
    'kiosk_report_channels': 'code channel_name display_order active created_at updated_at',
    'kiosk_daily_reports': 'id location_id staff_id report_date status submitted_at location_code_snapshot location_name_snapshot created_at updated_at opening_source_report_id opening_source_report_date',
    'kiosk_daily_report_channel_rows': 'id report_id channel_code channel_name_snapshot quantity amount_vnd created_at updated_at',
    'kiosk_daily_report_inventory_rows': 'id report_id product_code product_name_snapshot opening_quantity received_quantity shortage_quantity transfer_quantity waste_quantity returns_quantity sold_quantity created_at updated_at consumed_quantity closing_quantity opening_reconciliation_required',
    'suppliers': 'id name category created_at updated_at short_code default_payment_method payment_terms_days vat_included_in_price',
    'purchase_orders': 'id po_number supplier_id order_date expected_date status total_amount created_at updated_at vat_amount',
    'purchase_order_items': 'id purchase_order_id sku_id product_name quantity unit unit_price line_total created_at canonical_material_id material_resolution_status',
    'inventory_items': 'id name category quantity unit min_stock supplier_id created_at updated_at',
    'revenue_ledger_lines': 'id source_document_id source_row_number period revenue_date channel source_tab branch invoice_no customer_id parent_customer_id customer_code customer_name product_code product_name quantity unit_price gross_revenue order_gross order_discount customer_payable source_type approval_status audit_status confidence_status review_status reconciliation_status created_at updated_at route_customer_id route_customer_name',
}
TOTALS = {
    'payments': 'amount', 'invoices': 'total_amount',
    'invoice_items': 'line_total', 'payment_request_items': 'line_total',
    'payment_requests': 'total_amount', 'payment_allocations': 'amount',
    'dealer_orders': 'total_amount_vnd', 'dealer_order_items': 'line_total_vnd',
    'kiosk_daily_report_channel_rows': 'amount_vnd', 'purchase_orders': 'total_amount',
    'purchase_order_items': 'line_total', 'revenue_ledger_lines': 'customer_payable',
}
KEYS = {name: ('code' if name in {'kiosk_report_products', 'kiosk_report_channels'} else 'id') for name in FIELDS}


# Only routing scalars needed by the existing NPP debt contract are extracted.
# Never replicate arbitrary raw_payload instructions, contacts or signed URLs.
ROUTE_EXPRESSIONS = {
    'route_customer_id': "coalesce(nullif(raw_payload->>'route_customer_id',''),nullif(raw_payload->>'routeCustomerId',''),raw_payload->>'agency_customer_id','')",
    'route_customer_name': "coalesce(nullif(raw_payload->>'route_customer_name',''),nullif(raw_payload->>'routeCustomerName',''),nullif(raw_payload->>'agency_customer_name',''),raw_payload->>'route','')",
}


def query_sql():
    parts = []
    for table, fields in FIELDS.items():
        columns = []
        for field in fields.split():
            if table == 'revenue_ledger_lines' and field in ROUTE_EXPRESSIONS:
                columns.append(ROUTE_EXPRESSIONS[field] + ' AS "' + field + '"')
            elif table == 'product_skus' and field == 'selling_price':
                # Preserve only this JSON scalar, not the whole costing object.
                columns.append("cost_values->'selling_price' AS selling_price")
            else:
                columns.append('"' + field + '"')
        projection = ','.join(columns)
        key = KEYS[table]
        amount = TOTALS.get(table)
        total = f"(SELECT coalesce(sum({amount}),0)::text FROM public.{table})" if amount else 'NULL::text'
        # COUNT/SUM and payload share one repeatable-read snapshot. LIMIT never
        # silently becomes a complete table: count mismatch aborts publication.
        parts.append(f"SELECT '{table}' AS name, (SELECT count(*) FROM public.{table}) AS count, "
                     f"{total} AS total, "
                     f"coalesce(json_agg(row_to_json(r)::text ORDER BY r.\"{key}\"),'[]'::json) AS records "
                     f"FROM (SELECT {projection} FROM public.{table} ORDER BY \"{key}\" LIMIT {MAX_ROWS + 1}) r")
    return ("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; "
            "SET LOCAL statement_timeout = 30000; "
            "SELECT current_database() AS database, transaction_timestamp()::text AS observed_at, "
            "json_agg(t) AS tables FROM (" + ' UNION ALL '.join(parts) + ") t; COMMIT;")


def extract(cli: str, workdir: Path, temp_root: Path):
    ref = workdir / 'supabase/.temp/project-ref'
    if not ref.is_file() or ref.read_text().strip() != PROJECT:
        raise RuntimeError('Linked Supabase project mismatch')
    with tempfile.TemporaryDirectory(dir=temp_root) as directory:
        sql = Path(directory) / 'readonly.sql'
        output = Path(directory) / 'result.json'
        sql.write_text(query_sql())
        with output.open('wb') as stream:
            proc = subprocess.Popen([cli, 'db', 'query', '--linked', '--file', str(sql), '-o', 'json'],
                                    cwd=workdir, stdout=stream, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 90
            try:
                while proc.poll() is None:
                    if time.monotonic() > deadline or output.stat().st_size > MAX_BYTES:
                        raise RuntimeError('Source extraction exceeded budget')
                    time.sleep(.2)
                if proc.returncode != 0 or output.stat().st_size > MAX_BYTES:
                    raise RuntimeError('Source extraction failed; check host CLI login/project access')
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.wait()
        return parse_source_response(json.loads(output.read_text()))


def parse_source_response(envelope):
    # Host CLI can return a direct row array in launchd and a rows envelope
    # interactively. Both must contain exactly one snapshot, never tool text.
    rows = envelope.get('rows') if isinstance(envelope, dict) else envelope
    if not isinstance(rows, list) or len(rows) != 1:
        raise ValueError('Unexpected source response')
    snapshot = rows[0]
    if not isinstance(snapshot, dict) or set(snapshot) != {'database', 'observed_at', 'tables'}:
        raise ValueError('Unexpected source snapshot')
    validate(snapshot)
    return snapshot


def validate(snapshot):
    if snapshot.get('database') != 'postgres':
        raise ValueError('Unexpected source database')
    observed = datetime.fromisoformat(snapshot['observed_at'])
    if observed.tzinfo is None:
        raise ValueError('Missing source timezone')
    tables = snapshot['tables']
    if len(tables) != len(FIELDS) or {t['name'] for t in tables} != set(FIELDS):
        raise ValueError('Missing or duplicate source tables')
    validated = {}
    for table in tables:
        name = table['name']
        records = table['records']
        if not isinstance(records, list) or len(records) != table['count'] or len(records) > MAX_ROWS:
            raise ValueError('Truncated source table; previous publication retained')
        ids, total = set(), Decimal(0)
        parsed = []
        for payload in records:
            row = json.loads(payload, parse_float=Decimal)
            if set(row) != set(FIELDS[name].split()):
                raise ValueError('Source schema drift')
            # Keep the original scalar (including decimal lexemes); never
            # substitute unit_price or turn missing/invalid values into zero.
            if name == 'product_skus' and row['selling_price'] is not None:
                price = row['selling_price']
                if isinstance(price, bool) or not isinstance(price, (str, int, Decimal)):
                    raise ValueError('Invalid selling price scalar')
                try:
                    if not Decimal(str(price)).is_finite():
                        raise ValueError('Invalid selling price scalar')
                except InvalidOperation:
                    raise ValueError('Invalid selling price scalar') from None
            if name == 'dealer_order_items' and row['route_customer_name'] is not None:
                if not isinstance(row['route_customer_name'], str):
                    raise ValueError('Invalid route name scalar')
            key = row[KEYS[name]]
            if not isinstance(key, str) or not key or key in ids:
                raise ValueError('Invalid or duplicate source key')
            ids.add(key)
            if name in TOTALS:
                total += Decimal(str(row[TOTALS[name]] or 0))
            parsed.append((key, payload, hashlib.sha256(payload.encode()).hexdigest()))
        if name in TOTALS and total != Decimal(table['total']):
            raise ValueError('Source total reconciliation failed')
        validated[name] = parsed
    return observed, validated


def publish(warehouse: Warehouse, snapshot):
    observed, tables = validate(snapshot)
    run = uuid.uuid4().hex
    summary = {'version': VERSION, 'project': PROJECT, 'tenant': TENANT, 'run_id': run,
               'source_observed_at': observed.isoformat(), 'completed_at': None,
               'mode': 'consistent_full_scan_changed_row_revisions', 'tables': {}}
    with warehouse.lock(), warehouse.connect() as con:
        con.execute('CREATE SCHEMA IF NOT EXISTS bronze')
        con.execute('''CREATE TABLE IF NOT EXISTS bronze.supabase_current(
            tenant_id VARCHAR, source_table VARCHAR, source_id VARCHAR, payload VARCHAR,
            row_hash VARCHAR, observed_at TIMESTAMPTZ, PRIMARY KEY(tenant_id,source_table,source_id))''')
        con.execute('''CREATE TABLE IF NOT EXISTS bronze.supabase_changes(
            tenant_id VARCHAR, run_id VARCHAR, source_table VARCHAR, source_id VARCHAR,
            operation VARCHAR, payload VARCHAR, observed_at TIMESTAMPTZ)''')
        con.execute('''CREATE TABLE IF NOT EXISTS meta_supabase_sync_runs(
            run_id VARCHAR PRIMARY KEY, observed_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, manifest VARCHAR)''')
        latest = con.execute('SELECT max(observed_at) FROM meta_supabase_sync_runs').fetchone()[0]
        if latest and observed <= latest:
            raise ValueError('Stale source snapshot; previous publication retained')
        archive = safe_path(warehouse.root, 'raw', TENANT, 'supabase', VERSION)
        archive.mkdir(parents=True, exist_ok=True)
        con.execute('BEGIN')
        try:
            for table in snapshot['tables']:
                name = table['name']
                records = tables[name]
                # Exact projected source row JSON, including decimal lexemes.
                raw = ''.join(payload + '\n' for _, payload, _ in records).encode()
                digest = hashlib.sha256(raw).hexdigest()
                path = safe_path(warehouse.root, archive.relative_to(warehouse.root), name, digest + '.jsonl')
                path.parent.mkdir(parents=True, exist_ok=True)
                if path.exists():
                    if path.read_bytes() != raw:
                        raise RuntimeError('Raw content hash mismatch')
                else:
                    with path.open('xb') as handle:
                        handle.write(raw)
                        handle.flush()
                        os.fsync(handle.fileno())
                before = dict(con.execute('SELECT source_id,row_hash FROM bronze.supabase_current WHERE tenant_id=? AND source_table=?', [TENANT, name]).fetchall())
                current = {key for key, _, _ in records}
                added = sum(key not in before for key, _, _ in records)
                changed = sum(key in before and before[key] != digest for key, _, digest in records)
                removed = before.keys() - current
                # Bulk merge: per-row ON CONFLICT retains excessive transaction
                # state in DuckDB for real ledger sizes under the 512 MiB cap.
                con.execute('CREATE OR REPLACE TEMP TABLE incoming(source_id VARCHAR, payload VARCHAR, row_hash VARCHAR)')
                if records:
                    con.executemany('INSERT INTO incoming VALUES (?,?,?)', records)
                con.execute("""INSERT INTO bronze.supabase_changes
                    SELECT ?, ?, ?, i.source_id,
                    CASE WHEN c.source_id IS NULL THEN 'insert' ELSE 'update' END, i.payload, ?
                    FROM incoming i LEFT JOIN bronze.supabase_current c
                    ON c.tenant_id=? AND c.source_table=? AND c.source_id=i.source_id
                    WHERE c.source_id IS NULL OR c.row_hash<>i.row_hash""", [TENANT, run, name, observed, TENANT, name])
                con.execute("""INSERT INTO bronze.supabase_changes
                    SELECT tenant_id, ?, source_table, source_id, 'absent_in_source_snapshot', NULL, ?
                    FROM bronze.supabase_current WHERE tenant_id=? AND source_table=?
                    AND source_id NOT IN (SELECT source_id FROM incoming)""", [run, observed, TENANT, name])
                con.execute("""DELETE FROM bronze.supabase_current WHERE tenant_id=? AND source_table=?
                    AND source_id NOT IN (SELECT source_id FROM incoming)""", [TENANT, name])
                con.execute("""INSERT INTO bronze.supabase_current
                    SELECT ?, ?, source_id, payload, row_hash, ? FROM incoming
                    ON CONFLICT(tenant_id,source_table,source_id) DO UPDATE SET
                    payload=excluded.payload,row_hash=excluded.row_hash,observed_at=excluded.observed_at
                    WHERE supabase_current.row_hash<>excluded.row_hash""", [TENANT, name, observed])
                count = con.execute('SELECT count(*) FROM bronze.supabase_current WHERE tenant_id=? AND source_table=?', [TENANT, name]).fetchone()[0]
                if count != table['count']:
                    raise RuntimeError('Published row count mismatch')
                summary['tables'][name] = {'records': count, 'inserted': added, 'updated': changed, 'absent': len(removed),
                    'source_total': table['total'], 'reconciled': True, 'raw_path': str(path.relative_to(warehouse.root)), 'sha256': digest}
            summary['completed_at'] = datetime.now(timezone.utc).isoformat()
            con.execute('INSERT INTO meta_supabase_sync_runs VALUES (?,?,now(),?)', [run, observed, json.dumps(summary)])
            con.execute('COMMIT')
        except Exception:
            con.execute('ROLLBACK')
            raise
        # DuckDB publication is authoritative; raw + run manifest are replayable.
        # Parquet export is atomic and repairable by the next successful scan.
        export = safe_path(warehouse.root, 'bronze', TENANT, 'supabase', 'current.parquet')
        export.parent.mkdir(parents=True, exist_ok=True)
        temporary = export.with_name(run + '.parquet')
        con.execute('COPY (SELECT * FROM bronze.supabase_current WHERE tenant_id=$tenant) TO $path (FORMAT PARQUET)', {'tenant': TENANT, 'path': str(temporary)})
        os.replace(temporary, export)
        atomic_json(safe_path(warehouse.root, 'logs', 'supabase-sync-latest.json'), summary)
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--workdir', type=Path, required=True)
    parser.add_argument('--cli', default='/opt/homebrew/bin/supabase')
    args = parser.parse_args()
    os.umask(0o077)
    warehouse = Warehouse(Settings.from_env())
    try:
        warehouse.settings.validate_storage(write=True)
        snapshot = extract(args.cli, args.workdir, safe_path(warehouse.root, 'temp'))
        result = publish(warehouse, snapshot)
        print(json.dumps({'status': 'success', 'run_id': result['run_id'], 'tables': len(result['tables']),
                          'records': sum(t['records'] for t in result['tables'].values()),
                          'changed': sum(t['inserted'] + t['updated'] + t['absent'] for t in result['tables'].values())}))
    except Exception as error:
        # Never log source rows, SQL/CLI output, credentials or exception text.
        print(json.dumps({'status': 'failed', 'error_type': type(error).__name__}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
