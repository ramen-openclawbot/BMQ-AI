"""Closed semantic grammar: user strings become parameters, never SQL identifiers."""
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
import copy, hashlib, json, threading, time, uuid
import yaml
from .config import safe_name,safe_path
from .warehouse import CONFIG_DIR, atomic_json

class QueryEngine:
    def __init__(self,warehouse):
        self.warehouse=warehouse
        self.semantic=yaml.safe_load((CONFIG_DIR/'semantic.yaml').read_text())
        self.cache={}

    def _published(self,con,tenant_id):
        if con.execute('SELECT 1 FROM meta_dirty_tenants WHERE tenant_id=?',[tenant_id]).fetchone():
            raise RuntimeError('Data publication pending')

    def _period(self,value):
        today=datetime.now(ZoneInfo(self.warehouse.settings.timezone)).date()
        if isinstance(value,dict):
            if set(value)=={'type','value'} and value['type']=='relative':value=value['value']
            elif set(value)=={'start','end'}:
                start,end=date.fromisoformat(value['start']),date.fromisoformat(value['end'])
                if end<start or (end-start).days>730:raise ValueError('Date range must be 0..730 days')
                return start,end
            else:raise ValueError('Invalid time range')
        if value=='today':return today,today
        if value=='yesterday':return today-timedelta(days=1),today-timedelta(days=1)
        if value=='this_week':return today-timedelta(days=today.weekday()),today
        if value=='previous_week':
            end=today-timedelta(days=today.weekday()+1)
            return end-timedelta(days=6),end
        if value=='this_month':return today.replace(day=1),today
        if value=='previous_month':
            end=today.replace(day=1)-timedelta(days=1)
            return end.replace(day=1),end
        raise ValueError('Unsupported time range')

    def execute(self,dsl,tenant_id,permission_scope='owner'):
        safe_name(tenant_id)
        if not isinstance(permission_scope,str) or (permission_scope!='owner' and not permission_scope.startswith('owner:')):raise PermissionError('Owner analytics only')
        from . import bmq_semantic
        if isinstance(dsl,dict) and isinstance(dsl.get('metric'),str) and dsl['metric'] in bmq_semantic.METRICS:
            return bmq_semantic.execute(self,dsl,tenant_id,permission_scope)
        if not isinstance(dsl,dict) or set(dsl)-{'metric','dimensions','filters','time_range','comparison','sort','limit'}:raise ValueError('Unknown DSL field')
        metric=dsl.get('metric')
        if not isinstance(metric,str) or metric not in self.semantic['metrics']:raise ValueError('Unknown metric')
        dims=dsl.get('dimensions',[])
        if not isinstance(dims,list) or len(dims)>2 or any(not isinstance(d,str) for d in dims) or len(dims)!=len(set(dims)) or any(d not in self.semantic['dimensions'] for d in dims):raise ValueError('Invalid dimensions')
        limit=dsl.get('limit',100)
        if type(limit)!=int or not 1<=limit<=500:raise ValueError('Row limit is 1..500')
        start,end=self._period(dsl.get('time_range','today'))
        filters=dsl.get('filters',[])
        if not isinstance(filters,list) or len(filters)>8:raise ValueError('Too many filters')
        clauses=['tenant_id=?','metric_date BETWEEN ? AND ?'];params=[tenant_id,start,end]
        for f in filters:
            if not isinstance(f,dict) or set(f)!={'field','operator','value'} or not isinstance(f['field'],str) or f['field'] not in {'location','currency'} or f['operator']!='eq' or not isinstance(f['value'],str) or len(f['value'])>100:raise ValueError('Invalid filter')
            clauses.append(('location_id' if f['field']=='location' else 'currency')+'=?');params.append(f['value'])
        sort=dsl.get('sort',{'field':metric,'direction':'desc'})
        if not isinstance(sort,dict) or set(sort)!={'field','direction'} or sort['field'] not in [metric]+dims or not isinstance(sort['direction'],str) or sort['direction'] not in {'asc','desc'}:raise ValueError('Invalid sort')
        comparison=dsl.get('comparison')
        if comparison is not None and (not isinstance(comparison,str) or comparison not in {'previous_period','previous_month','previous_week'}):raise ValueError('Invalid comparison')
        resolved={**dsl,'time_range':{'start':str(start),'end':str(end)}}
        # Version changes on every successful transform/write; permissions never share a key.
        with self.warehouse.lock(write=False),self.warehouse.connect(read_only=True) as guard:
            self._published(guard,tenant_id)
            version=self.warehouse.db_path.stat().st_mtime_ns
            key=hashlib.sha256(json.dumps([tenant_id,permission_scope,version,self.semantic['version'],resolved],sort_keys=True).encode()).hexdigest()
            if key in self.cache and self.cache[key][0]>time.monotonic():
                result=copy.deepcopy(self.cache[key][1]);result['cache_hit']=True;return result
        fields=[self.semantic['dimensions'][d]+' AS '+d for d in dims]+['currency']
        expression=self.semantic['metrics'][metric]['expression']
        table='gold.gold_customer_activity' if metric=='customer_count' else 'gold.gold_store_daily_metrics'
        sql='SELECT '+','.join(fields)+','+expression+' AS '+metric+' FROM '+table+' WHERE '+' AND '.join(clauses)+' GROUP BY ALL ORDER BY '+sort['field']+' '+sort['direction']+' NULLS LAST LIMIT ?'
        t=time.monotonic()
        with self.warehouse.lock(write=False),self.warehouse.connect(read_only=True) as con:
            self._published(con,tenant_id)
            # Only generated SQL can execute; external access disabled even if future code regresses.
            con.execute('SET enable_external_access=false')
            timer=threading.Timer(self.warehouse.settings.query_timeout,con.interrupt)
            timer.start()
            try:
                cursor=con.execute(sql,params+[limit]);names=[c[0] for c in cursor.description]
                rows=[dict(zip(names,r)) for r in cursor.fetchall()]
            finally:timer.cancel()
        result={'metric':metric,'period':{'start':str(start),'end':str(end)},'rows':rows,'currency_policy':'separate; no FX conversion','semantic_version':self.semantic['version'],'definition':self.semantic['revenue_definition'] if metric in {'revenue','net_revenue'} else self.semantic['metrics'][metric]['label'],'cache_hit':False,'execution_time_ms':round((time.monotonic()-t)*1000,2)}
        if comparison:
            if comparison=='previous_month':
                prev_end=start.replace(day=1)-timedelta(days=1);prev_start=prev_end.replace(day=1)
            elif comparison=='previous_week':
                prev_end=start-timedelta(days=start.weekday()+1);prev_start=prev_end-timedelta(days=6)
            else:prev_end=start-timedelta(days=1);prev_start=prev_end-(end-start)
            previous={**dsl,'time_range':{'start':str(prev_start),'end':str(prev_end)}};previous.pop('comparison',None)
            result['comparison']=self.execute(previous,tenant_id,permission_scope)
        self.cache[key]=(time.monotonic()+self.warehouse.settings.cache_ttl,copy.deepcopy(result))
        if len(self.cache)>256:self.cache.pop(next(iter(self.cache)))
        # No raw query/filter values or result cells duplicated in audit.
        try:
            with self.warehouse.lock():
                atomic_json(safe_path(self.warehouse.root,'logs/queries',uuid.uuid4().hex+'.json'),{'tenant_id':tenant_id,'query_hash':key,'metric':metric,'row_count':len(rows),'elapsed_ms':result['execution_time_ms'],'created_at':datetime.now().isoformat()})
        except (RuntimeError,OSError):
            result['audit_status']='unavailable_storage_reserve'
        return result

    def get_metric(self,metric,tenant_id,time_range='today',**kwargs):return self.execute({'metric':metric,'time_range':time_range,**kwargs},tenant_id)
    def compare_metric(self,metric,tenant_id,time_range='this_week',comparison='previous_week'):return self.execute({'metric':metric,'time_range':time_range,'comparison':comparison},tenant_id)
    def group_metric(self,metric,tenant_id,dimension='location',time_range='this_month'):return self.execute({'metric':metric,'dimensions':[dimension],'time_range':time_range},tenant_id)
    def get_store_performance(self,tenant_id,time_range='this_month'):return self.group_metric('revenue',tenant_id,'location',time_range)

    def _summary(self,tenant_id,table,fields,filter_field=None,value=None,limit=100,order=None):
        safe_name(tenant_id)
        if type(limit)!=int or not 1<=limit<=500:raise ValueError('Invalid limit')
        params=[tenant_id];where='tenant_id=?'
        if filter_field:where+=' AND '+filter_field+'=?';params.append(str(value))
        sql='SELECT '+','.join(fields)+' FROM gold.'+table+' WHERE '+where+(' ORDER BY '+order if order else '')+' LIMIT ?'
        with self.warehouse.lock(write=False),self.warehouse.connect(read_only=True) as con:
            self._published(con,tenant_id)
            timer=threading.Timer(self.warehouse.settings.query_timeout,con.interrupt);timer.start()
            try:
                cur=con.execute(sql,params+[limit]);names=[c[0] for c in cur.description]
                return {'rows':[dict(zip(names,r)) for r in cur.fetchall()],'semantic_version':self.semantic['version']}
            finally:timer.cancel()

    def get_customer_summary(self,tenant_id,customer_id):return self._summary(tenant_id,'gold_customer_summary',['customer_id','currency','order_count','lifetime_revenue','last_order_at'],'customer_id',customer_id)
    def get_product_summary(self,tenant_id,product_id):return self._summary(tenant_id,'gold_product_summary',['product_id','currency','units_sold','revenue'],'product_id',product_id)
    def get_inventory(self,tenant_id,limit=100):return self._summary(tenant_id,'gold_inventory_current',['product_id','location_id','quantity_on_hand','quantity_available','snapshot_at'],limit=limit)
    def get_top_customers(self,tenant_id,limit=10):return self._summary(tenant_id,'gold_customer_summary',['customer_id','currency','lifetime_revenue','order_count'],limit=limit,order='currency,lifetime_revenue DESC')
    def get_top_products(self,tenant_id,limit=10):return self._summary(tenant_id,'gold_product_summary',['product_id','currency','revenue','units_sold'],limit=limit,order='currency,revenue DESC')
