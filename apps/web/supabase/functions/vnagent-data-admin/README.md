# vnagent-data-admin

Owner-only HTTP endpoint behind the VNAgent data-assets admin page
(`/data-admin` on BMQ hosts; `admin.banhmique.vn` primary, `admin.vnagent.ai`
alias).

- Feature flag: `VNAGENT_DATA_ADMIN_ENABLED === "true"` (default off, fails closed).
- Auth: caller bearer token is verified, then `user_roles` is read under the
  caller's own RLS; the `owner` role is required. The handler re-checks the role.
- No service-role client: dataset reads/writes use the caller-scoped Supabase
  client, so RLS (owner-only) is the final authority.
- CORS allow-list (exact match, no suffix/prefix): `admin.banhmique.vn`,
  `admin.vnagent.ai`, `ai.banhmique.vn`, local dev origins.
- Language: **English by default**. With no `language` body field and no
  Vietnamese `Accept-Language`, error messages are English. A caller can still
  opt into Vietnamese with `language: "vi"` or `Accept-Language: vi`. The
  generated Markdown export is always English. Captured question/answer/evidence
  content is returned verbatim and is never translated.

## Actions (POST JSON `{ action, language?, ... }`)

| Action | Body | Result |
| --- | --- | --- |
| `overview` | — | `{ status, overview }` real dataset metrics (stages, growth, reviewed denominator, unknown) |
| `assets` | `stage?, source_kind?, evaluation_status?, search?, limit 1..100, offset` | `{ status, assets, total, filters }` |
| `asset` | `asset_id` | `{ status, asset }` or 404 |
| `contribute` | `question, source_kind (contributor\|synthetic), source_designation (manual\|llm_generated), expected_intent?, expected_filters?, provenance?, snapshot_at?` | `{ status: created\|duplicate, asset, duplicate }`; dedupe by normalized question + source kind |
| `transition` | `asset_id, expected_version, to_stage, reason?, verified?` | `{ status, asset }`; Gold requires `verified { intent, conditions, evidence[] }`; `409 version_conflict` on stale version |
| `jev` | `limit 1..200` | `{ status, events }` bounded route telemetry |
| `export` | `stage?, source_kind?, from?, to?, limit 1..200` | `{ status, markdown, count, truncated, filters }` escaped, permission-checked |

Errors: `{ error, code }` with stable codes
(`forbidden`, `version_conflict`, `gold_intent_required`, `gold_conditions_required`,
`gold_evidence_required`, `invalid_transition`, `store_unavailable`, `rate_limited`, …).

## Server-side invariants

- Stage moves are one step only (`raw → curated → gold`, or one step down with a
  reason) and are recorded in `vnagent_data_asset_events`.
- `Gold` requires verified intent, explicit conditions and at least one piece of
  evidence, with `reviewer_id` set to the authenticated owner (never null).
- Concurrency uses `expected_version` (`409 version_conflict` on mismatch).
- Duplicate contributions return the existing asset instead of creating another.
- Export rows are escaped (`|`, newlines, backticks, `<`/`>`), scoped and bounded.

## Local checks

```bash
node --test apps/web/supabase/functions/vnagent-data-admin/data-assets.test.ts
node --test apps/web/supabase/functions/vnagent-data-admin/handler.test.ts
node apps/web/scripts/qa_vnagent_data_admin_contract.mjs
```
