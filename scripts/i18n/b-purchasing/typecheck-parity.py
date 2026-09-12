"""No emit/build. Require the exact baseline diagnostic multiset, mapped to baseline lines."""
import collections, difflib, json, os, pathlib, subprocess
root = pathlib.Path(__file__).resolve().parents[3]
output = pathlib.Path('/tmp/bmq-i18n-lanes/b-purchasing')
baseline_root = pathlib.Path(os.environ.get('BMQ_I18N_BASELINE', '/tmp/bmq-i18n-lanes/baseline'))
run = subprocess.run(['node', 'apps/web/scripts/i18n/typecheck.mjs'], cwd=root, capture_output=True, text=True)
(output / 'typecheck-final.json').write_text(run.stdout)
if run.stderr:
    (output / 'typecheck-stderr.txt').write_text(run.stderr)
current = json.loads(run.stdout)
baseline = json.loads(pathlib.Path(__file__).with_name('baseline-diagnostics.json').read_text())
assert current['noEmit'] is True and baseline['errors'] == 55
maps = {}
def normalize(d):
    name = d['file']
    if name and name not in maps:
        before = (baseline_root / 'apps/web' / name).read_text().splitlines()
        after = (root / 'apps/web' / name).read_text().splitlines()
        mapping = {}
        for block in difflib.SequenceMatcher(a=before, b=after, autojunk=False).get_matching_blocks():
            for i in range(block.size):
                mapping[block.b+i+1] = block.a+i+1
        maps[name] = mapping
    return (name, maps[name].get(d['line'], 'UNMAPPED') if name else d['line'], d['code'], d['message'])
expected = collections.Counter((d['file'], d['line'], d['code'], d['message']) for d in baseline['diagnostics'])
actual = collections.Counter(normalize(d) for d in current['diagnostics'])
result = {'baselineErrors': baseline['errors'], 'currentErrors': current['errors'], 'exactDiagnosticParity': expected == actual, 'added': list((actual-expected).elements()), 'removed': list((expected-actual).elements()), 'normalization': 'Exact unchanged source-line mapping through difflib; unmatched positions fail.'}
(output / 'typecheck-parity.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps(result, ensure_ascii=False, indent=2))
assert expected == actual, 'TypeScript diagnostic set changed'
