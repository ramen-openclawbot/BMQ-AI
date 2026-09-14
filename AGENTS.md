# BMQ-AI — Agent Instructions

These instructions are for coding agents that read `AGENTS.md` (for example Codex).

## 1. Think before coding
- Do not assume silently.
- If the requirement is ambiguous, ask a clarifying question first.
- If there are multiple valid interpretations, surface them briefly instead of picking one invisibly.
- If a simpler approach exists, say so.
- Do not hide confusion.

## 2. Plan first, wait for approval
Before making code changes:
1. explain the plan briefly
2. list the main files you expect to touch
3. ask: `Anh có approve plan này không?`

Do not start coding until the plan is approved.

## 3. Simplicity first
- Write the minimum code that solves the problem.
- Do not introduce speculative abstractions.
- Do not add configurability unless it is clearly needed.
- Do not broaden scope beyond the approved slice.
- If a solution feels overengineered, simplify it.

## 4. Surgical changes only
When editing existing code:
- touch only files needed for the requested task
- do not refactor unrelated areas
- do not rename or delete unrelated code/comments
- match the surrounding style unless the task explicitly asks otherwise
- if you notice adjacent cleanup opportunities, mention them instead of silently changing them

## 5. Approved production source must be canonical in Git
For any page or workflow that has already been approved or deployed:
- Do not assume the latest Git source is the approved production version. Check Git history, deployment history, and the live custom-domain assets before replacing or redesigning it.
- Never deploy an approved change from a dirty worktree or leave it only in a manual Vercel deployment. The exact approved source and its regression contract must be committed and pushed to GitHub `main`.
- If an approved version exists only in deployment history, recover and compare the exact deployment source first. Do not recreate it from memory or infer it from screenshots when source evidence is available.
- A release is not complete until the Git commit SHA, production deployment, and custom-domain JS/CSS markers all match the intended version.
- For approved UI, add a stable version/behavior marker and contract tests for the essential layout and interactions. Run authenticated responsive QA on mobile and desktop before shipping.
- Before any later release touching the same page, verify those markers and contracts so a Git-triggered deployment cannot silently restore obsolete UI.

## 6. Approval-gated shipping rule
Even after coding is approved:
- build / commit / push only when the user explicitly approves that next step
- if the user approved coding only, stop after local implementation + verification summary
- Approval of a plan explicitly including code, tests, QA, build and ship authorizes that whole sequence. Carry it through without asking the same approval again.
- Follow these instructions without routinely quoting them or appending an AGENTS.md citation to replies (owner request, 2026-09-14). Only explain a concrete new blocker when needed; do not append boilerplate permission paragraphs.

## 7. Repo-specific workflow
Default sequence for this repo:
1. understand the request
2. propose a small plan
3. wait for approval
4. implement the approved slice only
5. verify behavior and responsive UX, report actual local status clearly
6. build / commit / push / deploy when covered by the approved plan; otherwise obtain the missing shipping approval

## 8. BMQ-AI business context to preserve
- This project prefers pragmatic, high-business-value slices over broad rewrites.
- For PO/revenue flows, keep parse configuration separate from finance execution.
- Respect current rollout gates such as Tier-1-first behavior unless the user explicitly asks to change them.
- Preserve auditability and operator clarity over hidden automation.
- For UX notifications, avoid duplicate confirmations: do not show the same success/error text in both a global message and a section-local status. Prefer one persistent inline message near the action, with toast only as transient support.

## 9. Success criteria
Before saying a task is done, verify:
- the requested behavior is actually implemented
- the scope stayed within the approved plan
- there are no unrelated edits
- any important limitations or follow-up risks are clearly stated

If something is not verified, say so explicitly.

## 10. Model-independent implementation, QA and release procedure
This procedure applies to every coding model/agent, including after handoff or context compaction. Preserve the existing approval scope; a model switch does not reset authorization or waive verification.

### Establish the baseline
- Read the canonical project handoff, relevant source, repository instructions and existing regression checks. Verify checkout path, branch, HEAD, origin sync and existing local changes.
- Match the approved live custom-domain version to Git before editing deployed flows. Preserve unrelated work and generated Supabase temp files; stage only explicit task files.
- Trace business contracts to source/API evidence. Never guess fields, defaults, status meanings or external side effects. Separate confirmed behavior from unverified assumptions.

### Implement and check the behavior
- Make scoped changes preserving permissions, source identifiers, SKU mappings, audit trails and existing approved operations.
- For external writes, validate on the server, re-read mutable inputs and permissions, protect concurrent/repeated clicks durably, and recover uncertain outcomes by reading state rather than blindly repeating writes.
- Add meaningful regression coverage for changed business behavior: successful path, denied permissions, empty/missing data, changed/cancelled records, duplicate/concurrent requests, network failure and resumable partial success as applicable. Do not replace behavioral coverage with source-marker assertions.
- Run the relevant existing contracts, behavioral tests, frontend type checks, Edge/Deno checks when changed, and production build when authorized. If the repository already fails typecheck, compare exact baseline/current diagnostics with the same compiler/dependencies; report existing failures honestly and fix all new task-related failures. Do not call the check clean merely because errors are unrelated.
- Use mocked/intercepted external writes or rollback-only DB fixtures for QA. Shipping approval does not authorize creating, confirming, rejecting, dispatching or deleting real business records as test data.

### Verify the actual UI
- Exercise real source components/pages with authenticated or clearly labeled fixture-auth sessions; a static mockup or build alone does not prove the interaction.
- Check mobile and desktop at relevant widths (typically 320/390 and 1280/1366/1440/1920), sidebar expanded/collapsed where applicable, realistic populated/empty/error states, long labels, form validation, repeated clicks and recovery paths. Test Vietnam midnight/date boundaries for date-sensitive operations.
- Inspect screenshots as well as geometry: no page overflow/clipped actions, internal table scrolling, readable inputs and labels, usable touch targets, correct loading/error placement and preserved print animation. Fix issues, then rerun the affected checks.
- Do not claim device or live-user verification from fixtures. Opening a PDF is not proof it was physically printed.

### Release and prove delivery
- Review the final scoped diff; commit/push exact approved source to main and deploy from a clean checkout. Do not ship unrelated local changes.
- Apply only reviewed migrations and deploy only changed Edge Functions/UI. Verify schema constraints/RLS and rollback-only DB checks when relevant; preserve JWT and operational permissions.
- Confirm deployment READY/ACTIVE, exact commit/source, and the live custom-domain JS/CSS behavior markers. For Edge changes verify deployed source/version, authentication and CORS. A successful local build is not deployment proof; an installed schedule is not proof of a successful scheduled run.
- Save a concise release/handoff record with commit, deployment/version, checks and evidence paths, remaining unverified business operations, next owner/action and any pending recovery state. Never record secrets.
- Keep the progress card current. Report overall **ĐANG LÀM**, **BỊ CHẶN — CHƯA XONG**, or **HOÀN TẤT** with verified results, remaining work, next action/owner and **Anh cần làm: ...** or **Không cần thao tác thêm**. Proactively deliver the final result; do not imply background work unless a real job is running.
