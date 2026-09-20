-- VNAgent synthetic generation — durable owner-only jobs with a hard cost bound.
--
-- Adds ONE table plus three reviewed SECURITY DEFINER routines. It does not touch
-- the existing dataset tables, their RPCs, grants or RLS, and it never writes a
-- business ledger. A job is created by the owner-only edge function before any
-- paid model call and finished after it, so an uncertain HTTP outcome can be
-- reconciled by reading the durable job row instead of resubmitting.
--
-- Security:
--   * every routine re-derives the actor from auth.uid() and requires the owner
--     role; there is NO authenticated INSERT/UPDATE/DELETE grant on the table;
--   * uniqueness is (tenant, created_by, idempotency_key), so a retry of the same
--     batch returns the existing job instead of starting a second paid call; a
--     same-key retry whose request contract/fingerprint differs is rejected with
--     `idempotency_conflict` instead of silently reusing the wrong job;
--   * job_start takes an owner-scoped advisory transaction lock AND a partial
--     unique index enforces at most one `running` job per owner, so two concurrent
--     distinct-key requests can never both spend money;
--   * the job stores the real request fingerprint, the budget and the worst-case
--     bound computed BEFORE the model call, so the cost is always bounded and
--     auditable.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. vnagent_generation_jobs
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.vnagent_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant text not null default 'bmq',
  created_by uuid not null references auth.users(id) on delete cascade,
  -- Client/server nonce; the durable idempotency key of one batch attempt.
  idempotency_key text not null,
  -- The exact validated request contract (topic/count/language/style mix/seeds).
  request jsonb not null default '{}'::jsonb,
  request_fingerprint text not null,
  model text not null,
  prompt_version text not null,
  seed_ids jsonb not null default '[]'::jsonb,
  status text not null default 'running',
  -- Hard pre-flight bound: budget_usd is the owner's cap and worst_case_cost_usd
  -- is the cost of the fixed token bound at the configured prices. A batch is
  -- only started when worst_case_cost_usd <= budget_usd.
  budget_usd numeric not null,
  worst_case_cost_usd numeric not null,
  -- Gateway-reported actual cost when supplied, else null (never fabricated 0).
  actual_cost_usd numeric,
  result_summary jsonb not null default '{}'::jsonb,
  error_code text,
  version integer not null default 1,
  -- While running, a lease bounds how long another request waits before the job
  -- is considered abandoned; the row itself is the durable progress record.
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint vnagent_generation_jobs_tenant_check check (tenant = 'bmq'),
  constraint vnagent_generation_jobs_status_check
    check (status in ('running', 'completed', 'failed', 'budget_exceeded')),
  constraint vnagent_generation_jobs_budget_check check (budget_usd > 0 and worst_case_cost_usd > 0),
  constraint vnagent_generation_jobs_actual_check check (actual_cost_usd is null or actual_cost_usd >= 0),
  constraint vnagent_generation_jobs_version_check check (version >= 1),
  constraint vnagent_generation_jobs_request_check check (jsonb_typeof(request) = 'object'),
  constraint vnagent_generation_jobs_seed_check check (jsonb_typeof(seed_ids) = 'array'),
  constraint vnagent_generation_jobs_summary_check check (jsonb_typeof(result_summary) = 'object'),
  constraint vnagent_generation_jobs_lease_check check (status <> 'running' or lease_expires_at is not null),
  constraint vnagent_generation_jobs_idempotency_unique unique (tenant, created_by, idempotency_key)
);

create index if not exists vnagent_generation_jobs_owner_idx
  on public.vnagent_generation_jobs (tenant, created_by, created_at desc);

-- Structural one-running-job-per-owner invariant. The job_start routine also takes
-- an owner-scoped advisory transaction lock, so the check-then-insert is atomic;
-- this partial unique index is the second, database-enforced line of defence that
-- makes a doubled dispatch impossible even if the routine were called another way.
-- Expired running leases are reaped to `failed` inside job_start before an insert,
-- so the index always holds.
--
-- If this unreleased draft was already exercised and left more than one running
-- job per owner, keep only the newest and finalize the rest before building the
-- index, so the apply itself cannot fail on pre-existing rows.
update public.vnagent_generation_jobs j
   set status = 'failed',
       error_code = 'superseded_by_single_running',
       version = version + 1,
       updated_at = now(),
       finished_at = now(),
       lease_expires_at = null
 where j.status = 'running'
   and exists (
     select 1
     from public.vnagent_generation_jobs newer
     where newer.tenant = j.tenant
       and newer.created_by = j.created_by
       and newer.status = 'running'
       and (newer.created_at, newer.id) > (j.created_at, j.id)
   );

create unique index if not exists vnagent_generation_jobs_one_running_idx
  on public.vnagent_generation_jobs (tenant, created_by)
  where status = 'running';

alter table public.vnagent_generation_jobs enable row level security;

