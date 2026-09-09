"""Owner-authenticated HTTP adapter. Run behind HTTPS; no public database/SQL endpoint."""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import httpx
import yaml
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .config import Settings, safe_name
from .knowledge import KnowledgeStore
from .query import QueryEngine
from .warehouse import CONFIG_DIR, Warehouse, json_default


@dataclass(frozen=True)
class Principal:
    tenant: str
    user: str
    permission: str = 'owner:rls:v1'


class SupabaseOwnerAuth:
    def __init__(self, url: str, publishable_key: str):
        parsed = urlparse(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path not in {'', '/'}:
            raise ValueError('SME_SUPABASE_URL must be a fixed HTTPS project origin')
        self.url = url.rstrip('/')
        self.tenant = parsed.hostname
        self.key = publishable_key

    async def __call__(self, request: Request):
        bearer = request.headers.get('authorization', '')
        if not bearer.startswith('Bearer ') or not 8 < len(bearer) <= 8192:
            raise HTTPException(401, 'unauthorized')
        if not self.key:
            raise HTTPException(503, 'auth_unconfigured')
        headers = {'Authorization': bearer, 'apikey': self.key}
        try:
            async with httpx.AsyncClient(timeout=5, follow_redirects=False) as client:
                response = await client.get(self.url + '/auth/v1/user', headers=headers)
                if response.status_code != 200:
                    raise HTTPException(401, 'unauthorized')
                user = response.json().get('id')
                if not isinstance(user, str) or len(user) > 100:
                    raise HTTPException(401, 'unauthorized')
                roles = await client.get(self.url + '/rest/v1/user_roles', headers=headers,
                    params={'select': 'role', 'user_id': f'eq.{user}'})
                if roles.status_code != 200 or not any(row.get('role') == 'owner' for row in roles.json()):
                    raise HTTPException(403, 'forbidden')
                return Principal(self.tenant, user)
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            raise HTTPException(503, 'auth_unavailable') from None


class StrictBody(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class IngestBody(StrictBody):
    source: str = Field(min_length=1, max_length=80)
    entity: str = Field(min_length=1, max_length=80)
    filename: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=1024 * 1024)
    timezone: str = 'Asia/Ho_Chi_Minh'


class DocumentBody(StrictBody):
    source: str = 'business_docs'
    title: str = Field(min_length=1, max_length=200)
    filename: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=1024 * 1024)


class SearchBody(StrictBody):
    question: str = Field(min_length=1, max_length=4000)
    limit: int = Field(default=5, ge=1, le=5)


