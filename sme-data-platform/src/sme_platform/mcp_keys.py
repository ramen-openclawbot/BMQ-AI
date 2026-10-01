"""Per-dealer MCP keys: a local SQLite store that is never synced or exported.

Only SHA-256 digests are persisted; the plaintext key is printed once by the
create command and is unrecoverable afterwards. Authentication compares the
digest of a well-formed candidate against every stored digest with a
constant-time comparison. Keys belonging to inactive customers are rejected by
the caller (see ``bmq_mcp.WarehouseCatalog``), never silently downgraded.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .config import Settings, safe_name, safe_path

PREFIX = 'bmq_live_'
TOKEN_BYTES = 24
MAX_KEY_LENGTH = 200
MAX_LABEL_LENGTH = 80

_SCHEMA = '''CREATE TABLE IF NOT EXISTS mcp_keys(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT NOT NULL UNIQUE,
    customer_code TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT)'''


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_label(label) -> str | None:
    if label is None:
        return None
    if not isinstance(label, str):
        raise ValueError('Invalid label')
    value = label.strip()
    if not value or len(value) > MAX_LABEL_LENGTH or any(ord(c) < 32 for c in value):
        raise ValueError('Invalid label')
    return value


class MCPKeyStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.path = safe_path(Path(settings.data_root), 'mcp', 'keys.sqlite3')

    def _open(self, write: bool):
        if not write:
            if not self.path.is_file():
                return None
            return sqlite3.connect(f'file:{self.path}?mode=ro', uri=True)
        self.settings.validate_storage(write=True)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.path.parent, 0o700)
        con = sqlite3.connect(str(self.path))
        con.execute(_SCHEMA)
        con.commit()
        os.chmod(self.path, 0o600)
        return con

    def create(self, customer_code: str, label=None) -> dict:
        code = safe_name(customer_code)
        clean_label = _clean_label(label)
        key = PREFIX + secrets.token_urlsafe(TOKEN_BYTES)
        digest = hashlib.sha256(key.encode()).hexdigest()
        created_at = _now()
        con = self._open(write=True)
        try:
            with con:
                cursor = con.execute(
                    'INSERT INTO mcp_keys(key_hash,customer_code,label,created_at,revoked_at) VALUES (?,?,?,?,NULL)',
                    [digest, code, clean_label, created_at])
            record = {'id': int(cursor.lastrowid), 'customer_code': code, 'label': clean_label,
                      'created_at': created_at, 'key': key}
        finally:
            con.close()
        return record

    def list(self) -> list[dict]:
        con = self._open(write=False)
        if con is None:
            return []
        try:
            con.row_factory = sqlite3.Row
            rows = con.execute('SELECT id,customer_code,label,created_at,revoked_at FROM mcp_keys ORDER BY id').fetchall()
        finally:
            con.close()
        return [{'id': row['id'], 'customer_code': row['customer_code'], 'label': row['label'],
                 'created_at': row['created_at'], 'revoked_at': row['revoked_at'],
                 'active': row['revoked_at'] is None} for row in rows]

    def revoke(self, key_id) -> dict:
        if isinstance(key_id, bool) or not isinstance(key_id, int) or key_id < 1:
            raise ValueError('Invalid key id')
        con = self._open(write=True)
        try:
            with con:
                found = con.execute('SELECT id,revoked_at FROM mcp_keys WHERE id=?', [key_id]).fetchone()
                if found is None:
                    raise ValueError('Unknown key id')
                if found[1] is None:
                    con.execute('UPDATE mcp_keys SET revoked_at=? WHERE id=?', [_now(), key_id])
                    revoked = True
                else:
                    revoked = False
        finally:
            con.close()
        return {'id': key_id, 'revoked': revoked}

    def authenticate(self, key) -> dict | None:
        if not isinstance(key, str) or not key.startswith(PREFIX) or not len(PREFIX) < len(key) <= MAX_KEY_LENGTH:
            return None
        candidate = hashlib.sha256(key.encode()).hexdigest()
        con = self._open(write=False)
        if con is None:
            return None
        try:
            con.row_factory = sqlite3.Row
            rows = con.execute('SELECT id,key_hash,customer_code,label,revoked_at FROM mcp_keys ORDER BY id').fetchall()
        finally:
            con.close()
        matched = None
        # Compare against every row so a miss and a late hit take the same path.
        for row in rows:
            if hmac.compare_digest(candidate, row['key_hash']) and row['revoked_at'] is None:
                matched = {'id': row['id'], 'customer_code': row['customer_code'], 'label': row['label']}
        return matched


def run_cli(settings: Settings, command: str, customer_code=None, label=None, target=None) -> dict:
    store = MCPKeyStore(settings)
    if command == 'create':
        if not customer_code:
            raise ValueError('--customer-code is required')
        return store.create(customer_code, label)
    if command == 'list':
        return {'keys': store.list()}
    if command == 'revoke':
        if target is None:
            raise ValueError('A key id is required')
        return store.revoke(int(target))
    raise ValueError('Unknown mcp-key command')
