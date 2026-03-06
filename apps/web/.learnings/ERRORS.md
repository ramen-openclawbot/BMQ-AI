## [ERR-20260301-001] bulk-string-replace-i18n

**Logged**: 2026-03-01T00:00:00+07:00
**Priority**: high
**Status**: pending
**Area**: frontend

### Summary
Bulk replacement accidentally changed a state variable identifier in FinanceControl.tsx and broke build.

### Error
```
ERROR: Expected "]" but found "{"
const [notes, set{isVi ? "Ghi chú" : "Notes"}] = useState("");
```

### Context
- Operation: scripted global string replacements for i18n
- File: src/pages/FinanceControl.tsx
- Cause: replacing "Notes" indiscriminately affected `setNotes` identifier

### Suggested Fix
- Revert/repair the identifier to `setNotes`
- Avoid global replace on common tokens; scope replacements to JSX text only

### Metadata
- Reproducible: yes
- Related Files: src/pages/FinanceControl.tsx

---

## [ERR-20260303-001] vite-esbuild-nullish-coalescing

**Logged**: 2026-03-03T11:20:00Z
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
Build failed due to mixing `??` and `||` without parentheses in TSX expressions.

### Error
```
Cannot use "||" with "??" without parentheses
```

### Context
- Command: `npm run build`
- File: `src/pages/FinanceControl.tsx`
- Trigger: refactor to use folder reconciliation fallback values.

### Suggested Fix
Wrap nullish-coalescing expressions in parentheses before applying `||`, e.g. `((a ?? b) || 0)`.

### Metadata
- Reproducible: yes
- Related Files: src/pages/FinanceControl.tsx

### Resolution
- **Resolved**: 2026-03-03T11:22:00Z
- **Commit/PR**: 58742be
- **Notes**: Replaced all mixed `??` + `||` expressions with parenthesized versions.

---
