# BMQ SME Data Platform V1

Local-first Python 3.12+, DuckDB, Parquet and a governed semantic API. Owner warehouse chat is enabled. See `BMQ_SOURCE_COVERAGE.md` for actual connected and pending sources; not all BMQ data is exposed. No shared VNAgent adapter or model setting changes.

## Storage and installation

Production data root: `/Volumes/Samsung SSD 9100 PRO 1TB Media/BMQ/sme-data-platform`.
Every production operation checks mounted volume UUID `98C046C3-3918-40D8-9F2F-A5F8382BBAA7`; no workspace fallback. Writes stop below 20% free. The root folder must be writable by the service account. Do not change ownership of the entire disk.

SSD folder and macOS removable-volume permissions were granted and real BMQ source snapshots are now synchronized. This release expands to 24 allowlisted projections and 14 governed metrics. Tests use explicit synthetic temporary directories. Backup is deferred by owner instruction; no new backup is scheduled.

From this directory:

```sh
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/init_warehouse.py
.venv/bin/python scripts/ingest_source.py --source sample --tenant sample
.venv/bin/python scripts/rebuild_silver.py
.venv/bin/python scripts/rebuild_gold.py
.venv/bin/python scripts/validate_data.py --tenant sample
PYTHONPATH=src .venv/bin/python -m sme_platform.cli query --tenant sample --dsl '{"metric":"revenue","time_range":{"start":"2026-09-01","end":"2026-09-30"}}'
```

Use an isolated `SME_DATA_ROOT` **on the verified SSD** for samples; never load sample revenue into the live BMQ tenant. CLI tenant is an operator choice; HTTP tenant is always resolved from authenticated server configuration. For the BMQ API tenant, use the Supabase project hostname, not the string `sample` or an arbitrary frontend input.

## Ingestion and data ownership

`raw → bronze Parquet → canonical Silver → Gold → semantic DSL`.
Raw source payloads are retained unchanged. Each batch has a source, entity, timestamp, hash and status. Replay does not duplicate records; stale updates do not replace newer ones. Failed validation preserves raw evidence and previous accepted data. Silver uses source mappings and canonical UUIDs; load referenced customers/products/locations before orders, then items/payments.

Supported local formats: CSV, JSON arrays and CLI JSONL. Browser/API imports are UTF-8 and <=1 MiB per file (whole request <=2 MiB). CLI batches <=32 MiB. Split larger exports. Real POS/CRM connector credentials and source-specific mappings are not bundled. Use `fixtures/` and `warehouse/schemas/canonical-v1.json` for the current schema.

Silver upserts incrementally by source identity and update timestamp. Gold refreshes dirty tenants only; full rebuild remains a recovery operation. Parquet is partitioned by tenant, with a current snapshot per entity/tenant. Date-partition delta materialization and 64–512 MiB compaction are future scale work, not claimed as implemented. Top-product/customer convenience APIs currently summarize all time, not a caller-selected period.

Canonical entities: customers, products, locations, orders, order_items, payments, inventory_movements, inventory_snapshots, suppliers, purchases, employees, expenses, conversations, messages. PII classification is stored with the canonical schema; no raw business files belong in Git.

### Business meaning

`config/semantic.yaml` is authoritative. Imported source net revenue is **not** the existing Supabase controlled-revenue ledger. Never reconcile them by assuming equivalence. Eligible order states, source tax/fees/refund semantics, currency, date and grain must be reviewed for each real connector. Currencies are kept separate; no FX conversion. UTC is used for timestamps and source/location timezone for reporting. Cancelled/refunded/deleted records are retained and handled by metric policy, not silently deleted. Missing data is not a zero balance.

DSL callers cannot name tables or execute SQL. The compiler accepts known metrics/dimensions, bounded dates/rows and parameterized filter values; execution uses read-only DuckDB and a timeout. Cache keys include tenant, authenticated permission/user scope, resolved dates, semantic version and data version.

## Business knowledge

```sh
.venv/bin/python scripts/ingest_document.py --file knowledge_seed/bmq-ai-overview.md --tenant YOUR_PROJECT_HOSTNAME --source bmq_app_docs --title 'BMQ AI overview'
```

Markdown/plain text only; no executable HTML, PDF OCR, image/audio transcription, or remote URL fetching. Each document has an immutable raw copy, content hash and stable chunk citations. Search normalizes Vietnamese accents and ranks lexical matches under a two-second budget; no embedding/cloud dependency. The initial knowledge note is a source-controlled summary of implemented behavior, **not a substitute for company SOPs**. Upload reviewed procedures to expand coverage.

