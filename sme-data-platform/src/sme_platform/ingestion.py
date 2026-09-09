"""All source extraction uses the same checkpointed connector interface."""
from pathlib import Path
from typing import Protocol
import csv, json
from .canonical import timestamp

class SourceConnector(Protocol):
    def test_connection(self) -> bool: ...
    def extract(self, since=None): ...
    def checkpoint(self): ...

class FileConnector:
    def __init__(self,path,timezone='Asia/Ho_Chi_Minh'):
        self.path=Path(path);self.timezone=timezone;self._checkpoint=None
    def test_connection(self):return self.path.is_file() and self.path.suffix.lower() in {'.csv','.json','.jsonl'}
    def extract(self,since=None):
        if not self.test_connection():raise FileNotFoundError('Source unavailable or unsupported')
        with self.path.open(encoding='utf-8-sig') as f:
            rows=list(csv.DictReader(f)) if self.path.suffix=='.csv' else [json.loads(line) for line in f if line.strip()] if self.path.suffix=='.jsonl' else json.load(f)
        for row in rows:
            updated=timestamp(row['updated_at'],self.timezone) if row.get('updated_at') else None
            if since and updated and updated<timestamp(since,self.timezone):continue
            if updated:self._checkpoint=max(self._checkpoint,updated) if self._checkpoint else updated
            yield row
    def checkpoint(self):return self._checkpoint.isoformat() if self._checkpoint else None
