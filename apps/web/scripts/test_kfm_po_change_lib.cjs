/* Pure lib + static migration checks. No network, no database. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

function load(file) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    { exports, require() { throw Error('Unexpected import'); }, URL, URLSearchParams, Request, Response, Headers, AbortSignal, TextEncoder, Uint8Array, setTimeout, clearTimeout },
  );
  return exports;
}

const lib = load('src/lib/kfmPoChange.ts');
const revision = 'a'.repeat(64);
const line = { sku: 'SP001', productName: 'BMQ Bread', unit: 'CÁI', oldQty: 10, newQty: 12 };
const valid = {
  orderId: 11,
  code: 'PO-TEST',
  inboxId: 'inbox-11',
  deliveryDate: '2026-11-04',
  revision,
  lines: [line],
  oldTotalQty: 10,
  newTotalQty: 12,
  productionOrders: [{ id: 'order-11', productionNumber: 'SX-1', status: 'planned' }],
  blocked: false,
};

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('ok', name);
}

test('parseKfmPoChanges accepts a complete change', () => {
  const parsed = lib.parseKfmPoChanges([valid]);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), [valid]);
});

test('parseKfmPoChanges rejects a non-array value', () => {
  assert.deepEqual(Array.from(lib.parseKfmPoChanges(null)), []);
  assert.deepEqual(Array.from(lib.parseKfmPoChanges({ ...valid })), []);
  assert.deepEqual(Array.from(lib.parseKfmPoChanges('nope')), []);
});

test('parseKfmPoChanges drops every malformed element', () => {
  const bad = [
    null,
    { ...valid, orderId: 0 },
    { ...valid, orderId: '11' },
    { ...valid, orderId: 1.5 },
    { ...valid, code: '   ' },
    { ...valid, inboxId: '' },
    { ...valid, deliveryDate: '2026-02-30' },
    { ...valid, deliveryDate: '2026-11-04junk' },
    { ...valid, revision: 'a'.repeat(63) },
    { ...valid, revision: 'z'.repeat(64) },
    { ...valid, oldTotalQty: -1 },
    { ...valid, newTotalQty: 'lots' },
    { ...valid, blocked: 'false' },
    { ...valid, lines: 'nope' },
    { ...valid, lines: [{ ...line, sku: '' }] },
    { ...valid, lines: [{ ...line, oldQty: -1 }] },
    { ...valid, lines: [{ ...line, newQty: null }] },
    { ...valid, lines: [{ ...line, productName: 42 }] },
    { ...valid, lines: [{ ...line, unit: null }] },
    { ...valid, productionOrders: {} },
    { ...valid, productionOrders: [{ id: '', productionNumber: 'SX-1', status: 'planned' }] },
    { ...valid, productionOrders: [{ id: 'order-11', productionNumber: '', status: 'planned' }] },
    { ...valid, productionOrders: [{ id: 'order-11', productionNumber: 'SX-1', status: '' }] },
  ];
  const parsed = lib.parseKfmPoChanges([valid, ...bad, { ...valid, orderId: 12, lines: [] }]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].orderId, 11);
  assert.equal(parsed[1].orderId, 12);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed[1].lines)), []);
});

test('summarizeKfmPoChange counts increases, decreases, additions and removals', () => {
  const summary = lib.summarizeKfmPoChange({
    ...valid,
    lines: [
      { sku: 'A', productName: 'A', unit: 'Cái', oldQty: 10, newQty: 12 },
      { sku: 'B', productName: 'B', unit: 'Cái', oldQty: 10, newQty: 8 },
      { sku: 'C', productName: 'C', unit: 'Cái', oldQty: 0, newQty: 5 },
      { sku: 'D', productName: 'D', unit: 'Cái', oldQty: 5, newQty: 0 },
      { sku: 'E', productName: 'E', unit: 'Cái', oldQty: 4, newQty: 4 },
    ],
    oldTotalQty: 29,
    newTotalQty: 29,
  });
  assert.deepEqual({ ...summary }, { increased: 1, decreased: 1, added: 1, removed: 1, deltaTotal: 0 });
});

test('summarizeKfmPoChange reports the total delta', () => {
  const summary = lib.summarizeKfmPoChange({ ...valid, oldTotalQty: 10, newTotalQty: 12.5 });
  assert.deepEqual({ ...summary }, { increased: 1, decreased: 0, added: 0, removed: 0, deltaTotal: 2.5 });
});

test('migration is definer-only and grants execute to service_role', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261106140000_kfm_po_change_sync.sql'), 'utf8');
  assert.match(sql, /security\s+definer/i);
  assert.match(sql, /set\s+search_path\s*=\s*public\s*,\s*pg_temp/i);
  assert.match(sql, /revoke\s+all\s+on\s+function\s+public\.kfm_apply_po_change\s*\(\s*text\s*,\s*jsonb\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated/i);
  assert.match(sql, /grant\s+execute\s+on\s+function\s+public\.kfm_apply_po_change\s*\(\s*text\s*,\s*jsonb\s*\)\s+to\s+service_role/i);
  assert.match(sql, /kfm_revisions/i);
});

test('rollback smoke covers updated, noop, blocked, history and ACL', () => {
  const sql = fs.readFileSync(path.join(root, 'scripts/smoke_kfm_po_change_sync_rollback.sql'), 'utf8');
  assert.match(sql, /begin\s*;/i);
  assert.match(sql, /rollback\s*;/i);
  assert.match(sql, /SMOKE_ALL_PASSED/);
  assert.match(sql, /'status'\)\s*=\s*'updated'/i);
  assert.match(sql, /'status'\)\s*=\s*'noop'/i);
  assert.match(sql, /'status'\)\s*=\s*'blocked'/i);
  assert.match(sql, /kfm_revisions/i);
  assert.match(sql, /has_function_privilege\('anon'/i);
});

console.log(`PASS ${passed} KFM PO change lib/sql tests`);
