// Strict release gate across every inventoried staff route and dependency.
// An unreviewed candidate is a failure, not an implicit non-UI exception.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { scan } from './check-literals.mjs';
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repo = path.resolve(web, '../..');
const inventory = JSON.parse(fs.readFileSync(path.join(repo, 'docs/i18n/staff-inventory.json'), 'utf8'));
const exceptions = JSON.parse(fs.readFileSync(path.join(web, 'scripts/i18n/literal-exceptions.json'), 'utf8'));
const key = e => JSON.stringify([e.file, e.kind, e.text]);
const allowed = new Map(exceptions.map(e => [key(e), e]));
const files = new Map();
for (const route of inventory.routes.filter(r => r.page)) for (const file of route.dependencies) {
  if (!files.has(file)) files.set(file, new Set()); files.get(file).add(route.scope);
}
for (const entry of inventory.components) if (!files.has(entry.file)) files.set(entry.file, new Set(['Shared staff UI']));
const counts = new Map(), candidates = [];
const evidence = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, batches]) => {
  const source = fs.readFileSync(path.join(web, file), 'utf8');
  const found = scan(file, source);
  found.forEach(c => { counts.set(key(c), (counts.get(key(c)) || 0) + 1); if (!allowed.has(key(c))) candidates.push(c); });
  return { file, batches: [...batches].sort(), sha256: createHash('sha256').update(source).digest('hex'), candidateCount: found.length, unreviewedCount: found.filter(c => !allowed.has(key(c))).length };
});
const staleExceptions = exceptions.filter(e => files.has(e.file) && (counts.get(key(e)) !== e.count || !e.reason));
const result = { kind: 'static literal release gate; does not establish runtime or exhaustive UI coverage', passed: candidates.length === 0 && staleExceptions.length === 0, counts: { files: files.size, routes: inventory.routes.filter(r => r.page).length, uniquePages: new Set(inventory.routes.filter(r => r.page).map(r => r.page)).size, unreviewedCandidates: candidates.length, staleExceptions: staleExceptions.length }, files: evidence, candidates, staleExceptions };
const output = process.env.BMQ_I18N_SCOPE_OUTPUT || '/tmp/bmq-i18n-bcd-qa/staff-scope.json';
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ passed: result.passed, counts: result.counts, evidence: output }, null, 2));
process.exitCode = result.passed ? 0 : 1;