-- Owner read only. No insert/update/delete policy exists, so even a future grant
-- would still be denied by RLS; all writes go through the routines below.
drop policy if exists vnagent_generation_jobs_owner_select on public.vnagent_generation_jobs;
create policy vnagent_generation_jobs_owner_select
  on public.vnagent_generation_jobs for select to authenticated
  using (public.has_role((select auth.uid()), 'owner'));

revoke all on public.vnagent_generation_jobs from anon, authenticated;
grant select on public.vnagent_generation_jobs to authenticated;
grant select on public.vnagent_generation_jobs to service_role;

comment on table public.vnagent_generation_jobs is
  'Owner-only synthetic question generation runs. Written only by vnagent_generation_job_start/finish(); the row is the durable progress and cost record.';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Start (atomic per owner, idempotent, conflict-checked)
-- ────────────────────────────────────────────────────────────────────────────
-- Drop the interim signature from the earlier unreleased draft of this migration
-- so a re-apply replaces it cleanly instead of leaving an ambiguous overload.
drop function if exists public.vnagent_generation_job_start(jsonb, text, text, text, jsonb, numeric, numeric, integer);

create or replace function public.vnagent_generation_job_start(
  p_request jsonb,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_model text,
  p_prompt_version text,
  p_seed_ids jsonb,
  p_budget_usd numeric,
  p_worst_case_cost_usd numeric,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := btrim(coalesce(p_request_fingerprint, ''));
  v_job public.vnagent_generation_jobs%rowtype;
  v_running public.vnagent_generation_jobs%rowtype;
begin
  if v_actor is null or not public.has_role(v_actor, 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_key = '' or v_key !~ '^[A-Za-z0-9-]{8,64}$' then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  if v_fingerprint = '' then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  if p_seed_ids is null or jsonb_typeof(p_seed_ids) <> 'array' then
    raise exception 'invalid_seeds' using errcode = '22023';
  end if;
  if p_budget_usd is null or p_budget_usd <= 0 or p_worst_case_cost_usd is null or p_worst_case_cost_usd <= 0 then
    raise exception 'invalid_budget' using errcode = '22023';
  end if;
  -- Fail closed before any paid call: an unbounded cost may never be started.
  if p_worst_case_cost_usd > p_budget_usd then
    raise exception 'budget_exceeded' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'invalid_lease' using errcode = '22023';
  end if;

  -- OWNER-SCOPED ATOMIC SERIALIZATION: every start for one owner takes the same
  -- transaction-scoped advisory lock, so two concurrent distinct-key requests can
  -- never both pass the "no live running job" check. The lock is released at
  -- commit; a concurrent caller blocks here instead of racing the insert.
  perform pg_advisory_xact_lock(hashtextextended('vnagent_generation_job_start:' || v_actor::text, 0));

  -- Idempotency: an existing attempt returns its durable job (running, completed,
  -- failed or budget_exceeded). A same-key retry whose batch CONTRACT differs is a
  -- conflict, never a silent reuse of the wrong job.
  select * into v_job
  from public.vnagent_generation_jobs
  where tenant = 'bmq' and created_by = v_actor and idempotency_key = v_key;
  if found then
    if v_job.request_fingerprint is distinct from v_fingerprint
       or v_job.request is distinct from p_request
       or v_job.model is distinct from p_model
       or v_job.prompt_version is distinct from p_prompt_version
       or v_job.seed_ids is distinct from p_seed_ids
       or v_job.budget_usd is distinct from p_budget_usd then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'job', to_jsonb(v_job),
      'resumed', true,
      'abandoned', (v_job.status = 'running' and v_job.lease_expires_at <= now())
    );
  end if;

  -- Reap any expired running lease for THIS owner before inserting, so the
  -- one-running-per-owner partial unique index is always satisfiable and a stale
  -- abandoned job can never block or double a new batch.
  update public.vnagent_generation_jobs
     set status = 'failed',
         error_code = 'lease_expired',
         version = version + 1,
         updated_at = now(),
         finished_at = now(),
         lease_expires_at = null
   where tenant = 'bmq' and created_by = v_actor and status = 'running' and lease_expires_at <= now();

  -- Concurrency: only one live running job per owner.
  select * into v_running
  from public.vnagent_generation_jobs
  where tenant = 'bmq' and created_by = v_actor and status = 'running'
  limit 1;
  if found then
    raise exception 'generation_busy' using errcode = 'P0001';
  end if;

  begin
    insert into public.vnagent_generation_jobs (
      tenant, created_by, idempotency_key, request, request_fingerprint,
      model, prompt_version, seed_ids, status, budget_usd, worst_case_cost_usd,
      lease_expires_at
    ) values (
      'bmq', v_actor, v_key, p_request, v_fingerprint,
      p_model, p_prompt_version, p_seed_ids, 'running', p_budget_usd, p_worst_case_cost_usd,
      now() + make_interval(secs => p_lease_seconds)
    )
    returning * into v_job;
  exception when unique_violation then
    -- The structural invariant caught a racing insert: report busy, never a double.
    raise exception 'generation_busy' using errcode = 'P0001';
  end;

  return jsonb_build_object('job', to_jsonb(v_job), 'resumed', false, 'abandoned', false);
end;
$$;

revoke all on function public.vnagent_generation_job_start(jsonb, text, text, text, text, jsonb, numeric, numeric, integer) from public, anon;
grant execute on function public.vnagent_generation_job_start(jsonb, text, text, text, text, jsonb, numeric, numeric, integer) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Finish (version-checked, terminal only)
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.vnagent_generation_job_finish(
  p_job_id uuid,
  p_expected_version integer,
  p_status text,
  p_result_summary jsonb,
  p_actual_cost_usd numeric,
  p_error_code text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_job public.vnagent_generation_jobs%rowtype;
begin
  if v_actor is null or not public.has_role(v_actor, 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_status not in ('completed', 'failed', 'budget_exceeded') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if p_result_summary is null or jsonb_typeof(p_result_summary) <> 'object' then
    raise exception 'invalid_summary' using errcode = '22023';
  end if;
  if p_actual_cost_usd is not null and p_actual_cost_usd < 0 then
    raise exception 'invalid_cost' using errcode = '22023';
  end if;

  select * into v_job
  from public.vnagent_generation_jobs
  where tenant = 'bmq' and id = p_job_id and created_by = v_actor
  for update;
  if not found then
    raise exception 'job_not_found' using errcode = 'P0001';
  end if;
  if v_job.status <> 'running' then
    raise exception 'job_finished' using errcode = 'P0001';
  end if;
  if v_job.version <> p_expected_version then
    raise exception 'version_conflict' using errcode = 'P0001';
  end if;

  update public.vnagent_generation_jobs
  set status = p_status,
      result_summary = p_result_summary,
      actual_cost_usd = p_actual_cost_usd,
      error_code = nullif(btrim(coalesce(p_error_code, '')), ''),
      version = version + 1,
      updated_at = now(),
      finished_at = now(),
      lease_expires_at = null
  where id = p_job_id
  returning * into v_job;

  return jsonb_build_object('job', to_jsonb(v_job));
end;
$$;

revoke all on function public.vnagent_generation_job_finish(uuid, integer, text, jsonb, numeric, text) from public, anon;
grant execute on function public.vnagent_generation_job_finish(uuid, integer, text, jsonb, numeric, text) to authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Get one job, or one job by exact idempotency key, or recent jobs
-- ────────────────────────────────────────────────────────────────────────────
-- Drop the interim signature from the earlier unreleased draft of this migration.
drop function if exists public.vnagent_generation_job_get(uuid, integer);

create or replace function public.vnagent_generation_job_get(
  p_job_id uuid default null,
  p_idempotency_key text default null,
  p_limit integer default 10
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_job public.vnagent_generation_jobs%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_jobs jsonb;
begin
  if v_actor is null or not public.has_role(v_actor, 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- Exact-key recovery: the pending batch is looked up by its OWN idempotency key
  -- (not a bounded recent list), so an absent/nonterminal read is authoritative.
  -- `abandoned` is evaluated on the SERVER clock: a running job whose lease already
  -- expired is an explicit terminal outcome the UI may release, instead of waiting
  -- forever for a worker that crashed. It never triggers another paid call.
  if v_key <> '' then
    select * into v_job
    from public.vnagent_generation_jobs
    where tenant = 'bmq' and created_by = v_actor and idempotency_key = v_key;
    if not found then
      return jsonb_build_object('job', null, 'abandoned', false);
    end if;
    return jsonb_build_object(
      'job', to_jsonb(v_job),
      'abandoned', (v_job.status = 'running' and v_job.lease_expires_at <= now())
    );
  end if;
  if p_job_id is not null then
    select * into v_job
    from public.vnagent_generation_jobs
    where tenant = 'bmq' and id = p_job_id and created_by = v_actor;
    if not found then
      return jsonb_build_object('job', null, 'abandoned', false);
    end if;
    return jsonb_build_object(
      'job', to_jsonb(v_job),
      'abandoned', (v_job.status = 'running' and v_job.lease_expires_at <= now())
    );
  end if;

  select coalesce(jsonb_agg(to_jsonb(j) order by j.created_at desc), '[]'::jsonb)
  into v_jobs
  from (
    select *
    from public.vnagent_generation_jobs
    where tenant = 'bmq' and created_by = v_actor
    order by created_at desc
    limit v_limit
  ) j;

  return jsonb_build_object('jobs', v_jobs);
end;
$$;

revoke all on function public.vnagent_generation_job_get(uuid, text, integer) from public, anon;
grant execute on function public.vnagent_generation_job_get(uuid, text, integer) to authenticated, service_role;
