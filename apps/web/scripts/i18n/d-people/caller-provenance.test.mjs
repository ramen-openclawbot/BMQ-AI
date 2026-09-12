import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

const paths = {
  shift: "src/components/attendance/ShiftPlannerGrid.tsx",
  migration: "src/components/settings/DataMigrationSettings.tsx",
  users: "src/hooks/useUserManagement.ts",
};
const read = (path) => fs.readFileSync(path, "utf8");
const parse = (path, source = read(path)) => ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const text = (node, tree) => node.getText(tree);

function assertActualCallerBoundaries(sources = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, read(path)]))) {
  const shift = parse(paths.shift, sources.shift);
  const shiftThrows = [];
  const shiftMutationFns = [];
  const walkShift = (node) => {
    if (ts.isPropertyAssignment(node) && text(node.name, shift) === "mutationFn") {
      shiftMutationFns.push(node);
      const walk = (child) => {
        if (ts.isThrowStatement(child)) shiftThrows.push(text(child.expression, shift));
        ts.forEachChild(child, walk);
      };
      ts.forEachChild(node.initializer, walk);
    }
    ts.forEachChild(node, walkShift);
  };
  walkShift(shift);
  assert.ok(shiftMutationFns.length >= 2, "extracted actual ShiftPlannerGrid mutationFn boundaries");
  assert.ok(shiftThrows.includes('new PeopleLocalError({ key: "unableToSaveShift" })'), "save permission caller throws an explicit reactive descriptor");
  assert.ok(shiftThrows.includes('new PeopleLocalError({ key: "thisDateIsInALockedPeriod" })'), "locked-period caller throws an explicit reactive descriptor");
  assert.ok(!shiftThrows.some((value) => /^new Error\(copy\./.test(value)), "no Error(copy.*) remains inside actual mutation callbacks");

  const migration = parse(paths.migration, sources.migration);
  const migrationThrows = [];
  const walkMigration = (node) => {
    if (ts.isThrowStatement(node)) migrationThrows.push(text(node.expression, migration));
    ts.forEachChild(node, walkMigration);
  };
  walkMigration(migration);
  assert.ok(migrationThrows.includes('new PeopleLocalError({ key: "unableToCreateTheExportFile" })'), "table export caller has an explicit local fallback");
  assert.ok(migrationThrows.includes('new PeopleLocalError({ key: "unableToCreateTheStorageManifest" })'), "manifest caller has an explicit local fallback");
  assert.ok(migrationThrows.includes('failure'), "ZIP caller throws its selected backend/local failure");
  assert.match(sources.migration, /let failure: Error = new PeopleLocalError\(\s*\{ key: "zipDownloadFailedHttp", values: \{ p0: resp\.status \} \},?\s*\)/, "ZIP HTTP fallback is an explicit reactive descriptor");
  assert.ok(!migrationThrows.some((value) => /^new Error\([^)]*pc\(/.test(value)), "migration callers do not freeze translated copy in Error");
  assert.ok(!sources.migration.includes('`${table}: ${error.message}`'), "table backend messages are no longer prefixed");

  const users = parse(paths.users, sources.users);
  const targetHooks = new Set(["useInviteUser", "useCancelInvitation"]);
  const callbackBodies = [];
  const walkUsers = (node, owner = null) => {
    let nextOwner = owner;
    if (ts.isFunctionDeclaration(node) && node.name && targetHooks.has(node.name.text)) nextOwner = node.name.text;
    if (nextOwner && ts.isPropertyAssignment(node) && ["mutationFn", "onSuccess", "onError"].includes(text(node.name, users))) callbackBodies.push(text(node.initializer, users));
    ts.forEachChild(node, (child) => walkUsers(child, nextOwner));
  };
  walkUsers(users);
  assert.ok(callbackBodies.length >= 6, "extracted actual invitation mutation/success/error boundaries");
  const callbacks = callbackBodies.join("\n");
  assert.doesNotMatch(callbacks, /showPeopleToast\([^,]+,\s*["'][^"']+["']/, "local toast titles are reactive nodes");
  assert.doesNotMatch(callbacks, /description:\s*(?:err\?\.message|data\?\.note)\s*\|\|/, "blank backend descriptions use localized reactive fallback");
  assert.doesNotMatch(callbacks, /["'](?:Đã|Lỗi|Vui lòng|User đã)/, "actual invitation boundaries contain no raw Vietnamese UI copy");
}

test("actual people mutation callers preserve backend provenance and reactive local copy", () => {
  assertActualCallerBoundaries();
});

test("caller contract kills Error(copy) and raw-Vietnamese mutations", () => {
  const originals = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, read(path)]));
  const errorCopy = { ...originals, shift: originals.shift.replace(/new PeopleLocalError\(\{ key: "unableToSaveShift" \}\)/, "new Error(copy.savedErr)") };
  assert.throws(() => assertActualCallerBoundaries(errorCopy), /explicit reactive descriptor|Error\(copy/);
  const rawVietnamese = { ...originals, users: originals.users.replace(/peopleToast\("invitationEmailSent"\)/, '"Đã gửi email mời"') };
  assert.throws(() => assertActualCallerBoundaries(rawVietnamese), /reactive nodes|raw Vietnamese/);
});
