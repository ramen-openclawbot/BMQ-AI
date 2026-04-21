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

## 5. Approval-gated shipping rule
Even after coding is approved:
- build / commit / push only when the user explicitly approves that next step
- if the user approved coding only, stop after local implementation + verification summary

## 6. Repo-specific workflow
Default sequence for this repo:
1. understand the request
2. propose a small plan
3. wait for approval
4. implement the approved slice only
5. report local status clearly
6. wait for approval before build / commit / push

## 7. BMQ-AI business context to preserve
- This project prefers pragmatic, high-business-value slices over broad rewrites.
- For PO/revenue flows, keep parse configuration separate from finance execution.
- Respect current rollout gates such as Tier-1-first behavior unless the user explicitly asks to change them.
- Preserve auditability and operator clarity over hidden automation.

## 8. Success criteria
Before saying a task is done, verify:
- the requested behavior is actually implemented
- the scope stayed within the approved plan
- there are no unrelated edits
- any important limitations or follow-up risks are clearly stated

If something is not verified, say so explicitly.
