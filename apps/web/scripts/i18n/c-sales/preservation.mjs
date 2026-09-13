import assert from 'node:assert/strict';
import { auditCombinedSourceOwnership } from '../combined-source-audit.mjs';

const owned = new Set([
  'pages/MiniCrm.tsx', 'pages/FacebookMessengerInbox.tsx',
  'components/facebook-messenger/FacebookMessengerPanels.tsx',
  'i18n/salesCrm.ts', 'i18n/facebookMessenger.ts',
  ...['SalesPoQuickViewEditor', 'KnowledgeBaseProfileEditor', 'ParseTestWorkbench', 'KioskReportAdminPanel', 'DeliveryStaffAdminPanel', 'AttendanceGeofenceAdminPanel'].map(name => `components/mini-crm/${name}.tsx`),
]);
const result = auditCombinedSourceOwnership();
const currentLaneFiles = result.changedSource.filter(file => result.ownership[file].includes('c-sales'));
assert.ok(currentLaneFiles.length > 0, 'c-sales immutable variant must own current combined source');
assert.deepEqual(currentLaneFiles.filter(file => !owned.has(file)), [], 'c-sales ownership drifted outside its declared source scope');
console.log(`PASS: combined ownership covers all ${result.changedSource.length} source deltas; ${currentLaneFiles.length} current files retain c-sales ownership.`);
