"""Synthetic owner queries: no production storage or network."""
from decimal import Decimal
import pytest
from fastapi.testclient import TestClient
from sme_platform.api import create_app, Principal
from sme_platform.supabase_sync import publish, TENANT
from test_bmq_customer import state, call
from test_bmq_semantic import snapshot

def prepare(state):
    state[2]['product_skus'][0].update(sku_type='finished_good',hide_from_dealer_portal=False,selling_price='7000.1234')
    publish(state[0],snapshot(state[2]))

def query(state, **kw): return call(state,kind='effective_prices',**kw)

def test_precedence_and_explicit_unchanged(state):
    prepare(state)
    r=query(state)['rows'][0]
    assert r['price']==Decimal('6500.25') and r['price_source']=='customer_override'
    state[2]['mini_crm_customer_price_list'][0]['is_active']=False
    publish(state[0],snapshot(state[2]))
    r=query(state)['rows'][0]
    assert r['price']==Decimal('7000.1234') and r['price_source']=='cost_values_selling_price'
    assert call(state)['rows']==[]
    assert query(state,customer='KH2')['rows'][0]['price']==Decimal('9000')

@pytest.mark.parametrize('value',[None,'0','-10'])
def test_invalid_override_no_fallback(state,value):
    prepare(state)
    state[2]['mini_crm_customer_price_list'][0]['price_vnd_per_unit']=value
    publish(state[0],snapshot(state[2]))
    row=query(state)['rows'][0]
    assert row['price'] is None and row['price_status']=='unavailable' and row['price_source']=='customer_override'

@pytest.mark.parametrize('value',[None,'0','-1'])
def test_missing_default_never_unit_price(state,value):
    prepare(state)
    state[2]['mini_crm_customer_price_list'][0]['is_active']=False
    state[2]['product_skus'][0]['selling_price']=value
    publish(state[0],snapshot(state[2]))
    row=query(state)['rows'][0]
    assert row['price'] is None and row['price_status']=='unavailable'

def test_duplicates_currency(state):
    prepare(state)
    prices=state[2]['mini_crm_customer_price_list'];prices[0]['currency']='USD'
    publish(state[0],snapshot(state[2]))
    with pytest.raises(RuntimeError,match='currency'):query(state)
    prices[0]['currency']='VND';prices.append({**prices[0],'id':'p3'})
    publish(state[0],snapshot(state[2]))
    with pytest.raises(RuntimeError,match='Ambiguous'):query(state)

def test_identity_history_hidden(state):
    prepare(state)
    assert query(state,customer='Mai')['status']=='choose_customer'
    assert query(state,product="' OR 1=1 --")['status']=='product_not_unique'
    with pytest.raises(ValueError,match='history'):query(state,time_range='yesterday')
    state[2]['product_skus'][0]['hide_from_dealer_portal']=True
    publish(state[0],snapshot(state[2]))
    assert query(state)['rows']==[]
    assert query(state,product='BMQ-001')['status']=='product_unavailable'
    state[2]['mini_crm_customers'][0]['is_active']=False
    publish(state[0],snapshot(state[2]))
    assert query(state)['status']=='inactive_customer'

def test_catalog_and_limits(state):
    prepare(state)
    products=state[2]['product_skus'];products.append({**products[0],'id':'s2','sku_code':'BMQ-002'})
    publish(state[0],snapshot(state[2]))
    assert query(state,product='Bánh mì')['status']=='product_not_unique'
    result=query(state,limit=1)
    assert result['truncated'] and len(result['rows'])==1
    assert query(state,product='BMQ-002')['rows'][0]['price_source']=='cost_values_selling_price'
    products[1]['sku_type']='material';publish(state[0],snapshot(state[2]))
    assert query(state,product='BMQ-002')['status']=='product_unavailable'
    products[1].update(sku_type=None,category='Thành phẩm');publish(state[0],snapshot(state[2]))
    assert query(state,product='BMQ-002')['rows'][0]['price']==Decimal('7000.1234')

def test_api_permissions_stale_orders(state):
    prepare(state)
    async def owner(): return Principal(TENANT,'test')
    body={'kind':'effective_prices','customer':'KH1','product':'','time_range':'today','limit':20}
    client=TestClient(create_app(state[0],owner))
    assert client.post('/v1/customer',json=body).json()['rows'][0]['price_source']=='customer_override'
    async def staff(): return Principal(TENANT,'test','staff')
    assert TestClient(create_app(state[0],staff)).post('/v1/customer',json=body).status_code==403
    async def other(): return Principal('other','test')
    assert TestClient(create_app(state[0],other)).post('/v1/customer',json=body).status_code==403
    period={'start':'2026-09-09','end':'2026-09-09'}
    assert call(state,kind='orders',time_range=period)['rows'][0]['amount']=='15000'
    with state[0].lock(),state[0].connect() as con:con.execute("UPDATE meta_supabase_sync_runs SET observed_at=now()-interval '31 minutes'")
    with pytest.raises(RuntimeError,match='stale'):query(state)

@pytest.mark.parametrize('value',['NaN','Infinity','bad',True])
def test_corrupt_numeric_rejected(value):
    from sme_platform.bmq_customer import effective_prices
    sku={'id':'s','sku_code':'S','product_name':'Bread','unit':'pc','sku_type':'finished_good','selling_price':value}
    with pytest.raises(RuntimeError,match='Invalid price'):effective_prices({'s':sku},[],'')

def test_old_projection_does_not_look_like_missing_price():
    from sme_platform.bmq_customer import effective_prices
    sku={'id':'s','sku_code':'S','product_name':'Bread','unit':'pc','sku_type':'finished_good','unit_price':999}
    with pytest.raises(RuntimeError,match='projection'):effective_prices({'s':sku},[],'')
