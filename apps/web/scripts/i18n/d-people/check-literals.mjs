import fs from 'node:fs';import assert from 'node:assert/strict';import {files} from './scope.mjs';import {parse,candidates,text} from './inventory.mjs';
const exceptions=JSON.parse(fs.readFileSync(new URL('./literal-exceptions.json',import.meta.url),'utf8'));
const actual=[];for(const file of files){const tree=parse(file);for(const node of candidates(tree))actual.push({file,text:text(node)});}
const counts=list=>{const out={};for(const x of list){const key=x.file+'|'+x.text;out[key]=(out[key]||0)+1;}return out;};
assert.deepEqual(counts(actual),Object.fromEntries(exceptions.map(x=>{assert.ok(x.reason.length>15);return [x.file+'|'+x.text,x.count];})), 'New or stale untranslated literals; review individual non-UI exceptions');
console.log(`PASS: scoped literal guard; ${exceptions.length} individually documented exceptions. Existing bilingual module metadata is recognized; inactive invitation hooks are outside this lane.`);
