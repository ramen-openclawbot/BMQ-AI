from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json

import pytest
from fastapi.testclient import TestClient
from sme_platform.api import create_app, Principal
from sme_platform.bmq_semantic import METRICS
from sme_platform.config import Settings
from sme_platform.query import QueryEngine
from sme_platform.supabase_sync import FIELDS, KEYS, TOTALS, TENANT, publish
from sme_platform.warehouse import Warehouse


def snapshot(rows, offset=0):
    tables=[]
    for name, fields in FIELDS.items():
        records=[{**dict.fromkeys(fields.split()),**row} for row in rows.get(name,[])]
        total=str(sum(Decimal(str(row.get(TOTALS.get(name)) or 0)) for row in records)) if name in TOTALS else None
        tables.append({'name':name,'records':[json.dumps(row) for row in records],'count':len(records),'total':total})
    return {'database':'postgres','observed_at':(datetime.now(timezone.utc)+timedelta(seconds=offset)).isoformat(),'tables':tables}


@pytest.fixture
def state(tmp_path):
    w=Warehouse(Settings(tmp_path/'data',test_mode=True));w.initialize()
    rows={
        'dealer_orders':[
            {'id':'o1','submitted_at':'2026-09-08T17:10:00Z','status':'submitted','is_test':False,'currency':'VND','total_amount_vnd':'100.15'},
            {'id':'o2','submitted_at':'2026-09-09T01:00:00Z','status':'cancelled','is_test':False,'currency':'VND','total_amount_vnd':'900'},
            {'id':'o3','submitted_at':'2026-09-09T01:00:00Z','status':'submitted','is_test':True,'currency':'VND','total_amount_vnd':'900'},
            {'id':'o4','submitted_at':'2026-09-08T16:59:59Z','status':'submitted','is_test':False,'currency':'VND','total_amount_vnd':'20'},
        ],
        'kiosk_daily_reports':[
            {'id':'r1','report_date':'2026-09-09','status':'submitted','location_id':'l1'},
            {'id':'r2','report_date':'2026-09-09','status':'draft','location_id':'l2'},
        ],
        'kiosk_daily_report_channel_rows':[
            {'id':'c1','report_id':'r1','amount_vnd':'10.25'},
            {'id':'c2','report_id':'r1','amount_vnd':'20.25'},
            {'id':'c3','report_id':'r2','amount_vnd':'900'},
        ]}
    publish(w,snapshot(rows))
    return w,QueryEngine(w),rows


def query(engine,metric,**extra):
    return engine.execute({'metric':metric,'time_range':{'start':'2026-09-09','end':'2026-09-09'},**extra},TENANT,'owner:test')


def test_order_contract_timezone_no_tests_cancelled_or_fanout(state):
    _,e,_=state
    assert query(e,'dealer_order_count')['rows'][0]['dealer_order_count']==1
    r=query(e,'dealer_order_value')
    assert r['rows'][0]['dealer_order_value']==Decimal('100.15')
    assert r['snapshot_id'] and r['source_observed_at'] and 'not revenue' in r['definition']


def test_reports_join_once_and_exclude_draft(state):
    _,e,_=state
    assert query(e,'kiosk_report_count')['rows'][0]['kiosk_report_count']==1
    r=query(e,'kiosk_reported_amount',dimensions=['location'])
    assert r['rows'][0]['kiosk_reported_amount']==Decimal('30.50')
    assert r['rows'][0]['location']=='l1'


def test_changed_and_deleted_source_rows_are_visible_without_cache(state):
    w,e,rows=state
    before=query(e,'dealer_order_count')
    rows['dealer_orders'][0]['status']='cancelled'
    rows['kiosk_daily_report_channel_rows']=rows['kiosk_daily_report_channel_rows'][1:]
    publish(w,snapshot(rows,1))
    assert query(e,'dealer_order_count')['rows']==[]
    assert query(e,'kiosk_reported_amount')['rows'][0]['kiosk_reported_amount']==Decimal('20.25')
    assert before['snapshot_id']!=query(e,'kiosk_report_count')['snapshot_id']


@pytest.mark.parametrize('extra',[{'filters':[]},{'sql':'drop table x'},{'tenant_id':'other'},{'dimensions':['location']},{'dimensions':['date','date']},{'limit':501},{'limit':True},{'comparison':'previous_month'}])
def test_closed_dsl(state,extra):
    with pytest.raises(ValueError):query(state[1],'dealer_order_count',**extra)


def test_wrong_identity_no_access(state):
    e=state[1]
    for tenant,permission in [('other','owner'),(TENANT,'staff')]:
        with pytest.raises(PermissionError):e.execute({'metric':'dealer_order_count'},tenant,permission)


def test_stale_snapshot_fails_not_zero(state):
    w,e,_=state
    query(e,'dealer_order_count')
    with w.lock(),w.connect() as c:c.execute("update meta_supabase_sync_runs set observed_at=now()-interval '31 minutes'")
    with pytest.raises(RuntimeError,match='stale'):query(e,'dealer_order_count')


def test_missing_snapshot_fails(tmp_path):
    w=Warehouse(Settings(tmp_path/'empty',test_mode=True));w.initialize()
    with pytest.raises(RuntimeError):query(QueryEngine(w),'dealer_order_count')


def test_truncation_is_explicit(state):
    r=state[1].execute({'metric':'dealer_order_count','time_range':{'start':'2026-09-08','end':'2026-09-09'},'dimensions':['date'],'limit':1},TENANT)
    assert len(r['rows'])==1 and r['truncated']


def test_api_bmq_catalog_excludes_generic_revenue(state):
    w,_,_=state
    client=TestClient(create_app(w,authenticator=lambda:Principal(TENANT,'fixture-owner')))
    assert set(client.get('/v1/semantic').json()['metrics'])==set(METRICS)
    result=client.post('/v1/query',json={'metric':'dealer_order_count','time_range':{'start':'2026-09-09','end':'2026-09-09'}})
    assert result.status_code==200 and result.json()['rows'][0]['dealer_order_count']==1
    assert 'payload' not in result.text and 'staff_id' not in result.text
