import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const expected = new Map([
  ['src/pages/material-master/MaterialMasterAdmin.tsx', ['material-mutation', 'material-supplier-confirm', 'material-payment-sync', 'material-resolution']],
  ['src/pages/material-master/ControllerDashboard.tsx', ['material-controller-mode']],
  ['src/components/q7-material-inventory/Q7SignedMaterialIssueQueue.tsx', ['q7-check', 'q7-upload', 'q7-confirm']],
]);

test('all eight actual catch consumers dispatch their bounded errors directly to Sonner', () => {
  let count = 0;
  for (const [file, names] of expected) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const name of names) {
      assert.ok(source.includes(`productionErrorToast("${name}",`), `${file}: ${name}`);
      assert.ok(!source.includes(`toast(productionErrorToast("${name}",`), `${file}: ${name} must bypass the unmounted legacy store`);
      count += 1;
    }
  }
  assert.equal(count, 8);
});

test('the scoped dispatcher defines all eight boundary copy mappings', () => {
  const source = fs.readFileSync(path.join(root, 'src/i18n/ProductionErrorToast.tsx'), 'utf8');
  for (const names of expected.values()) {
    for (const name of names) assert.match(source, new RegExp(`"${name}"\\s*:`), name);
  }
  assert.match(source, /sonnerToast\.custom/);
  assert.doesNotMatch(source, /useToast|productionSonner/);
});
