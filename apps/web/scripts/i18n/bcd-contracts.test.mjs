import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { batchForPage, pageBatches } from './batches.mjs';
import { scan } from './check-literals.mjs';
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repo = path.resolve(web, '../..');
const read = f => fs.readFileSync(path.join(web, f), 'utf8');
const base = f => execFileSync('git', ['show', `eac7ee887ae44494b9187865fe9766b3ccf49e16:apps/web/${f}`], { cwd: repo, encoding: 'utf8' });
const tree = (f, s) => ts.createSourceFile(f, s, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const collect = (f, s, predicate) => { const t = tree(f, s), out = []; function walk(n) { if (predicate(n)) out.push(n.getText(t)); ts.forEachChild(n, walk); } walk(t); return out; };
const named = (f, s, name) => { const found = collect(f, s, n => (ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name?.getText() === name); assert.equal(found.length, 1, name); return found[0]; };
test('all dictionary modules have matching keys and interpolation parameters', async () => {
  for (const name of fs.readdirSync(path.join(web, 'src/i18n')).filter(f => f.endsWith('.ts'))) {
    const src = read(`src/i18n/${name}`);
    const sourceFile = tree(name, src);
    const dictionaries = sourceFile.statements.flatMap(statement => {
      if (!ts.isVariableStatement(statement)) return [];
      return statement.declarationList.declarations.filter(declaration => ts.isObjectLiteralExpression(declaration.initializer)
        && declaration.initializer.properties.some(property => property.name?.getText(sourceFile).replace(/["']/g, '') === 'vi')
        && declaration.initializer.properties.some(property => property.name?.getText(sourceFile).replace(/["']/g, '') === 'en'));
    });
    for (const declaration of dictionaries) {
      const dictionary = declaration.initializer;
      const localeObject = locale => {
        const property = dictionary.properties.find(item => item.name?.getText(sourceFile).replace(/["']/g, '') === locale);
        let initializer = ts.isPropertyAssignment(property) ? property.initializer : undefined;
        if (ts.isShorthandPropertyAssignment(property)) {
          initializer = sourceFile.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
            .find(item => item.name.getText(sourceFile) === property.name.getText(sourceFile))?.initializer;
        }
        assert.ok(ts.isObjectLiteralExpression(initializer), `${name}:${locale} dictionary must be a static object`);
        return new Map(initializer.properties.filter(ts.isPropertyAssignment).map(item => [item.name.getText(sourceFile).replace(/^["']|["']$/g, ''), item.initializer.getText(sourceFile)]));
      };
      const vi = localeObject('vi'), en = localeObject('en');
      assert.deepEqual([...vi.keys()].sort(), [...en.keys()].sort(), `${name}:${declaration.name.getText(sourceFile)}`);
      for (const key of vi.keys()) {
        assert.ok(vi.get(key).length > 2 && en.get(key).length > 2, `${name}.${key}`);
        const params = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
        assert.deepEqual(params(vi.get(key)), params(en.get(key)), `${name}.${key}`);
      }
    }
  }
});
test('each active staff page has one batch and /kho is excluded', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(repo, 'docs/i18n/staff-inventory.json'), 'utf8'));
  assert.equal(inventory.routes.some(r => r.path === '/kho'), false);
  for (const route of inventory.routes.filter(r => r.page)) assert.equal(route.scope, `Batch ${batchForPage(route.page)}`);
  const assigned = Object.values(pageBatches).flat(); assert.equal(new Set(assigned).size, assigned.length);
});
test('revenue daily review preserves computations, query, exact RPC payload, navigation and layout', () => {
  const f = 'src/pages/RevenueDailyReview.tsx';
  assert.match(read(f), /data-staff-i18n="revenue-daily-review-v1"/);
  for (const name of ['vnd', 'todayLocal', 'dateOnly', 'getDraftDate', 'sourceOptions', 'filteredDrafts', 'stats', 'paginatedDrafts', 'editFor', 'openDraftEvidence', 'openPoInboxEvidence', 'updateEdit']) assert.equal(named(f, read(f), name), named(f, base(f), name), name);
  for (const predicate of [n => ts.isCallExpression(n) && n.expression.getText() === 'db.rpc', n => ts.isPropertyAssignment(n) && n.name.getText() === 'queryFn', n => ts.isJsxAttribute(n) && n.name.getText() === 'className']) assert.deepEqual(collect(f, read(f), predicate), collect(f, base(f), predicate));
  // No copy has entered stored status/source comparisons or option values.
  const comparisons = n => ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(n.operatorToken.kind);
  assert.deepEqual(collect(f, read(f), comparisons), collect(f, base(f), comparisons));
  assert.deepEqual(scan(f, read(f)), []);
});
test('payables preserves accounting math, canonical search, mutations and layout', () => {
  const f = 'src/pages/PayablesManagement.tsx';
  assert.equal((read(f).match(/data-staff-i18n="payables-v1"/g) || []).length, 2);
  for (const name of ['normalizeSearch', 'formatCurrency', 'getRequestCode', 'isWarehouseReceiptPayable', 'getPayableSource', 'getProductNames', 'filteredPayables', 'stats', 'paginatedPayables', 'handleSearchChange', 'handlePaymentStatusFilterChange', 'handleApprovalStatusFilterChange', 'handleSourceFilterChange']) assert.equal(named(f, read(f), name), named(f, base(f), name), name);
  for (const predicate of [n => ts.isCallExpression(n) && n.expression.getText().endsWith('.mutateAsync'), n => ts.isJsxAttribute(n) && n.name.getText() === 'className']) assert.deepEqual(collect(f, read(f), predicate), collect(f, base(f), predicate));
  const candidates = scan(f, read(f));
  assert.deepEqual(candidates.map(c => [c.kind, c.text]), [['template', '`${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(amount)} đ`'], ['JSX', 'PO:'], ['JSX', 'PO:']], 'Only preserved VND formatting and canonical PO acronym prefixes remain');
});
