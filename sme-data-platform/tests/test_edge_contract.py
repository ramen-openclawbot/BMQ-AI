"""Synthetic local API -> actual Edge runtime contract, no network/model/credentials."""
import json
from decimal import Decimal
import subprocess
from pathlib import Path
from fastapi.testclient import TestClient
from sme_platform.api import Principal, create_app
from sme_platform.config import Settings
from sme_platform.warehouse import Warehouse


def test_api_ingest_query_knowledge_contract_executes_edge(tmp_path):
    platform = Path(__file__).resolve().parents[1]
    repo = platform.parent
    warehouse = Warehouse(Settings(tmp_path / 'data', test_mode=True))
    warehouse.initialize()
    warehouse.rebuild_gold()
    async def owner():
        return Principal('bmq-contract', 'owner-test')
    client = TestClient(create_app(warehouse, owner))
    def post(path, body):
        response = client.post('/v1/' + path, json=body)
        assert response.status_code == 200, response.text
        return response.json()
    for entity in ['customers', 'products', 'locations', 'orders', 'order_items', 'payments']:
        content = (platform / 'fixtures' / (entity + '.json')).read_text()
        result = post('ingest', {'source':'sample', 'entity':entity, 'filename':entity+'.json', 'content':content})
        assert result['status'] == 'success'
    query = post('query', {'metric':'revenue', 'dimensions':[], 'time_range':{'start':'2026-09-09','end':'2026-09-09'}, 'limit':20})
    assert Decimal(query['rows'][0]['revenue']) == Decimal('100000')
    document = {'source':'manual','title':'BMQ guide','filename':'guide.md','content':'BMQ AI manages inventory and purchase orders.'}
    post('documents', document)
    records = {'query':query,'semantic':client.get('/v1/semantic').json(),'sources':client.get('/v1/sources').json(),
               'knowledge':post('knowledge/search',{'question':'BMQ inventory','limit':5})}
    assert len(records['sources']['sources']) == 7
    records_file = tmp_path / 'api-responses.json'
    records_file.write_text(json.dumps(records))
    runner = repo / 'apps/web/supabase/functions/bmq-analytics/api-contract.test-runner.ts'
    completed = subprocess.run(['node','--experimental-strip-types',str(runner),str(records_file)],cwd=repo,text=True,capture_output=True)
    assert completed.returncode == 0, completed.stdout + completed.stderr
