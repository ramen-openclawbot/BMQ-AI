import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseline = '/tmp/bmq-i18n-lanes/baseline/apps/web/src';
const laneWorktrees = '/home/ubuntu/projects';
const lanes = ['b-purchasing', 'b-finance', 'b-revenue', 'c-sales', 'c-warehouse', 'c-production', 'd-people', 'd-sku'];
const reconciledHashes = {
  // Documented origin/main deltas after baseline eac7ee8; each source path is pinned exactly, never blanket-waived.
  'components/agent/GlobalAgentChatWidget.tsx': 'ec498754c2c294cfde07f8df1051f125c88a3d23c1e6e33ae23bfe135c24f216',
  'lib/bmqAnalytics.test.ts': 'eca8e792ef9e06ad8a653bf31043fdb3b02f91e54beedc7cda9ddf21b3616f46',
  'lib/bmqAnalytics.ts': '88246a6f054c95d204518026b45a826d19ef7f44c77ad17646381d0c664a1008',
  'lib/bmqChatLocale.ts': 'c0eb7004e25ddaf63f9e519c21e6a2589f759c7ff9843a20788ed5993f9c77c3',
  'lib/vnagentProtocol.ts': '4ebaa87995502174bc0b7c571a28e7d5c90f02c86d9c92a9cf94992dd13d134b',
  // Approved VAT-only reconciliation: typed VAT is normalized for preview and submitted from Zod-validated numeric data.
  'components/dialogs/AddInvoiceDialog.tsx': '5f3f7ee41db865aadcc982ccd3e3e4a832deaf4acc7e743b14d1c390c54882ce',
  'components/dialogs/AddPaymentRequestDialog.tsx': 'dde4db7dd94e4c7cc9f20f0bdb20eec91d3ee66b456dc481aa76e0a931276890',
  // Reviewed procurement provenance reconciliation: backend errors remain verbatim; typed local descriptors still render through purchasingErrorMessage.
  'components/dialogs/GoodsReceiptDetailsDialog.tsx': '9a415212ce925611cf963608e59f35728c095c809511537bb12849fdd5cae09f',
  'components/settings/DataMigrationSettings.tsx': 'da73cf34f9dc8c16c10bb10e2af369dabc91f5272a2b1bbc2eee614c135ef857',
  'hooks/usePeopleCopy.ts': '1e9f63c93b5fade9eba3c21e89267e5a6dd9c72ac97d45c18e1d91eec4cc62f1',
  'hooks/useUserManagement.ts': '5f9f9008ca218f7ddb3ca7737774ea02c1e35ee0673ae06938fdaf339b14f037',
  'lib/session-errors.ts': '9641931690ad00e7200167bb10beaa289920135e64e5fb56113b65b6e6fcee29',
  'lib/supabase-helpers.ts': '447626798d061cc1c948f91338cc56d5d1098b8ff0e8aecbd3b68825c8352929',
};

function hash(file) {
  return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
}

function files(root, base = root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? files(full, base) : [path.relative(base, full)];
  });
}
function changed(left, right) {
  const names = new Set([...files(left), ...files(right)]);
  return [...names].filter(name => {
    const a = path.join(left, name), b = path.join(right, name);
    return !fs.existsSync(a) || !fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b));
  }).sort();
}

export function auditCombinedSourceOwnership() {
  const ownership = new Map();
  for (const lane of lanes) {
    const laneSource = path.join(laneWorktrees, `BMQ-AI-i18n-${lane}`, 'apps/web/src');
    assert.ok(fs.existsSync(laneSource), `immutable lane worktree missing: ${laneSource}`);
    for (const file of changed(baseline, laneSource)) {
      const owners = ownership.get(file) ?? [];
      owners.push(lane);
      ownership.set(file, owners);
    }
  }
  const changedSource = changed(baseline, path.join(web, 'src'));
  const unowned = changedSource.filter(file => !ownership.has(file) && !reconciledHashes[file]);
  assert.deepEqual(unowned, [], 'Every source delta from the original baseline must be owned by an immutable lane variant or an exact reviewed reconciliation');
  const content = Object.fromEntries(changedSource.map(file => {
    const currentHash = hash(path.join(web, 'src', file));
    const laneHashes = Object.fromEntries((ownership.get(file) ?? []).map(lane => [
      lane,
      hash(path.join(laneWorktrees, `BMQ-AI-i18n-${lane}`, 'apps/web/src', file)),
    ]));
    const exactLane = Object.entries(laneHashes).find(([, laneHash]) => laneHash === currentHash)?.[0] ?? null;
    const expectedReconciledHash = reconciledHashes[file] ?? null;
    assert.ok(
      exactLane || currentHash === expectedReconciledHash,
      `${file} content is neither an exact immutable owned-lane variant nor the reviewed reconciled hash`,
    );
    return [file, { currentHash, exactLane, expectedReconciledHash, laneHashes }];
  }));
  return {
    baseline,
    changedSource,
    ownership: Object.fromEntries(changedSource.map(file => [file, ownership.get(file)])),
    content,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = auditCombinedSourceOwnership();
  const output = '/tmp/bmq-i18n-lanes/combined-source-ownership.json';
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(`PASS: ${result.changedSource.length} changed source files all have immutable lane ownership or exact reviewed reconciliation hashes; ${output}`);
}
