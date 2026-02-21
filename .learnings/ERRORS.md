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
