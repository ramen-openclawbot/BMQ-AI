import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

function assertSessionErrorContract() {
  const helper = read("src/lib/supabase-helpers.ts");
  const errors = read("src/lib/session-errors.ts");
  const people = read("src/hooks/usePeopleCopy.ts");
  const users = read("src/hooks/useUserManagement.ts");
  const migration = read("src/components/settings/DataMigrationSettings.tsx");

  assert.match(errors, /export class SessionExpiredError extends Error/);
  assert.match(helper, /export \{ SessionExpiredError \} from "@\/lib\/session-errors"/);
  assert.match(helper, /throw new SessionExpiredError\(\)/);
  assert.doesNotMatch(helper, /Phiên đăng nhập đã hết hạn/);
  assert.match(people, /error instanceof SessionExpiredError/);
  assert.match(people, /peopleToast\("sessionExpiredRelogin"\)/);
  assert.match(users, /peopleSupabaseErrorDescription\(err, "pleaseTryAgain"\)/);
  assert.match(migration, /peopleSupabaseErrorDescription\(error, "unableToCreateTheStorageManifest"\)/);
  assert.match(migration, /peopleSupabaseErrorDescription\(error, "unableToExportTheStorageZip"\)/);
}

test("typed helper session expiry is mapped only at People UI boundaries", () => {
  assertSessionErrorContract();
});

test("backend text collision remains verbatim rather than becoming a local descriptor", () => {
  const people = read("src/hooks/usePeopleCopy.ts");
  assert.match(people, /return peopleErrorDescription\(error, fallbackKey\)/);
  assert.match(people, /typeof error\?\.message === "string" && error\.message\.trim\(\)/);
});
