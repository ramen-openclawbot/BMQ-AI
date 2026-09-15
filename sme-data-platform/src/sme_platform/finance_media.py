"""Read-only QTM/UNC evidence mirror. No OCR, source writes or public URLs.

Separate from scalar sync: a failed media scan never invalidates fresh numbers.
Original stored image bytes are content-addressed; reference snapshots retain
changes/removals without deleting old evidence. Arrays and legacy first-image
fields are both retained with explicit provenance (not counted as unique files).
"""
from __future__ import annotations
import argparse
import base64
from datetime import date, datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid

from .config import Settings, safe_path
from .warehouse import Warehouse, atomic_json
from .supabase_sync import PROJECT, TENANT

VERSION = 'bmq-finance-media-v1'
MAX_IMAGE_CHARS = 32 * 1024 * 1024
MAX_REFS = 10000
BATCH_CHARS = 2 * 1024 * 1024
CHUNK_CHARS = 512 * 1024
# The source stores bare base64 and occasionally data URLs. Never fetch a URL.
CTE = """WITH images AS (
 SELECT d.id::text AS declaration_id, d.closing_date::text AS closing_date,
 'QTM'::text AS kind, 'extraction_meta.qtm_images'::text AS source_field,
 a.ordinality::integer AS ordinal, a.value AS payload
 FROM public.ceo_daily_closing_declarations d CROSS JOIN LATERAL
 jsonb_array_elements_text(CASE WHEN jsonb_typeof(d.extraction_meta->'qtm_images')='array'
 THEN d.extraction_meta->'qtm_images' ELSE '[]'::jsonb END) WITH ORDINALITY a(value,ordinality)
 UNION ALL
 SELECT d.id::text,d.closing_date::text,'UNC','extraction_meta.unc_images',a.ordinality::integer,a.value
 FROM public.ceo_daily_closing_declarations d CROSS JOIN LATERAL
 jsonb_array_elements_text(CASE WHEN jsonb_typeof(d.extraction_meta->'unc_images')='array'
 THEN d.extraction_meta->'unc_images' ELSE '[]'::jsonb END) WITH ORDINALITY a(value,ordinality)
 UNION ALL SELECT id::text,closing_date::text,'QTM','qtm_slip_image_base64',1,qtm_slip_image_base64
 FROM public.ceo_daily_closing_declarations
 UNION ALL SELECT id::text,closing_date::text,'UNC','unc_slip_image_base64',1,unc_slip_image_base64
 FROM public.ceo_daily_closing_declarations
), populated AS (SELECT * FROM images WHERE payload IS NOT NULL AND payload<>'')
"""
MANIFEST_SQL = CTE + """SELECT declaration_id,closing_date,kind,source_field,ordinal,
md5(payload) AS source_md5,length(payload) AS characters
FROM populated ORDER BY declaration_id,source_field,ordinal LIMIT 10001"""


def query(cli, workdir, temp_root, sql):
    if (workdir / 'supabase/.temp/project-ref').read_text().strip() != PROJECT:
        raise ValueError('Linked project mismatch')
    with tempfile.TemporaryDirectory(dir=temp_root) as directory:
        script, output = Path(directory)/'read.sql', Path(directory)/'result.json'
        script.write_text('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; '
                          'SET LOCAL statement_timeout=30000; ' + sql + '; COMMIT;')
        with output.open('wb') as handle:
            p = subprocess.Popen([cli,'db','query','--linked','--file',str(script),'-o','json'],
                                 cwd=workdir,stdout=handle,stderr=subprocess.DEVNULL)
            deadline = time.monotonic()+90
            try:
                while p.poll() is None:
                    if time.monotonic()>deadline or output.stat().st_size>16*1024*1024:
                        raise RuntimeError('Media query budget exceeded')
                    time.sleep(.1)
                if p.returncode or output.stat().st_size>16*1024*1024:
                    raise RuntimeError('Media query failed')
            finally:
                if p.poll() is None:p.kill()
                p.wait()
        rows=json.loads(output.read_text())
        if isinstance(rows,dict):rows=rows.get('rows')
        if not isinstance(rows,list) or not all(isinstance(r,dict) for r in rows):
            raise ValueError('Invalid query response')
        return rows


