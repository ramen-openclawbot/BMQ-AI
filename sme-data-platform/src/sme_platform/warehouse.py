from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import csv, fcntl, hashlib, io, json, os, uuid, sys
import duckdb, yaml
from .config import Settings, safe_name, safe_path
from .canonical import SCHEMAS, PK, REFS, normalize, canonical_id, timestamp

RESOURCE_ROOT = Path(__file__).resolve().parents[2]
if not (RESOURCE_ROOT/'config/semantic.yaml').exists():
    RESOURCE_ROOT = Path(sys.prefix)/'share/bmq-sme-data-platform'
CONFIG_DIR = RESOURCE_ROOT/'config'

def json_default(v):
    return v.isoformat() if hasattr(v,'isoformat') else str(v)

def atomic_json(path, value):
    path.parent.mkdir(parents=True,exist_ok=True)
    temp = path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    temp.write_text(json.dumps(value,default=json_default,ensure_ascii=False),encoding='utf8')
    os.replace(temp,path)

class Warehouse:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.root = Path(settings.data_root)
        self.db_path = safe_path(self.root,'warehouse/warehouse.duckdb')

    @contextmanager
    def lock(self,write=True):
        self.settings.validate_storage(write=write)
        self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
        if not self.settings.test_mode and self.root.name=='sme-data-platform' and self.root.parent.name=='BMQ':
            if self.root.stat().st_uid!=os.getuid():raise RuntimeError('BMQ data directory must be owned by service account')
            self.root.chmod(0o700)
        for name in ['raw','bronze','silver','gold','datasets','knowledge','logs','temp','warehouse','config']:
            safe_path(self.root,name)
        with safe_path(self.root,'.warehouse.lock').open('a') as handle:
            fcntl.flock(handle,fcntl.LOCK_EX)
            try: yield
            finally: fcntl.flock(handle,fcntl.LOCK_UN)

    def connect(self, read_only=False):
        self.settings.validate_storage(write=not read_only)
        safe_path(self.root,'warehouse/warehouse.duckdb')
        con = duckdb.connect(str(self.db_path),read_only=read_only)
        con.execute("SET TimeZone='UTC'")
        con.execute("SET memory_limit='512MB'")
        con.execute('SET threads=2')
        return con

    def initialize(self):
        with self.lock():
            for name in ['raw','bronze','silver','gold','datasets/training','datasets/validation','datasets/evaluation','knowledge','logs/quality','logs/queries','temp','warehouse','config']:
                safe_path(self.root,name).mkdir(parents=True,exist_ok=True)
            with self.connect() as con:
                con.execute('CREATE SCHEMA IF NOT EXISTS silver; CREATE SCHEMA IF NOT EXISTS gold')
                for entity,fields in SCHEMAS.items():
                    cols = ','.join('"'+k+'" '+v for k,v in fields.items())
                    con.execute(f'CREATE TABLE IF NOT EXISTS silver.{entity} ({cols}, PRIMARY KEY(tenant_id,{PK[entity]}))')
                con.execute('CREATE TABLE IF NOT EXISTS meta_ingestion_runs(run_id VARCHAR PRIMARY KEY, tenant_id VARCHAR, source VARCHAR, entity VARCHAR, batch_hash VARCHAR, raw_path VARCHAR, timezone VARCHAR, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, status VARCHAR, records_read INTEGER, records_written INTEGER, records_failed INTEGER, error_message VARCHAR)')
                con.execute('ALTER TABLE meta_ingestion_runs ADD COLUMN IF NOT EXISTS original_filename VARCHAR')
                con.execute('CREATE TABLE IF NOT EXISTS meta_dirty_tenants(tenant_id VARCHAR PRIMARY KEY)')
                con.execute('CREATE TABLE IF NOT EXISTS meta_sources(tenant_id VARCHAR, source VARCHAR, last_successful_sync TIMESTAMPTZ, last_source_updated_at TIMESTAMPTZ, PRIMARY KEY(tenant_id,source))')
                for table in ['meta_transform_runs','meta_dataset_versions','meta_schema_versions','meta_quality_runs']:
                    con.execute(f'CREATE TABLE IF NOT EXISTS {table}(id VARCHAR, created_at TIMESTAMPTZ, metadata VARCHAR)')
                con.execute('CREATE TABLE IF NOT EXISTS entity_identity_map(tenant_id VARCHAR, entity_type VARCHAR, canonical_id VARCHAR, source_system VARCHAR, external_id VARCHAR, confidence DOUBLE, match_method VARCHAR, created_at TIMESTAMPTZ, PRIMARY KEY(tenant_id,entity_type,source_system,external_id))')
                if not con.execute('SELECT COUNT(*) FROM meta_schema_versions').fetchone()[0]:
                    con.execute("INSERT INTO meta_schema_versions VALUES ('001',now(),'canonical-v1')")
            for path in CONFIG_DIR.glob('*.yaml'):
                target = safe_path(self.root,'config',path.name)
                if not target.exists(): target.write_bytes(path.read_bytes())
        return self.status()

    def ingest_file(self,path,tenant_id,source='csv_upload',entity='orders',timezone='Asia/Ho_Chi_Minh',original_filename=None):
        tenant_id,source = safe_name(tenant_id),safe_name(source)
        if entity not in SCHEMAS: raise ValueError('Unsupported entity')
        path = Path(path)
        original_filename=original_filename or path.name
        if Path(original_filename).name!=original_filename or len(original_filename)>200:raise ValueError('Invalid filename')
        if path.stat().st_size > self.settings.max_batch_bytes: raise ValueError('V1 batch limit is 32 MiB; split source files')
        payload = path.read_bytes()
        suffix = path.suffix.lower()
        if suffix not in {'.csv','.json','.jsonl'}: raise ValueError('CSV/JSON/JSONL required')
        batch_hash = hashlib.sha256(payload+entity.encode()+timezone.encode()).hexdigest()
        now=datetime.now(__import__('datetime').timezone.utc)
        run_id=uuid.uuid4().hex
        raw=self.root/'raw'/tenant_id/source/entity/now.strftime('year=%Y/month=%m/day=%d')/(batch_hash+suffix)
        with self.lock(),self.connect() as con:
            done=con.execute("SELECT run_id,records_written FROM meta_ingestion_runs WHERE tenant_id=? AND source=? AND entity=? AND batch_hash=? AND status='success'",[tenant_id,source,entity,batch_hash]).fetchone()
            if done: return {'run_id':done[0],'status':'duplicate','records_written':done[1]}
            safe_path(self.root,raw.relative_to(self.root))
            raw.parent.mkdir(parents=True,exist_ok=True)
            if not raw.exists():
                with raw.open('xb') as f: f.write(payload)
            elif raw.read_bytes()!=payload: raise RuntimeError('Immutable raw hash collision')
            con.execute('INSERT INTO meta_ingestion_runs(run_id,tenant_id,source,entity,batch_hash,raw_path,timezone,started_at,ended_at,status,records_read,records_written,records_failed,error_message) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[run_id,tenant_id,source,entity,batch_hash,str(raw.relative_to(self.root)),timezone,now,None,'started',0,0,0,None])
            con.execute('UPDATE meta_ingestion_runs SET original_filename=? WHERE run_id=?',[original_filename,run_id])
            rows=[]
            committed=False
            try:
                decoded=payload.decode('utf-8-sig')
                rows=list(csv.DictReader(io.StringIO(decoded))) if suffix=='.csv' else [json.loads(line) for line in decoded.splitlines() if line.strip()] if suffix=='.jsonl' else json.loads(decoded)
                if not isinstance(rows,list) or not all(isinstance(r,dict) for r in rows): raise ValueError('Expected array of objects')
                canonical=[normalize(entity,r,tenant_id,source,timezone,now) for r in rows]
                ids=[r[PK[entity]] for r in canonical]
                if len(ids)!=len(set(ids)): raise ValueError('Duplicate source IDs within batch')
                # No partial batch: validate everything before a transactional upsert.
                con.execute('CREATE TEMP TABLE bronze_batch(_source_system VARCHAR,_source_entity VARCHAR,_source_record_id VARCHAR,_ingested_at TIMESTAMPTZ,_source_updated_at TIMESTAMPTZ,_raw_path VARCHAR,payload VARCHAR)')
                if rows: con.executemany('INSERT INTO bronze_batch VALUES (?,?,?,?,?,?,?)',[(source,entity,r['source_record_id'],now,timestamp(original['updated_at'],timezone) if original.get('updated_at') else None,str(raw.relative_to(self.root)),json.dumps(original,ensure_ascii=False)) for original,r in zip(rows,canonical)])
                bronze=self.root/'bronze'/tenant_id/source/entity/now.strftime('year=%Y/month=%m')/(run_id+'.parquet')
                safe_path(self.root,bronze.relative_to(self.root))
                bronze.parent.mkdir(parents=True,exist_ok=True)
                con.execute('COPY bronze_batch TO ? (FORMAT PARQUET)',[str(bronze)])
                con.execute('BEGIN')
                try:
                    self._upsert(con,entity,canonical)
                    self._check_refs(con,entity,tenant_id)
                    con.execute('INSERT INTO meta_dirty_tenants VALUES (?) ON CONFLICT DO NOTHING',[tenant_id])
                    con.execute("UPDATE meta_ingestion_runs SET ended_at=now(), status='success',records_read=?,records_written=? WHERE run_id=?",[len(rows),len(rows),run_id])
                    watermark=max((timestamp(r['updated_at'],timezone) for r in rows if r.get('updated_at')),default=None)
                    con.execute('INSERT INTO meta_sources VALUES (?,?,?,?) ON CONFLICT(tenant_id,source) DO UPDATE SET last_successful_sync=excluded.last_successful_sync,last_source_updated_at=greatest(meta_sources.last_source_updated_at,excluded.last_source_updated_at)',[tenant_id,source,now,watermark])
                    con.execute('COMMIT')
                    committed=True
                except Exception:
                    con.execute('ROLLBACK');raise
                self._export(con,'silver',entity,[tenant_id])
                return {'run_id':run_id,'status':'success','records_written':len(rows),'raw_path':str(raw.relative_to(self.root))}
            except Exception as error:
                if committed:
                    return {'run_id':run_id,'status':'success','records_written':len(rows),'parquet_export':'pending_rebuild','warning':'Silver committed; retry rebuild_silver for Parquet export'}
                # Error codes only; no source payload/PII in operational logs.
                con.execute("UPDATE meta_ingestion_runs SET ended_at=now(),status='failed',records_read=?,records_failed=?,error_message=? WHERE run_id=?",[len(rows),len(rows) or 1,type(error).__name__,run_id])
                raise

    def _upsert(self,con,entity,rows):
        fields=list(SCHEMAS[entity]); pk=PK[entity]
        assignments=','.join('"'+f+'"=excluded."'+f+'"' for f in fields if f not in {'tenant_id',pk})
        sql=f'INSERT INTO silver.{entity} VALUES ({",".join("?" for _ in fields)}) ON CONFLICT(tenant_id,{pk}) DO UPDATE SET {assignments} WHERE excluded.updated_at >= {entity}.updated_at'
        for r in rows:
            existing=con.execute('SELECT canonical_id FROM entity_identity_map WHERE tenant_id=? AND entity_type=? AND source_system=? AND external_id=?',[r['tenant_id'],entity,r['source_system'],r['source_record_id']]).fetchone()
            method='source_id'
            if existing: r[pk]=existing[0]
            if entity=='customers' and not r['is_deleted']:
                candidates=set()
                for field in ['email','phone']:
                    value=r.get(field)
                    if not value:continue
                    normalized=value.strip().lower() if field=='email' else ''.join(c for c in value if c.isdigit())
                    if not normalized:continue
                    expression='lower(trim(email))' if field=='email' else "regexp_replace(phone,'[^0-9]','','g')"
                    matches=con.execute(f'SELECT customer_id FROM silver.customers WHERE tenant_id=? AND NOT is_deleted AND {expression}=?',[r['tenant_id'],normalized]).fetchall()
                    candidates.update(m[0] for m in matches)
                if existing and candidates and candidates!={existing[0]}:raise ValueError('Existing identity conflicts with contact evidence; review required')
                if len(candidates)>1:raise ValueError('Conflicting identity evidence; explicit review required')
                if candidates:r[pk]=next(iter(candidates));method='exact_email_or_phone'
            for field,target in REFS.items():
                if field==pk or not r.get(field):continue
                mappings=con.execute('SELECT external_id,canonical_id FROM entity_identity_map WHERE tenant_id=? AND source_system=? AND entity_type=?',[r['tenant_id'],r['source_system'],target]).fetchall()
                for external,canonical in mappings:
                    if canonical_id(r['tenant_id'],r['source_system'],target,external)==r[field]:r[field]=canonical;break
            if r['is_deleted']:
                previous=con.execute(f'SELECT * FROM silver.{entity} WHERE tenant_id=? AND {pk}=?',[r['tenant_id'],r[pk]]).fetchone()
                if previous:
                    preserved=dict(zip(fields,previous))
                    for f in fields:
                        if r[f] is None or f in {'created_at','metadata'}:r[f]=preserved[f]
            con.execute(sql,[r[f] for f in fields])
            con.execute('INSERT INTO entity_identity_map VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',[r['tenant_id'],entity,r[pk],r['source_system'],r['source_record_id'],1,method,r['created_at']])

    def _check_refs(self,con,entity,tenant):
        for field,target in REFS.items():
            if field not in SCHEMAS[entity] or field==PK[entity]:continue
            count=con.execute(f'SELECT COUNT(*) FROM silver.{entity} a LEFT JOIN silver.{target} b ON a.tenant_id=b.tenant_id AND a.{field}=b.{PK[target]} WHERE a.tenant_id=? AND NOT a.is_deleted AND a.{field} IS NOT NULL AND b.{PK[target]} IS NULL',[tenant]).fetchone()[0]
            if count:raise ValueError('Missing reference: '+field+'; ingest referenced source first')

    def map_identity(self,tenant_id,entity,source,external_id,target_id):
        """Explicit operator-reviewed source mapping, never fuzzy matching."""
        safe_name(tenant_id);safe_name(source)
        if entity not in SCHEMAS:raise ValueError('Unknown entity')
        with self.lock(),self.connect() as con:
            if not con.execute(f'SELECT 1 FROM silver.{entity} WHERE tenant_id=? AND {PK[entity]}=?',[tenant_id,target_id]).fetchone():raise ValueError('Canonical target not found in tenant')
            existing=con.execute('SELECT canonical_id FROM entity_identity_map WHERE tenant_id=? AND entity_type=? AND source_system=? AND external_id=?',[tenant_id,entity,source,str(external_id)]).fetchone()
            if existing and existing[0]!=target_id:raise ValueError('Existing mapping cannot silently be reassigned')
            con.execute("INSERT INTO entity_identity_map VALUES (?,?,?,?,?,1,'explicit',now()) ON CONFLICT DO NOTHING",[tenant_id,entity,target_id,source,str(external_id)])
        return {'status':'mapped','canonical_id':target_id}

    def _export(self,con,schema,entity,tenants=None):
        destination=safe_path(self.root,schema,entity)
        destination.mkdir(parents=True,exist_ok=True)
        if tenants is None:
            tenants={r[0] for r in con.execute(f'SELECT DISTINCT tenant_id FROM {schema}.{entity}').fetchall()}
            tenants.update(p.name[len('tenant='):] for p in destination.glob('tenant=*') if p.is_dir())
        for tenant in sorted(tenants):
            safe_name(tenant)
            partition=safe_path(self.root,schema,entity,'tenant='+tenant)
            partition.mkdir(parents=True,exist_ok=True)
            tmp=partition/('snapshot-'+uuid.uuid4().hex+'.parquet')
            con.execute(f'COPY (SELECT * FROM {schema}.{entity} WHERE tenant_id=$tenant) TO $path (FORMAT PARQUET)',{'tenant':tenant,'path':str(tmp)})
            os.replace(tmp,partition/'current.parquet')
        atomic_json(safe_path(self.root,schema,entity,'manifest.json'),{'version':1,'partition_by':['tenant_id'],'pattern':'tenant=*/current.parquet','updated_at':datetime.now(timezone.utc).isoformat()})

    def rebuild_silver(self):
        with self.lock(),self.connect() as con:
            runs=con.execute("SELECT tenant_id,source,entity,raw_path,timezone,started_at FROM meta_ingestion_runs WHERE status='success' ORDER BY started_at,run_id").fetchall()
            con.execute('BEGIN')
            try:
                for entity in SCHEMAS: con.execute(f'DELETE FROM silver.{entity}')
                for tenant,source,entity,raw_path,tz,now in runs:
                    path=safe_path(self.root,raw_path)
                    if not path.resolve().is_relative_to(self.root.resolve()): raise ValueError('Invalid raw path')
                    text=path.read_text('utf-8-sig')
                    rows=list(csv.DictReader(io.StringIO(text))) if path.suffix=='.csv' else [json.loads(l) for l in text.splitlines() if l.strip()] if path.suffix=='.jsonl' else json.loads(text)
                    self._upsert(con,entity,[normalize(entity,r,tenant,source,tz,now) for r in rows])
                for tenant in {r[0] for r in runs}:con.execute('INSERT INTO meta_dirty_tenants VALUES (?) ON CONFLICT DO NOTHING',[tenant])
                con.execute('COMMIT')
            except Exception:
                con.execute('ROLLBACK');raise
            for entity in SCHEMAS:self._export(con,'silver',entity)
            con.execute("INSERT INTO meta_transform_runs VALUES (?,now(),?)",[uuid.uuid4().hex,json.dumps({'stage':'silver','runs':len(runs)})])
        return {'status':'success','runs':len(runs)}

    def refresh_gold(self):
        return self.rebuild_gold(incremental=True)

    def rebuild_gold(self,incremental=False):
        semantic=yaml.safe_load((CONFIG_DIR/'semantic.yaml').read_text())
        statuses=semantic['order_statuses']
        with self.lock(),self.connect() as con:
            tenants=[r[0] for r in con.execute('SELECT tenant_id FROM meta_dirty_tenants').fetchall()] if incremental else None
            if tenants==[]:return {'status':'unchanged','tenants_refreshed':0}
            tenant_filter=' AND o.tenant_id IN ('+','.join("'"+safe_name(t)+"'" for t in tenants)+')' if tenants else ''
            con.execute('CREATE SCHEMA IF NOT EXISTS gold_stage')
            def execute(sql,params=None):
                return con.execute(sql.replace('gold.','gold_stage.'),params or [])
            con.execute('BEGIN')
            try:
                allowed=','.join("'"+s.replace("'","''")+"'" for s in statuses)
                con.execute(f"CREATE OR REPLACE TEMP VIEW eligible AS SELECT o.*, CAST(timezone(coalesce(l.timezone,o.source_timezone),o.ordered_at) AS DATE) metric_date FROM silver.orders o LEFT JOIN silver.locations l ON o.tenant_id=l.tenant_id AND o.location_id=l.location_id AND NOT l.is_deleted WHERE NOT o.is_deleted AND o.status IN ({allowed}){tenant_filter}")
                execute('CREATE OR REPLACE TABLE gold.gold_store_daily_metrics AS SELECT o.tenant_id,metric_date,location_id,currency,SUM(net_amount) revenue,COUNT(*) order_count,COUNT(DISTINCT customer_id) customer_count,SUM(gross_profit) gross_profit,SUM(net_amount)/NULLIF(COUNT(*),0) average_order_value,SUM(gross_profit)/NULLIF(SUM(net_amount),0)*100 gross_margin_pct,SUM(i.units_sold) units_sold FROM eligible o LEFT JOIN (SELECT tenant_id,order_id,SUM(quantity) units_sold FROM silver.order_items WHERE NOT is_deleted GROUP BY ALL) i ON o.tenant_id=i.tenant_id AND o.order_id=i.order_id GROUP BY ALL')
                for name,col in [('revenue','revenue'),('orders','order_count'),('customers','customer_count'),('gross_profit','gross_profit')]:
                    execute(f'CREATE OR REPLACE TABLE gold.gold_daily_{name} AS SELECT tenant_id,metric_date,currency,SUM({col}) {col} FROM gold.gold_store_daily_metrics GROUP BY ALL')
                execute('CREATE OR REPLACE TABLE gold.gold_customer_activity AS SELECT DISTINCT tenant_id,metric_date,location_id,currency,customer_id FROM eligible WHERE customer_id IS NOT NULL')
                execute('CREATE OR REPLACE TABLE gold.gold_daily_customers AS SELECT tenant_id,metric_date,currency,COUNT(DISTINCT customer_id) customer_count FROM eligible GROUP BY ALL')
                execute('CREATE OR REPLACE TABLE gold.gold_daily_aov AS SELECT tenant_id,metric_date,currency,SUM(revenue)/NULLIF(SUM(order_count),0) average_order_value FROM gold.gold_store_daily_metrics GROUP BY ALL')
                execute('CREATE OR REPLACE TABLE gold.gold_product_daily_sales AS SELECT o.tenant_id,o.metric_date,o.currency,i.product_id,SUM(i.quantity) units_sold,SUM(i.net_amount) revenue,SUM(i.gross_profit) gross_profit FROM eligible o JOIN silver.order_items i ON o.tenant_id=i.tenant_id AND o.order_id=i.order_id WHERE NOT i.is_deleted GROUP BY ALL')
                execute('CREATE OR REPLACE TABLE gold.gold_product_summary AS SELECT tenant_id,product_id,currency,SUM(units_sold) units_sold,SUM(revenue) revenue,SUM(gross_profit) gross_profit FROM gold.gold_product_daily_sales GROUP BY ALL')
                execute('CREATE OR REPLACE TABLE gold.gold_customer_summary AS SELECT tenant_id,customer_id,currency,MIN(ordered_at) first_order_at,MAX(ordered_at) last_order_at,COUNT(*) order_count,SUM(net_amount) lifetime_revenue,SUM(gross_profit) lifetime_gross_profit,SUM(net_amount)/COUNT(*) average_order_value,date_diff(\'day\',MAX(ordered_at),current_timestamp) days_since_last_order FROM eligible WHERE customer_id IS NOT NULL GROUP BY ALL')
                execute('CREATE OR REPLACE TABLE gold.gold_customer_last_order AS SELECT tenant_id,customer_id,MAX(last_order_at) last_order_at FROM gold.gold_customer_summary GROUP BY ALL')
                execute('CREATE OR REPLACE TABLE gold.gold_inventory_current AS SELECT * FROM silver.inventory_snapshots WHERE NOT is_deleted'+(' AND tenant_id IN ('+','.join("'"+safe_name(t)+"'" for t in tenants)+')' if tenants else '')+' QUALIFY row_number() OVER(PARTITION BY tenant_id,product_id,location_id ORDER BY snapshot_at DESC,updated_at DESC)=1')
                tables=[r[0] for r in con.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='gold_stage'").fetchall()]
                for table in tables:
                    if incremental:
                        con.execute(f'CREATE TABLE IF NOT EXISTS gold.{table} AS SELECT * FROM gold_stage.{table} WHERE false')
                        con.execute(f'DELETE FROM gold.{table} WHERE tenant_id IN ('+','.join('?' for _ in tenants)+')',tenants)
                        con.execute(f'INSERT INTO gold.{table} SELECT * FROM gold_stage.{table}')
                    else:con.execute(f'CREATE OR REPLACE TABLE gold.{table} AS SELECT * FROM gold_stage.{table}')
                con.execute('DELETE FROM meta_dirty_tenants')
                con.execute("INSERT INTO meta_transform_runs VALUES (?,now(),?)",[uuid.uuid4().hex,json.dumps({'stage':'gold','semantic_version':semantic['version'],'incremental':incremental,'tenants':tenants})])
                con.execute('COMMIT')
            except Exception:con.execute('ROLLBACK');raise
            for (table,) in con.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='gold'").fetchall():self._export(con,'gold',table,tenants)
        return {'status':'success','semantic_version':semantic['version'],'scope':'dirty_tenants' if incremental else 'full','tenants_refreshed':len(tenants) if tenants is not None else None}

    def validate(self,tenant_id=None):
        if tenant_id:safe_name(tenant_id)
        results=[]
        with self.lock(write=False),self.connect(read_only=True) as con:
            for entity,fields in SCHEMAS.items():
                checks=[]
                for field,target in REFS.items():
                    if field not in fields or field==PK[entity]:continue
                    sql=f'SELECT COUNT(*) FROM silver.{entity} a LEFT JOIN silver.{target} b ON a.tenant_id=b.tenant_id AND a.{field}=b.{PK[target]} WHERE a.{field} IS NOT NULL AND b.{PK[target]} IS NULL AND NOT a.is_deleted'
                    params=[]
                    if tenant_id: sql+=' AND a.tenant_id=?';params=[tenant_id]
                    checks.append({'check':'reference:'+field,'failed':con.execute(sql,params).fetchone()[0]})
                results.append({'dataset':entity,'status':'fail' if any(c['failed'] for c in checks) else 'pass','checks':len(checks),'failed':sum(c['failed'] for c in checks),'details':checks})
            failed_runs=con.execute("SELECT entity,COUNT(*) FROM meta_ingestion_runs WHERE status='failed'"+(' AND tenant_id=?' if tenant_id else '')+' GROUP BY entity',[tenant_id] if tenant_id else []).fetchall()
        report={'checked_at':datetime.now(timezone.utc).isoformat(),'datasets':results,'failed_ingestions':[{'entity':e,'count':n} for e,n in failed_runs],'status':'fail' if failed_runs or any(r['failed'] for r in results) else 'pass'}
        with self.lock(),self.connect() as con:
            run=uuid.uuid4().hex
            atomic_json(safe_path(self.root,'logs/quality',run+'.json'),report)
            con.execute('INSERT INTO meta_quality_runs VALUES (?,now(),?)',[run,json.dumps(report)])
        return report

    def status(self):
        status={'storage':self.settings.validate_storage(),'database_exists':self.db_path.exists()}
        if self.db_path.exists():
            with self.lock(write=False),self.connect(read_only=True) as con:
                status['sources']=[dict(zip(['tenant_id','source','last_ingested_at','last_source_updated_at'],r)) for r in con.execute('SELECT * FROM meta_sources').fetchall()]
                status['entities']={e:con.execute(f'SELECT COUNT(*) FROM silver.{e}').fetchone()[0] for e in SCHEMAS}
        return status
