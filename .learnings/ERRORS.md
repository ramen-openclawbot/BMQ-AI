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

## [ERR-20260228-003] openclaw-edit-tool

**Logged**: 2026-02-28T22:56:00+07:00
**Priority**: medium
**Status**: resolved
**Area**: backend

### Summary
Tool edit báo lỗi khi thay chuỗi không khớp chính xác hoặc thiếu tham số new_string/newText.

### Error
```
⚠️ 📝 Edit: in ~/.openclaw/workspace/BMQ-AI/apps/web/supabase/functions/po-use-latest-kingfood-today/index.ts failed
```

### Context
- Đang chỉnh edge function nhanh trong nhiều lần edit liên tiếp.
- Có lần gửi thiếu `new_string`, có lần `old_string` không còn khớp sau khi file đã thay đổi.

### Suggested Fix
- Luôn `read` lại block gần nhất trước khi `edit`.
- Chỉ dùng `old_string` ngắn và đặc trưng để giảm mismatch.
- Nếu chỉnh nhiều đoạn lớn, dùng `write` để ghi lại toàn bộ file.

### Metadata
- Reproducible: yes
- Related Files: apps/web/supabase/functions/po-use-latest-kingfood-today/index.ts

### Resolution
- **Resolved**: 2026-02-28T22:57:00+07:00
- **Commit/PR**: N/A (tooling/process)
- **Notes**: Đã read lại file, sửa đúng block, deploy và invoke thành công.

---
## [ERR-20260301-001] mini-crm-revenue-post-schema-mismatch

**Logged**: 2026-03-01T00:04:00+07:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
Luồng "Đẩy sang kiểm soát doanh thu" fail do frontend/select phụ thuộc cột schema cache chưa expose ổn định (`posted_to_revenue`, `po_number`).

### Error
```
Could not find the 'posted_to_revenue' column of 'customer_po_inbox' in the schema cache
column customer_po_inbox.po_number does not exist
```

### Context
- Operation: update/select trên `customer_po_inbox` từ MiniCrm.tsx
- Ảnh hưởng: không đẩy được PO sang finance, user thấy thông báo lỗi liên tục

### Suggested Fix
- Không phụ thuộc cột optional trong flow runtime; ưu tiên `raw_payload.revenue_post` để đánh dấu post.
- Đồng bộ migration compatibility + grants để PostgREST expose cột ổn định.

### Metadata
- Reproducible: yes
- Related Files: apps/web/src/pages/MiniCrm.tsx, apps/web/src/pages/FinanceRevenueControl.tsx, apps/web/supabase/migrations/20260228235800_customer_po_inbox_compat_columns.sql
- See Also: N/A

### Resolution
- **Resolved**: 2026-03-01T00:00:00+07:00
- **Commit/PR**: a412686, 84a1deb
- **Notes**: Bỏ phụ thuộc `po_number`/`posted_to_revenue` trong query cập nhật chính; thêm migration compatibility + grants.

---
## [ERR-20260301-002] frontend-deploy-vercel-cli-missing

**Logged**: 2026-03-01T23:30:00+07:00
**Priority**: medium
**Status**: pending
**Area**: infra

### Summary
Không thể deploy frontend bằng lệnh `vercel --prod --yes` vì môi trường chưa cài Vercel CLI.

### Error
```
zsh:1: command not found: vercel
```

### Context
- Command attempted: `vercel --prod --yes`
- Workdir: `apps/web`
- User request: deploy frontend ngay

### Suggested Fix
- Dùng kênh deploy sẵn có của dự án (Lovable Publish hoặc CI/CD hiện hữu), hoặc cài `vercel` CLI trước khi dùng.
- Xác nhận quy trình deploy chuẩn cho repo để tránh đoán sai toolchain.

### Metadata
- Reproducible: yes
- Related Files: apps/web/vercel.json, apps/web/README.md
- See Also: N/A

---
## [ERR-20260301-003] frontend-deploy-vercel-token-invalid

**Logged**: 2026-03-01T23:33:00+07:00
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Deploy frontend bằng Vercel CLI bị chặn do token hiện tại không hợp lệ.

### Error
```
Error: The specified token is not valid. Use `vercel login` to generate a new token.
```

### Context
- Command attempted: `vercel --prod --yes`
- Prerequisite đã xử lý: đã cài `vercel` CLI thành công
- Blocker: credential/token deploy hết hạn hoặc sai

### Suggested Fix
- Chạy `vercel login` để cấp token mới, hoặc export `VERCEL_TOKEN` hợp lệ trước khi deploy.
- Sau khi login/token hợp lệ, chạy lại `vercel --prod --yes` tại `apps/web`.

### Metadata
- Reproducible: yes
- Related Files: apps/web/vercel.json
- See Also: ERR-20260301-002

