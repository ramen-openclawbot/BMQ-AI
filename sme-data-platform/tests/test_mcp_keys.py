"""Per-dealer MCP keys: local SQLite, hash-only, constant-time, revocable."""
import hashlib
import sqlite3

import pytest

from sme_platform.cli import build_parser
from sme_platform.config import Settings
from sme_platform.mcp_keys import MCPKeyStore, PREFIX, run_cli


@pytest.fixture
def settings(tmp_path):
    return Settings(tmp_path / 'data', test_mode=True)


def store(settings):
    return MCPKeyStore(settings)


def test_create_returns_key_once_and_persists_only_hash(settings):
    result = store(settings).create('KH1', 'quầy 1')
    assert result['key'].startswith(PREFIX) and len(result['key']) > len(PREFIX) + 20
    assert result['customer_code'] == 'KH1' and result['label'] == 'quầy 1' and result['id'] >= 1
    with sqlite3.connect(str(store(settings).path)) as con:
        row = con.execute('SELECT key_hash,customer_code,revoked_at FROM mcp_keys').fetchone()
    assert row[0] == hashlib.sha256(result['key'].encode()).hexdigest()
    assert result['key'] not in row and row[1] == 'KH1' and row[2] is None
    listing = store(settings).list()
    assert listing[0]['customer_code'] == 'KH1' and listing[0]['active'] is True
    assert 'key' not in listing[0] and 'key_hash' not in listing[0]


def test_authenticate_accepts_only_active_well_formed_keys(settings):
    first = store(settings).create('KH1')
    second = store(settings).create('KH2')
    keys = store(settings)
    assert keys.authenticate(first['key'])['customer_code'] == 'KH1'
    assert keys.authenticate(second['key'])['customer_code'] == 'KH2'
    assert keys.authenticate('bmq_live_not-a-real-key') is None
    assert keys.authenticate('missing-prefix') is None
    assert keys.authenticate('') is None
    assert keys.authenticate(None) is None
    assert keys.authenticate(first['key'] + 'x') is None


def test_revoke_is_idempotent_and_blocks_authentication(settings):
    created = store(settings).create('KH1')
    keys = store(settings)
    assert keys.revoke(created['id']) == {'id': created['id'], 'revoked': True}
    assert keys.authenticate(created['key']) is None
    assert keys.revoke(created['id']) == {'id': created['id'], 'revoked': False}
    assert keys.list()[0]['active'] is False and keys.list()[0]['revoked_at']
    with pytest.raises(ValueError): keys.revoke(9999)
    with pytest.raises(ValueError): keys.revoke(True)


def test_empty_store_authenticates_nobody(settings):
    keys = store(settings)
    assert keys.list() == []
    assert keys.authenticate(PREFIX + 'anything') is None
    assert not keys.path.exists()


def test_create_rejects_bad_customer_and_key_material_never_shown_twice(settings):
    keys = store(settings)
    with pytest.raises(ValueError): keys.create('bad code')
    with pytest.raises(ValueError): keys.create('KH1', 'x' * 81)
    created = keys.create('KH1')
    assert created['key'] not in str(keys.list())


def test_run_cli_create_list_revoke(settings):
    created = run_cli(settings, 'create', customer_code='KH1', label='test')
    assert created['key'].startswith(PREFIX)
    listed = run_cli(settings, 'list')
    assert listed['keys'][0]['customer_code'] == 'KH1' and 'key' not in listed['keys'][0]
    revoked = run_cli(settings, 'revoke', target=str(created['id']))
    assert revoked == {'id': created['id'], 'revoked': True}
    with pytest.raises(ValueError): run_cli(settings, 'create')
    with pytest.raises(ValueError): run_cli(settings, 'revoke')
    with pytest.raises(ValueError): run_cli(settings, 'unknown')


def test_cli_parser_wires_mcp_key_commands():
    parser = build_parser()
    create = parser.parse_args(['mcp-key', 'create', '--customer-code', 'KH1', '--label', 'quầy'])
    assert (create.action, create.command, create.customer_code, create.label) == ('mcp-key', 'create', 'KH1', 'quầy')
    assert parser.parse_args(['mcp-key', 'list']).command == 'list'
    revoke = parser.parse_args(['mcp-key', 'revoke', '7'])
    assert (revoke.command, revoke.target) == ('revoke', '7')
    # Existing actions keep parsing unchanged.
    assert parser.parse_args(['status']).action == 'status'
