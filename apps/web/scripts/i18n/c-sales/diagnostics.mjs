import fs from 'node:fs';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const result=spawnSync(process.execPath,[fileURLToPath(new URL('../typecheck.mjs',import.meta.url))],{encoding:'utf8',maxBuffer:10*1024*1024});
if(!result.stdout.trim()){console.error(result.stderr);process.exit(1)}
const current=JSON.parse(result.stdout),baseline=JSON.parse(fs.readFileSync(new URL('./baseline-diagnostics.json',import.meta.url),'utf8'));
fs.writeFileSync('/tmp/bmq-i18n-lanes/c-sales/typecheck-final.json',JSON.stringify(current,null,2));
assert.equal(result.status,1,'Expected baseline tsc diagnostics, not a process crash');assert.deepEqual(current.diagnostics,baseline);console.log(`PASS: exact ${current.errors}-diagnostic baseline preserved (file, line, code and full message).`);
