## [ERR-20260221-001] build-command-workdir

**Logged**: 2026-02-21T11:24:00Z
**Priority**: medium
**Status**: resolved
**Area**: config

### Summary
Ran `npm run build` in repo root instead of apps/web and got missing script error.

### Error
```
npm error Missing script: "build"
```

### Context
- Command attempted from `/Users/c.o.t.e/.openclaw/workspace/BMQ-AI`
- Build script exists in `apps/web/package.json`

### Suggested Fix
Always run web build commands with `workdir=apps/web`.

### Metadata
- Reproducible: yes
- Related Files: apps/web/package.json

### Resolution
- **Resolved**: 2026-02-21T11:24:30Z
- **Notes**: Re-ran build in apps/web.

---

## [ERR-20260222-002] vercel-deploy-auth

**Logged**: 2026-02-22T00:48:27Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Production deploy via Vercel CLI failed because the configured token is invalid.

### Error
```
Error: The specified token is not valid. Use `vercel login` to generate a new token.
```

### Context
- Command: `npx -y vercel --prod --yes`
- Workdir: `apps/web`
- Commit requested to deploy: `be78673`

### Suggested Fix
Re-authenticate Vercel CLI (`npx vercel login`) or provide a valid `VERCEL_TOKEN`, then rerun deploy.

### Metadata
- Reproducible: yes
- Related Files: apps/web/vercel.json, .learnings/ERRORS.md
- See Also: ERR-20260221-001

---
## [ERR-20260223-001] coding-agent/codex

**Logged**: 2026-02-23T13:47:36.094884+00:00
**Priority**: medium
**Status**: pending
**Area**: infra

### Summary
Failed to run coding-agent delegation because `codex` CLI is not installed on host.

### Error
```
zsh:1: command not found: codex
```

### Context
- Command attempted: `codex exec --full-auto ...`
- Environment: OpenClaw host on Mac mini

### Suggested Fix
Use `sessions_spawn` for complex coding delegation when local codex binary is unavailable, or install codex CLI.

### Metadata
- Reproducible: yes
- Related Files: .learnings/ERRORS.md

---
