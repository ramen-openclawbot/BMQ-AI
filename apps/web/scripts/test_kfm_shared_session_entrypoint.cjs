/* Offline regressions for fresh-session verification and exact-generation invalidation. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/kfm-portal-sync/index.ts'), 'utf8');
const start = source.indexOf('async function openVerifiedKfmSession(');
const end = source.indexOf('/** Only sanitized business identifiers', start);
assert(start >= 0 && end > start);
const code = ts.transpileModule(source.slice(start, end) + '\nexports.openVerifiedKfmSession = openVerifiedKfmSession;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
class KfmPortalError extends Error {
  constructor(step, status) { super('fixture error'); this.step = step; this.status = status; }
}
(async () => {
  let passed = 0;
  for (const status of [401, 403, 500]) {
    const invalidated = [];
    const error = new KfmPortalError('me', status);
    const exports = {};
    vm.runInNewContext(code, {
      exports, KfmPortalError, tripAdmin: () => ({}),
      createKfmPasswordLoginGuard: () => ({}),
      createKfmSharedSessionStore: () => ({ invalidateSharedSession: async generation => { invalidated.push(generation); return true; } }),
      openSessionWithLoginGuard: async () => ({ token: 'synthetic-token', sharedGeneration: 'published-generation' }),
      getMe: async () => { throw error; },
    });
    await assert.rejects(() => exports.openVerifiedKfmSession({}), e => e === error);
    assert.deepEqual(invalidated, status === 500 ? [] : ['published-generation']);
    console.log(`ok fresh session /me ${status}: exact-generation invalidation policy`);
    passed++;
  }
  console.log(`${passed} passed, 0 failed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
