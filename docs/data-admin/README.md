# VNAgent data assets admin

Owner-only admin for the VNAgent evaluation dataset, reachable at `/data-admin`
on existing BMQ hosts and at the future `admin.vnagent.ai`.

## Language

The admin is **English by default and independent from the BMQ app language**.
It does not read `LanguageContext` or the shared `app-language` localStorage key,
and it never calls `setLanguage`, so switching the BMQ app to Vietnamese does not
change the admin and the admin cannot change the BMQ app. The page, the panel
copy, form validation, error/empty/loading states, accessibility labels, number
and date formatting, the edge-function error defaults and the generated Markdown
headings are all English.

Localization only applies to UI chrome. **Raw captured questions, answers,
provenance and evidence are shown verbatim in their original language** and are
never translated.

## What it is

BMQ analytics chat interactions are automatically captured into a **separate
interaction dataset** (`vnagent_interactions`). This dataset is not a business or
financial ledger, and it never changes a BMQ business reply.

The evaluation inventory (`vnagent_data_assets`) moves through three stages, all
of which are **the same asset**:

| Stage | Meaning | Badge |
| --- | --- | --- |
| `raw` | Just collected or submitted, not yet edited | neutral |
| `curated` | Edited and internally consistent, waiting for verification | restrained indigo |
| `gold` | Verified intent + conditions + evidence by a real owner reviewer | amber |

The dashboard never counts `raw + curated + gold` as independent assets. Growth is
shown separately for newly collected interactions and for audited promotions.

## Data model

- `vnagent_interactions` — raw capture. Original BMQ `requestId` is the durable
  idempotency key (`unique (tenant, request_id)`). Stores a redacted question, a
  bounded original answer (reviewer reference only), minimized actor/page
  context, understood intent, the page filters vs the executed filters, provenance,
  response status, **separate** known vs unknown usage (unknown numbers stay null),
  model route, retention expiry. Owner-readable; written only through the trusted
  `vnagent_capture_chat()` RPC.
- `vnagent_data_assets` — evaluation inventory. `source_kind` distinguishes
  `operational_chat`, `contributor` and `synthetic`; `source_designation`
  distinguishes `manual` from `llm_generated`. Direct INSERT/UPDATE/DELETE is
  revoked for every caller; assets are created and moved only by the reviewed
  SECURITY DEFINER RPCs, which derive `created_by`/`reviewer_id` from `auth.uid()`.
- `vnagent_data_asset_events` — append-only audited transitions with from/to stage
  and version. Not writable by any caller directly.
- `vnagent_jev_events` — bounded Jev telemetry using the real `JevTelemetry`
  fields: model, prompt/registry version, attempted/decided, metric/period/support
  with probabilities, threshold, fallback, cost, real `JevUsage`
  (`{input, output}`), real `JevTimings` and `JevCounts`. No question, prompt,
  option-id list or key.

`tenant` is pinned to `'bmq'` by a check constraint. This is intentionally not a
cross-tenant selector; adding tenants requires a reviewed migration.

## Capture

BMQ analytics chat capture is **default off** (`VNAGENT_CAPTURE_ENABLED=true`) and
runs through one atomic RPC that writes the interaction, its initial `raw` dataset
asset (question, original answer, executed filters, provenance) and the Jev row in
a single transaction. It is idempotent on both the request id and the derived asset
dedupe key, so a retry after a partial failure recovers the missing raw asset. The
overview shows whether capture is currently enabled, so an empty dataset is never
confused with a running pipeline.

## Privacy and honesty rules

- Secrets (bearer tokens, API keys, JWTs, `password=`/`token=`-style values) are
  redacted before storage. Conversation history text and provider bodies are not
  stored; only bounded counts/keys.
- Retention defaults to 180 days per captured interaction, recorded on the row. A
  purge job is **not** part of this migration; the field is metadata until an
  owner-approved purge is deployed.
- Raw capture is owner-only. There is no authenticated INSERT policy, and direct
  INSERT/UPDATE/DELETE is revoked on every `vnagent_*` table.
- A capture failure is audited (`bmq_interaction_capture_failed`) and never
  silently reported as success; the business reply is untouched. Capture runs
  under its own bounded deadline.