def create_app(warehouse: Warehouse | None = None, authenticator=None):
    warehouse = warehouse or Warehouse(Settings.from_env())
    knowledge = KnowledgeStore(warehouse)
    engine = QueryEngine(warehouse)
    app = FastAPI(title='BMQ local data platform', docs_url=None, redoc_url=None, openapi_url=None)
    if authenticator is None:
        url = os.environ.get('SME_SUPABASE_URL', '')
        if url:
            authenticator = SupabaseOwnerAuth(url, os.environ.get('SME_SUPABASE_PUBLISHABLE_KEY', ''))
        else:
            async def authenticator(request: Request):
                raise HTTPException(503, 'auth_unconfigured')

    @app.middleware('http')
    async def bounds(request, call_next):
        if request.method == 'POST':
            if request.headers.get('content-type', '').split(';')[0] != 'application/json':
                return JSONResponse({'error': 'json_required'}, status_code=415)
            # Read bounded chunks even if Content-Length is absent or dishonest.
            parts, length = [], 0
            try:
                async with asyncio.timeout(10):
                    async for part in request.stream():
                        length += len(part)
                        if length > 2 * 1024 * 1024:
                            return JSONResponse({'error': 'payload_too_large'}, status_code=413)
                        parts.append(part)
            except TimeoutError:
                return JSONResponse({'error': 'request_timeout'}, status_code=408)
            request._body = b''.join(parts)
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @app.exception_handler(ValueError)
    async def invalid(request, error):
        # Do not expose input data/SQL/paths from parser exceptions.
        return JSONResponse({'error': 'invalid_request', 'message': 'Check file schema, identifiers and query limits.'}, status_code=400)

    @app.exception_handler(RuntimeError)
    async def unavailable(request, error):
        return JSONResponse({'error': 'data_unavailable', 'message': 'Storage or data is not ready.'}, status_code=503)

    @app.exception_handler(PermissionError)
    async def denied(request, error):
        return JSONResponse({'error': 'forbidden'}, status_code=403)

    def dataset_sources(tenant):
        safe_name(tenant)
        with warehouse.lock(write=False), warehouse.connect(read_only=True) as conn:
            cursor = conn.execute('''SELECT run_id AS id, source, entity, raw_path, original_filename, status,
                records_written AS records, started_at AS ingested_at, records_failed
                FROM meta_ingestion_runs WHERE tenant_id=? ORDER BY started_at DESC LIMIT 200''', [tenant])
            names = [column[0] for column in cursor.description]
            rows = [dict(zip(names, row)) for row in cursor.fetchall()]
        for row in rows:
            raw_name = Path(row.pop('raw_path')).name
            row['filename'] = row.pop('original_filename') or raw_name
            row['kind'] = 'dataset'
            if row.pop('records_failed') or row['status'] == 'failed':
                row['error'] = 'Validation failed; existing published data retained.'
        return rows

    @app.get('/v1/status')
    def status(principal: Principal = Depends(authenticator)):
        storage = warehouse.settings.validate_storage()
        sources = dataset_sources(principal.tenant)
        docs = knowledge.list_sources(principal.tenant)
        return {'status': 'ready', 'storage': {**storage, 'warning': None if storage.get('status') == 'ok' else storage.get('status')},
                'sources': len(sources), 'knowledge_documents': len(docs), 'semantic_version': '1.0'}

    @app.get('/v1/sources')
    def sources(principal: Principal = Depends(authenticator)):
        return {'sources': dataset_sources(principal.tenant) + knowledge.list_sources(principal.tenant)}

    @app.get('/v1/semantic')
    def semantic(principal: Principal = Depends(authenticator)):
        from .bmq_semantic import catalog
        from .supabase_sync import TENANT
        if principal.tenant == TENANT:
            return catalog()
        return yaml.safe_load((CONFIG_DIR / 'semantic.yaml').read_text())

    @app.post('/v1/ingest')
    def ingest(body: IngestBody, principal: Principal = Depends(authenticator)):
        if Path(body.filename).name != body.filename or Path(body.filename).suffix.lower() not in {'.csv', '.json', '.jsonl'}:
            raise ValueError('Invalid filename')
        payload = body.content.encode('utf-8')
        if len(payload) > 1024 * 1024 or b'\0' in payload:
            raise ValueError('Invalid file size or content')
        warehouse.settings.validate_storage(write=True)
        # Uploaded filenames never select filesystem paths.
        with tempfile.TemporaryDirectory(dir=warehouse.root / 'temp') as directory:
            path = Path(directory) / ('upload' + Path(body.filename).suffix.lower())
            path.write_bytes(payload)
            result = warehouse.ingest_file(path, tenant_id=principal.tenant, source=body.source,
                                           entity=body.entity, timezone=body.timezone, original_filename=body.filename)
        warehouse.refresh_gold()
        result['publication'] = 'ready'
        return json.loads(json.dumps(result, default=json_default))

    @app.post('/v1/documents')
    def documents(body: DocumentBody, principal: Principal = Depends(authenticator)):
        return knowledge.ingest(tenant_id=principal.tenant, **body.model_dump())

    @app.post('/v1/knowledge/search')
    def search(body: SearchBody, principal: Principal = Depends(authenticator)):
        return knowledge.search(tenant_id=principal.tenant, **body.model_dump())

    @app.post('/v1/query')
    def query(body: dict, principal: Principal = Depends(authenticator)):
        result = engine.execute(body, tenant_id=principal.tenant, permission_scope=principal.permission + ':' + principal.user)
        return json.loads(json.dumps(result, default=json_default))

    return app


def main():
    import uvicorn
    # No --host 0.0.0.0 default: connect Edge only through a separately configured TLS relay.
    uvicorn.run(create_app(), host='127.0.0.1', port=8766, access_log=False)


if __name__ == '__main__':
    main()
