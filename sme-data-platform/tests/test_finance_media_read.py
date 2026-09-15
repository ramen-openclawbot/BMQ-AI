import base64
import hashlib
from datetime import datetime, timedelta, timezone

from fastapi import Request
from fastapi.testclient import TestClient
import httpx
import pytest

from sme_platform.api import Principal, SupabaseOwnerAuth, create_app
from sme_platform.config import Settings
from sme_platform.finance_media import TENANT, publish, store_blob
from sme_platform.warehouse import Warehouse

RAW = b'\x89PNG\r\n\x1a\nfixture-image'
SHA = hashlib.sha256(RAW).hexdigest()


@pytest.fixture
def warehouse(tmp_path):
    w = Warehouse(Settings(tmp_path, test_mode=True))
    w.initialize()
    return w


def seed(w, dates=('2026-09-14',), kind='UNC', age=0):
    payload = base64.b64encode(RAW).decode()
    md5 = hashlib.md5(payload.encode()).hexdigest()
    blob = store_blob(w.root, payload, md5)
    refs = []
    for i, day in enumerate(dates):
        for field in (f'extraction_meta.{kind.lower()}_images', f'{kind.lower()}_slip_image_base64'):
            refs.append(dict(declaration_id=f'00000000-0000-0000-0000-{i:012d}', closing_date=day,
                             kind=kind, source_field=field, ordinal=1, source_md5=md5))
    publish(w, refs, {md5: blob}, (datetime.now(timezone.utc)-timedelta(seconds=age)).isoformat())
    return w.root / blob['path']


def client(w, tenant=TENANT):
    async def auth(request: Request):
        return Principal(tenant, 'fixture-owner')
    return TestClient(create_app(w, auth))


def test_day_dedup_and_protected_bytes(warehouse):
    seed(warehouse)
    c = client(warehouse)
    response = c.post('/v1/finance-media/search', json={'date':'2026-09-14'})
    assert response.status_code == 200
    data = response.json()
    assert data['total'] == len(data['images']) == 1
    assert data['images'][0]['id'] == SHA
    assert data['images'][0]['payment_status'] == 'submitted_unverified'
    assert data['freshness']['age_seconds'] < 60
    assert 'path' not in str(data) and 'media/' not in str(data)
    image = c.get('/v1/finance-media/' + SHA)
    assert image.status_code == 200 and image.content == RAW
    assert image.headers['content-type'] == 'image/png'
    assert image.headers['cache-control'] == 'private, no-store'
    assert image.headers['x-content-type-options'] == 'nosniff'


def test_month_latest_day_limits_and_empty(warehouse):
    seed(warehouse, ('2026-09-01','2026-09-14','2026-09-14'))
    c=client(warehouse)
    result=c.post('/v1/finance-media/search',json={'month':'2026-09','limit':1}).json()
    assert result['selected_date']=='2026-09-14' and result['total']==2
    assert result['truncated'] is True and len(result['images'])==1
    empty=c.post('/v1/finance-media/search',json={'date':'2026-08-01'}).json()
    assert empty['total']==0 and empty['selected_date'] is None and empty['freshness']


@pytest.mark.parametrize('body', [{}, {'date':'2026-09-14','month':'2026-09'}, {'date':'2026-02-30'},
    {'month':'2026-13'}, {'date':'2026-9-1'}, {'month':'9999-01'}, {'month':True},
    {'month':'2026-09','limit':True}, {'month':'2026-09','limit':13}, {'month':'2026-09','kind':'QTM'},
    {'month':'2026-09','tenant_id':'other'}, {'date':"2026-09-14';drop table x;"}])
def test_invalid_requests(warehouse, body):
    seed(warehouse)
    assert client(warehouse).post('/v1/finance-media/search',json=body).status_code==400


def test_cross_tenant_and_absent_current_image(warehouse):
    seed(warehouse)
    c=client(warehouse,'other.supabase.co')
    assert c.post('/v1/finance-media/search',json={'month':'2026-09'}).status_code==403
    assert c.get('/v1/finance-media/'+SHA).status_code==403
    assert client(warehouse).get('/v1/finance-media/'+'f'*64).status_code==404
    assert client(warehouse).get('/v1/finance-media/not-a-hash').status_code==400
    # Removed evidence remains on disk, but cannot be fetched from current catalog.
    publish(warehouse,[],{},datetime.now(timezone.utc).isoformat())
    assert client(warehouse).get('/v1/finance-media/'+SHA).status_code==404


