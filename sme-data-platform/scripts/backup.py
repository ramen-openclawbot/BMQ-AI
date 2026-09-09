import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from sme_platform.backup import create_backup, restore_backup, verify_backup
from sme_platform.config import Settings
from sme_platform.warehouse import Warehouse

parser = argparse.ArgumentParser(description='Back up immutable BMQ data to an explicit destination')
parser.add_argument('--destination', type=Path)
parser.add_argument('--verify', type=Path, help='Verify an existing backup')
parser.add_argument('--restore', type=Path, help='Restore an existing backup into a NEW --destination on the approved SSD')
parser.add_argument('--require-secondary', action='store_true', help='Require a separately verified physical disk')
args = parser.parse_args()
if args.verify:
    print(json.dumps(verify_backup(args.verify)))
elif args.restore and args.destination:
    print(restore_backup(args.restore, args.destination, settings=Settings(args.destination)))
elif args.destination:
    print(create_backup(Warehouse(Settings.from_env()), args.destination, require_secondary=args.require_secondary))
else:
    parser.error('Specify --destination, --verify BACKUP, or --restore BACKUP --destination NEW_PATH')
