# QTM / UNC image replication

A separate read-only scanner of `ceo_daily_closing_declarations` copies the
`extraction_meta.qtm_images` / `unc_images` arrays plus legacy
`qtm_slip_image_base64` / `unc_slip_image_base64` fields. Legacy copies remain
explicit references rather than being confused with unique images. This mirrors
exact **stored** image bytes (uploads may already have been compressed by BMQ),
not a claim to recover a camera original.

- SHA-256 addressed private files: `media/<tenant>/qtm-unc/objects/` on the approved SSD.
- DuckDB: `bronze.finance_media_current`, one row per declaration/source field/position.
- Same catalog exported to `media/<tenant>/qtm-unc/current.parquet`.
- Immutable reference manifests and retained old blobs preserve changed/removed
  evidence. No automatic source repair or deletion. `meta_finance_media_runs`
  and `logs/finance-media-latest.json` record successful scans separately from raw.
- Fields include declaration ID/date, QTM/UNC, source field/ordinal, source MD5,
  byte SHA-256, MIME, size, private relative path and observation time.
- No arbitrary URLs, OCR calls, LLM input, training exports, backup or public file API.
  Access is local service-account filesystem ownership (files0600/root0700);
  future web viewing must independently enforce owner authorization.

The scanner reads only fixed SQL in READ ONLY transactions using the existing
host-managed Supabase CLI login; it never reads/exports credentials. Only source
image fingerprints are interpolated after strict hex validation. Catalog reads
are bounded to10,000 references, individual text32MiB, responses16MiB and90s,
whole fetch600s. Failed backfills resume verified private cached files next run.
A re-read catalog must match before publication. This is a stable observation,
not CDC: edits made and reversed between observations are not reconstructable.
Publication is transactional; files precede catalog commit; Parquet/latest export
is derived and repaired on next success if interrupted. Failed query/invalid
image/changing source retains the previous catalog. No image failure blocks the
existing scalar scheduler.

Installation: run `scripts/install_finance_media.py --repo <clean committed repo>`,
then bootstrap the printed **user/UID Background** job. Default900seconds,
independent of `ai.vnagent.bmq-supabase-sync`. Validate actual job completion and
file hashes/Parquet parity, not merely an installed schedule. Requires awake Mac,
network and the UUID-checked BMQ SSD; never falls back to workspace storage.

Scope: this source only, including historical and future QTM/UNC images retained
there. Images solely in Drive or other tables are not covered. No new OCR or
amount reclassification, new chat capability or model training is implied.
