from copy import deepcopy
from decimal import Decimal
import pytest
from sme_platform.bmq_customer import execute
from sme_platform.supabase_sync import TENANT, publish
from test_bmq_customer import state, call
from test_bmq_semantic import snapshot

@pytest.fixture
def details(state):
    w,e,rows=state
    rows['mini_crm_customers'].append({'id':'r1','customer_code':'R1','customer_name':'Renamed route','is_active':True})
    rows['dealer_orders'][0]['requested_delivery_date']='2026-09-11'
    line={'id':'l1','order_id':'o1','sku_id':'s1','sku_code':'OLD-SKU','product_name':'Historical bread','unit':'que','quantity':'2','unit_price_vnd':'100','line_total_vnd':'200','ordered_quantity':'2','exchange_quantity':'1','makeup_quantity':'3','physical_quantity':'6','route_customer_id':'r1','route_customer_name':'Old route','price_source':'customer_override'}
    rows['dealer_order_items']=[line,{**line,'id':'l2','route_customer_id':None,'route_customer_name':None},{**line,'id':'l3','order_id':'o2'}]
    publish(w,snapshot(rows))
    return state

def query(state,**kw):
    return call(state,**{'kind':'order_details','time_range':{'start':'2026-09-09','end':'2026-09-09'},**kw})

def test_historical_no_reprice_no_fanout_totals_before_limit(details):
    r=query(details,limit=1)
    assert r['truncated'] and len(r['rows'])==1
    assert r['totals']['matched_order_count']==1 and r['totals']['matched_line_count']==2
    assert r['totals']['amount_vnd']==Decimal('400')
    assert r['totals']['quantities_by_unit'][0]['physical_quantity']==12
    assert r['totals']['quantities_by_unit'][0]['quantity']==4
    assert r['rows'][0]['unit_price_vnd']==100

def test_route_identity_snapshot_and_product_scope(details):
    r=query(details,product='BMQ-001',detail_filters={'route':'R1'})
    assert len(r['rows'])==1 and r['rows'][0]['route_customer_name']=='Old route'
    assert r['totals']['amount_vnd']==200
    assert query(details,product='unknown')['status']=='product_not_unique'
    assert query(details,detail_filters={'route':'unknown'})['status']=='route_not_unique'

def test_missing_snapshot_never_current_name_fallback(details):
    details[2]['dealer_order_items'][0]['route_customer_name']=None
    publish(details[0],snapshot(details[2]))
    assert query(details,detail_filters={'route':'R1'})['rows'][0]['route_customer_name'] is None

def test_dates_status_and_test_flags(details):
    assert query(details,detail_filters={'date_basis':'delivery'})['rows']==[]
    assert len(query(details,time_range={'start':'2026-09-11','end':'2026-09-11'},detail_filters={'date_basis':'delivery'})['rows'])==2
    original=details[2]['dealer_orders'][0]
    details[2]['dealer_orders'] += [{**original,'id':'oc','order_number':'C','status':'cancelled'},{**original,'id':'ot','order_number':'T','is_test':True}]
    line=details[2]['dealer_order_items'][0]
    details[2]['dealer_order_items'] += [{**line,'id':'lc','order_id':'oc'},{**line,'id':'lt','order_id':'ot'}]
    publish(details[0],snapshot(details[2]))
    assert query(details)['totals']['matched_order_count']==1
    assert query(details,detail_filters={'status':'cancelled'})['totals']['matched_order_count']==1
    assert query(details,detail_filters={'status':'all'})['totals']['matched_order_count']==2

@pytest.mark.parametrize('filters',[{'status':'approved'},{'date_basis':'created'},{'route':1},{'route':'x\n'},{'tenant':'other'}])
def test_closed_filters(details,filters):
    with pytest.raises(ValueError):query(details,detail_filters=filters)

def test_other_kind_cannot_receive_new_filters(details):
    with pytest.raises(ValueError):call(details,kind='orders',detail_filters={})

def test_fail_closed_amount_and_currency(details):
    details[2]['dealer_order_items'][0]['line_total_vnd']='201'
    publish(details[0],snapshot(details[2]))
    with pytest.raises(RuntimeError,match='mismatch'):query(details)
    details[2]['dealer_order_items'][0]['line_total_vnd']='200'
    details[2]['dealer_orders'][0]['currency']='USD'
    publish(details[0],snapshot(details[2]))
    with pytest.raises(RuntimeError,match='currency'):query(details)

def test_permissions_freshness(details):
    with pytest.raises(PermissionError):execute(details[1],{},TENANT,'staff')
    with details[0].lock(),details[0].connect() as c:c.execute("UPDATE meta_supabase_sync_runs SET observed_at=now()-interval '31 minutes'")
    with pytest.raises(RuntimeError,match='stale'):query(details)

def test_missing_quantity_remains_unknown(details):
    details[2]['dealer_order_items'][0]['exchange_quantity']=None
    publish(details[0],snapshot(details[2]))
    r=query(details)
    assert r['totals']['quantities_by_unit'][0]['exchange_quantity'] is None
    assert r['totals']['amount_vnd']==400

def test_ambiguous_route_does_not_choose_and_missing_lines_fail(details):
    details[2]['mini_crm_customers'].append({'id':'r2','customer_code':'R2','customer_name':'Renamed route','is_active':True})
    publish(details[0],snapshot(details[2]))
    r=query(details,detail_filters={'route':'Renamed route'})
    assert r['status']=='route_not_unique' and len(r['route_candidates'])==2
    details[2]['dealer_order_items']=[line for line in details[2]['dealer_order_items'] if line['order_id']!='o1']
    publish(details[0],snapshot(details[2]))
    with pytest.raises(RuntimeError,match='source incomplete'):query(details)

def test_api_details_owner_success(details):
    from fastapi.testclient import TestClient
    from sme_platform.api import create_app, Principal
    async def owner():return Principal(TENANT,'owner-test')
    client=TestClient(create_app(details[0],owner))
    r=client.post('/v1/customer',json={'kind':'order_details','customer':'KH1','product':'','time_range':{'start':'2026-09-09','end':'2026-09-09'},'limit':10,'detail_filters':{'route':'R1','date_basis':'submitted','status':'submitted'}})
    assert r.status_code==200 and Decimal(r.json()['totals']['amount_vnd'])==200
    assert r.json()['filters']['date_basis']=='submitted'
