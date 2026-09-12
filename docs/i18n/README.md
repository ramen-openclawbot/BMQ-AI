# Local i18n inventory and Batch A

This slice localizes staff navigation/common UI and the three active SKU routes (`/sku-costs/dashboard`, `/sku-costs/analysis`, `/sku-costs/management`). It reuses `LanguageContext`; existing flat `t` keys remain compatible. Module copy is available through `messages.staff` and `messages.skuCosts`. `StaffUiProvider` scopes dialog/sheet/pagination copy to staff so dealer/kiosk defaults stay unchanged.

The exact Sales group remains **Bán Hàng và Tiếp Thị** / **Sale & Marketing**. The existing `data-header-language="en-vi-v1"` behavior stays intact. The SKU roots add `data-i18n-batch="staff-sku-a-v1"` and retain their approved light-theme markers.

## Inventory and evidence

- [Staff inventory](staff-inventory.md): verified router declarations, source classifications and explicit runtime case IDs.
- [Machine-readable inventory](staff-inventory.json): before/after evidence, local dependencies and dialogs. Literal counts include candidates requiring semantic review, not a count of proven UI defects. Evidence samples are capped at 12 per file; total and omitted counts are retained.
- [Production base evidence](production-base.json): unauthenticated public HTML/asset GETs before editing, base SHA, asset hashes and markers. No deployment credentials were used. This verifies public markers, not a privileged deployment-source/SHA attestation.
- [Verification results](verification.json): programmatic counts, test outcomes and review paths.
- The full local report, raw outputs, synthetic export/payload examples and screenshots are under `/tmp/bmq-i18n-a-result.md` and `/tmp/bmq-i18n-a-qa/`.

**Static scanning is not runtime verification.** “Complete” for an audited Batch A file is bounded by the named synthetic test cases. A copy-free UI primitive may be source-complete without any runtime claim about its children. Business pages in other batches remain inventory-only.

## Preserved contracts

Names, SKU/material codes, notes, stored units/categories/statuses, COGS version audit reasons, request prompts, API payloads, permission decisions, VND calculations, and Vietnamese date formatting rules are unchanged. Analysis source/warning values are localized only when rendered; exports keep their canonical values and headers. Native date/month controls still follow browser rendering; their stored values and app date calculations do not depend on the language toggle.

Image and save validation errors retain message keys, so changing language while a dialog is open updates them. Errors near an action use one persistent inline message rather than a duplicated toast description. Unknown load/upload/save failures use localized fallback copy rather than showing arbitrary backend text. Read errors previously appearing as empty lists now have explicit localized error states.

## Local verification (no build)

Dependencies use the existing `apps/web/node_modules` symlink; no packages or lockfiles were changed. Run from `apps/web`:

```sh
node --test scripts/i18n/contracts.test.mjs
node scripts/i18n/check-literals.mjs
python3 scripts/test_sku_cost_light_theme.py
node scripts/test_header_language.mjs
```

Start the isolated dev fixture (never the real app with production integrations):

```sh
node node_modules/vite/bin/vite.js --config scripts/i18n/fixture/vite.config.mjs
```

Then, in another terminal:

```sh
node scripts/i18n/browser.mjs
node scripts/i18n/inventory.mjs
```

The fixture is at `http://127.0.0.1:4196/sku-costs/dashboard?role=staff`. Other review routes are `/sku-costs/analysis?role=staff` and `/sku-costs/management?role=staff`. Omitting `role=staff` enables the synthetic owner chat. `fixture=empty`, `error`, `loading`, `upload-error`, `save-error`, `unresolved` and `zero-cost` select synthetic scenarios. `deny=suppliers`, `auth-timeout=1`, `recovery=1`, and `crash=1` exercise common fallbacks.

The browser harness requires the existing Playwright installation under `/home/ubuntu/bmq-payment-preview/node_modules/playwright` and the cached Chromium binary. `BMQ_PLAYWRIGHT`, `BMQ_CHROMIUM`, and `BMQ_I18N_ARTIFACTS` can override these local tooling locations.

The fixture mounts actual components and router guards, mocks Supabase before import (including the management mount-time snapshot RPC), stubs VNAgent fetch/WebSocket calls, and blocks all unhandled non-local requests. Google Fonts CSS is fulfilled locally with system-font fallback. Screenshots therefore verify responsive structure and UI text, not exact production typography. An extra fixture toaster exposes the existing management toast store; the production root's separate Sonner/toast wiring is not changed by this slice.

Open dialogs intentionally make the header inert. The harness uses the actual header for normal switching/reload, and a fixture-only setter on the real `LanguageContext` to verify translation updates while a modal remains open.

## Literal exceptions and limitations

[Exact literal exceptions](../../apps/web/scripts/i18n/literal-exceptions.json) have per-file, per-kind, per-text occurrence counts and reasons. The guard rejects new candidates and stale/count-changing exceptions. It checks JSX copy, accessible attributes, Vietnamese literals/templates and direct error messages; runtime text checks complement it. Language-neutral abbreviations/symbols and canonical business/export values are intentional exceptions. The scan is not a general proof that all possible computed text is translated.

The shared navigation's Drive import dialog belongs to the PO execution workflow and is deferred. The revenue daily card embedded in global chat now has EN/VI UI copy and actual mocked browser coverage as part of the approved local review fixes. Its server/user text, revenue actions, owner gates and payloads remain canonical. The original inventory and verification JSON predate these fixes; use the review report below for the updated card evidence. Unused legacy SKU scan/widget handlers have no active rendered entry point; they are not claimed as browser-tested flows. `ActualLaborCostPanel` is not an active dependency of these three routes. The four legacy SKU subroutes are inventoried, not silently treated as Batch A.

No live authenticated staff session, live RLS/storage permission test, Safari/WebKit run, production build, commit, push, deployment, DB write or auth write was performed. Full no-emit typechecking has pre-existing failures; `scripts/i18n/typecheck.mjs --base` substitutes the base source in memory, allowing exact diagnostic comparison without modifying another worktree.

## Local review fixes

The final review fixes cover exact level-2 material interpolation, storage-safe error fallback language selection, and the shared chat revenue card. ErrorBoundary preserves Vietnamese on dealer and kiosk hosts, `/dealer`, `/kho`, `/auth`, `/trace`, `/recover` and the existing `recover=1` bypass; staff fallback still follows the persisted language. Only fallback copy changes, not route permissions or portal implementations.

**Intentional formatting exception:** hardcoded `vi-VN` date/number formatting, VND display/calculations, and canonical CSV bytes/headers remain unchanged under the approved plan. These are not untranslated-UI blockers.

Run the extra actual-component regressions against the same isolated fixture:

```sh
node --test scripts/i18n/review-fixes.browser.mjs
```

Detailed review report: `/tmp/bmq-i18n-a-review-fixes.md`. New raw results: `/tmp/bmq-i18n-a-review-qa/`. The prior Batch A report/results remain intact. All evidence is local and mocked; no production build or shipping action is authorized or performed.