Retrieved text is untrusted evidence. Luna cannot follow instructions inside documents to change permissions/tools. No relevant passage means an explicit insufficient-information reply. Financial answers come from semantic queries, not from document assertions. GBrain is an optional `KnowledgeMemoryProvider` interface and is not installed or required.

## Authenticated HTTP and chat

Configure `SME_SUPABASE_URL` and the existing **public/publishable** key through the host service manager. Never copy a service-role key or OpenAI secret into the browser. No credentials are included here. Startup fails closed when auth is unconfigured.

```sh
PYTHONPATH=src .venv/bin/python -m sme_platform.api
```

The service binds **127.0.0.1:8766**, disables access logs, re-verifies the forwarded Supabase bearer with `/auth/v1/user`, then checks owner role with caller RLS. It derives tenant from the fixed project hostname. Offline ingestion/query/knowledge CLI works independently; authenticated BMQ web access needs Supabase, and Luna needs the model provider.

Endpoints: `GET /v1/status`, `/v1/sources`, `/v1/semantic`; `POST /v1/ingest`, `/v1/documents`, `/v1/knowledge/search`, `/v1/query`. No public raw database, arbitrary SQL, raw customer download, deletion or training endpoint exists. Source list displays the latest 200 ingestion runs and latest 200 documents.

The Edge bridge must reach this loopback service through an explicitly configured HTTPS relay. No tunnel/service installation or public port is automatically enabled. `BMQ_WAREHOUSE_ENABLED` and server-only `BMQ_WAREHOUSE_URL` configure Edge; `VITE_BMQ_DATA_PLATFORM_ENABLED` gates source management. Backend first, then web activation. Default off preserves existing production behavior. A later shipping approval is required by the repo's AGENTS.md.

Chat routing: exact fast metrics need no model; semantic/agentic plans use only `gpt-5.6-luna`, bounded to four query calls and two model calls. Knowledge responses validate citations against returned chunk IDs. EN/VI follows the app, existing history text remains unchanged. Unavailable warehouse does not silently return unrelated Supabase totals.

## Evaluation and logs

Warehouse facts are not model memory. `datasets.py` exports only explicitly approved, anonymized planning examples; no automatic customer-data extraction or training. Version directories and manifests are immutable. Normalized question hashes cannot cross train/validation/evaluation splits. PII detection is a defense-in-depth heuristic, **not proof of anonymization**; human review remains required.

```sh
.venv/bin/python scripts/build_training_dataset.py --input fixtures/evaluation_examples.json --version v001 --split evaluation
```

Query logs contain metadata/hashes, not result rows. The interaction logger hashes query, response, plan and session text by default. It intentionally does not retain recoverable raw conversations or corrections without a separate retention policy.

The bundled evaluation examples are synthetic fixtures for reviewing the exporter, not approvals to train on real conversations. Do not copy their approval flags onto unreviewed data.

## Backup and recovery

```sh
.venv/bin/python scripts/backup.py --destination /Volumes/SECONDARY_DISK/BMQ-backups --require-secondary
.venv/bin/python scripts/backup.py --verify /Volumes/SECONDARY_DISK/BMQ-backups/BACKUP_ID
.venv/bin/python scripts/backup.py --restore /Volumes/SECONDARY_DISK/BMQ-backups/BACKUP_ID --destination '/Volumes/Samsung SSD 9100 PRO 1TB Media/BMQ/restored-check'
```

Use an actual provisioned secondary destination, not the literal example path. Backup requires an explicit destination outside the data root, captures a locked/checkpointed snapshot, hashes files, verifies DuckDB/knowledge integrity and restores only into a new directory. `--require-secondary` checks backing physical disks, not just different APFS volume IDs. Tests prove synthetic recovery; **an independent physical backup disk has not been configured or verified**. A same-disk test copy is not disaster recovery.

## Verification and rollout limits

Run `.venv/bin/python -m pytest -q`. The suite covers API→Python→DuckDB→Edge contracts using synthetic data and a fixture identity, not production user credentials. Frontend mobile/desktop fixtures validate owner upload, locale switching, size rejection and layout. A real Safari device, live owner login, real-data reconciliation and load-scale p95 latency are separate release checks.

This change does not auto-import operational BMQ data, apply DB migrations remotely, expose a warehouse port, enable the feature, modify Gateway or train a model. Complete storage permissions and secondary-backup provisioning before claiming a production-ready data service.
