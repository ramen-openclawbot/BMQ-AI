"""Read-only BMQ MCP: protocol, tools, per-dealer pricing and the /mcp route."""
import json
import socket

import pytest
from fastapi.testclient import TestClient

from sme_platform.api import Principal, create_app
from sme_platform.bmq_mcp import (PROTOCOL_VERSION, PROVIDER_NAME, WarehouseCatalog,
                                  dispatch, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND,
                                  UNAUTHORIZED)
from sme_platform.config import Settings
from sme_platform.mcp_keys import MCPKeyStore
from sme_platform.supabase_sync import TENANT, publish
from sme_platform.warehouse import Warehouse
from test_bmq_semantic import snapshot


def catalog_rows():
    return {
        'mini_crm_customers': [
            {'id': 'c1', 'customer_code': 'KH1', 'customer_name': 'Mai An', 'is_active': True},
            {'id': 'c2', 'customer_code': 'KH2', 'customer_name': 'Mai Binh', 'is_active': True}],
        'product_skus': [
            {'id': 's1', 'sku_code': 'BMQ-001', 'product_name': 'Bánh mì que', 'unit': 'que',
             'sku_type': 'finished_good', 'hide_from_dealer_portal': False, 'selling_price': '6500',
             'image_url': 'https://cdn.example/bmq-001.png'},
            {'id': 's2', 'sku_code': 'BMQ-002', 'product_name': 'Bánh mì ngọt', 'unit': 'que',
             'sku_type': 'finished_good', 'hide_from_dealer_portal': False, 'selling_price': '8000',
             'image_url': None},
            {'id': 's3', 'sku_code': 'BMQ-003', 'product_name': 'Bánh mì ẩn', 'unit': 'que',
             'sku_type': 'finished_good', 'hide_from_dealer_portal': True, 'selling_price': '1000',
             'image_url': None},
            {'id': 's4', 'sku_code': 'MAT-001', 'product_name': 'Bột mì', 'unit': 'kg',
             'sku_type': 'material', 'hide_from_dealer_portal': False, 'selling_price': '500',
             'image_url': None},
            {'id': 's5', 'sku_code': 'BMQ-005', 'product_name': 'Bánh mì lẻ', 'unit': 'que',
             'sku_type': 'finished_good', 'hide_from_dealer_portal': False, 'selling_price': '7500.5',
             'image_url': None}],
        'mini_crm_customer_price_list': [
            {'id': 'p1', 'customer_id': 'c1', 'sku_id': 's1', 'price_vnd_per_unit': '7000',
             'currency': 'VND', 'is_active': True},
            {'id': 'p2', 'customer_id': 'c2', 'sku_id': 's1', 'price_vnd_per_unit': '9000',
             'currency': 'VND', 'is_active': True}],
        'product_label_specs': [
            {'id': 'l1', 'sku_id': 's1', 'sku_code': 'BMQ-001', 'product_name': 'Bánh mì que',
             'shelf_life_days': 2, 'net_weight_value': '80', 'net_weight_unit': 'g',
             'barcode_value': '893', 'partner_product_code': 'P1'}],
    }


def build(tmp_path, name='data', **settings_kw):
    settings = Settings(tmp_path / name, test_mode=True, **settings_kw)
    warehouse = Warehouse(settings)
    warehouse.initialize()
    publish(warehouse, snapshot(catalog_rows()))
    return warehouse, settings


@pytest.fixture
def state(tmp_path):
    warehouse, settings = build(tmp_path, mcp_enabled=True, mcp_ui_theme='street')
    return warehouse, settings


def catalog(state, customer='KH1'):
    return WarehouseCatalog(state[0], customer, ui_theme=state[1].mcp_ui_theme)


def rpc(loader, method, params=None, message_id=1):
    message = {'jsonrpc': '2.0', 'id': message_id, 'method': method}
    if params is not None:
        message['params'] = params
    return dispatch(message, loader)


def tool_result(loader, name, arguments):
    status, payload = rpc(loader, 'tools/call', {'name': name, 'arguments': arguments})
    assert status == 200 and 'result' in payload
    return payload['result']


