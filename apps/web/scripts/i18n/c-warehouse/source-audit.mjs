import assert from 'node:assert/strict';
import { scope, addedSource } from './scope.mjs';
import { auditCombinedSourceOwnership } from '../combined-source-audit.mjs';

const declared = new Set([...scope, ...addedSource]);
const result = auditCombinedSourceOwnership();
const currentLaneFiles = result.changedSource.filter(file => result.ownership[file].includes('c-warehouse'));
assert.ok(currentLaneFiles.length > 0, 'c-warehouse immutable variant must own current combined source');
assert.deepEqual(currentLaneFiles.filter(file => !declared.has(file)), [], 'c-warehouse ownership drifted outside its declared source scope');
console.log(`PASS: combined ownership covers all ${result.changedSource.length} source deltas; ${currentLaneFiles.length} current files retain c-warehouse ownership.`);
