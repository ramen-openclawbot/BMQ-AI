from datetime import datetime, timezone
from decimal import Decimal
import json
import pytest
from fastapi.testclient import TestClient
from sme_platform.api import create_app, Principal
from sme_platform.bmq_customer import execute
from sme_platform.config import Settings
from sme_platform.query import QueryEngine
from sme_platform.supabase_sync import publish, TENANT
from sme_platform.warehouse import Warehouse
from test_bmq_semantic import snapshot

@pytest.fixture
def state(tmp_path):
    w=Warehouse(Settings(tmp_path/'data',test_mode=True));w.initialize()
    rows={
      'mini_crm_customers':[{'id':'c1','customer_code':'KH1','customer_name':'Mai An','is_active':True},{'id':'c2','customer_code':'KH2','customer_name':'Mai Binh','is_active':True}],
      'product_skus':[{'id':'s1','sku_code':'BMQ-001','product_name':'Bánh mì','unit':'que','unit_price':'999'}],
      'mini_crm_customer_price_list':[{'id':'p1','customer_id':'c1','sku_id':'s1','price_vnd_per_unit':'6500.25','currency':'VND','is_active':True},{'id':'p2','customer_id':'c2','sku_id':'s1','price_vnd_per_unit':'9000','currency':'VND','is_active':True}],
      'dealer_orders':[{'id':'o1','customer_id':'c1','order_number':'D1','status':'submitted','is_test':False,'submitted_at':'2026-09-08T17:01:00Z','total_amount_vnd':'15000','currency':'VND'},{'id':'o2','customer_id':'c2','order_number':'D2','status':'submitted','is_test':False,'submitted_at':'2026-09-08T17:01:00Z','total_amount_vnd':'99000','currency':'VND'}]}
    publish(w,snapshot(rows))
    return w,QueryEngine(w),rows

def call(state,**kw):
    return execute(state[1],{'kind':'prices','customer':'KH1','product':'','time_range':'today','limit':20,**kw},TENANT,'owner:test')

def test_exact_customer_scope_decimal_no_default_price(state):
    r=call(state,customer='  mai an  ')
    assert r['rows'][0]['price']==Decimal('6500.25') and len(r['rows'])==1
    assert r['customer']['customer_code']=='KH1' and r['snapshot_id']

def test_partial_and_ambiguous_names_never_choose_automatically(state):
    r=call(state,customer='Mai');assert r['status']=='choose_customer' and not r['rows'] and len(r['candidates'])==2
    assert call(state,customer='Mai A')['status']=='choose_customer'
    assert call(state,customer="' OR 1=1 --")['status']=='not_found'
    state[2]['mini_crm_customers'][1]['customer_name']='Mai An'
    publish(state[0],snapshot(state[2]))
    assert call(state,customer='Mai An')['status']=='choose_customer'

def test_missing_price_no_catalog_or_other_customer_fallback(state):
    state[2]['mini_crm_customer_price_list']=state[2]['mini_crm_customer_price_list'][1:]
    publish(state[0],snapshot(state[2]));assert call(state)['rows']==[]

def test_duplicate_active_prices_fail(state):
    state[2]['mini_crm_customer_price_list'].append({**state[2]['mini_crm_customer_price_list'][0],'id':'p3'})
    publish(state[0],snapshot(state[2]))
    with pytest.raises(RuntimeError,match='Ambiguous'):call(state)

def test_inactive_product_unknown_and_history(state):
    assert call(state,product='BMQ-001')['rows'][0]['price']==Decimal('6500.25')
    assert call(state,product='unknown')['status']=='product_not_unique'
    with pytest.raises(ValueError):call(state,time_range='yesterday')
    state[2]['mini_crm_customers'][0]['is_active']=False
    publish(state[0],snapshot(state[2]));assert call(state)['status']=='inactive_customer'

def test_orders_identity_vietnam_date_status_and_truncation(state):
    period={'start':'2026-09-09','end':'2026-09-09'}
    assert [r['order_number'] for r in call(state,kind='orders',time_range=period)['rows']]==['D1']
    state[2]['dealer_orders'].append({**state[2]['dealer_orders'][0],'id':'o3','order_number':'D3','status':'cancelled'})
    publish(state[0],snapshot(state[2]));assert len(call(state,kind='orders',time_range=period)['rows'])==1
    state[2]['dealer_orders'][-1]['status']='submitted'
    publish(state[0],snapshot(state[2]));assert call(state,kind='orders',time_range=period,limit=1)['truncated']

@pytest.mark.parametrize('kw',[{'limit':True},{'limit':21},{'customer':''},{'customer':'x\n'},{'kind':'sql'},{'tenant':'other'},{'kind':'orders','product':'BMQ-001'}])
def test_closed_inputs(state,kw):
    with pytest.raises(ValueError):call(state,**kw)

def test_permissions_stale_manifest(state):
    for tenant,permission in [('other','owner'),(TENANT,'staff')]:
        with pytest.raises(PermissionError):execute(state[1],{},tenant,permission)
    with state[0].lock(),state[0].connect() as c:c.execute("UPDATE meta_supabase_sync_runs SET observed_at=now()-interval '31 minutes'")
    with pytest.raises(RuntimeError,match='stale'):call(state)

def test_api_owner_and_strict_payload(state):
    async def owner():return Principal(TENANT,'test')
    client=TestClient(create_app(state[0],owner))
    body={'kind':'prices','customer':'KH1','product':'','time_range':'today','limit':20}
    r=client.post('/v1/customer',json=body);assert r.status_code==200 and Decimal(str(r.json()['rows'][0]['price']))==Decimal('6500.25')
    assert client.post('/v1/customer',json={**body,'tenant':'x'}).status_code==400
    async def staff():return Principal(TENANT,'test','staff')
    assert TestClient(create_app(state[0],staff)).post('/v1/customer',json=body).status_code==403

def test_unreconciled_source_and_missing_order_date_rejected(state):
    w,e,rows=state
    rows['dealer_orders'][0]['submitted_at']=None
    publish(w,snapshot(rows))
    with pytest.raises(RuntimeError,match='dates'):call(state,kind='orders')
    with w.lock(),w.connect() as c:
        record=c.execute('SELECT run_id,manifest FROM meta_supabase_sync_runs ORDER BY observed_at DESC LIMIT 1').fetchone()
        m=json.loads(record[1]);m['tables']['mini_crm_customer_price_list']['reconciled']=False
        c.execute('UPDATE meta_supabase_sync_runs SET manifest=? WHERE run_id=?',[json.dumps(m),record[0]])
    with pytest.raises(RuntimeError,match='source'):call(state)