def test_catalog_is_scoped_to_one_dealer_and_excludes_unorderable_skus(state):
    loader = catalog(state)
    assert loader.provider == {'name': PROVIDER_NAME, 'ui_theme': 'street'}
    assert loader.customer['customer_code'] == 'KH1' and loader.data_as_of
    by_code = {p['sku_code']: p for p in loader.search('', 50)}
    assert set(by_code) == {'BMQ-001', 'BMQ-002', 'BMQ-005'}
    assert by_code['BMQ-001']['unit_price_vnd'] == 7000 and by_code['BMQ-001']['price_source'] == 'customer_override'
    assert by_code['BMQ-002']['unit_price_vnd'] == 8000 and by_code['BMQ-002']['image_url'] is None
    assert by_code['BMQ-005']['price_available'] is False and by_code['BMQ-005']['unit_price_vnd'] is None
    assert catalog(state, 'KH2').get('BMQ-001')['unit_price_vnd'] == 9000
    assert loader.get('bmq-001')['sku_code'] == 'BMQ-001'
    assert loader.get('BMQ-003') is None and loader.get('MAT-001') is None


def test_catalog_requires_unique_customer_and_inactivated_dealer(tmp_path):
    warehouse, settings = build(tmp_path)
    from sme_platform.bmq_mcp import McpUnauthorized
    with pytest.raises(McpUnauthorized): WarehouseCatalog(warehouse, 'Mai')
    with pytest.raises(McpUnauthorized): WarehouseCatalog(warehouse, 'nobody')
    rows = catalog_rows()
    rows['mini_crm_customers'][0]['is_active'] = False
    publish(warehouse, snapshot(rows, 1))
    with pytest.raises(McpUnauthorized): WarehouseCatalog(warehouse, 'KH1')


def test_initialize_notification_ping_and_tools_list(state):
    loader = catalog(state)
    status, payload = rpc(loader, 'initialize', {'protocolVersion': PROTOCOL_VERSION,
                                                 'clientInfo': {'name': 'test', 'version': '1'}})
    assert status == 200 and payload['result']['protocolVersion'] == PROTOCOL_VERSION
    assert payload['result']['capabilities']['tools'] == {'listChanged': False}
    status, payload = dispatch({'jsonrpc': '2.0', 'method': 'notifications/initialized'}, loader)
    assert (status, payload) == (202, None)
    assert rpc(loader, 'ping')[1]['result'] == {}
    tools = rpc(loader, 'tools/list')[1]['result']['tools']
    assert {t['name'] for t in tools} == {'search_products', 'get_product', 'quote_cart', 'prepare_order_draft'}
    assert all(t['inputSchema']['type'] == 'object' and t['annotations']['readOnlyHint'] for t in tools)


def test_protocol_errors_are_closed(state):
    loader = catalog(state)
    assert dispatch('not json', loader)[1]['error']['code'] != 0
    assert dispatch({'jsonrpc': '2.0', 'id': 1, 'method': 'unknown'}, loader)[1]['error']['code'] == METHOD_NOT_FOUND
    assert rpc(loader, 'tools/call', {'name': 'nope', 'arguments': {}})[1]['error']['code'] == INVALID_PARAMS
    assert rpc(loader, 'tools/call', {'arguments': {}})[1]['error']['code'] == INVALID_PARAMS
    assert rpc(loader, 'tools/call', {'name': 'search_products', 'arguments': {'query': 5}})[1]['error']['code'] == INVALID_PARAMS


def test_search_and_get_tools_carry_provider_freshness_image_and_label(state):
    loader = catalog(state)
    result = tool_result(loader, 'search_products', {'query': 'Bánh mì que', 'limit': 5})
    data = result['structuredContent']
    assert data['provider'] == {'name': PROVIDER_NAME, 'ui_theme': 'street'}
    assert data['data_as_of'] == loader.data_as_of
    assert [p['sku_code'] for p in data['products']] == ['BMQ-001']
    assert result['content'][0]['type'] == 'text' and 'BMQ-001' in result['content'][0]['text']
    product = tool_result(loader, 'get_product', {'sku': 'BMQ-001'})['structuredContent']['product']
    assert product['image_url'] == 'https://cdn.example/bmq-001.png'
    assert product['label_spec'] == {'shelf_life_days': 2, 'net_weight_value': '80',
                                     'net_weight_unit': 'g', 'barcode_value': '893',
                                     'partner_product_code': 'P1'}
    missing = tool_result(loader, 'get_product', {'sku': 'UNKNOWN'})
    assert missing['isError'] is True and missing['structuredContent']['error'] == 'unknown_sku'
    assert missing['structuredContent']['provider']['ui_theme'] == 'street'


