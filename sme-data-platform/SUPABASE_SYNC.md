# Current release — R7 raw-v10

74 scalar projections; see the R7 section below. Earlier release notes retain historical counts and versions. No change to existing chat metrics.

# R3 finance connection — raw-v6

35 explicit projections: adds payments, invoices, invoice_items, payment_request_items, customer_debt_period_adjustments, ceo_daily_closing_declarations, daily_reconciliations, finance_daily_close_runs and finance_payment_auto_approval_matches. Only the reviewed scalar allowlist is copied. Four additional same-snapshot amount checksums validate transport, not accounting correctness. Missing opening/collections remain missing, legacy discrepancies remain exact, close attempts are not payments. No change to chat metrics, source financial facts, backup or training. Detailed accounting reconciliation and balance queries are deferred by the owner until the full connection is complete. Preserve user/501 Background900sec runtime.

## R2 update — 2026-09-10

Current projection is v5, 26 allowlisted tables. v4 selling_price scalar and historical route_customer_name retained. v5 adds cancellation events (6 fields) and customer confirmation status (7 fields), excluding contacts/session/payload/errors. Missing cancellation event never overrides dealer_orders.status; notification sent never means approved/paid. Host scheduler remains user/501 Background every900seconds; preserve this host configuration when upgrading. The original v1 implementation notes below describe the initial16-table rollout, not current coverage.

## Expansion 2026-09-09

Version bmq-supabase-raw-v2 adds revenue source-document status, payment requests/allocations, production orders/items, goods receipts, dispatch records and contract file metadata. Total 24 explicit table projections. No contract file URLs, contents, auth secrets or source mutations. Existing 900-second schedule must use the same committed release as the semantic API; old manifests missing required tables fail closed. See BMQ_SOURCE_COVERAGE.md for the complete source inventory.

# Supabase raw sync — BMQ v1

Owner approved Supabase ingestion on 2026-09-09. Backup remains deferred.

## Scope

Fixed project `cxntbdvfsikwmitapony`; 16 explicitly projected public tables in
`src/sme_platform/supabase_sync.py`: CRM customers/prices, SKUs, dealer orders/items,
kiosk locations/products/channels/reports/channel rows/inventory rows, suppliers,
purchase orders/items, inventory items and controlled revenue ledger lines.

No OTP, sessions, authentication tables, contact snapshots, arbitrary JSON blobs,
contract URLs, bank details or staff phone/salary are exported. These are **raw
projections**, not full database backups. Source business IDs and test/cancelled
states remain unchanged. Names included in business rows are owner-only data.

## Extraction and publication

The installed Supabase CLI uses its existing host-managed login. The connector
never reads a token, accepts arbitrary SQL, or changes source data. It verifies
the linked project, then executes a fixed SELECT in a repeatable-read READ ONLY
transaction with a 30-second statement budget and bounded output. The CLI account
has broader management privileges; READ ONLY is enforced per extraction, not a
claim that the stored CLI account itself is a least-privilege replication role.

For this small V1 source, each scan reads a consistent snapshot of all 16 tables.
Only new/changed rows create local revisions. This avoids missing child row edits
without updated_at and hard deletes. It is **not CDC**, and changes made and
reversed between scans cannot be recovered. A production read-only CDC/replication
identity is a future scaling option, not installed by this release.

Counts and exact decimal totals for six amount fields are reconciled in the same
source snapshot before publication. These totals include cancelled/test rows and
are technical checksums, **not reportable business revenue**. No cross-table totals
are added together. A table exceeding 50,000 rows, 128 MiB output, schema mismatch,
invalid key or failed reconciliation aborts publication; previous data stays live.

- Raw: `raw/<project>.supabase.co/supabase/bmq-supabase-raw-v1/<table>/<sha256>.jsonl`
- Current source rows: DuckDB `bronze.supabase_current`, also Parquet at
  `bronze/<project>.supabase.co/supabase/current.parquet`.
- Revisions: DuckDB `bronze.supabase_changes`, with source table, row ID, operation
  and observation time. An absence is labelled `absent_in_source_snapshot`, never
  asserted to be the exact deletion time. Old immutable raw files remain.
- Successful manifests: DuckDB `meta_supabase_sync_runs`; latest summary at
  `logs/supabase-sync-latest.json`.
- Runtime stdout: counts/status only; raw rows and credentials are never logged.

All BMQ data is restricted to the approved SSD UUID with no workspace fallback.
Raw writes precede a single transactional publication of all tables. Parquet and
latest-manifest exports are derived after commit and repaired on the next scan
if interrupted. A failure before commit may leave unreferenced immutable raw files
but never a partial current dataset. Original row JSON preserves decimal lexemes.

## Operation

```sh
python -m sme_platform.supabase_sync --workdir /path/to/linked/project
```

