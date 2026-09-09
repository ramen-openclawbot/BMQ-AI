import json
from datetime import datetime, timezone
from decimal import Decimal
import pytest
from sme_platform.config import Settings
from sme_platform.warehouse import Warehouse
from sme_platform.query import QueryEngine

@pytest.fixture
def wh(tmp_path):
    w=Warehouse(Settings(tmp_path/'data',test_mode=True));w.initialize();return w

def put(w,tmp_path,entity,rows,tenant='bmq',source='sample'):
    p=tmp_path/(entity+'.json');p.write_text(json.dumps(rows));return w.ingest_file(p,tenant,source,entity)

def order(id='o1',amount=100,**kw):
    return {'id':id,'currency':'VND','status':'completed','ordered_at':'2026-09-09T00:30:00+07:00','net_amount':amount,**kw}

def test_immutable_idempotent_update_and_timezone(wh,tmp_path):
    first=put(wh,tmp_path,'orders',[order(updated_at='2026-09-09T00:00:00Z')])
    assert put(wh,tmp_path,'orders',[order(updated_at='2026-09-09T00:00:00Z')])['status']=='duplicate'
    put(wh,tmp_path,'orders',[order(amount=200,updated_at='2026-09-10T00:00:00Z')])
    put(wh,tmp_path,'orders',[order(amount=50,updated_at='2026-09-08T00:00:00Z')])
    with wh.connect(True) as c:
        row=c.execute('select net_amount,ordered_at from silver.orders').fetchone()
        assert row[0]==200 and row[1].day==8
    assert json.loads((wh.root/first['raw_path']).read_text())[0]['net_amount']==100
    wh.rebuild_silver();wh.rebuild_gold()
    r=QueryEngine(wh).execute({'metric':'revenue','time_range':{'start':'2026-09-09','end':'2026-09-09'}},'bmq')
    assert r['rows'][0]['revenue']==200

def test_invalid_atomic_batch_preserves_previous_and_raw(wh,tmp_path):
    put(wh,tmp_path,'orders',[order()])
    for rows in [[order('o2'),{'id':'bad'}],[order(),order()],[order(ordered_at='yesterday')],[order(amount='NaN')]]:
        with pytest.raises(ValueError):put(wh,tmp_path,'orders',rows)
    with wh.connect(True) as c:assert c.execute('select count(*) from silver.orders').fetchone()[0]==1
    assert wh.validate()['status']=='fail'
    assert len(list((wh.root/'raw').rglob('*.json')))==5

def test_tenant_currency_status_and_cache(wh,tmp_path):
    put(wh,tmp_path,'orders',[order(),order('usd',currency='USD'),order('cancel',status='cancelled'),order('refund',status='refunded')])
    put(wh,tmp_path,'orders',[order(amount=999)],tenant='other')
    wh.rebuild_gold();e=QueryEngine(wh)
    q={'metric':'revenue','time_range':{'start':'2026-09-09','end':'2026-09-09'}}
    a=e.execute(q,'bmq');assert sorted(r['revenue'] for r in a['rows'])==[100,100]
    assert e.execute(q,'bmq')['cache_hit']
    assert e.execute(q,'other')['rows'][0]['revenue']==999
    with pytest.raises(PermissionError):e.execute(q,'bmq','staff')
    for invalid in [{**q,'sql':'SELECT *'}, {**q,'metric':'silver.orders'},{**q,'dimensions':['email']},{**q,'limit':1000},{**q,'filters':[{'field':'currency','operator':'sql','value':'x'}]}]:
        with pytest.raises(ValueError):e.execute(invalid,'bmq')

def test_references_soft_delete_and_all_entities(wh,tmp_path):
    with pytest.raises(ValueError):put(wh,tmp_path,'orders',[order(customer_id='missing')])
    assert wh.validate()['status']=='fail'
    put(wh,tmp_path,'customers',[{'id':'missing','email':'a@example.invalid'}])
    put(wh,tmp_path,'orders',[order(customer_id='missing')])
    assert all(r['status']=='pass' for r in wh.validate()['datasets'])
    put(wh,tmp_path,'orders',[{'id':'o1','is_deleted':True}]);wh.rebuild_gold()
    with wh.connect(True) as c:
        assert c.execute('select is_deleted from silver.orders').fetchone()[0]
        assert c.execute('select count(*) from gold.gold_daily_revenue').fetchone()[0]==0
        assert c.execute("select count(*) from information_schema.tables where table_schema='silver'").fetchone()[0]==14

def test_comparison_group_and_financial_consistency(wh,tmp_path):
    put(wh,tmp_path,'orders',[order('prior',ordered_at='2026-09-08',amount='123.45'),order(amount='246.90')]);wh.rebuild_gold()
    r=QueryEngine(wh).execute({'metric':'revenue','dimensions':['date'],'time_range':{'start':'2026-09-09','end':'2026-09-09'},'comparison':'previous_period'},'bmq')
    assert r['rows'][0]['revenue']==Decimal('246.90')
    assert r['comparison']['rows'][0]['revenue']==Decimal('123.45')
    with pytest.raises(ValueError):put(wh,tmp_path,'orders',[order(subtotal=100,discount_amount=5)])

