"""Consistent local backups with hash verification and a working restore test."""
import hashlib
import json
import os
import plistlib
import shutil
import sqlite3
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

import duckdb


def physical_stores(path):
    """APFS volume IDs are not physical disk IDs. Unknown platforms fail closed."""
    path = Path(path).resolve()
    while not os.path.ismount(path) and path.parent != path:
        path = path.parent
    try:
        info = plistlib.loads(subprocess.run(['diskutil', 'info', '-plist', str(path)],
            capture_output=True, check=True, timeout=5).stdout)
        stores = info.get('APFSPhysicalStores', [])
        devices = {item['APFSPhysicalStore'] for item in stores}
        if not devices and info.get('ParentWholeDisk'):
            devices = {info['ParentWholeDisk']}
        physical = set()
        for device in devices:
            detail = plistlib.loads(subprocess.run(['diskutil', 'info', '-plist', device],
                capture_output=True, check=True, timeout=5).stdout)
            physical.add(detail.get('ParentWholeDisk', detail.get('DeviceIdentifier', device)))
        return physical
    except (OSError, subprocess.SubprocessError, ValueError):
        return set()


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def verify_backup(path):
    path = Path(path).resolve()
    if (path / 'manifest.json').is_symlink():
        raise ValueError('Symlink manifest prohibited')
    manifest = json.loads((path / 'manifest.json').read_text())
    if manifest.get('version') != 1 or not isinstance(manifest.get('files'), dict):
        raise ValueError('Invalid backup manifest')
    for name, expected in manifest['files'].items():
        relative = Path(name)
        target = path / relative
        if relative.is_absolute() or '..' in relative.parts or not target.resolve().is_relative_to(path) or target.is_symlink():
            raise ValueError('Unsafe backup path')
        if not target.is_file() or digest(target) != expected:
            raise ValueError('Backup checksum mismatch')
    db = path / 'warehouse/warehouse.duckdb'
    if 'warehouse/warehouse.duckdb' not in manifest['files']:
        raise ValueError('Warehouse database absent')
    with duckdb.connect(str(db), read_only=True) as conn:
        conn.execute('SELECT count(*) FROM information_schema.tables').fetchone()
    knowledge = path / 'knowledge/index.sqlite'
    if knowledge.exists():
        with sqlite3.connect(f'file:{knowledge}?mode=ro', uri=True) as conn:
            if conn.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Knowledge integrity check failed')
    return {'status': 'verified', 'files': len(manifest['files']), 'secondary_device': manifest.get('secondary_device', False)}


def create_backup(warehouse, destination, *, verify=True, require_secondary=False):
    destination = Path(destination).resolve()
    root = warehouse.settings.data_root.resolve()
    if destination == root or destination.is_relative_to(root) or root.is_relative_to(destination):
        raise ValueError('Backup must be outside data root and not an ancestor')
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    with warehouse.lock():
        warehouse.settings.validate_storage()
        primary_devices, secondary_devices = physical_stores(root), physical_stores(destination)
        secondary = bool(primary_devices and secondary_devices and primary_devices.isdisjoint(secondary_devices))
        if require_secondary and not secondary:
            raise ValueError('A different physical storage device is required for this backup policy')
        name = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:10]
        staging = destination / ('.pending-' + name)
        staging.mkdir(mode=0o700)
        try:
            # All DuckDB connections are short lived under the same process/file lock.
            with warehouse.connect() as conn:
                conn.execute('CHECKPOINT')
            files = {}
            for original in sorted(root.rglob('*')):
                relative = original.relative_to(root)
                if relative.parts[0] == 'temp' or original.name in {'.lock', '.warehouse.lock'} or original.name.endswith(('-wal', '-shm')):
                    continue
                if original.is_symlink():
                    raise ValueError('Symlinks in warehouse are prohibited during backup')
                if not original.is_file():
                    continue
                copy = staging / relative
                copy.parent.mkdir(parents=True, exist_ok=True)
                if original.name == 'index.sqlite':
                    with sqlite3.connect(original) as source, sqlite3.connect(copy) as target:
                        source.backup(target)
                else:
                    shutil.copyfile(original, copy)
                files[str(relative)] = digest(copy)
            config = Path(__file__).resolve().parents[2] / 'config'
            if config.exists():
                for original in config.glob('*.yaml'):
                    copy = staging / 'config' / original.name
                    copy.parent.mkdir(exist_ok=True)
                    shutil.copyfile(original, copy)
                    files[str(copy.relative_to(staging))] = digest(copy)
            (staging / 'manifest.json').write_text(json.dumps({'version': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
                'secondary_device': secondary, 'files': files}, indent=2))
            if verify:
                verify_backup(staging)
            target = destination / name
            staging.rename(target)
            return target
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise


def restore_backup(backup, destination, *, settings=None):
    """Restore to a NEW explicit destination only; never overwrite a live warehouse."""
    backup, destination = Path(backup).resolve(), Path(destination).resolve()
    if settings is not None:
        if settings.data_root.resolve() != destination:
            raise ValueError('Restore settings do not match destination')
        settings.validate_storage(write=True)
    if destination.exists():
        raise ValueError('Restore destination must not exist')
    verify_backup(backup)
    manifest = json.loads((backup / 'manifest.json').read_text())
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = destination.parent / ('.restore-' + uuid.uuid4().hex)
    staging.mkdir(mode=0o700)
    try:
        for name in manifest['files']:
            target = staging / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(backup / name, target)
        shutil.copyfile(backup / 'manifest.json', staging / 'manifest.json')
        verify_backup(staging)
        staging.rename(destination)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return destination
