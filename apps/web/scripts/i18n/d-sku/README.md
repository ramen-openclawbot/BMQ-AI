# d-sku local verification

Run from `apps/web`. All jobs are sequential and capped at `NODE_OPTIONS=--max-old-space-size=1024`.

`bash scripts/i18n/d-sku/run.sh` runs the contracts, literal guard, two browser suites on strict port 4307, closes its own server, then runs lint and separate baseline/current no-emit compilers and exact diagnostic parity. The wrapper was syntax-checked; its constituent commands were executed separately during implementation.

The fixture imports the real five pages, real nested components, real query hooks and material controller. Only the Supabase client and authentication backend are replaced with a closed in-memory fixture. Django API requests and invoice scanning are intercepted locally by Playwright. Google Fonts CSS is fulfilled with empty local CSS; no remote fonts are fetched. Unexpected external requests are aborted and fail the case. Unexpected backend tables, methods and RPCs throw and fail the case.

The fixture is synthetic staff authentication, not live authenticated production QA. One browser context runs at a time and closes after each case. `BMQ_PLAYWRIGHT` and `BMQ_CHROMIUM` override the existing runner installation paths. `BMQ_CASE` selects a debugging substring such as `index-vi-390-data`; leave it unset for full coverage.

Evidence is written to `/tmp/bmq-i18n-lanes/d-sku`. Main browser suite: 84 cases; dialog suite: 12 cases. Screenshots use the initial language in filenames; data cases deliberately switch to the opposite language before the final screenshot. Scan screenshots also show the opposite language after switching during scanning.

The TypeScript baseline snapshot remains read-only at `/tmp/bmq-i18n-lanes/baseline/apps/web`. The checker substitutes its source through a compiler host while resolving dependencies from the package cwd, because the baseline has no node_modules. Exit 1 for both compilers is expected for the existing 55 diagnostics; the parity script compares full messages, codes, files, duplicate counts and unchanged baseline line mappings. A compiler crash or mismatch is not a pass.

No build, commit, push, deploy or live write occurs. This lane shares `AddPaymentRequestDialog.tsx` with b-finance: parent must reconcile its separate dictionary implementation and rerun both lanes' relevant contracts and browser tests. See the detailed report for exact coverage and remaining integration risks.