def validate_manifest(rows):
    if len(rows)>MAX_REFS:raise ValueError('Media reference limit')
    keys=set()
    for r in rows:
        if set(r)!={'declaration_id','closing_date','kind','source_field','ordinal','source_md5','characters'}:
            raise ValueError('Invalid media manifest')
        uuid.UUID(r['declaration_id']); date.fromisoformat(r['closing_date'])
        if r['kind'] not in ('QTM','UNC') or r['source_field'] not in (
            'extraction_meta.'+r['kind'].lower()+'_images',r['kind'].lower()+'_slip_image_base64'):
            raise ValueError('Invalid media source')
        if type(r['ordinal']) is not int or r['ordinal']<1 or type(r['characters']) is not int or not 0<r['characters']<=MAX_IMAGE_CHARS:
            raise ValueError('Invalid image size/position')
        if not re.fullmatch('[0-9a-f]{32}',r['source_md5']):raise ValueError('Invalid source digest')
        key=(r['declaration_id'],r['source_field'],r['ordinal'])
        if key in keys:raise ValueError('Duplicate source position')
        keys.add(key)
    return rows


def decode_image(payload):
    if not isinstance(payload,str) or not 0<len(payload)<=MAX_IMAGE_CHARS:raise ValueError('Image size')
    mime=None
    if payload.startswith('data:'):
        match=re.fullmatch(r'data:(image/(?:png|jpeg|webp|gif));base64,(.*)',payload,re.S)
        if not match:raise ValueError('Unsupported data URL')
        mime,payload=match.groups()
    try:raw=base64.b64decode(payload,validate=True)
    except Exception:raise ValueError('Invalid base64') from None
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):ext,detected='png','image/png'
    elif raw.startswith(b'\xff\xd8\xff'):ext,detected='jpg','image/jpeg'
    elif raw[:6] in (b'GIF87a',b'GIF89a'):ext,detected='gif','image/gif'
    elif raw[:4]==b'RIFF' and raw[8:12]==b'WEBP':ext,detected='webp','image/webp'
    else:raise ValueError('Unsupported image signature')
    if mime and mime!=detected:raise ValueError('Image MIME mismatch')
    return raw,ext,detected


def store_blob(root,payload,expected_md5):
    if hashlib.md5(payload.encode()).hexdigest()!=expected_md5:raise ValueError('Source changed/truncated')
    raw,ext,mime=decode_image(payload)
    sha=hashlib.sha256(raw).hexdigest()
    path=safe_path(root,'media',TENANT,'qtm-unc','objects',sha+'.'+ext)
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    if path.exists():
        if path.read_bytes()!=raw:raise ValueError('Existing media integrity failure')
    else:
        # Atomic placement; temp is private and on the same SSD.
        with tempfile.NamedTemporaryFile(dir=path.parent,delete=False) as handle:
            temp=Path(handle.name);handle.write(raw);handle.flush();os.fsync(handle.fileno())
        os.replace(temp,path);path.chmod(0o600)
    result={'sha256':sha,'path':str(path.relative_to(root)),'bytes':len(raw),'mime_type':mime}
    cache=safe_path(root,'media',TENANT,'qtm-unc','cache',expected_md5+'.json')
    atomic_json(cache,result)
    return result


def cached(root,digest):
    path=safe_path(root,'media',TENANT,'qtm-unc','cache',digest+'.json')
    if not path.exists():return None
    r=json.loads(path.read_text())
    blob=safe_path(root,r['path'])
    if not blob.is_file():return None
    raw=blob.read_bytes()
    if len(raw)!=r['bytes'] or hashlib.sha256(raw).hexdigest()!=r['sha256']:
        raise ValueError('Cached media integrity failure')
    return r


def fetch_blobs(run_query,root,manifest,deadline):
    sizes={r['source_md5']:r['characters'] for r in manifest}
    blobs={};pending=[]
    for digest,size in sizes.items():
        item=cached(root,digest)
        if item:blobs[digest]=item
        else:pending.append((digest,size))
    while pending:
        if time.monotonic()>deadline:raise RuntimeError('Backfill budget reached; rerun resumes cached files')
        batch=[];total=0
        while pending and total+pending[0][1]<=BATCH_CHARS:
            digest,size=pending.pop(0);batch.append(digest);total+=size
        if batch:
            # All SQL values here are validated hex hashes; never user SQL/URLs.
            quoted=','.join("'"+d+"'" for d in batch)
            rows=run_query(CTE+f"SELECT DISTINCT md5(payload) AS source_md5,payload FROM populated WHERE md5(payload) IN ({quoted})")
            if len(rows)!=len(batch) or {r['source_md5'] for r in rows}!=set(batch):raise ValueError('Source changed during fetch')
            for r in rows:
                if len(r['payload'])!=sizes[r['source_md5']]:raise ValueError('Source length mismatch')
                blobs[r['source_md5']]=store_blob(root,r['payload'],r['source_md5'])
        else:
            digest,size=pending.pop(0);chunks=[]
            for start in range(1,size+1,CHUNK_CHARS):
                if time.monotonic()>deadline:raise RuntimeError('Media fetch budget')
                rows=run_query(CTE+f"SELECT DISTINCT substring(payload from {start} for {CHUNK_CHARS}) AS chunk FROM populated WHERE md5(payload)='{digest}'")
                if len(rows)!=1:raise ValueError('Source changed during chunk fetch')
                chunks.append(rows[0]['chunk'])
            payload=''.join(chunks)
            if len(payload)!=size:raise ValueError('Source length mismatch')
            blobs[digest]=store_blob(root,payload,digest)
    return blobs


