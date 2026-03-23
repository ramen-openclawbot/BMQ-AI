# HANDOFF — BMQ-AI KB AI flow debug

## Repo
`/Users/c.o.t.e/.openclaw/workspace/BMQ-AI`

## Branch
`main`

## Recent commits relevant
- `ca7c4f9` — `feat(web): add AI-assisted KB flow for sales PO parsing`
- `f13f1ce` — `refactor(web): polish AI knowledge base editor UI`
- `f9aaa88` — `refactor(web): simplify AI knowledge base inputs`
- `efb2222` — `fix(web): surface KB AI function errors`
- `1fc27f8` — `fix(web): guard KB AI calls with session auth`

## Goal of the feature
Knowledge Base profile now supports an **AI-assisted rule generation flow** for Sales PO parsing:

1. user uploads KB template (`.xlsx`, `.pdf`, image)
2. user enters **business description**
3. app extracts template context if possible
4. user clicks **AI Tính Toán**
5. app calls Supabase Edge Function `kb-suggest-po-rules`
6. function calls OpenAI and returns structured parsing/calculation rules
7. user reviews and saves/approves into KB
8. approved AI rules are reused for future Sales PO email-body parsing

## Main files involved

### Frontend
- `apps/web/src/pages/MiniCrm.tsx`
- `apps/web/src/components/mini-crm/KnowledgeBaseProfileEditor.tsx`
- `apps/web/src/components/mini-crm/kbAiUtils.ts`

### Supabase function
- `apps/web/supabase/functions/kb-suggest-po-rules/index.ts`

### Supabase config
- `apps/web/supabase/config.toml`

### Migration
- `apps/web/supabase/migrations/20260323174500_add_ai_fields_to_kb_profiles.sql`

## What has already been implemented

### KB AI flow
- removed manual UI emphasis on:
  - sample email input
  - calculation notes
  - operational notes
- KB UI now centers around:
  - profile basics
  - template upload
  - business description
  - AI suggestion
  - approval flow

### AI function
`kb-suggest-po-rules` currently:
- verifies JWT in code
- expects auth header bearer token
- uses `OPENAI_API_KEY`
- uses `OPENAI_MODEL` if set, otherwise fallback to `gpt-4o-mini`
- calls OpenAI chat completions with `response_format: { type: "json_object" }`
- normalizes structured JSON output

### Runtime integration
- approved AI config is persisted in structured columns + legacy marker fallback
- Sales PO email-body parsing can use approved AI config

## Current problem to debug
User still gets:

**Frontend error shown:**
`AI tính toán thất bại: Edge Function returned a non-2xx status code`

Later browser console also showed:
- `401` on `kb-suggest-po-rules`

A frontend patch was added to surface better errors, but user still sees the old generic message even after deploy claim.

## Important current suspicion
There are **two competing possibilities**:

### A. Frontend bundle is still stale/cached
Even after push/deploy, app still shows the old generic message:
- this strongly suggests browser or hosting still serves an older JS bundle

### B. Edge function is still returning 401
Even if frontend is fresh, current request may still be unauthorized:
- missing/expired app session
- JWT not being sent as expected
- function auth/config mismatch

## Specific things already patched
### In frontend
`MiniCrm.tsx`
- before calling function:
  - checks `supabase.auth.getSession()`
  - if no session, throws:
    `Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại rồi thử AI Tính Toán.`
- on function error:
  - attempts to read `error.context.json()`
  - tries to surface `error`, `message`, `code`, `details`

### In config
`apps/web/supabase/config.toml`
- added:
```toml
[functions.kb-suggest-po-rules]
verify_jwt = true
```

### In function
`kb-suggest-po-rules/index.ts`
- still manually checks bearer auth header
- uses OpenAI key/model env

## Verified constraints / environment notes
- Supabase CLI on machine was previously `2.75.0`
- local `supabase functions serve` cannot be used because Docker daemon is unavailable
- `supabase secrets list` previously returned `401 Unauthorized` from CLI on this machine
- user claims `OPENAI_API_KEY` is already set
- `OPENAI_MODEL` has been discussed and set attempts were made
- function deploy command has been run multiple times

## What the next agent should do

### 1. Verify whether frontend is truly on the latest build
Need to confirm the app actually includes commits:
- `efb2222`
- `1fc27f8`

If possible:
- inspect deployed JS bundle
- add temporary debug marker/version in UI if needed
- verify browser is not serving stale assets

### 2. Verify auth state from frontend at runtime
Check:
- whether `supabase.auth.getSession()` returns a real access token in the running app
- whether function invocation includes auth correctly
- whether user is actually authenticated in the environment where AI button is clicked

### 3. Verify remote function deployment/config
Check that remote deployed function matches local source:
- `apps/web/supabase/functions/kb-suggest-po-rules/index.ts`

Also verify:
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `verify_jwt = true` behavior for this function
- whether function is returning 401 before even reaching OpenAI call

### 4. If needed, reduce auth ambiguity
Potential debugging move:
- temporarily add explicit logging or return codes in function
- or simplify auth path to isolate whether failure is JWT or OpenAI

### 5. Check if function should use `verify_jwt = true` or rely only on code-level bearer validation
Current setup may be redundant/confusing:
- config-level JWT verify
- plus manual bearer parsing in function

Agent should decide if one should be simplified for reliability.

## Suggested exact debug targets
- `apps/web/src/pages/MiniCrm.tsx`
- `apps/web/supabase/functions/kb-suggest-po-rules/index.ts`
- `apps/web/supabase/config.toml`

## Known non-blocking warning
Browser warning seen:
`Missing Description or aria-describedby={undefined} for {DialogContent}`
Some cleanup was done, but this is **not the root blocker**.

## Desired outcome
Make **AI Tính Toán** successfully return structured KB suggestion, or at minimum surface the **real underlying cause** clearly in UI/logs:
- session expired
- invalid JWT
- function deploy mismatch
- missing OpenAI env
- unsupported model
- invalid JSON from model
