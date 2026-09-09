from decimal import Decimal
import pytest
from sme_platform.bmq_receivable import calculate
from sme_platform.bmq_customer import execute
from sme_platform.query import QueryEngine
from sme_platform.warehouse import Warehouse
from sme_platform.config import Settings
from sme_platform.supabase_sync import publish, TENANT, query_sql
from test_bmq_semantic import snapshot

P={'start':'2026-08-01','end':'2026-08-31'}

def data():
    customers=[{'id':'n','customer_code':'NPP1','customer_name':'NPP Test','is_npp':True,'is_active':True},
        {'id':'a','customer_code':'A','customer_name':'Đại lý A','is_active':True,'supplied_by_npp_customer_id':'n','npp_management_fee_vnd':'100.25'},
        {'id':'b','customer_code':'B','customer_name':'B','is_active':True,'supplied_by_npp_customer_id':'n','npp_management_fee_vnd':'50'},
        {'id':'c','customer_code':'C','customer_name':'Inactive','is_active':False,'supplied_by_npp_customer_id':'n','npp_management_fee_vnd':'900'}]
    line={'id':'l1','approval_status':'approved','revenue_date':'2026-08-10','parent_customer_id':'n','customer_id':'a','route_customer_id':'a','route_customer_name':'Đại lý A','gross_revenue':'1000.50'}
    return customers,[line,{**line,'id':'l2','customer_id':'n','route_customer_id':'','route_customer_name':'','gross_revenue':'200'},
      {**line,'id':'l3','approval_status':'pending','gross_revenue':'999'},
      {**line,'id':'l4','revenue_date':'2026-09-01','gross_revenue':'999'}]

def calc(customers,lines,limit=20):
    return calculate({},customers[0],customers,lines,P['start'],P['end'],limit)

def test_period_parity_fees_once_even_zero_sales_no_join_fanout():
    cs,ls=data();r=calc(cs,ls)
    assert r['totals']['gross']==Decimal('1200.50')
    assert r['totals']['management_fee']==Decimal('150.25')
    assert r['totals']['period_payable']==Decimal('1050.25')
    assert r['totals']['line_count']==2 and r['unmapped_line_count']==1
    assert calc(cs,ls,1)['totals']==r['totals'] and calc(cs,ls,1)['truncated']
    assert calc(cs,[])['totals']['period_payable']==Decimal('-150.25')

def test_route_priority_name_alias_and_other_npp_exclusion():
    cs,ls=data();ls=[{**ls[0],'parent_customer_id':'other','customer_id':'other','route_customer_id':'','route_customer_name':'dai ly a'}]
    assert calc(cs,ls)['totals']['gross']==Decimal('1000.50')
    ls[0]['route_customer_name']='different'
    assert calc(cs,ls)['totals']['gross']==0

def test_ambiguous_child_and_invalid_amount_and_old_projection_fail():
    cs,ls=data();cs[2]['customer_name']='Dai ly a'
    with pytest.raises(RuntimeError,match='Ambiguous'):calc(cs,ls)
    cs,ls=data();ls[0]['gross_revenue']='NaN'
    with pytest.raises(RuntimeError,match='financial'):calc(cs,ls)
    cs,ls=data();del ls[0]['route_customer_id']
    with pytest.raises(RuntimeError,match='projection'):calc(cs,ls)

def test_owner_lane_scope_update_and_raw_scalar_projection(tmp_path):
    w=Warehouse(Settings(tmp_path/'data',test_mode=True));w.initialize();e=QueryEngine(w)
    cs,ls=data();rows={'mini_crm_customers':cs,'revenue_ledger_lines':ls};publish(w,snapshot(rows))
    q={'kind':'npp_receivable','customer':'NPP1','product':'','time_range':P,'limit':20}
    r=execute(e,q,TENANT,'owner:test');assert r['totals']['period_payable']==Decimal('1050.25')
    assert execute(e,{**q,'customer':'A'},TENANT,'owner')['status']=='not_npp'
    with pytest.raises(ValueError):execute(e,{**q,'product':'SKU'},TENANT,'owner')
    with pytest.raises(PermissionError):execute(e,q,TENANT,'staff')
    rows['revenue_ledger_lines']=ls[1:];publish(w,snapshot(rows))
    assert execute(e,q,TENANT,'owner')['totals']['gross']==Decimal('200')
    sql=query_sql();assert "raw_payload->>'route_customer_id'" in sql
    assert '"raw_payload"' not in sql and 'READ ONLY' in sql


def test_absent_customer_codes_use_stable_identity_and_duplicate_npp_names_block():
    cs,ls=data();cs[1]['customer_code']=None
    assert calc(cs,ls)['rows'][0]['customer_code']=='a'
    cs.append({**cs[0],'id':'other'})
    with pytest.raises(RuntimeError,match='Ambiguous NPP'):calc(cs,ls)

def test_raw_json_decimal_lexeme_is_not_rounded_through_float(tmp_path):
    w=Warehouse(Settings(tmp_path/'data',test_mode=True));w.initialize()
    cs,ls=data();ls=[{**ls[0],'gross_revenue':'1234567890123456.78'}]
    s=snapshot({'mini_crm_customers':cs,'revenue_ledger_lines':ls})
    t=next(t for t in s['tables'] if t['name']=='revenue_ledger_lines')
    t['records'][0]=t['records'][0].replace('"1234567890123456.78"','1234567890123456.78')
    publish(w,s)
    q={'kind':'npp_receivable','customer':'NPP1','product':'','time_range':P,'limit':20}
    assert execute(QueryEngine(w),q,TENANT,'owner')['totals']['gross']==Decimal('1234567890123456.78')