def test_qtm_not_exposed_as_unc(warehouse):
    seed(warehouse,kind='QTM')
    c=client(warehouse)
    assert c.post('/v1/finance-media/search',json={'month':'2026-09'}).json()['total']==0
    assert c.get('/v1/finance-media/'+SHA).status_code==404


@pytest.mark.parametrize('failure',['missing_catalog','stale','missing_file','tampered','symlink','path','mime','size'])
def test_unavailable_or_corrupt_fails_closed(warehouse,failure):
    if failure!='missing_catalog':
        path=seed(warehouse,age=3601 if failure=='stale' else 0)
        if failure=='missing_file':path.unlink()
        if failure=='tampered':path.write_bytes(RAW[:-1]+b'!')
        if failure=='symlink':
            target=warehouse.root/'copy.png';target.write_bytes(RAW);path.unlink();path.symlink_to(target)
        if failure in ('path','mime','size'):
            column,value={'path':('path','../../outside.png'),'mime':('mime_type','text/html'),'size':('bytes',999999999)}[failure]
            with warehouse.connect() as con:
                con.execute(f'UPDATE bronze.finance_media_current SET {column}=?',[value])
    c=client(warehouse)
    assert c.get('/v1/finance-media/'+SHA).status_code==503
    if failure in ('missing_catalog','stale'):
        assert c.post('/v1/finance-media/search',json={'month':'2026-09'}).status_code==503


def test_storage_identity_failure(warehouse,monkeypatch):
    seed(warehouse)
    def unavailable(*a,**k):raise RuntimeError('SSD absent')
    monkeypatch.setattr(Settings,'validate_storage',unavailable)
    c=client(warehouse)
    assert c.get('/v1/finance-media/'+SHA).status_code==503
    assert c.post('/v1/finance-media/search',json={'month':'2026-09'}).status_code==503


@pytest.mark.parametrize('role,status',[('owner',200),('staff',403),('expired',401)])
def test_actual_supabase_auth_role_boundary(warehouse,monkeypatch,role,status):
    seed(warehouse)
    async_client=httpx.AsyncClient
    def transport(request):
        if request.url.path=='/auth/v1/user':
            return httpx.Response(401 if role=='expired' else 200,json={'id':'owner-test'})
        assert request.url.path=='/rest/v1/user_roles'
        assert request.url.params['user_id']=='eq.owner-test'
        return httpx.Response(200,json=[{'role':role}])
    monkeypatch.setattr(httpx,'AsyncClient',lambda **kw:async_client(transport=httpx.MockTransport(transport),**kw))
    c=TestClient(create_app(warehouse,SupabaseOwnerAuth('https://'+TENANT,'fixture-publishable')))
    assert c.get('/v1/finance-media/'+SHA).status_code==401
    assert c.post('/v1/finance-media/search',json={'month':'2026-09'}).status_code==401
    headers={'Authorization':'Bearer fixture-test'}
    assert c.get('/v1/finance-media/'+SHA,headers=headers).status_code==status
    assert c.post('/v1/finance-media/search',json={'month':'2026-09'},headers=headers).status_code==status


def test_symlink_directory_and_root(warehouse, tmp_path):
    path = seed(warehouse)
    objects = path.parent
    moved = objects.with_name('moved')
    objects.rename(moved)
    objects.symlink_to(moved, target_is_directory=True)
    assert client(warehouse).get('/v1/finance-media/'+SHA).status_code == 503
    objects.unlink()
    moved.rename(objects)
    alias = tmp_path.parent / (tmp_path.name+'-alias')
    alias.symlink_to(warehouse.root, target_is_directory=True)
    try:
        aliased = Warehouse(Settings(alias, test_mode=True))
        assert client(aliased).get('/v1/finance-media/'+SHA).status_code == 503
        assert client(aliased).post('/v1/finance-media/search',json={'month':'2026-09'}).status_code == 503
    finally:
        alias.unlink()
