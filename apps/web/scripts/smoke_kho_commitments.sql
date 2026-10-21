-- Smoke test for 20261102580000_kho_commitments.sql.
--
-- Run entirely inside BEGIN ... ROLLBACK.  It applies nothing itself: the
-- Maestro applies the migration first and then runs this file in the same
-- transaction.  It only reads the commitment payload and the cron rows.
--
-- The service_role claim plus a sub makes auth.uid() non-null so the RPC goes
-- through its actor_required gate while auth.role() remains service_role.
--
-- Run with:  psql "$DATABASE_URL" -f scripts/smoke_kho_commitments.sql

begin;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"00000000-0000-0000-0000-000000000001"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000001',
  true
);

-- Counts of the three commitment sections.
with c as (
  select public.kho_get_commitments() as payload
)
select
  payload ->> 'as_of' as as_of,
  jsonb_array_length(coalesce(payload -> 'items', '[]'::jsonb)) as item_count,
  jsonb_array_length(coalesce(payload -> 'skus', '[]'::jsonb)) as sku_count,
  coalesce((payload #>> '{gaps,pxk_lines_unposted}')::integer, 0) as pxk_lines_unposted,
  jsonb_array_length(
    coalesce(payload #> '{gaps,pxk_unposted_issues}', '[]'::jsonb)
  ) as pxk_unposted_issues_count
from c;

-- The two hourly jobs and their unchanged commands.
select
  jobid,
  jobname,
  schedule,
  command,
  active
from cron.job
where jobname in ('tan-tao-daily-ledger', 'q7-fg-daily-ledger')
order by jobname;

rollback;
