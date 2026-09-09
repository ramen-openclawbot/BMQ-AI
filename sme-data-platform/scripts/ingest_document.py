import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from sme_platform.config import Settings
from sme_platform.knowledge import KnowledgeStore
from sme_platform.warehouse import Warehouse

parser = argparse.ArgumentParser(description='Import reviewed UTF-8 business knowledge; raw copy retained, cited local search')
parser.add_argument('--file', required=True, type=Path)
parser.add_argument('--tenant', required=True)
parser.add_argument('--source', default='business_docs')
parser.add_argument('--title', required=True)
args = parser.parse_args()
if args.file.stat().st_size > 1024 * 1024:
    parser.error('Document exceeds 1 MiB')
print(json.dumps(KnowledgeStore(Warehouse(Settings.from_env())).ingest(tenant_id=args.tenant, source=args.source, title=args.title,
    filename=args.file.name, content=args.file.read_text('utf-8'))))
