import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const scoped = [
  "pages/AttendanceManagement.tsx",
  "pages/PayrollManagement.tsx",
  "pages/UserManagement.tsx",
  "components/attendance/ShiftPlannerGrid.tsx",
  "components/settings/DataMigrationSettings.tsx",
  "hooks/useUserManagement.ts",
];

test("d-people fixture matches AppInner Sonner-only renderer", () => {
  const fixture = read("scripts/i18n/d-people/main.tsx");
  assert.doesNotMatch(fixture, /components\/ui\/toaster/);
  assert.doesNotMatch(fixture, /<Toaster\s*\/>/);
  assert.match(fixture, /<Sonner\s*\/>/);
});

test("scoped notifications dispatch only through the context-reactive Sonner renderer", () => {
  for (const path of scoped) {
    const source = read(`src/${path}`);
    assert.doesNotMatch(source, /@\/hooks\/use-toast/, path);
    assert.doesNotMatch(source, /from ["']sonner["']/, path);
    assert.match(source, /showPeopleToast\(/, path);
    assert.doesNotMatch(source, /toast\s*\(\s*\{/, path);
  }
  const renderer = read("src/hooks/usePeopleCopy.ts");
  assert.match(renderer, /sonnerToast\.custom/);
  assert.match(renderer, /data-people-toast-description/);
});

test("Drive local errors use descriptors that distinguish them from backend text", () => {
  const source = read("src/hooks/useDriveSync.ts");
  assert.match(source, /new PeopleLocalError\(\{ key: "syncInProgressPleaseWait" \}\)/);
  assert.match(source, /new PeopleLocalError\(\{ key: "yourSessionHasExpired" \}\)/);
  assert.match(source, /new PeopleLocalError\(\{ key: "syncFailed" \}\)/);
  assert.match(source, /peopleErrorDescription\(error, "syncFailed"\)/);
});
