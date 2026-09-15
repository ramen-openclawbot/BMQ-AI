"""Bounded, tenant-scoped read access to mirrored UNC evidence, never payment proof."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime, timezone
import hashlib
import os
from pathlib import Path
import re
import stat

import duckdb

from .config import safe_path
from .supabase_sync import TENANT

MAX_AGE_SECONDS = 3600
MAX_BYTES = 24 * 1024 * 1024
MIMES = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp'}


def period(body):
    if not isinstance(body, dict) or set(body) - {'date', 'month', 'limit'}:
        raise ValueError('Invalid media query')
    if ('date' in body) == ('month' in body):
        raise ValueError('Choose exactly one period')
    limit = body.get('limit', 8)
    if type(limit) is not int or not 1 <= limit <= 12:
        raise ValueError('Invalid media limit')
    if 'date' in body:
        value = body['date']
        if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            raise ValueError('Invalid day')
        start = date.fromisoformat(value)
        end = start
    else:
        value = body['month']
        if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}', value):
            raise ValueError('Invalid month')
        start = date.fromisoformat(value + '-01')
        import calendar
        end = date(start.year, start.month, calendar.monthrange(start.year, start.month)[1])
    if not 2000 <= start.year <= 2100:
        raise ValueError('Date outside supported period')
    return start, end, limit


@contextmanager
def catalog(warehouse, tenant):
    # The sync has a fixed project; authenticated owners from another project
    # cannot select or reuse its catalog, even if they know an image hash.
    if tenant != TENANT:
        raise PermissionError('Wrong project')
    warehouse.settings.validate_storage()
    if warehouse.root.is_symlink():
        raise RuntimeError('Symlink storage root forbidden')
    if not warehouse.db_path.is_file():
        raise RuntimeError('Media database unavailable')
    try:
        with warehouse.lock(write=False), warehouse.connect(read_only=True) as con:
            latest = con.execute("""SELECT observed_at FROM meta_finance_media_runs
                WHERE json_extract_string(manifest, '$.tenant')=?
                ORDER BY observed_at DESC LIMIT 1""", [tenant]).fetchone()
            if not latest or latest[0] is None:
                raise RuntimeError('Media source has not been synchronized')
            age = (datetime.now(timezone.utc) - latest[0]).total_seconds()
            if not -60 <= age <= MAX_AGE_SECONDS:
                raise RuntimeError('Media source stale')
            freshness = {'source_observed_at': latest[0].isoformat(), 'age_seconds': max(0, int(age)),
                         'max_age_seconds': MAX_AGE_SECONDS}
            yield con, freshness
    except duckdb.Error:
        raise RuntimeError('Media catalog unavailable') from None


def search(warehouse, body, tenant):
    start, end, limit = period(body)
    with catalog(warehouse, tenant) as (con, freshness):
        selected = con.execute("""SELECT max(closing_date) FROM bronze.finance_media_current
            WHERE tenant_id=? AND kind='UNC' AND closing_date BETWEEN ? AND ?""", [tenant, start, end]).fetchone()[0]
        images, total = [], 0
        if selected:
            total = con.execute("""SELECT count(*) FROM (
                SELECT DISTINCT declaration_id,sha256 FROM bronze.finance_media_current
                WHERE tenant_id=? AND kind='UNC' AND closing_date=?)""", [tenant, selected]).fetchone()[0]
            rows = con.execute("""SELECT declaration_id,sha256,min(mime_type),min(bytes)
                FROM bronze.finance_media_current WHERE tenant_id=? AND kind='UNC' AND closing_date=?
                GROUP BY declaration_id,sha256 ORDER BY declaration_id,sha256 LIMIT ?""", [tenant, selected, limit]).fetchall()
            for declaration, sha, mime, size in rows:
                if not re.fullmatch('[0-9a-f]{64}', sha or '') or mime not in MIMES or not 0 < size <= MAX_BYTES:
                    raise RuntimeError('Invalid catalog entry')
                images.append({'id': sha, 'declaration_id': declaration, 'date': selected.isoformat(),
                               'kind': 'UNC', 'mime_type': mime, 'bytes': size,
                               'payment_status': 'submitted_unverified'})
    return {'selected_date': selected.isoformat() if selected else None,
            'requested_date': body.get('date'), 'requested_month': body.get('month'),
            'images': images, 'total': total, 'truncated': total > len(images),
            'payment_status': 'submitted_unverified', 'freshness': freshness}


def read_image(warehouse, sha, tenant):
    if not isinstance(sha, str) or not re.fullmatch('[0-9a-f]{64}', sha):
        raise ValueError('Invalid image identifier')
    with catalog(warehouse, tenant) as (con, _):
        rows = con.execute("""SELECT DISTINCT path,mime_type,bytes FROM bronze.finance_media_current
            WHERE tenant_id=? AND kind='UNC' AND sha256=? LIMIT 2""", [tenant, sha]).fetchall()
        if not rows:
            return None
        if len(rows) != 1:
            raise RuntimeError('Inconsistent media catalog')
        relative, mime, size = rows[0]
        if mime not in MIMES or type(size) is not int or not 0 < size <= MAX_BYTES:
            raise RuntimeError('Invalid media metadata')
        expected = Path('media') / tenant / 'qtm-unc' / 'objects' / (sha + '.' + MIMES[mime])
        if relative != expected.as_posix():
            raise RuntimeError('Invalid media location')
        try:
            path = safe_path(warehouse.root, relative)
            # Reject symlinked components and atomically reject a symlink file.
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size != size:
                    raise RuntimeError('Invalid media file')
                raw = handle.read(MAX_BYTES + 1)
        except (OSError, ValueError):
            raise RuntimeError('Media file unavailable') from None
        if len(raw) != size or hashlib.sha256(raw).hexdigest() != sha:
            raise RuntimeError('Media integrity mismatch')
        signatures = {'image/png': raw.startswith(b'\x89PNG\r\n\x1a\n'),
                      'image/jpeg': raw.startswith(b'\xff\xd8\xff'),
                      'image/gif': raw[:6] in (b'GIF87a', b'GIF89a'),
                      'image/webp': raw[:4] == b'RIFF' and raw[8:12] == b'WEBP'}
        if not signatures[mime]:
            raise RuntimeError('Media signature mismatch')
        return raw, mime
