"""Local lexical knowledge retrieval. Documents are evidence, never instructions."""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from .config import safe_name, safe_path


class KnowledgeMemoryProvider(Protocol):
    def ingest(self, **kwargs): ...
    def search(self, **kwargs): ...
    def delete(self, **kwargs): ...


def terms(text: str) -> set[str]:
    normalized = unicodedata.normalize('NFKD', text.lower().replace('đ', 'd'))
    return set(re.findall(r'[a-z0-9]{2,}', ''.join(c for c in normalized if not unicodedata.combining(c))))


class KnowledgeStore:
    def __init__(self, warehouse):
        self.warehouse = warehouse

    def _connection(self, read_only=False):
        self.warehouse.settings.validate_storage()
        path = safe_path(self.warehouse.settings.data_root, 'knowledge')
        safe_path(path, 'index.sqlite')
        if read_only:
            conn = sqlite3.connect(f'file:{path / "index.sqlite"}?mode=ro', uri=True)
            conn.row_factory = sqlite3.Row
            return conn
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        conn = sqlite3.connect(path / 'index.sqlite')
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        conn.executescript('''
          CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY, tenant TEXT NOT NULL, source TEXT NOT NULL,
            title TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL,
            raw_path TEXT NOT NULL, ingested_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
            UNIQUE(tenant, source, sha256, title));
          CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY, document_id TEXT REFERENCES documents(id),
            ordinal INTEGER NOT NULL, text TEXT NOT NULL);
        ''')
        return conn

    def ingest(self, *, tenant_id: str, source: str, title: str, filename: str, content: str):
        safe_name(tenant_id)
        safe_name(source)
        if not isinstance(title, str) or not title.strip() or len(title) > 200:
            raise ValueError('Title must contain 1–200 characters')
        if Path(filename).name != filename or Path(filename).suffix.lower() not in {'.txt', '.md'}:
            raise ValueError('Only plain UTF-8 .md and .txt documents are supported')
        data = content.encode('utf-8')
        if not data or len(data) > 1024 * 1024 or '\x00' in content:
            raise ValueError('Document must contain 1 byte–1 MiB of UTF-8 text')
        sha = hashlib.sha256(data).hexdigest()
        document_id = hashlib.sha256(json.dumps([tenant_id, source, sha, title], ensure_ascii=False).encode()).hexdigest()
        now = datetime.now(timezone.utc).isoformat()
        with self.warehouse.lock():
            self.warehouse.settings.validate_storage(write=True)
            conn = self._connection()
            try:
                old = conn.execute('SELECT id FROM documents WHERE id=? AND deleted=0', (document_id,)).fetchone()
                if old:
                    return {'status': 'duplicate', 'id': document_id}
                root = self.warehouse.settings.data_root
                raw = safe_path(root, 'raw', tenant_id, source, 'documents', f'{sha}{Path(filename).suffix.lower()}')
                raw.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                if not raw.exists():
                    with raw.open('xb') as handle:
                        handle.write(data)
                    raw.chmod(0o400)
                elif hashlib.sha256(raw.read_bytes()).hexdigest() != sha:
                    raise RuntimeError('Immutable raw document checksum mismatch')
                conn.execute('''INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,0)
                    ON CONFLICT(id) DO UPDATE SET deleted=0, ingested_at=excluded.ingested_at''',
                             (document_id, tenant_id, source, title.strip(), filename, sha, str(raw.relative_to(root)), now))
                conn.execute('DELETE FROM chunks WHERE document_id=?', (document_id,))
                # Fixed bounded windows with overlap preserve citations and avoid large model contexts.
                for i, start in enumerate(range(0, len(content), 1400)):
                    conn.execute('INSERT INTO chunks VALUES (?,?,?,?)',
                                 (f'{document_id}:{i}', document_id, i, content[start:start + 1600]))
                conn.commit()
                return {'status': 'success', 'id': document_id, 'records': i + 1, 'ingested_at': now}
            finally:
                conn.close()

    def list_sources(self, tenant_id: str):
        safe_name(tenant_id)
        with self.warehouse.lock(write=False):
            if not (self.warehouse.root / 'knowledge/index.sqlite').exists():
                return []
            conn = self._connection(read_only=True)
            try:
                rows = conn.execute('''SELECT d.id, d.source, d.filename, d.ingested_at, COUNT(c.id) AS records
                    FROM documents d LEFT JOIN chunks c ON c.document_id=d.id
                    WHERE d.tenant=? AND d.deleted=0 GROUP BY d.id ORDER BY d.ingested_at DESC LIMIT 200''', (tenant_id,)).fetchall()
                return [dict(row) | {'entity': 'document', 'kind': 'document', 'status': 'success'} for row in rows]
            finally:
                conn.close()

    def search(self, *, tenant_id: str, question: str, limit: int = 5):
        safe_name(tenant_id)
        if not isinstance(question, str) or not 1 <= len(question) <= 4000 or type(limit) is not int or not 1 <= limit <= 5:
            raise ValueError('Invalid knowledge search')
        wanted = terms(question) - {'the', 'what', 'how', 'does', 'can', 'toi', 'cho', 'cua', 'and', 'are'}
        if not wanted:
            return {'chunks': []}
        with self.warehouse.lock(write=False):
            if not (self.warehouse.root / 'knowledge/index.sqlite').exists():
                return {'chunks': []}
            conn = self._connection(read_only=True)
            try:
                cursor = conn.execute('''SELECT c.id,c.text,d.title,d.source,d.ingested_at AS updated_at,d.sha256
                    FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.tenant=? AND d.deleted=0''', (tenant_id,))
                best = []
                deadline = time.monotonic() + 2
                for row in cursor:
                    if time.monotonic() > deadline:
                        raise RuntimeError('Knowledge search budget exceeded; narrow the query or add an indexed provider')
                    tokens = terms(row['text'])
                    score = len(wanted & tokens) + 2 * len(wanted & terms(row['title']))
                    if score:
                        best.append((score, dict(row)))
                        best.sort(key=lambda item: (-item[0], item[1]['id']))
                        del best[limit:]
                return {'chunks': [item[1] for item in best]}
            finally:
                conn.close()

    def delete(self, *, tenant_id: str, document_id: str):
        """Explicitly retire retrieval only; immutable raw evidence remains retained."""
        safe_name(tenant_id)
        with self.warehouse.lock():
            conn = self._connection()
            try:
                conn.execute('UPDATE documents SET deleted=1 WHERE tenant=? AND id=?', (tenant_id, document_id))
                conn.commit()
            finally:
                conn.close()
