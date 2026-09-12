import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

async function loadErrors() {
  const outfile = `/tmp/c-production-errors-${process.pid}-${Date.now()}.mjs`;
  buildSync({ entryPoints: ['src/i18n/productionErrors.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

test('explicit descriptors resolve in the current language without reclassifying backend text', async () => {
  const errors = await loadErrors();
  const { productionCopy } = await import(pathToFileURL(path.join(root, 'src/i18n/production.ts')).href).catch(async () => {
    const outfile = `/tmp/c-production-copy-${process.pid}-${Date.now()}.mjs`;
    buildSync({ entryPoints: ['src/i18n/production.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    return import(pathToFileURL(outfile).href);
  });
  const local = errors.localProductionError('materialError0');
  assert.equal(errors.productionErrorText(local, productionCopy.vi), productionCopy.vi.materialError0);
  assert.equal(errors.productionErrorText(local, productionCopy.en), productionCopy.en.materialError0);
  const collision = new Error(productionCopy.vi.materialError0);
  assert.equal(errors.productionErrorText(collision, productionCopy.en), productionCopy.vi.materialError0);
  assert.equal(errors.productionErrorText(new Error('backend opaque'), productionCopy.vi), 'backend opaque');
  assert.equal(errors.productionErrorText({ nope: true }, productionCopy.en, productionCopy.en.m122), productionCopy.en.m122);
});

test('nested descriptor values resolve at display time', async () => {
  const errors = await loadErrors();
  const outfile = `/tmp/c-production-copy-nested-${process.pid}-${Date.now()}.mjs`;
  buildSync({ entryPoints: ['src/i18n/production.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { productionCopy } = await import(pathToFileURL(outfile).href);
  const nested = errors.localProductionError('blockerList', {
    lines: [errors.productionErrorDescriptor('blockerLine', { name: 'Bột', required: '2', unit: 'kg', available: '1' })],
  });
  assert.match(errors.productionErrorText(nested, productionCopy.vi), /Bột/);
  assert.match(errors.productionErrorText(nested, productionCopy.en), /Bột/);
  assert.notEqual(errors.productionErrorText(nested, productionCopy.vi), errors.productionErrorText(nested, productionCopy.en));
});

test('actual Material Master throw and catch boundaries preserve descriptors', () => {
  const hook = read('src/hooks/useMaterialMaster.ts');
  const admin = read('src/pages/material-master/MaterialMasterAdmin.tsx');
  assert.match(hook, /localProductionError\("materialError0"\)/);
  assert.match(hook, /localProductionError\("materialRpcStatus", \{ status:/);
  assert.doesNotMatch(hook, /throw new Error\((?:"|`)(?:Vui lòng|RPC|Cần|Không có|Request|Định lượng|Hao hụt)/);
  assert.match(admin, /throw localProductionError\("m117"\)/);
  assert.doesNotMatch(admin, /materialErrorText\(/);
  assert.equal((admin.match(/productionErrorToast\("material-/g) || []).length, 4);
  assert.doesNotMatch(admin, /toast\(productionErrorToast\(/);
});

test('actual Q7 async boundaries keep local descriptors until reactive display', () => {
  const q7 = read('src/components/q7-material-inventory/Q7SignedMaterialIssueQueue.tsx');
  assert.doesNotMatch(q7, /throw new Error\(c\.m(?:49[1-9]|50\d|51\d)/);
  assert.match(q7, /localProductionError\("m491"\)/);
  assert.doesNotMatch(q7, /currentCopy|useRef/);
  assert.equal((q7.match(/productionErrorToast\("q7-/g) || []).length, 3);
  assert.doesNotMatch(q7, /toast\(productionErrorToast\(/);
  assert.doesNotMatch(q7, /sanitizeQ7MaterialIssueConfirmationRpcError/);
  assert.match(q7, /productionErrorDescriptor\("blockerLine"/);
  assert.match(q7, /productionErrorDescriptor\("blockerList"/);
});