def test_quote_cart_integer_vnd_multiples_of_ten_and_unknown_sku(state):
    loader = catalog(state)
    quoted = tool_result(loader, 'quote_cart', {'items': [
        {'sku': 'BMQ-001', 'quantity': 10}, {'sku': 'BMQ-002', 'quantity': 20}]})['structuredContent']
    assert quoted['total_vnd'] == 7000 * 10 + 8000 * 20 and quoted['total_vnd'] == 230000
    assert [line['line_total_vnd'] for line in quoted['lines']] == [70000, 160000]
    assert all(isinstance(line['unit_price_vnd'], int) for line in quoted['lines'])
    for quantity in (5, 0, -10, 11, True, '10'):
        result = tool_result(loader, 'quote_cart', {'items': [{'sku': 'BMQ-001', 'quantity': quantity}]})
        assert result['isError'] is True and result['structuredContent']['error'] == 'invalid_quantity'
    unknown = tool_result(loader, 'quote_cart', {'items': [{'sku': 'NOPE', 'quantity': 10}]})
    assert unknown['isError'] is True and unknown['structuredContent']['error'] == 'unknown_sku'
    unavailable = tool_result(loader, 'quote_cart', {'items': [{'sku': 'BMQ-005', 'quantity': 10}]})
    assert unavailable['isError'] is True and unavailable['structuredContent']['error'] == 'price_unavailable'
    assert rpc(loader, 'tools/call', {'name': 'quote_cart', 'arguments': {}})[1]['error']['code'] == INVALID_PARAMS


def test_prepare_order_draft_is_idempotent_and_never_writes(state):
    loader = catalog(state)
    warehouse = state[0]
    with warehouse.lock(write=False), warehouse.connect(read_only=True) as con:
        before = {table: con.execute('SELECT count(*) FROM bronze.supabase_current WHERE source_table=?',
                                     [table]).fetchone()[0] for table in ('dealer_orders', 'product_skus')}
        runs = con.execute('SELECT count(*) FROM meta_supabase_sync_runs').fetchone()[0]
        orders = con.execute('SELECT count(*) FROM silver.orders').fetchone()[0]
    call = {'items': [{'sku': 'BMQ-001', 'quantity': 10}], 'key': 'dealer-key-1'}
    first = tool_result(loader, 'prepare_order_draft', call)['structuredContent']
    second = tool_result(loader, 'prepare_order_draft', call)['structuredContent']
    other = tool_result(loader, 'prepare_order_draft',
                        {'items': [{'sku': 'BMQ-002', 'quantity': 10}], 'key': 'dealer-key-2'})['structuredContent']
    assert first['draft_id'] == second['draft_id'] and first['total_vnd'] == second['total_vnd'] == 70000
    assert first['draft_id'].startswith('draft-') and first['draft_id'] != other['draft_id']
    assert first['ui_payload'] == second['ui_payload']
    assert first['ui_payload'].startswith('<vnagent-order>') and first['ui_payload'].endswith('</vnagent-order>')
    ui = json.loads(first['ui_payload'][len('<vnagent-order>'):-len('</vnagent-order>')])
    assert ui['draft_id'] == first['draft_id'] and ui['submitted'] is False and ui['total_vnd'] == 70000
    assert ui['customer']['customer_code'] == 'KH1' and ui['lines'][0]['image_url'].endswith('bmq-001.png')
    assert first['submitted'] is False and first['order_created'] is False
    with warehouse.lock(write=False), warehouse.connect(read_only=True) as con:
        after = {table: con.execute('SELECT count(*) FROM bronze.supabase_current WHERE source_table=?',
                                    [table]).fetchone()[0] for table in ('dealer_orders', 'product_skus')}
        assert after == before
        assert con.execute('SELECT count(*) FROM meta_supabase_sync_runs').fetchone()[0] == runs
        assert con.execute('SELECT count(*) FROM silver.orders').fetchone()[0] == orders == 0


def test_tools_perform_no_network_io(state, monkeypatch):
    loader = catalog(state)

    def denied(*args, **kwargs):
        raise AssertionError('network is forbidden')
    monkeypatch.setattr(socket.socket, 'connect', denied)
    result = tool_result(loader, 'prepare_order_draft',
                         {'items': [{'sku': 'BMQ-001', 'quantity': 10}], 'key': 'net'})
    assert result['isError'] is False


