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
