"""Exact diagnostic multiset comparison, mapping current lines to unchanged baseline lines."""
import collections
import difflib
import json
from pathlib import Path

out = Path('/tmp/bmq-i18n-lanes/d-sku')
baseline = Path('/tmp/bmq-i18n-lanes/baseline/apps/web')
a = json.loads((out / 'types-base.json').read_text())
b = json.loads((out / 'types-current.json').read_text())
line_maps = {}

def key(d, current=False):
    line = d['line']
    if current and d['file'] and line is not None:
        file = d['file']
        if file not in line_maps:
            old = (baseline / file).read_text().splitlines()
            new = Path(file).read_text().splitlines()
            mapping = {}
            for block in difflib.SequenceMatcher(a=old, b=new, autojunk=False).get_matching_blocks():
                for i in range(block.size):
                    mapping[block.b + i + 1] = block.a + i + 1
            line_maps[file] = mapping
        assert line in line_maps[file], f'Unmapped diagnostic on changed line: {d}'
        line = line_maps[file][line]
    return d['file'], line, d['code'], d['message']

old = collections.Counter(key(d) for d in a['diagnostics'])
new = collections.Counter(key(d, True) for d in b['diagnostics'])
result = {'passed': old == new, 'baseline': a['errors'], 'current': b['errors'],
          'comparison': 'Exact multiset: file + mapped unchanged baseline line + TS code + full message, including duplicates.',
          'additions': list((new-old).elements()), 'removals': list((old-new).elements())}
(out / 'diagnostic-parity.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
assert result['passed'], result
print(json.dumps(result, ensure_ascii=False))