- Every failed request keeps its own event identity (a fresh per-event id, never a
  hash of status/code/question), so repeated genuine errors are not collapsed.
- Financial answers are evaluation material, not timeless truth. The dataset is
  **not** used to train a model, and the UI does not promise training.

## Panels

Overview · Repository · Review queue · Contributions · Generate data · Jev logs ·
Markdown export.

Overview shows current inventory, source contribution counts and a **real daily
chart** (7/30/90-day selector, stock vs new) reconstructed from asset creation and
audited transitions. The chart resolves the latest per-asset stage by event
`created_at` and then `to_version`, so several transitions captured in one
transaction (shared `now()`) still show the real current stage.

Export is bounded (≤200 rows), applies every filter — including dates — in SQL
before the row limit, and includes the original question/answer, executed filters,
provenance, Gold reviewed semantics and evidence. The compact table may shorten a
long cell (explicitly marked); a per-case **Full cases** section then carries every
stored bounded field verbatim inside a fenced JSON block with a dynamically sized
fence, so untrusted text cannot inject markup and no value is silently lost. If the
complete document would exceed the response size cap the export fails with an
explicit error instead of dropping content. A single selected case can be exported
from the repository.

The review queue pages over one reviewable stage at a time using the **server**
stage filter and the honest server total, so older Raw/Curated pending assets stay
reachable once the queue exceeds one page of Gold.

Automatic capture nests the sanitized original interaction provenance under the raw
asset provenance as `sourceProvenance` (semantic version, citations, snapshot,
evidence), so reviewers can verify the source; credential-looking keys are stripped
and the payload is bounded.

Contribution submission is paste/manual and never requires a paid LLM call; when an
LLM was used the source must be marked as such. If a submit outcome is uncertain
(network/5xx) the retry is locked until the durable state has been read back; the
scope-aware dedupe key then prevents a duplicate.

## Generate Data (owner-only, default off)

**Generate data** runs ONE bounded batch of 20–50 synthetic questions from the
supported BMQ business definitions and the curated **built-in example** questions
shipped in reviewed source (`generation.ts`). Those examples are not owner
approvals — real approval lives on Curated/Gold assets only. The owner picks topic,
count, question language and a hard USD budget; the default split covers variants,
typos, ambiguous and out-of-scope questions.

Everything lands in **Raw** as `synthetic` / `llm_generated`; Curated/Gold review is
unchanged, there is no auto-Gold and no fine-tune, and the dataset is still not used
to train a model. The model only proposes questions — it never states a value and
the output schema has no stage, evaluation or truth label; a question containing a
fabricated money claim, a duplicate, a wrong count or a style/routing contradiction
rejects the whole batch.

The batch is durable and bounded: a `vnagent_generation_jobs` row is written before
the single paid model call and finished after it. Uniqueness on
`(tenant, created_by, idempotency_key)` plus a real contract fingerprint makes a
retry read the job back instead of spending again (a same-key different-payload
retry is a 409 conflict). An owner-scoped advisory lock and a partial unique index
allow exactly one live running job per owner; an expired lease is surfaced as
abandoned on the server clock. The worst-case cost is measured from the actual
serialized request and checked against the owner's budget before any call. An
unknown model with no explicit price fails closed (`generation_cost_unbounded`); the
price otherwise comes from the reviewed **official DeepSeek price list** for the
model, at the conservative peak cache-miss input and peak output rates.

The Generate Data lane calls DeepSeek's official OpenAI-compatible API directly
(`https://api.deepseek.com/chat/completions`, default model `deepseek-flash`) with
the server-only `DEEPSEEK_API_KEY`. The Jev/Vercel AI Gateway key is not a fallback
for generation. The request uses `response_format: { type: "json_object" }` and
`thinking: { type: "disabled" }`; DeepSeek does not enforce a schema, so the exact
contract is enforced in code. DeepSeek reports no dollar cost, so the recorded cost
is computed from the usage tokens it does report, and unknown usage stays `null`.
No DeepSeek retention guarantee is claimed: the reviewed official docs state none,
so no zero-data-retention parameter is sent for this lane.
