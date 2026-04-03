# Handoff — Supabase support: performance follow-up plan

## Ticket / project
- Supabase ticket: `SU-351477`
- Project ref: `cxntbdvfsikwmitapony`
- Support conclusion: project recovered after restart, but root cause is capacity stress on `nano` (high Disk IO, high RAM, high SWAP, memory overcommitment)

## Immediate conclusion
This is not just an auth/frontend incident. The database instance is under-provisioned and likely also carrying schema/query performance debt.

## What has been prepared now
### Migration added
- `apps/web/supabase/migrations/20260403122000_drop_duplicate_ceo_declarations_index_again.sql`
- Purpose: remove duplicate index reported by Supabase advisor:
  - keep `idx_ceo_daily_closing_declarations_closing_date`
  - drop `idx_ceo_declarations_closing_date`

## Priority plan

### P1 — Stabilize first
1. Upgrade compute from `nano` to at least `micro`
2. Observe for 24–48h:
   - host availability
   - auth/login failures
   - Disk IO budget
   - RAM
   - SWAP

### P2 — Low-risk cleanup from advisor output
1. Apply the duplicate-index migration above
2. Re-run the advisor/linter and confirm the duplicate index warning disappears

### P3 — RLS merge checklist (performance debt)
The CSV shows many tables with **multiple permissive policies** for the same `authenticated + SELECT` combination.
This adds policy-evaluation cost to every read.

#### Highest-priority tables to inspect first
- `app_settings`
- `drive_file_index`
- `drive_import_logs`
- `drive_sync_config`
- `payment_requests`
- `payment_request_items`
- `invoices`
- `invoice_items`
- `orders`
- `order_items`
- `suppliers`
- `profiles`
- `user_roles`
- `user_module_permissions`

#### Merge rule
For each flagged table:
1. List all policies on the table
2. Group by `(role, action)`
3. If there are 2+ permissive policies for `authenticated + SELECT`, merge them into **one SELECT policy** with OR logic where safe
4. Keep write policies (`INSERT/UPDATE/DELETE`) separate only if needed for distinct checks
5. Re-run advisor after each batch

#### Suggested inspection SQL
```sql
select
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'app_settings',
    'drive_file_index',
    'drive_import_logs',
    'drive_sync_config',
    'payment_requests',
    'payment_request_items',
    'invoices',
    'invoice_items',
    'orders',
    'order_items',
    'suppliers',
    'profiles',
    'user_roles',
    'user_module_permissions'
  )
order by tablename, cmd, policyname;
```

#### Safe batching order for RLS cleanup
Batch 1:
- `app_settings`
- `drive_file_index`
- `drive_import_logs`
- `drive_sync_config`

Batch 2:
- `payment_requests`
- `payment_request_items`
- `invoices`
- `invoice_items`

Batch 3:
- `orders`
- `order_items`
- `suppliers`

Batch 4:
- `profiles`
- `user_roles`
- `user_module_permissions`

### P4 — Find the real load drivers
Advisor warnings alone do not explain all spikes. Still need:
1. `Query Performance`
2. `Performance Advisor`
3. `pg_stat_statements`
4. top queries by:
   - total execution time
   - mean execution time
   - call count

### P5 — Map heavy queries back to app flows
Likely hot areas in BMQ-AI to inspect after query export:
- finance screens (`payment_requests`, `invoices`, reconciliation)
- drive sync / OCR cache (`drive_file_index`)
- permissions/profile bootstrap (`profiles`, `user_roles`, `user_module_permissions`)
- config/bootstrap (`app_settings`)

## Practical next steps
1. Run compute upgrade to `micro`
2. Apply duplicate-index migration
3. Export current policies for the priority tables
4. Draft first RLS merge migration for Batch 1
5. Export top slow queries and map them to screens/hooks in app code

## Notes
- `20260307170000_fix_remaining_linter_warnings.sql` had already tried to drop the duplicate index.
- `20260401090000_finance_v033_reconciliation.sql` reintroduced `idx_ceo_declarations_closing_date`.
- So the new migration is a corrective cleanup for the reintroduced duplicate.
