# Revenue staff i18n lane verification

Run from repository root. Run every command **sequentially**. Do not overlap typechecks or browser processes. Each browser script uses one context at a time and closes it before the next case. No full build is needed.

1. `node scripts/i18n/b-revenue/typecheck-parity.cjs` — starts separate sequential TypeScript workers with `apps/web` as the compiler working directory; compares every diagnostic against `/tmp/bmq-i18n-lanes/baseline` (override with `BMQ_I18N_BASELINE`). Must match the exact 55 baseline diagnostics.
2. `node scripts/i18n/b-revenue/contracts.cjs` — compares current actual page source against the pre-edit preservation snapshot. Never regenerate `preservation.json` to accept a failure.
3. `node --test scripts/i18n/b-revenue/dictionaries.test.cjs` — imports the real dictionaries via TypeScript transpilation; checks nested key/interpolation parity and actual page version markers.
4. `node scripts/i18n/b-revenue/guard.cjs` — scoped static literal guard. Every exception is individually documented. This is not runtime coverage.
5. From `apps/web`: `./node_modules/.bin/eslint src/pages/{RevenueManagementDashboard,RevenueSourceDetail,FinanceRevenueControl,RevenueDailyReview,PointRevenueManagement}.tsx src/i18n/{revenueDashboard,revenueSourceDetail,revenueParseControl,pointRevenue}.ts`
6. Start the fixture: `apps/web/node_modules/.bin/vite --config scripts/i18n/b-revenue/fixture/vite.config.mjs` (strict port 4302).
7. Run each browser script separately, waiting for completion: `node --test scripts/i18n/b-revenue/browser.mjs`, then `node --test scripts/i18n/b-revenue/actions.browser.mjs`, then `node --test scripts/i18n/b-revenue/editors.browser.mjs`, then `node --test scripts/i18n/b-revenue/daily.browser.mjs`.
8. Stop the fixture server you launched. Do not kill other lanes' servers.

The fixture imports all five production pages, their real inline editors, shared primitives, LanguageProvider and StaffUiProvider. Only AuthContext and the backend client are substituted. Function fetches are fulfilled explicitly by the action test; unknown requests are aborted and fail the suite. Google font requests are fulfilled with empty local CSS. No live database/auth/storage/orders/payments/messages are used. Tests capture canonical in-memory calls and fake export response metadata; they do not create real Sheets or export bytes.

Outputs go to `/tmp/bmq-i18n-lanes/b-revenue/`. Browser tests use the existing Playwright installation and Chromium paths from the earlier i18n fixtures. `inventory.cjs` is a read-only diagnostic inventory aid; it is not a test. The detailed integration evidence and limitations are in `report.md` under that output directory, distinct from `final.md`.