The host LaunchAgent runs at load and every 900 seconds; the machine must be awake,
SSD mounted and network/auth available. Launchd does not run overlapping instances
of the job; manual overlap is serialized during publication and stale source
snapshots are refused. Source failures produce a nonzero exit status and never
clear the previous successful snapshot. Check both launchd LastExitStatus and the
manifest's source_observed_at; an old success manifest is not proof of freshness.

Disable the dedicated `ai.vnagent.bmq-supabase-sync` LaunchAgent to stop automatic
reads. This does not change Supabase or delete warehouse data. No backup scheduling
or warehouse chat activation is included.

## Semantic and training boundary

This release lands raw + bronze. It deliberately does not map an order to paid
revenue, infer Hotline revenue from notes, combine controlled revenue and orders,
or treat current inventory as historical stock. Silver/Gold metric contracts and
owner chat integration remain separate work. No records are sent to Luna or
included in a training dataset by the sync.

## NPP routing projection v3
Revenue ledger replication additionally extracts only route_customer_id and route_customer_name scalars using the same raw_payload alias precedence as NppDebtManagement. The complete raw_payload is not copied. Deploy the new sync runtime before enabling npp_receivable; old snapshots lacking routing must fail closed. Existing table count and exact-money reconciliation remain unchanged.

## R5 Q7 / kitchen projection v8

R5 allowlist: 52 tables. Adds kitchen_inventory_items/movements/monthly_closings,
q7_inventory_openings/movements, q7_material_issue_material_mappings, and
kfm_daily_material_issues/items/sources. See BMQ_SOURCE_COVERAGE.md for semantic limits. These are scalar
evidence projections only; no source repairs, stock formula or new chat metric.
Null opening/counts, unit spelling, precision, status and source relationships
remain unchanged. Repeating a snapshot creates no duplicate current rows.

## R6 Material Master / COGS / actual issue projection v9

R6 allowlist: 65 tables. Adds sku_cogs_materials/aliases, material_scoped_aliases,
material_supplier_products, material_price_history, material_unit_conversions,
sku_formulations, sku_cogs_versions/version_formulations, production_material_issues,
production_material_issue_items/checks/check_actuals. Full read-only snapshots
retain revisions, effective dates, precision, nulls, approval and posting states.
No name-based joining, conversion or cost/stock recomputation is performed.

Checks and actual quantities are linked evidence, not a new certification engine:
no signed files, actor identities or arbitrary JSON are ingested. Check status
alone does not prove matching signatures/file completeness; posted_at and actual
Q7 movements remain distinct. Full historical product/material JSON snapshots
are excluded; no claim to reconstruct total historical COGS. R3 review remains
deferred, and raw-only tables do not widen LLM/owner query exposure.

## R7 PO / production shifts / dispatch evidence (raw v10)

R7 allowlist: 74 tables. Nine new scalar-only tables: customer_po_inbox,
sales_po_documents, revenue_drafts, production_shifts, production_shift_items,
production_location_sku_settings, warehouse_dispatch_items,
po_dispatch_revenue_confirmations and po_dispatch_revenue_confirmation_lines.
PO approval/posted flags, draft approval, production actuals, dispatch state and
temporary/confirmed VAT-inclusive amounts remain distinct source evidence.
No additional revenue ledger rows or new chat metrics are generated.
Missing links/prices and source precision/statuses are retained, not defaulted.
SKU text in confirmation lines is not a SKU UUID. Source line keys retain lineage.
Email identifiers/body/contacts, assigned staff/actors, notes and arbitrary JSON
(including items/production_items/raw_payload) are excluded. Header-only PO
transport is not complete PO line replication. No source mutation, HR,
stock/revenue certification or automatic historical repair. R3 review deferred.

## R8 QA inspection evidence (raw v11)

R8 allowlist: 76 tables. Two new scalar-only tables: qa_inspections and
qa_inspection_items. Inspection status, case number, production order/shift
links, SKU, inspected/approved/rejected quantities and unit are replicated as
transport evidence only. An approved or rejected QA quantity is never converted
into a warehouse receipt, stock movement or posted revenue; QA approval does not
imply goods were received. Inspector names, product photo arrays and free-text
notes/rejection reasons are excluded. Header-only inspection transport is not
line-level replication of every inspection. No source mutation, HR, stock or
revenue certification, and no new chat metrics. R3 review remains deferred.
## R9 posted revenue, cost and label/material evidence (raw v12)

R8 allowlist: 76 tables. Twenty new scalar-only tables bring the allowlist to 96:
monthly revenue parse runs/lines and daily parse logs (A), cost categories, alias
mappings, classification rules and line classifications plus other kitchen costs
(B), and QA label checks, material issue events, material resolution requests,
supplier aliases/scan templates, kitchen import batches/rows and product label
specs (C). These are transport evidence: a parsed revenue line is not an
independently certified ledger posting, a classified cost line is not a settled
payable or final COGS, and a label check or material resolution request is not a
stock receipt. Actor/staff identifiers, free-text notes/reasons, OCR text,
JSON/array payloads, image and document URLs are excluded. No source mutation,
HR, backup, training, model or Gateway change. R3 accounting review remains
deferred.
