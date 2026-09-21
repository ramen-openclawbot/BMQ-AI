-- VNAgent synthetic generation — live progress heartbeat for a running batch.
--
-- The job row is the durable progress record. A 50-question run can be killed
-- after some inserts (an Edge invocation death, a caller abort) while the last
-- committed write is the job row itself; without a heartbeat the UI only sees
-- `running` until the lease expires, so it cannot show how many questions were
-- stored and it keeps holding the pending lock.
--
-- This migration adds ONE reviewed SECURITY DEFINER routine that writes the
-- partial created/duplicate counts into result_summary and refreshes the lease.
-- It does not touch the table, the existing job routines, their grants or RLS.
--
-- Security:
--   * it re-derives the actor from auth.uid() and requires the owner role, exactly
--     like vnagent_generation_job_get/_finish;
--   * it only updates a job the caller created that is STILL running with the
--     expected version, so a late heartbeat can never resurrect or alter a
--     finished job;
--   * it never bumps `version`, so the terminal finish call that captured the
--     start version still succeeds;
--   * no direct table grant is added; authenticated callers only get EXECUTE.

-- ────────────────────────────────────────────────────────────────────────────
-- vnagent_generation_job_progress (heartbeat, non-terminal)
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.vnagent_generation_job_progress(
  p_job_id uuid,
  p_expected_version integer,
  p_created integer,
  p_duplicate integer
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_job public.vnagent_generation_jobs%rowtype;
  -- Same 120s lease vnagent_generation_job_start grants; a heartbeat pushed after
  -- each stored question keeps a slow batch from being reaped mid-flight.
  v_lease_seconds integer := 120;
begin
  if v_actor is null or not public.has_role(v_actor, 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_job_id is null then
    raise exception 'job_not_found' using errcode = 'P0001';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'invalid_version' using errcode = '22023';
  end if;
  -- Counts are non-negative running totals; a negative value is a bug, never a
  -- silent clamp.
  if p_created is null or p_created < 0 or p_duplicate is null or p_duplicate < 0 then
    raise exception 'invalid_counts' using errcode = '22023';
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

  -- Merge, never replace: any allowlisted key already on the row stays. `version`
  -- is deliberately NOT bumped, so the still-pending terminal write is not
  -- invalidated by a heartbeat that raced in just before it.
  update public.vnagent_generation_jobs
     set result_summary = result_summary || jsonb_build_object('created', p_created, 'duplicate', p_duplicate),
         lease_expires_at = now() + make_interval(secs => v_lease_seconds),
         updated_at = now()
   where id = p_job_id
   returning * into v_job;

  return jsonb_build_object('job', to_jsonb(v_job), 'abandoned', false);
end;
$$;

revoke all on function public.vnagent_generation_job_progress(uuid, integer, integer, integer) from public, anon;
grant execute on function public.vnagent_generation_job_progress(uuid, integer, integer, integer) to authenticated, service_role;

-- Rollback:
--   drop function if exists public.vnagent_generation_job_progress(uuid, integer, integer, integer);
-- No table or data change is required. Heartbeats only merged created/duplicate
-- into result_summary and moved lease_expires_at forward, both of which the
-- existing terminal finish routine overwrites/clears.
