import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { batchForPage, excludedPaths } from './batches.mjs';
import { createHash } from 'node:crypto';
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repo = path.resolve(web, '../..');
const out = path.join(repo, 'docs/i18n');
const qaPath = process.env.BMQ_I18N_QA || '/tmp/bmq-i18n-a-qa/browser-results.json';
const qa = fs.existsSync(qaPath) ? JSON.parse(fs.readFileSync(qaPath, 'utf8')) : { cases: [] };
const additionalQaPaths = ['/tmp/bmq-i18n-bcd-qa/revenue-daily-browser.json', '/tmp/bmq-i18n-bcd-qa/payables-browser.json'];
const additionalQa = additionalQaPaths.filter(p => fs.existsSync(p)).map(p => ({ path: p, ...JSON.parse(fs.readFileSync(p, 'utf8')) }));
const runtimeCases = [...qa.cases, ...additionalQa.flatMap(result => result.cases || [])];
const base = 'eac7ee887ae44494b9187865fe9766b3ccf49e16';
const read = file => fs.readFileSync(path.join(web, file), 'utf8');
const tree = file => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const resolve = (from, value) => {
  const p = value.startsWith('@/') ? `src/${value.slice(2)}` : value.startsWith('.') ? path.posix.join(path.posix.dirname(from), value) : null;
  return p && [p, `${p}.tsx`, `${p}.ts`, `${p}/index.tsx`, `${p}/index.ts`].find(f => fs.existsSync(path.join(web, f)) && fs.statSync(path.join(web, f)).isFile());
};
function imports(file) {
  const result = new Map();
  const t = tree(file);
  function walk(n) {
    if (ts.isImportDeclaration(n)) {
      const f = resolve(file, n.moduleSpecifier.text);
      if (f && n.importClause) {
        if (n.importClause.name) result.set(n.importClause.name.text, f);
        n.importClause.namedBindings?.elements?.forEach(e => result.set(e.name.text, f));
      }
    }
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const match = n.initializer.getText(t).match(/lazy\(\(\) => import\("([^"]+)"\)\)/);
      if (match) result.set(n.name.getText(t), resolve(file, match[1]));
    }
    ts.forEachChild(n, walk);
  }
  walk(t); return result;
}
const neutral = /^(?:SKU|LC(?: %)?|VNAgent|EN|VN|N\/A|v|BMQ|VND|PR|PO|CSV|PDF|Excel)$/;
function evidence(file, source = read(file)) {
  const t = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const literals = [];
  function walk(n) {
    let value, kind;
    if (ts.isJsxText(n)) { value = n.getText(t).trim().replace(/\s+/g, ' '); kind = 'JSX text'; }
    else if (ts.isStringLiteral(n) && ts.isJsxAttribute(n.parent) && /^(title|placeholder|aria-label|alt)$/.test(n.parent.name.getText(t))) { value = n.text; kind = 'UI attribute'; }
    else if (ts.isStringLiteral(n) && /[À-ỹ]/.test(n.text)) { value = n.text; kind = 'Vietnamese literal: requires semantic review (may be stored/export data)'; }
    if (value && /[A-Za-zÀ-ỹ]/.test(value) && !neutral.test(value)) literals.push({ line: t.getLineAndCharacterOfPosition(n.getStart(t)).line + 1, kind, text: value.slice(0, 240) });
    ts.forEachChild(n, walk);
  }
  walk(t);
  const localized = /useLanguage|useStaffUi|\.messages\b|language\s*===/.test(source);
  return { localized, literalCount: literals.length, evidence: literals.slice(0, 12), omittedEvidenceCount: Math.max(0, literals.length - 12), status: localized ? 'partial' : 'untranslated' };
}
const router = 'src/components/AppRoutes.tsx', routeImports = imports(router), rt = tree(router);
const routes = [];
function walkRoutes(n) {
  if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(rt) === 'Route') {
    const attrs = n.attributes.properties;
    const p = attrs.find(a => a.name?.getText(rt) === 'path')?.initializer;
    const element = attrs.find(a => a.name?.getText(rt) === 'element')?.initializer;
    if (p && ts.isStringLiteral(p) && element) {
      const markup = element.getText(rt);
      const names = [...markup.matchAll(/<([A-Z]\w*)\b/g)].map(m => m[1]);
      const page = names.map(name => routeImports.get(name)).find(f => f?.startsWith('src/pages/') || f?.startsWith('src/warehouse/pages/'));
      const redirect = markup.match(/<Navigate to="([^"]+)"/)?.[1];
      if (p.text !== '*' && !p.text.startsWith('/dealer') && !p.text.startsWith('/promotion') && !excludedPaths.includes(p.text) && !page?.includes('Dealer')) {
        routes.push({ path: p.text, page: page || null, redirect: redirect || null, routerLine: rt.getLineAndCharacterOfPosition(n.getStart(rt)).line + 1, guard: markup.match(/moduleKey="([^"]+)"/)?.[1] || (markup.includes('OwnerRoute') ? 'owner' : 'authenticated'), routeEvidence: 'Verified declaration in AppRoutes.tsx; not a claim of live permission/navigation QA' });
      }
    }
  }
  ts.forEachChild(n, walkRoutes);
}
walkRoutes(rt);
const cache = new Map();
function dependencies(file, seen = new Set()) {
  if (seen.has(file)) return seen; seen.add(file);
  const im = imports(file), src = read(file);
  for (const [name, dependency] of im) {
    if (/^src\/(components|hooks|lib)\//.test(dependency) && !dependency.startsWith('src/components/ui/') && !dependency.includes('integrations/') && (src.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length > 1) dependencies(dependency, seen);
    else if (dependency.startsWith('src/components/ui/')) seen.add(dependency);
  }
  return seen;
}
function component(file) {
  if (cache.has(file)) return cache.get(file);
  const after = evidence(file);
  let before;
  try { before = evidence(file, execFileSync('git', ['show', `${base}:apps/web/${file}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] })); } catch { before = { status: 'new', evidence: [], literalCount: 0 }; }
  const runtime = runtimeCases.filter(c => c.files?.includes(file) && c.passed).map(c => c.id);
  if (file.startsWith('src/components/ui/') && after.literalCount === 0) after.status = 'complete';
  if (file.startsWith('src/components/ui/') && before.literalCount === 0) before.status = 'complete';
  const entry = { file, kind: /Dialog|dialog|Sheet|sheet/.test(file) ? 'dialog' : file.includes('/hooks/') || file.includes('/lib/') ? 'data/helper' : 'component', before, after, runtime: { kind: runtime.length ? 'actual-component synthetic browser fixture' : 'not runtime verified', cases: runtime } };
  if (runtime.length && qa.completedFiles?.includes(file) && !file.endsWith('GlobalAgentChatWidget.tsx')) entry.after.status = 'complete';
  entry.statusMeaning = entry.after.status === 'complete' ? (runtime.length ? 'Batch A copy audit + regression checks + listed synthetic runtime cases; not exhaustive live QA' : 'No owned untranslated UI literal found in this primitive; source-only, not a runtime or child-content claim') : 'Conservative source classification; complete runtime/localization coverage not established';
  entry.sourceSha256 = createHash('sha256').update(read(file)).digest('hex');
  entry.runtime.evidencePaths = [qaPath, ...additionalQaPaths].filter(p => fs.existsSync(p) && JSON.parse(fs.readFileSync(p, 'utf8')).cases?.some(c => c.files?.includes(file) && c.passed));
  cache.set(file, entry); return entry;
}
for (const route of routes) {
  if (!route.page) { route.classification = 'redirect'; continue; }
  route.dependencies = [...dependencies(route.page)].sort();
  route.dependencies.forEach(component);
  const c = component(route.page);
  route.before = c.before.status; route.after = c.after.status;
  route.runtime = c.runtime;
  route.scope = `Batch ${batchForPage(route.page)}`;
}
const shared = ['src/components/layout/AppLayout.tsx','src/components/layout/Header.tsx','src/components/layout/Sidebar.tsx','src/components/AppRoutes.tsx','src/components/OwnerRoute.tsx','src/components/SessionRecoveryOverlay.tsx','src/components/ErrorBoundary.tsx','src/components/agent/GlobalAgentChatWidget.tsx'];
shared.forEach(f => [...dependencies(f)].filter(p => !p.startsWith('src/pages/')).forEach(component));
const components = [...cache.values()].sort((a,b) => a.file.localeCompare(b.file));
const dialogs = [];
for (const component of components) {
  const t = tree(component.file);
  function walk(n) {
    if (ts.isJsxElement(n) && ['Dialog','AlertDialog','Sheet','Drawer'].includes(n.openingElement.tagName.getText(t))) {
      const opening = n.openingElement;
      let owner = n.parent;
      while (owner && !ts.isFunctionDeclaration(owner) && !ts.isVariableDeclaration(owner)) owner = owner.parent;
      const ownerName = owner?.name?.getText(t) || 'inline';
      const titleMatch = n.getText(t).match(/<(?:DialogTitle|AlertDialogTitle|SheetTitle|DrawerTitle)[^>]*>([\s\S]*?)<\/(?:DialogTitle|AlertDialogTitle|SheetTitle|DrawerTitle)>/);
      const line = t.getLineAndCharacterOfPosition(opening.getStart(t)).line + 1;
      const deferred = component.file.endsWith('GlobalAgentChatWidget.tsx') && ownerName !== 'GlobalAgentChatWidget';
      dialogs.push({ id: `${component.file}:${ownerName}:${line}`, file: component.file, owner: ownerName, line,
        primitive: opening.tagName.getText(t), openEvidence: opening.attributes.getText(t),
        titleEvidence: titleMatch?.[1].trim().replace(/\s+/g,' ') || 'Title supplied by children or not statically identifiable',
        classification: component.after.status,
        runtime: deferred ? { kind: 'not runtime verified — deferred finance flow', cases: [] } : component.runtime,
        evidenceLimit: 'Declared dialog and owning component evidence. Runtime cases only cover states explicitly exercised by the harness, not every possible dialog branch.',
      });
    }
    ts.forEachChild(n, walk);
  }
  walk(t);
}
const countBy = (list, fn) => list.reduce((acc,v) => {const k=fn(v);acc[k]=(acc[k]||0)+1;return acc;}, {});
const result = {
  baseCommit: base, method: 'TypeScript AST router declarations and local import graph, plus explicitly enumerated synthetic browser cases. Static scanning does not prove rendered coverage.',
  definitions: { complete: 'Reviewed Batch A UI copy and listed fixture cases pass; remaining data literals have explicit exceptions', partial: 'Some localization exists; unresolved copy or untested coverage remains', untranslated: 'No localization mechanism found in this file; semantic review still needed', 'data/helper': 'Import dependency, not necessarily rendered UI; classification is heuristic evidence only' },
  exclusions: ['Dealer host dathang.banhmique.vn and /dealer/*','Kiosk host baocao.banhmique.vn and /kho','Public auth, trace and recovery screens'],
  coverageNotes: ['Batch assignment is scope ownership, never a completion claim.', 'Batch A review fixes and revenue card runtime evidence are documented in /tmp/bmq-i18n-a-review-fixes.md; the original Batch A browser evidence below remains separately identified.', 'B/C/D work is in progress. Unlisted states and dependencies have no runtime proof.'],
  runtimeEvidence: { originalBatchA: qaPath, additionalFixtures: additionalQaPaths, cases: runtimeCases, limitation: 'Synthetic actual-component fixtures only; no live verification. A page case does not imply coverage of all imported dialogs.' },
  counts: { staffRouteDeclarations: routes.length, pageRoutes: routes.filter(r=>r.page).length, redirects: routes.filter(r=>r.redirect).length, uniquePages: new Set(routes.map(r=>r.page).filter(Boolean)).size, dependencyFiles: components.length, dialogFiles: components.filter(c=>c.kind==='dialog').length, inlineDialogDeclarations: dialogs.length, before: countBy(components,c=>c.before.status), after: countBy(components,c=>c.after.status), runtimeVerifiedFiles: components.filter(c=>c.runtime.cases.length).length },
  routes, shared, components, dialogs,
};
result.counts.byBatch = countBy(routes.filter(r => r.page), r => r.scope);
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'staff-inventory.json'),JSON.stringify(result,null,2)+'\n');
const md = `# Staff i18n inventory — A/B/C/D scope and evidence\n\nBase: \`${base}\`. Generated by \`node scripts/i18n/inventory.mjs\`.\n\n${result.method}\n\n**Do not read this table as live verification.** “Complete” is limited to the audited UI copy and enumerated synthetic fixture cases. Other classifications are conservative source evidence. Data/helper entries are dependencies, not page coverage. The JSON contains per-file literal evidence with line numbers, before/after status and runtime case IDs.\n\n## Counts\n\n\`\`\`json\n${JSON.stringify(result.counts,null,2)}\n\`\`\`\n\n## Active staff routes\n\n| Route | Router line | Page / redirect | Before → after | Runtime evidence |\n|---|---:|---|---|---|\n` + routes.map(r=>`| ${r.path} | ${r.routerLine} | ${r.page||'→ '+r.redirect} | ${r.before||'redirect'} → ${r.after||'redirect'} | ${r.runtime?.cases.join(', ') || 'Not runtime verified'} |`).join('\n') + '\n\n## Boundaries\n\n' + [...result.exclusions, ...result.coverageNotes].map(s=>'- '+s).join('\n') + '\n\n## Components and dialogs\n\n| File | Kind | Before → after | Evidence / runtime |\n|---|---|---|---|\n' + components.map(c=>`| ${c.file} | ${c.kind} | ${c.before.status} → ${c.after.status} | ${c.after.literalCount} literal candidates (not all UI); ${c.runtime.cases.join(', ') || 'source only'} |`).join('\n')+'\n';
fs.writeFileSync(path.join(out,'staff-inventory.md'),md + '\n## Inline dialog declarations\n\nTitles/open-state expressions are source evidence. Runtime coverage remains limited to named cases.\n\n| Owner / file:line | Primitive | Title evidence | Classification |\n|---|---|---|---|\n' + dialogs.map(d=>`| ${d.owner} · ${d.file}:${d.line} | ${d.primitive} | ${d.titleEvidence.replaceAll('|','\\|')} | ${d.classification} |`).join('\n') + '\n');console.log(JSON.stringify(result.counts,null,2));