---
## [ERR-20260302-001] po-gmail-sync-jwt-mismatch

**Logged**: 2026-03-02T12:52:00Z
**Priority**: high
**Status**: pending
**Area**: frontend

### Summary
PO Gmail sync preview trả HTTP 401 Invalid JWT dù người dùng đã đăng nhập lại.

### Error
```
[preview] HTTP 401 - Invalid JWT
```

### Context
- Frontend gọi Edge Function po-gmail-sync bằng Bearer session.access_token.
- Debug endpoint po-gmail-debug-check đọc Gmail bình thường.
- Khả năng cao token frontend không cùng project/issuer với function env tại runtime.

### Suggested Fix
- Tránh chặn cứng bằng supabaseAdmin.auth.getUser(token) trong po-gmail-sync.
- Hoặc đồng nhất project giữa Supabase client env và function URL.
- Thêm endpoint auth-check để xác định rõ mismatch project.

### Metadata
- Reproducible: yes
- Related Files: apps/web/src/pages/MiniCrm.tsx, apps/web/supabase/functions/po-gmail-sync/index.ts

---

## [ERR-20260302-001] supabase db push

**Logged**: 2026-03-02T21:05:00+07:00
**Priority**: medium
**Status**: pending
**Area**: backend

### Summary
Migration failed because trigger function `public.handle_updated_at()` is not present in this database.

### Error
```
ERROR: function public.handle_updated_at() does not exist (SQLSTATE 42883)
At statement: create trigger ... execute function public.handle_updated_at()
```

### Context
- Command: `supabase db push`
- Migration: `20260302210200_create_mini_crm_po_templates.sql`

### Suggested Fix
Use an inline trigger function local to this table migration (or skip trigger) instead of depending on global `handle_updated_at()`.

### Metadata
- Reproducible: yes
- Related Files: apps/web/supabase/migrations/20260302210200_create_mini_crm_po_templates.sql

---
## [ERR-20260303-001] git_push_origin_main

**Logged**: 2026-03-03T20:58:00+07:00
**Priority**: medium
**Status**: pending
**Area**: infra

### Summary
Push lên GitHub bị lỗi HTTP 500 từ remote.

### Error
```
remote: Internal Server Error
fatal: unable to access 'https://github.com/ramen-openclawbot/BMQ-AI.git/': The requested URL returned error: 500
```

### Context
- Operation: git push origin main
- Repo: BMQ-AI

### Suggested Fix
Retry push sau 10-30s; nếu lặp lại, kiểm tra GitHub status.

### Metadata
- Reproducible: unknown
- Related Files: n/a

---
## [ERR-20260306-API-CORS504] finance scan edge functions

**Logged**: 2026-03-06T21:31:00+07:00
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Daily reconciliation scan can appear "stuck" when Supabase Edge Function preflight fails with 504 and missing CORS headers.

### Error
```
Preflight response is not successful. Status code: 504
Origin https://ai.banhmique.vn is not allowed by Access-Control-Allow-Origin. Status code: 504
Fetch API cannot load .../functions/v1/sync-drive-index due to access control checks.
Fetch API cannot load .../functions/v1/finance-extract-slip-amount due to access control checks.
```

### Context
- Operation: Daily reconciliation (UNC/QTM scan + OCR amount extraction)
- Frontend invokes Supabase Edge Functions from browser
- Functions affected in logs: `sync-drive-index`, `finance-extract-slip-amount`

### Suggested Fix
- Ensure edge functions always return CORS headers for OPTIONS and error paths (including upstream timeout/exception responses).
- Add gateway-level monitoring/retry for 504 from edge runtime.
- Frontend should surface actionable error when CORS/preflight blocks response body.

### Metadata
- Reproducible: yes
- Related Files: apps/web/src/pages/FinanceControl.tsx, apps/web/supabase/functions/*

---

## [ERR-20260307-001] sql-repair-on-conflict-user-roles

**Logged**: 2026-03-07T00:49:00+07:00
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
RBAC repair SQL failed in production DB because script used `ON CONFLICT (user_id)` on `public.user_roles` without a matching unique constraint.

### Error
```
ERROR: 42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification
```

### Context
- Attempted data repair for `thuy@bmq.vn` role/permission mismatch.
- Existing schema appears to allow multiple `user_roles` rows per user (or lacks unique index on `user_id`).

### Suggested Fix
- Avoid `ON CONFLICT` for `public.user_roles` until unique constraint exists.
- Use `UPDATE` + `INSERT ... WHERE NOT EXISTS` pattern.
- Add a schema hardening migration later: unique index on `user_roles(user_id)` after deduplicating.

### Metadata
- Reproducible: yes
- Related Files: output/fix_thuy_and_non_owner_permissions_full.sql, supabase/migrations/20260307000000_user_management_tables.sql
- Tags: rbac, sql, data-repair

---
