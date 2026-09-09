from dataclasses import dataclass
from pathlib import Path
import os, plistlib, re, shutil, subprocess, sys
import yaml
from zoneinfo import ZoneInfo

MOUNT = Path('/Volumes/Samsung SSD 9100 PRO 1TB Media')
UUID = '98C046C3-3918-40D8-9F2F-A5F8382BBAA7'

def safe_name(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}', value):
        raise ValueError('Invalid identifier')
    return value

def safe_path(root: Path, *parts) -> Path:
    """Reject symlink traversal, including a symlink that points back inside root."""
    root = Path(root)
    target = root.joinpath(*parts)
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError('Data path escapes configured root')
    current = target
    while current != root and current != current.parent:
        if current.is_symlink():raise ValueError('Symlink data paths are forbidden')
        current = current.parent
    return target

@dataclass(frozen=True)
class Settings:
    data_root: Path = MOUNT / 'BMQ/sme-data-platform'
    test_mode: bool = False
    timezone: str = 'Asia/Ho_Chi_Minh'
    cache_ttl: int = 15
    query_timeout: float = 10
    min_free_fraction: float = .2
    max_batch_bytes: int = 32*1024*1024

    @classmethod
    def from_env(cls):
        directory=Path(__file__).resolve().parents[2]/'config'
        if not directory.exists():directory=Path(sys.prefix)/'share/bmq-sme-data-platform/config'
        app=yaml.safe_load((directory/'app.yaml').read_text())
        warehouse=yaml.safe_load((directory/'warehouse.yaml').read_text())
        ZoneInfo(app['timezone'])
        ttl=int(app['cache_ttl_seconds']);timeout=float(warehouse['query_timeout_seconds']);reserve=float(warehouse['minimum_free_fraction']);batch=int(app['max_batch_bytes'])
        if not 0<=ttl<=300 or not 0<timeout<=10 or not .2<=reserve<1 or not 0<batch<=32*1024*1024:raise ValueError('Unsafe storage/query configuration')
        return cls(Path(os.environ.get('SME_DATA_ROOT', str(MOUNT / 'BMQ/sme-data-platform'))),timezone=app['timezone'],cache_ttl=ttl,query_timeout=timeout,min_free_fraction=reserve,max_batch_bytes=batch)

    def validate_storage(self, write=False):
        root = Path(self.data_root).resolve()
        if not self.test_mode:
            if root==MOUNT.resolve() or not root.is_relative_to(MOUNT.resolve()) or not os.path.ismount(MOUNT):
                raise RuntimeError('Required BMQ SSD is not mounted; workspace fallback forbidden')
            info = plistlib.loads(subprocess.run(['diskutil', 'info', '-plist', str(MOUNT)], check=True, capture_output=True).stdout)
            if info.get('VolumeUUID', '').upper() != UUID or info.get('MountPoint') != str(MOUNT):
                raise RuntimeError('SSD identity mismatch')
        existing = root
        while not existing.exists():
            existing = existing.parent
        usage = shutil.disk_usage(existing)
        if write and not self.test_mode and usage.free / usage.total < self.min_free_fraction:
            raise RuntimeError('Storage reserve: at least 20% free required')
        return {'total_bytes': usage.total, 'free_bytes': usage.free, 'used_bytes': usage.used,
                'status': 'critical' if usage.free/usage.total < .1 else 'warning' if usage.free/usage.total < .2 else 'ok'}
