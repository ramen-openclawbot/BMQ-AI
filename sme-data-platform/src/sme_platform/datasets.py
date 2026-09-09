"""Explicitly approved, immutable evaluation/training exports, never raw warehouse facts."""
import hashlib
import json
import re
import shutil
import uuid
from datetime import datetime, timezone

from .config import safe_name, safe_path

SPLITS = {'training', 'validation', 'evaluation'}
FIELDS = {'question', 'expected_intent', 'expected_tools', 'expected_metrics',
          'expected_answer_constraints', 'category', 'approved', 'anonymized'}


def build_dataset(warehouse, records, *, version: str, split: str = 'evaluation'):
    safe_name(version)
    if split not in SPLITS or not isinstance(records, list) or len(records) > 10000:
        raise ValueError('Invalid split or record count')
    exported, fingerprints = [], []
    for record in records:
        if not isinstance(record, dict) or set(record) - FIELDS or record.get('approved') is not True or record.get('anonymized') is not True:
            raise ValueError('Every record needs explicit approval and anonymization; raw results are prohibited')
        if not isinstance(record.get('question'), str) or not record['question'].strip():
            raise ValueError('Question required')
        clean = {k: v for k, v in record.items() if k not in {'approved', 'anonymized'}}
        text = json.dumps(clean, ensure_ascii=False, sort_keys=True)
        if len(text) > 16000 or re.search(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+?\d[\s().-]?){9,}', text):
            raise ValueError('Possible PII or oversized record; review/redact before export')
        # Same normalized question may not cross train/eval boundaries even with different labels.
        fingerprint = hashlib.sha256(' '.join(record['question'].lower().split()).encode()).hexdigest()
        if fingerprint in fingerprints:
            raise ValueError('Duplicate question')
        fingerprints.append(fingerprint)
        exported.append(text)
    with warehouse.lock():
        warehouse.settings.validate_storage(write=True)
        root = safe_path(warehouse.settings.data_root, 'datasets')
        for other in SPLITS - {split}:
            for manifest in safe_path(root, other).glob('*/manifest.json'):
                safe_path(root, manifest.relative_to(root))
                if set(json.loads(manifest.read_text()).get('question_hashes', [])) & set(fingerprints):
                    raise ValueError('Training/evaluation leakage: question exists in another split')
        target = safe_path(root, split, version)
        if target.exists():
            raise ValueError('Dataset versions are immutable')
        target.parent.mkdir(parents=True, exist_ok=True)
        staging = root / f'.dataset-{uuid.uuid4().hex}'
        staging.mkdir(mode=0o700)
        try:
            payload = ('\n'.join(exported) + ('\n' if exported else '')).encode()
            manifest = {'dataset_name': 'agent_query_planning', 'version': version, 'split': split,
                        'created_at': datetime.now(timezone.utc).isoformat(), 'schema_version': '1.0',
                        'record_count': len(records), 'source': 'human_approved_anonymized_examples',
                        'sha256': hashlib.sha256(payload).hexdigest(), 'question_hashes': fingerprints}
            (staging / 'data.jsonl').write_bytes(payload)
            (staging / 'manifest.json').write_text(json.dumps(manifest, indent=2))
            staging.rename(target)
            with warehouse.connect() as conn:
                conn.execute('INSERT INTO meta_dataset_versions VALUES (?, now(), ?)',
                             [f'{split}/{version}', json.dumps(manifest, sort_keys=True)])
            return manifest
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise


def log_interaction(warehouse, *, tenant_id: str, event: dict):
    """Record metadata and hashes only. Never persist raw query/answer or returned PII."""
    safe_name(tenant_id)
    permitted = {'interaction_id', 'session_id', 'intent', 'query_plan', 'tool_calls', 'query_dsl',
                 'execution_time_ms', 'result_metadata', 'model_name', 'prompt_version',
                 'user_feedback', 'human_corrected_answer', 'user_query', 'response'}
    if set(event) - permitted:
        raise ValueError('Unknown interaction metadata')
    private = {'user_query', 'response', 'human_corrected_answer', 'query_plan', 'query_dsl', 'tool_calls', 'user_feedback'}
    result = {'created_at': datetime.now(timezone.utc).isoformat(), 'tenant_id': tenant_id}
    for key, value in event.items():
        if key in private or key in {'session_id', 'result_metadata'}:
            result[key + '_hash'] = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
        elif key == 'execution_time_ms':
            if type(value) not in {int, float} or value < 0:
                raise ValueError('Invalid timing')
            result[key] = value
        else:
            # Bounded tags; freeform strings do not belong in diagnostic logs.
            if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,100}', value):
                raise ValueError('Invalid metadata tag')
            result[key] = value
    with warehouse.lock():
        warehouse.settings.validate_storage(write=True)
        folder = safe_path(warehouse.settings.data_root, 'logs', 'interactions', tenant_id)
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        with safe_path(folder, f'{datetime.now(timezone.utc).date()}.jsonl').open('a') as handle:
            handle.write(json.dumps(result, sort_keys=True) + '\n')
    return result
