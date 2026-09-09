import json
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from sme_platform.api import Principal, create_app
from sme_platform.backup import create_backup, restore_backup, verify_backup
from sme_platform.config import Settings
from sme_platform.datasets import build_dataset, log_interaction
from sme_platform.knowledge import KnowledgeStore
from sme_platform.warehouse import Warehouse


@pytest.fixture
def warehouse(tmp_path):
    w = Warehouse(Settings(tmp_path / 'data', test_mode=True))
    w.initialize()
    w.rebuild_gold()
    return w


def test_knowledge_is_scoped_immutable_cited_and_retirable(warehouse):
    store = KnowledgeStore(warehouse)
    args = dict(tenant_id='bmq', source='manual', filename='guide.md', title='BMQ AI',
                content='BMQ AI manages inventory and purchase orders. Kho hàng và đơn mua.')
    first = store.ingest(**args)
    assert store.ingest(**args)['status'] == 'duplicate'
    assert store.search(tenant_id='another', question='BMQ AI')['chunks'] == []
    chunks = store.search(tenant_id='bmq', question='kho hang')['chunks']
    assert chunks and chunks[0]['id'].startswith(first['id'])
    assert chunks[0]['source'] == 'manual'
    assert store.search(tenant_id='bmq', question='completelyunrelated')['chunks'] == []
    store.delete(tenant_id='bmq', document_id=first['id'])
    assert store.search(tenant_id='bmq', question='inventory')['chunks'] == []
    assert len(list((warehouse.root / 'raw').rglob('*.md'))) == 1


def test_knowledge_rejects_traversal_and_binary(warehouse):
    store = KnowledgeStore(warehouse)
    base = dict(tenant_id='bmq', source='manual', filename='a.txt', title='Guide', content='valid')
    for change in [{'source': '../outside'}, {'filename': '../a.txt'}, {'content': 'binary\0'}, {'filename': 'a.html'}]:
        with pytest.raises(ValueError):
            store.ingest(**(base | change))


def test_dataset_versions_pii_and_split_isolation(warehouse):
    records = [{'question': 'Revenue today?', 'expected_intent': 'revenue', 'approved': True, 'anonymized': True}]
    result = build_dataset(warehouse, records, version='v001', split='evaluation')
    assert result['record_count'] == 1
    for change in [{'version': 'v001', 'split': 'evaluation'}, {'version': 'v002', 'split': 'training'}]:
        with pytest.raises(ValueError):
            build_dataset(warehouse, records, **change)
    for record in [records[0] | {'approved': False}, records[0] | {'question': 'Email alice@example.com'}, records[0] | {'raw_result': 'secret'}]:
        with pytest.raises(ValueError):
            build_dataset(warehouse, [record], version='v003')


def test_interaction_logs_do_not_retain_personal_text(warehouse):
    event = log_interaction(warehouse, tenant_id='bmq', event={'interaction_id': 'test-1',
        'user_query': 'alice@example.com balance', 'response': '500 VND', 'execution_time_ms': 12,
        'model_name': 'gpt-5.6-luna', 'session_id': 'sensitive-id'})
    assert 'user_query_hash' in event and 'user_query' not in event
    saved = next((warehouse.root / 'logs/interactions').rglob('*.jsonl')).read_text()
    assert 'alice@example.com' not in saved and '500 VND' not in saved and 'sensitive-id' not in saved


def test_backup_restore_checksums_and_no_overwrite(warehouse, tmp_path):
    KnowledgeStore(warehouse).ingest(tenant_id='bmq', source='manual', filename='a.md', title='Guide', content='BMQ inventory guidance')
    backup = create_backup(warehouse, tmp_path / 'backups')
    assert verify_backup(backup)['status'] == 'verified'
    restored = restore_backup(backup, tmp_path / 'restored')
    w = Warehouse(Settings(restored, test_mode=True))
    assert KnowledgeStore(w).search(tenant_id='bmq', question='inventory')['chunks']
    with pytest.raises(ValueError):
        restore_backup(backup, restored)
    with pytest.raises(ValueError):
        create_backup(warehouse, warehouse.root / 'backups')
    (backup / 'knowledge/index.sqlite').write_bytes(b'corrupted')
    with pytest.raises(ValueError):
        verify_backup(backup)


def test_backup_rejects_manifest_traversal(warehouse, tmp_path):
    backup = create_backup(warehouse, tmp_path / 'backups')
    manifest = json.loads((backup / 'manifest.json').read_text())
    manifest['files']['../escape'] = 'x'
    (backup / 'manifest.json').write_text(json.dumps(manifest))
    with pytest.raises(ValueError):
        restore_backup(backup, tmp_path / 'unsafe')
    assert not (tmp_path / 'unsafe').exists()


def test_http_owner_boundary_unknown_tenant_and_uploads(warehouse):
    async def auth(request):
        # Use explicit signature annotation below; FastAPI reads it for injection.
        return Principal('bmq', 'owner')
    from fastapi import Request
    auth.__annotations__['request'] = Request
    app = create_app(warehouse, auth)
    client = TestClient(app)
    assert client.get('/v1/status').status_code == 200
    doc = {'source': 'manual', 'title': 'BMQ AI', 'filename': 'guide.md', 'content': 'BMQ AI manages inventory.'}
    assert client.post('/v1/documents', json=doc).status_code == 200
    assert client.post('/v1/documents', json=doc | {'tenant_id': 'victim'}).status_code == 422
    assert client.post('/v1/knowledge/search', json={'question': 'inventory'}).json()['chunks']
    assert client.get('/v1/sources').json()['sources'][0]['kind'] == 'document'
    assert client.post('/v1/query', json={'sql': 'DROP TABLE silver.orders'}).status_code == 400
    assert client.post('/v1/documents', content='a' * (2 * 1024 * 1024 + 1), headers={'content-type': 'application/json'}).status_code == 413
    assert client.post('/v1/documents', content='plain').status_code == 415


def test_http_default_fails_closed_without_auth_configuration(warehouse, monkeypatch):
    monkeypatch.delenv('SME_SUPABASE_URL', raising=False)
    client = TestClient(create_app(warehouse))
    assert client.get('/v1/status').status_code == 503
    assert client.post('/v1/documents', json={'title': 'x', 'filename': 'x.md', 'content': 'x'}).status_code == 503
