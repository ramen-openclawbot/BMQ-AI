import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from sme_platform.config import Settings
from sme_platform.datasets import build_dataset
from sme_platform.warehouse import Warehouse

parser = argparse.ArgumentParser(description='Export only reviewed anonymized planning examples; no warehouse auto-export')
parser.add_argument('--input', required=True, type=Path, help='Explicitly approved JSON array')
parser.add_argument('--version', required=True)
parser.add_argument('--split', choices=['training', 'validation', 'evaluation'], default='evaluation')
args = parser.parse_args()
print(json.dumps(build_dataset(Warehouse(Settings.from_env()), json.loads(args.input.read_text()), version=args.version, split=args.split)))
