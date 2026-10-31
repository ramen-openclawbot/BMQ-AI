"""Dispatch-report evidence: actual delivered quantity and saved photo/Jev result."""
import json

from sme_platform.supabase_sync import FIELDS, publish
from test_r2_audit_sync import snapshot, put, warehouse
from test_r4_warehouse_sync import read

TABLES = {'kfm_po_deliveries', 'dispatch_report_photos'}

DELIVERIES = ('id po_number customer_po_inbox_id delivery_date po_qty delivered_qty '
              'source updated_at created_at')
PHOTOS = ('id report_date storage_path saved_at size_bytes width height jev_status '
          'jev_kind jev_po_numbers jev_quantities jev_summary jev_mismatch '
          'jev_prompt_version jev_checked_at created_at')


def test_dispatch_report_projection_is_exact_and_has_no_image_bytes():
    assert TABLES <= FIELDS.keys()
    assert FIELDS['kfm_po_deliveries'].split() == DELIVERIES.split()
    assert FIELDS['dispatch_report_photos'].split() == PHOTOS.split()

    for table in TABLES:
        assert not set(FIELDS[table].split()) & {
            'uploaded_by', 'image', 'image_bytes', 'raw_bytes', 'signed_url',
            'public_url', 'bucket_id', 'raw_payload',
        }
    assert 'storage_path' in FIELDS['dispatch_report_photos'].split()


def test_dispatch_report_rows_keep_quantities_and_jev_result(warehouse):
    value = snapshot()
    put(
        value, 'kfm_po_deliveries',
        id='delivery-1', po_number='PO1000000001', customer_po_inbox_id=None,
        delivery_date='2026-11-01', po_qty='100.500000', delivered_qty='90',
        source='kho', updated_at='2026-11-01T09:00:00Z',
        created_at='2026-11-01T08:00:00Z',
    )
    put(
        value, 'dispatch_report_photos',
        id='photo-1', report_date='2026-11-01',
        storage_path='2026-11-01/photo-1.jpg',
        saved_at='2026-11-01T09:00:00Z', size_bytes=12345, width=800, height=600,
        jev_status='done', jev_kind='phieu_xuat_kho',
        jev_po_numbers=['PO1000000001'],
        jev_quantities=[{'po_number': 'PO1000000001', 'qty': 90}],
        jev_summary='Phiếu xuất kho · PO1000000001 · SL 90',
        jev_mismatch=False, jev_prompt_version='jev-dispatch-report-test',
        jev_checked_at='2026-11-01T09:01:00Z',
        created_at='2026-11-01T08:00:00Z',
    )

    report = publish(warehouse, value)
    assert report['tables']['kfm_po_deliveries']['records'] == 1
    assert report['tables']['dispatch_report_photos']['records'] == 1

    delivery = read(warehouse, report, 'kfm_po_deliveries')[0]
    assert delivery['po_number'] == 'PO1000000001'
    assert delivery['po_qty'] == '100.500000'
    assert delivery['delivered_qty'] == '90'
    assert delivery['source'] == 'kho'
    assert 'note' not in delivery

    photo = read(warehouse, report, 'dispatch_report_photos')[0]
    assert photo['storage_path'] == '2026-11-01/photo-1.jpg'
    assert photo['saved_at'] == '2026-11-01T09:00:00Z'
    assert photo['size_bytes'] == 12345
    assert photo['jev_status'] == 'done'
    assert photo['jev_kind'] == 'phieu_xuat_kho'
    assert photo['jev_po_numbers'] == ['PO1000000001']
    assert photo['jev_quantities'] == [{'po_number': 'PO1000000001', 'qty': 90}]
    assert photo['jev_mismatch'] is False
    assert 'image_bytes' not in photo


def test_dispatch_report_replay_keeps_one_revision(warehouse):
    value = snapshot()
    put(value, 'kfm_po_deliveries', id='delivery-1', po_number='PO1000000001',
        delivery_date='2026-11-01', po_qty='100', delivered_qty='90', source='kho')
    first = publish(warehouse, value)

    repeated = json.loads(json.dumps(value))
    repeated['observed_at'] = snapshot(1)['observed_at']
    second = publish(warehouse, repeated)
    assert first['tables']['kfm_po_deliveries']['raw_path'] == \
        second['tables']['kfm_po_deliveries']['raw_path']
    assert second['tables']['kfm_po_deliveries']['updated'] == 0
