"""R6 source transport must not convert plans/checks/current mappings into facts."""
import copy
import json

import pytest

from sme_platform.supabase_sync import FIELDS, publish
from test_r2_audit_sync import snapshot, put, warehouse
from test_r4_warehouse_sync import read

TABLES = {'sku_cogs_materials', 'sku_cogs_material_aliases', 'material_scoped_aliases',
          'material_supplier_products', 'material_price_history', 'material_unit_conversions',
          'sku_formulations', 'sku_cogs_versions', 'sku_cogs_version_formulations',
          'production_material_issues', 'production_material_issue_items',
          'production_material_issue_checks', 'production_material_issue_check_actuals'}


def test_no_signed_files_actors_or_arbitrary_payloads():
    assert TABLES <= FIELDS.keys()
    for table in TABLES:
        assert not set(FIELDS[table].split()) & {
            'created_by', 'updated_by', 'approved_by', 'changed_by', 'checked_by',
            'confirmed_by', 'signed_uploaded_by', 'signed_file_path', 'signed_file_sha256',
            'pdf_path', 'pdf_sha256', 'immutable_token', 'source_hash', 'notes',
            'metadata', 'result', 'check_metadata', 'product_snapshot',
            'canonical_material_snapshot', 'raw_ocr_name', 'change_reason'}


def test_effective_cost_history_keeps_inactive_and_unapproved_without_fallback(warehouse):
    value = snapshot()
    put(value, 'sku_cogs_materials', id='old', active=False, default_unit='g')
    put(value, 'sku_cogs_materials', id='new', active=True, default_unit='KG')
    for key, material, start, end in [('v1', 'old', '2026-01-01', '2026-06-11'),
                                      ('v2', 'new', '2026-06-12', None)]:
        put(value, 'sku_cogs_versions', id=key, sku_id='sku', effective_from=start, effective_to=end)
        put(value, 'sku_cogs_version_formulations', id=key+'-line', version_id=key,
            canonical_material_id=material, unit_price='0.1234567890123456789', dosage_qty='1.2')
    put(value, 'material_unit_conversions', id='future', material_id='new', from_unit='KG',
        to_unit='g', factor='1000.000001', approved=False, effective_from='2027-01-01')
    put(value, 'material_price_history', id='price', material_id='new', price='9.123456789',
        normalized_base_unit_price=None, approved=False)
    put(value, 'sku_formulations', id='current', canonical_material_id=None,
        unit_price=0, standard_unit_price=None)
    report = publish(warehouse, value)
    assert {r['effective_to'] for r in read(warehouse, report, 'sku_cogs_versions')} == {'2026-06-11', None}
    assert read(warehouse, report, 'material_price_history')[0]['normalized_base_unit_price'] is None
    assert read(warehouse, report, 'material_unit_conversions')[0]['approved'] is False
    assert read(warehouse, report, 'sku_formulations')[0]['canonical_material_id'] is None
    assert all(r['unit_price'] == '0.1234567890123456789' for r in read(warehouse, report, 'sku_cogs_version_formulations'))


def test_supplier_scope_and_checked_actuals_do_not_create_posted_movements(warehouse):
    value = snapshot()
    for supplier in ['s1', 's2']:
        put(value, 'material_scoped_aliases', id=supplier, supplier_id=supplier,
            alias_name='same name', material_id='material-'+supplier, approved=True)
    put(value, 'production_material_issues', id='old', revision=1, status='superseded',
        is_current=False, superseded_by_issue_id='current')
    put(value, 'production_material_issues', id='current', revision=2, status='ready_to_confirm',
        check_status='passed', is_current=True, posted_at=None)
    put(value, 'production_material_issue_items', id='line', material_issue_id='current',
        required_qty='10.123', unit='g', canonical_material_id=None)
    put(value, 'production_material_issue_checks', id='check', issue_id='current', status='passed', attempt_no=2)
    put(value, 'production_material_issue_check_actuals', id='actual', check_id='check',
        issue_item_id='line', planned_qty='10.123', actual_qty=0, difference_qty='-10.123',
        evidence_kind='handwritten_final', confidence='0.9', unit='g')
    report = publish(warehouse, value)
    assert report['tables']['q7_inventory_movements']['records'] == 0
    actual = read(warehouse, report, 'production_material_issue_check_actuals')[0]
    assert actual['actual_qty'] == 0 and actual['difference_qty'] == '-10.123'
    assert len(read(warehouse, report, 'material_scoped_aliases')) == 2
    assert all(r['posted_at'] is None for r in read(warehouse, report, 'production_material_issues'))
    again = copy.deepcopy(value); again['observed_at'] = snapshot(1)['observed_at']
    repeat = publish(warehouse, again)
    assert all(t['inserted'] + t['updated'] + t['absent'] == 0 for t in repeat['tables'].values())


@pytest.mark.parametrize('fault', ['duplicate', 'truncated', 'extra'])
def test_failed_actuals_snapshot_keeps_previous_publication(warehouse, fault):
    value = snapshot()
    put(value, 'production_material_issue_check_actuals', id='actual', actual_qty=None)
    report = publish(warehouse, value)
    bad = copy.deepcopy(value); bad['observed_at'] = snapshot(1)['observed_at']
    table = next(t for t in bad['tables'] if t['name'] == 'production_material_issue_check_actuals')
    if fault == 'duplicate':
        table['records'] *= 2; table['count'] = 2
    elif fault == 'truncated':
        table['records'] = []
    else:
        row = json.loads(table['records'][0]); row['signed_file_path'] = 'excluded'
        table['records'] = [json.dumps(row)]
    with pytest.raises(ValueError):
        publish(warehouse, bad)
    with warehouse.connect(read_only=True) as con:
        assert con.execute('SELECT count(*) FROM meta_supabase_sync_runs').fetchone()[0] == 1
    assert read(warehouse, report, 'production_material_issue_check_actuals')[0]['actual_qty'] is None