# --- HTTP route -------------------------------------------------------------

def owner():
    async def principal():
        return Principal(TENANT, 'test')
    return principal


def auth(key):
    return {'Authorization': 'Bearer ' + key}


def test_route_requires_bearer_key_and_serves_tools(state):
    key = MCPKeyStore(state[1]).create('KH1')['key']
    client = TestClient(create_app(state[0], owner()))
    assert client.post('/mcp', json={'jsonrpc': '2.0', 'id': 1, 'method': 'ping'}).status_code == 401
    assert client.post('/mcp', json={'jsonrpc': '2.0', 'id': 1, 'method': 'ping'},
                       headers=auth('bmq_live_wrong')).status_code == 401
    ok = client.post('/mcp', json={'jsonrpc': '2.0', 'id': 1, 'method': 'ping'}, headers=auth(key))
    assert ok.status_code == 200 and ok.json()['result'] == {}
    init = client.post('/mcp', json={'jsonrpc': '2.0', 'id': 2, 'method': 'initialize',
                                     'params': {'protocolVersion': PROTOCOL_VERSION}}, headers=auth(key))
    assert init.json()['result']['protocolVersion'] == PROTOCOL_VERSION
    called = client.post('/mcp', json={'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call',
                                       'params': {'name': 'get_product', 'arguments': {'sku': 'BMQ-001'}}},
                         headers=auth(key))
    assert called.json()['result']['structuredContent']['provider']['ui_theme'] == 'street'
    notified = client.post('/mcp', json={'jsonrpc': '2.0', 'method': 'notifications/initialized'},
                           headers=auth(key))
    assert notified.status_code == 202 and notified.content == b''
    assert notified.headers['cache-control'] == 'no-store'
    assert notified.headers['x-content-type-options'] == 'nosniff'


def test_route_rejects_revoked_and_inactive(state):
    store = MCPKeyStore(state[1])
    revoked = store.create('KH1')
    inactive = store.create('KH2')
    assert store.revoke(revoked['id'])['revoked'] is True
    rows = catalog_rows()
    rows['mini_crm_customers'][1]['is_active'] = False
    publish(state[0], snapshot(rows, 1))
    client = TestClient(create_app(state[0], owner()))
    for key in (revoked['key'], inactive['key']):
        response = client.post('/mcp', json={'jsonrpc': '2.0', 'id': 9, 'method': 'ping'}, headers=auth(key))
        assert response.status_code == 401 and response.json()['error']['code'] == UNAUTHORIZED


def test_route_rejects_oversized_body(state):
    key = MCPKeyStore(state[1]).create('KH1')['key']
    client = TestClient(create_app(state[0], owner()))
    body = {'jsonrpc': '2.0', 'id': 1, 'method': 'ping', 'params': {'padding': 'x' * 70000}}
    response = client.post('/mcp', content=json.dumps(body).encode(), headers={**auth(key),
                                                                               'Content-Type': 'application/json'})
    assert response.status_code == 413


def test_route_is_absent_until_enabled(tmp_path):
    warehouse, _ = build(tmp_path, name='off', mcp_enabled=False)
    client = TestClient(create_app(warehouse, owner()))
    assert client.post('/mcp', json={'jsonrpc': '2.0', 'id': 1, 'method': 'ping'}).status_code == 404
    assert Settings(tmp_path / 'x', test_mode=True).mcp_enabled is False
    assert Settings(tmp_path / 'x', test_mode=True).mcp_ui_theme == 'bakery'


def test_existing_v1_routes_still_reject_non_owner(state):
    from sme_platform.supabase_sync import TENANT as tenant

    async def staff():
        return Principal(tenant, 'test', 'staff')

    store = MCPKeyStore(state[1])
    key = store.create('KH1')['key']
    body = {'kind': 'prices', 'customer': 'KH1', 'product': '', 'time_range': 'today', 'limit': 20}
    assert TestClient(create_app(state[0], staff)).post('/v1/customer', json=body).status_code == 403
    assert TestClient(create_app(state[0], owner())).post('/v1/customer', json=body).status_code == 200
    # A valid MCP key never authenticates or elevates an owner-only /v1 route.
    with_key = TestClient(create_app(state[0], staff)).post('/v1/customer', json=body, headers=auth(key))
    assert with_key.status_code == 403
