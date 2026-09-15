import base64,hashlib,json,fcntl
from datetime import datetime,timezone
import pytest
from sme_platform.finance_media import *
PNG=base64.b64encode(b'\x89PNG\r\n\x1a\nfixture-image').decode()
ID='00000000-0000-0000-0000-000000000001'
def row(kind='UNC',field=None):
 return dict(declaration_id=ID,closing_date='2026-09-14',kind=kind,source_field=field or f'extraction_meta.{kind.lower()}_images',ordinal=1,source_md5=hashlib.md5(PNG.encode()).hexdigest(),characters=len(PNG))
@pytest.fixture
def w(tmp_path):
 w=Warehouse(Settings(data_root=tmp_path,test_mode=True));w.initialize();return w

def fake(rows,changed=False):
 calls=[]
 def q(sql):
  calls.append(sql)
  if sql==MANIFEST_SQL:return [] if changed and calls.count(sql)>1 else rows
  return [{'source_md5':row()['source_md5'],'payload':PNG}]
 return q,calls

def test_roundtrip_repeat_and_dedup(w):
 q,calls=fake([row(),row('QTM'),row(field='unc_slip_image_base64')])
 a=sync(w,q);b=sync(w,q)
 assert a['references']==3 and a['unique_files']==b['unique_files']==1
 assert len([c for c in calls if c!=MANIFEST_SQL])==1
 with w.connect(read_only=True) as c:
  assert c.execute('SELECT count(*) FROM bronze.finance_media_current').fetchone()[0]==3
  assert c.execute('SELECT count(*) FROM meta_finance_media_runs').fetchone()[0]==2
  path=c.execute('SELECT path FROM bronze.finance_media_current LIMIT 1').fetchone()[0]
 assert (w.root/path).read_bytes()==base64.b64decode(PNG)
 assert (w.root/path).stat().st_mode&0o777==0o600
 assert len(list((w.root/'media').rglob('*.png')))==1
 assert len(list((w.root/'media').rglob('current.parquet')))==1

def test_changed_source_retains_previous(w):
 sync(w,fake([row()])[0])
 with pytest.raises(ValueError,match='Source changed'):sync(w,fake([row('QTM')],True)[0])
 with w.connect(read_only=True) as c:assert c.execute('SELECT kind FROM bronze.finance_media_current').fetchone()[0]=='UNC'

def test_removal_retains_history(w):
 sync(w,fake([row()])[0]);a=sync(w,lambda sql:[])
 assert a['references']==0
 assert len(list((w.root/'media').rglob('*.png')))==1
 assert len(list((w.root/'media').rglob('manifests/*.json')))==2

@pytest.mark.parametrize('payload',['https://example.com/a.png','<svg/>','data:image/svg+xml;base64,AAAA','@@@','',base64.b64encode(b'not-image').decode(),'data:image/jpeg;base64,'+PNG])
def test_invalid_image(payload):
 with pytest.raises(ValueError):decode_image(payload)

def test_dataurl_same_bytes(w):
 a=store_blob(w.root,PNG,row()['source_md5']);p='data:image/png;base64,'+PNG
 assert a==store_blob(w.root,p,hashlib.md5(p.encode()).hexdigest())

@pytest.mark.parametrize('patch',[{'declaration_id':"x';DROP TABLE x;"},{'ordinal':0},{'ordinal':True},{'characters':MAX_IMAGE_CHARS+1},{'source_md5':"'bad"},{'closing_date':'2026-02-30'},{'source_field':'other'},{'kind':'OTHER'}])
def test_invalid_manifest(patch):
 r=row();r.update(patch)
 with pytest.raises((ValueError,AttributeError)):validate_manifest([r])

def test_duplicate_slot():
 with pytest.raises(ValueError):validate_manifest([row(),row()])

def test_bad_hash(w):
 with pytest.raises(ValueError):store_blob(w.root,PNG,'0'*32)

def test_corrupt_cache(w):
 a=store_blob(w.root,PNG,row()['source_md5']);(w.root/a['path']).write_bytes(b'bad')
 with pytest.raises(ValueError):cached(w.root,row()['source_md5'])

def test_symlink(w):
 (w.root/'media').symlink_to(w.root/'raw',target_is_directory=True)
 with pytest.raises(ValueError):store_blob(w.root,PNG,row()['source_md5'])

def test_missing_source(w):
 with pytest.raises(ValueError):sync(w,lambda sql:[row()] if sql==MANIFEST_SQL else [])
 assert not (w.root/'logs/finance-media-latest.json').exists()

def test_stale(w):
 r=row();blobs={r['source_md5']:store_blob(w.root,PNG,r['source_md5'])};t=datetime.now(timezone.utc).isoformat()
 publish(w,[r],blobs,t)
 with pytest.raises(ValueError):publish(w,[],{},t)

def test_concurrent(w):
 with (w.root/'.finance-media.lock').open('a') as h:
  fcntl.flock(h,fcntl.LOCK_EX|fcntl.LOCK_NB)
  with pytest.raises(BlockingIOError):sync(w,lambda sql:[])

def test_wrong_project(tmp_path):
 with pytest.raises(FileNotFoundError):query('never-execute',tmp_path,tmp_path,'SELECT 1')

def test_chunked_image(w):
 payload=base64.b64encode(b'\xff\xd8\xff'+b'x'*(BATCH_CHARS+200)).decode();digest=hashlib.md5(payload.encode()).hexdigest()
 r=row();r.update(source_md5=digest,characters=len(payload))
 def q(sql):
  m=re.search(r'from (\d+) for (\d+)',sql)
  assert m
  start,length=map(int,m.groups())
  return [{'chunk':payload[start-1:start-1+length]}]
 b=fetch_blobs(q,w.root,[r],time.monotonic()+5)
 assert (w.root/b[digest]['path']).read_bytes()==base64.b64decode(payload)

def test_failure_does_not_publish_or_delete(w):
 sync(w,fake([row()])[0])
 def q(sql):raise RuntimeError('offline')
 with pytest.raises(RuntimeError):sync(w,q)
 with w.connect(read_only=True) as c:assert c.execute('SELECT count(*) FROM bronze.finance_media_current').fetchone()[0]==1