def test_ssd_missing_fails_closed(tmp_path):
    with pytest.raises(RuntimeError):Warehouse(Settings(tmp_path/'production')).initialize()

def test_customer_identity_and_period_distinct(wh,tmp_path):
    put(wh,tmp_path,'customers',[{'id':'c1','email':'TEST@example.invalid'}])
    put(wh,tmp_path,'customers',[{'id':'customer_other','email':'test@example.invalid'}],source='other')
    put(wh,tmp_path,'orders',[order(customer_id='c1'),order('o2',customer_id='c1',ordered_at='2026-09-08T00:00:00Z')])
    put(wh,tmp_path,'orders',[order('o3',customer_id='customer_other')],source='other')
    wh.rebuild_gold()
    result=QueryEngine(wh).execute({'metric':'customer_count','time_range':{'start':'2026-09-01','end':'2026-09-30'}},'bmq','owner:rls:v1:user')
    assert result['rows'][0]['customer_count']==1
    with wh.connect(True) as con:assert con.execute('select count(*) from silver.customers').fetchone()[0]==1

def test_sample_entities_gold_and_rebuild(wh,tmp_path):
    from pathlib import Path
    for entity in ['customers','locations','products','orders','order_items','payments']:
        wh.ingest_file(Path(__file__).parents[1]/'fixtures'/(entity+'.json'),'bmq','sample',entity)
    wh.rebuild_silver();wh.rebuild_gold()
    assert wh.validate()['status']=='pass'
    with wh.connect(True) as con:
        assert con.execute('SELECT units_sold FROM gold.gold_store_daily_metrics').fetchone()[0]==2
        assert con.execute('SELECT revenue FROM gold.gold_product_daily_sales').fetchone()[0]==100000
    assert len(list((wh.root/'bronze').rglob('*.parquet')))==6
    assert (wh.root/'gold/gold_inventory_current/manifest.json').exists()

def test_tombstone_preserves_business_history(wh,tmp_path):
    put(wh,tmp_path,'orders',[order()])
    put(wh,tmp_path,'orders',[{'id':'o1','is_deleted':True}])
    with wh.connect(True) as con:
        assert con.execute('SELECT net_amount FROM silver.orders').fetchone()[0]==100

def test_path_escape_and_unavailable_source(wh,tmp_path):
    from sme_platform.ingestion import FileConnector
    with pytest.raises(FileNotFoundError):list(FileConnector(tmp_path/'missing.json').extract())
    outside=tmp_path/'outside';outside.mkdir()
    (wh.root/'raw/bmq').symlink_to(outside,target_is_directory=True)
    with pytest.raises(ValueError):put(wh,tmp_path,'orders',[order()])
    assert not list(outside.iterdir())

def test_parquet_export_failure_is_not_failed_ingestion(wh,tmp_path,monkeypatch):
    monkeypatch.setattr(wh,'_export',lambda *_: (_ for _ in ()).throw(OSError('synthetic disk failure')))
    result=put(wh,tmp_path,'orders',[order()])
    assert result['status']=='success' and result['parquet_export']=='pending_rebuild'
    with wh.connect(True) as con:
        assert con.execute('SELECT status FROM meta_ingestion_runs').fetchone()[0]=='success'
        assert con.execute('SELECT count(*) FROM silver.orders').fetchone()[0]==1

def test_dirty_tenant_refresh_keeps_other_company(wh,tmp_path):
    put(wh,tmp_path,'orders',[order(amount=100)])
    put(wh,tmp_path,'orders',[order(amount=999)],tenant='other')
    assert wh.refresh_gold()['tenants_refreshed']==2
    assert wh.refresh_gold()['status']=='unchanged'
    put(wh,tmp_path,'orders',[order(amount=200)])
    result=wh.refresh_gold();assert result['tenants_refreshed']==1
    q={'metric':'revenue','time_range':{'start':'2026-09-09','end':'2026-09-09'}}
    engine=QueryEngine(wh)
    assert engine.execute(q,'bmq')['rows'][0]['revenue']==200
    assert engine.execute(q,'other')['rows'][0]['revenue']==999

def test_pending_publication_blocks_cached_and_summary_answers(wh,tmp_path):
    put(wh,tmp_path,'orders',[order()]);wh.refresh_gold()
    engine=QueryEngine(wh);q={'metric':'revenue','time_range':{'start':'2026-09-09','end':'2026-09-09'}}
    engine.execute(q,'bmq')
    put(wh,tmp_path,'orders',[order(amount=200)])
    with pytest.raises(RuntimeError,match='publication pending'):engine.execute(q,'bmq')
    with pytest.raises(RuntimeError,match='publication pending'):engine.get_top_products('bmq')
    wh.refresh_gold();assert engine.execute(q,'bmq')['rows'][0]['revenue']==200
    wh.rebuild_silver()
    with pytest.raises(RuntimeError,match='publication pending'):engine.execute(q,'bmq')
