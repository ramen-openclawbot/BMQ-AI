# b-finance isolated i18n verification

Run from the repository root. No build, live credentials, DB/auth/storage writes, or external messages are required. The fixture imports the actual pages/dialogs/hooks; only Supabase and AuthContext are replaced. The real LanguageProvider and StaffUiProvider are used. All backend calls are captured in memory or intercepted by Playwright. Fonts are fulfilled with empty CSS; other nonlocal requests are aborted and fail the suite.

Run verification sequentially to avoid exhausting memory:

1. `node --test scripts/i18n/b-finance/contracts.test.cjs`
2. `node scripts/i18n/b-finance/literals.cjs`
3. Start `node apps/web/node_modules/vite/bin/vite.js --config scripts/i18n/b-finance/fixture/vite.config.mjs` (port 4301).
4. `node --test scripts/i18n/b-finance/browser.mjs` (one context at a time, each closed in `finally`; Chromium closed by the after hook).
5. `node scripts/i18n/b-finance/visuals.mjs` captures 16 stable EN/VI mobile/desktop views and checks document overflow. Then stop that Vite process before typechecking.
6. `NODE_OPTIONS=--max-old-space-size=2048 node apps/web/scripts/i18n/typecheck.mjs > /tmp/bmq-i18n-lanes/b-finance/typecheck-final.json` (expected exit 1 for the existing 55 errors).
7. `node scripts/i18n/b-finance/diagnostic-parity.cjs` (exact diagnostic multiset; line shifts reported separately).
8. From `apps/web`, run scoped ESLint on the changed pages, dialogs, hook and new dictionaries listed in the lane report.

Playwright/Chromium paths match this runner's existing i18n fixtures. Browser results, screenshots and logs are written to `/tmp/bmq-i18n-lanes/b-finance`. `--test-name-pattern` can select individual cases during debugging. Snapshot filenames name the **initial** language; scenarios that switch language end in the other language.

`literal-exceptions.json` lists exact non-UI business strings, protocol matching sentinels, persisted notes/names and currency notation with occurrence counts. The literal guard also traverses the active payment hooks and the finance query hooks. The scan is not runtime coverage. `inventory.cjs` is a read-only AST inventory utility, not a test.

The contract tests compare layout class expressions, canonical financial payload objects, generated procurement business text, and export function bytes to `/tmp/bmq-i18n-lanes/baseline`. No existing test has been weakened or replaced. See the separate detailed report for individual runtime states and explicit gaps.