def publish(warehouse,manifest,blobs,observed):
    refs=[dict(r,**blobs[r['source_md5']]) for r in manifest]
    run=uuid.uuid4().hex
    summary={'version':VERSION,'tenant':TENANT,'run_id':run,'source_observed_at':observed,
             'completed_at':datetime.now(timezone.utc).isoformat(),'references':len(refs),
             'unique_files':len({r['sha256'] for r in refs}),
             'kinds':{k:sum(r['kind']==k for r in refs) for k in ('QTM','UNC')},
             'ocr':'not_performed','items':refs}
    with warehouse.lock(),warehouse.connect() as con:
        con.execute('CREATE SCHEMA IF NOT EXISTS bronze')
        con.execute('CREATE TABLE IF NOT EXISTS bronze.finance_media_current(tenant_id VARCHAR, declaration_id VARCHAR, closing_date DATE, kind VARCHAR, source_field VARCHAR, ordinal INTEGER, source_md5 VARCHAR, sha256 VARCHAR, path VARCHAR, bytes BIGINT, mime_type VARCHAR, observed_at TIMESTAMPTZ, PRIMARY KEY(tenant_id,declaration_id,source_field,ordinal))')
        con.execute('CREATE TABLE IF NOT EXISTS meta_finance_media_runs(run_id VARCHAR PRIMARY KEY, observed_at TIMESTAMPTZ, manifest VARCHAR)')
        old=con.execute('SELECT max(observed_at) FROM meta_finance_media_runs').fetchone()[0]
        if old and datetime.fromisoformat(observed)<=old:raise ValueError('Stale media snapshot')
        archive=safe_path(warehouse.root,'media',TENANT,'qtm-unc','manifests',run+'.json')
        atomic_json(archive,summary)
        con.execute('BEGIN')
        try:
            con.execute('DELETE FROM bronze.finance_media_current WHERE tenant_id=?',[TENANT])
            if refs:
                con.executemany('INSERT INTO bronze.finance_media_current VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[
                    (TENANT,r['declaration_id'],r['closing_date'],r['kind'],r['source_field'],r['ordinal'],r['source_md5'],r['sha256'],r['path'],r['bytes'],r['mime_type'],observed) for r in refs])
            con.execute('INSERT INTO meta_finance_media_runs VALUES (?,?,?)',[run,observed,json.dumps(summary)])
            con.execute('COMMIT')
        except Exception:con.execute('ROLLBACK');raise
        export=safe_path(warehouse.root,'media',TENANT,'qtm-unc','current.parquet')
        temp=export.with_name(run+'.parquet')
        con.execute('COPY (SELECT * FROM bronze.finance_media_current) TO $path (FORMAT PARQUET)',{'path':str(temp)})
        os.replace(temp,export)
        atomic_json(safe_path(warehouse.root,'logs','finance-media-latest.json'),summary)
    return {k:v for k,v in summary.items() if k!='items'}


def sync(warehouse,run_query,budget=600):
    warehouse.settings.validate_storage(write=True)
    warehouse.root.mkdir(parents=True,exist_ok=True)
    # Separate non-overlapping media job; do not hold the scalar warehouse lock
    # while doing network IO. Failed/changed scans retain last current catalog.
    with safe_path(warehouse.root,'.finance-media.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        observed=datetime.now(timezone.utc).isoformat()
        manifest=validate_manifest(run_query(MANIFEST_SQL))
        blobs=fetch_blobs(run_query,warehouse.root,manifest,time.monotonic()+budget)
        if validate_manifest(run_query(MANIFEST_SQL))!=manifest:raise ValueError('Source changed; retry next scan')
        return publish(warehouse,manifest,blobs,observed)


def main():
    p=argparse.ArgumentParser();p.add_argument('--workdir',type=Path,required=True)
    p.add_argument('--cli',default='/opt/homebrew/bin/supabase');args=p.parse_args()
    os.umask(0o077);w=Warehouse(Settings.from_env())
    try:
        w.settings.validate_storage(write=True)
        result=sync(w,lambda sql:query(args.cli,args.workdir,safe_path(w.root,'temp'),sql))
        print(json.dumps(dict(status='success',**result)))
    except Exception as error:
        print(json.dumps({'status':'failed','error_type':type(error).__name__}))
        raise SystemExit(1) from None

if __name__=='__main__':main()
