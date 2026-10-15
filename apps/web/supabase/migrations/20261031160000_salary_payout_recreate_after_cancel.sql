-- Chi lương: re-creating a period after Huỷ phiếu replayed the cancelled payout,
-- because the client key is per period (salary-payout:create:<period_id>). A replay
-- that points at a cancelled payout now releases the key and creates a new payout.
-- Body copied from 20261029140000; only the replay block changed. Grants unchanged.
create or replace function public.create_salary_payout(
  p_period_id uuid,
  p_idempotency_key text,
  p_exclusions jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_prior jsonb;
  v_period public.payroll_bn_periods%rowtype;
  v_exclusions jsonb := coalesce(p_exclusions, '[]'::jsonb);
  v_employee_count integer := 0;
  v_total numeric := 0;
  v_day text;
  v_seq integer;
  v_payout_number text;
  v_payout_id uuid;
  v_attempt integer := 0;
  v_result jsonb;
begin
  if not (
    v_is_service
    or (
      v_actor is not null
      and (
        public.has_role(v_actor, 'owner')
        or public.has_module_permission(v_actor, 'salary_cash', 'edit')
      )
    )
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_period_id is null then
    raise exception 'period_id_required' using errcode = '22023';
  end if;
  if v_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('salary_payout_create:' || v_key));

  -- Idempotent replay, except when the replayed payout was cancelled: then the key
  -- is released so the period can be created again (re-create after Huỷ phiếu).
  select result into v_prior
  from public.salary_payout_idempotency
  where idempotency_key = v_key;
  if found then
    if exists (
      select 1 from public.salary_payouts sp
      where sp.id = nullif(v_prior->>'payout_id', '')::uuid
        and sp.status = 'cancelled'
    ) then
      delete from public.salary_payout_idempotency where idempotency_key = v_key;
    else
      return v_prior || jsonb_build_object('replayed', true);
    end if;
  end if;

  select * into v_period
  from public.payroll_bn_periods
  where id = p_period_id;
  if not found then
    raise exception 'period_not_found' using errcode = 'P0002';
  end if;

  -- Published payslips are the only source; payroll_bn is never modified.
  if not exists (
    select 1
    from public.payroll_bn_payslips p
    where p.period_id = p_period_id
      and p.net_pay > 0
  ) then
    raise exception 'no_published_payslips' using errcode = 'P0001';
  end if;

  -- At most one live (non-cancelled) payout per period.
  if exists (
    select 1
    from public.salary_payouts sp
    where sp.payroll_period_id = p_period_id
      and sp.status <> 'cancelled'
  ) then
    raise exception 'payout_already_exists' using errcode = 'P0001';
  end if;

  -- Exclusion payload shape: a jsonb array of objects, each with a non-blank
  -- employee_code text and no duplicate code.
  if jsonb_typeof(v_exclusions) <> 'array' then
    raise exception 'invalid_exclusions' using errcode = '22023', detail = 'not_array';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_exclusions) m
    where jsonb_typeof(m) <> 'object'
       or not (m ? 'employee_code')
       or jsonb_typeof(m->'employee_code') <> 'string'
       or btrim(m->>'employee_code') = ''
  ) then
    raise exception 'invalid_exclusions' using errcode = '22023', detail = 'invalid_item';
  end if;
  if (
    select count(*) <> count(distinct btrim(m->>'employee_code'))
    from jsonb_array_elements(v_exclusions) m
  ) then
    raise exception 'invalid_exclusions' using errcode = '22023', detail = 'duplicate_employee_code';
  end if;

  -- Every reason is required and 3..200 chars after btrim.
  if exists (
    select 1
    from jsonb_array_elements(v_exclusions) m
    where (m ? 'reason' and jsonb_typeof(m->'reason') <> 'string')
       or char_length(btrim(coalesce(m->>'reason', ''))) not between 3 and 200
  ) then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  -- Every excluded code must belong to this period's published snapshot.
  if exists (
    select 1
    from jsonb_array_elements(v_exclusions) m
    where not exists (
      select 1
      from public.payroll_bn_payslips p
      where p.period_id = p_period_id
        and p.net_pay > 0
        and p.employee_code = btrim(m->>'employee_code')
    )
  ) then
    raise exception 'unknown_employee_code' using errcode = '22023';
  end if;

  -- Count/sum only the non-excluded employees.
  select count(*), coalesce(sum(p.net_pay), 0)
    into v_employee_count, v_total
  from public.payroll_bn_payslips p
  where p.period_id = p_period_id
    and p.net_pay > 0
    and not exists (
      select 1
      from jsonb_array_elements(v_exclusions) m
      where btrim(m->>'employee_code') = p.employee_code
    );

  if v_employee_count < 1 then
    raise exception 'no_employees_left' using errcode = 'P0001';
  end if;

  -- SAL-YYMMDD-NN under an advisory lock, with a retry on a rare collision.
  v_day := to_char((now() at time zone 'Asia/Ho_Chi_Minh'), 'YYMMDD');
  perform pg_advisory_xact_lock(hashtext('salary_payout_number:' || v_day));

  loop
    v_attempt := v_attempt + 1;
    select coalesce(max(right(sp.payout_number, 2)::integer), 0) + 1
      into v_seq
    from public.salary_payouts sp
    where sp.payout_number like 'SAL-' || v_day || '-%';
    v_payout_number := 'SAL-' || v_day || '-' || lpad(v_seq::text, 2, '0');

    begin
      insert into public.salary_payouts (
        payout_number,
        payroll_period_id,
        period_name,
        employee_count,
        total_amount,
        status,
        created_by
      ) values (
        v_payout_number,
        p_period_id,
        v_period.period_name,
        v_employee_count,
        v_total,
        'pending',
        v_actor
      )
      returning id into v_payout_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into public.salary_payout_lines (
    payout_id, employee_code, employee_name, net_pay
  )
  select
    v_payout_id, p.employee_code, p.employee_name, p.net_pay
  from public.payroll_bn_payslips p
  where p.period_id = p_period_id
    and p.net_pay > 0
    and not exists (
      select 1
      from jsonb_array_elements(v_exclusions) m
      where btrim(m->>'employee_code') = p.employee_code
    )
  order by p.employee_code;

  -- Snapshot each exclusion with the employee name/net_pay from the payslip.
  insert into public.salary_payout_exclusions (
    payout_id, employee_code, employee_name, net_pay, reason, created_by
  )
  select
    v_payout_id, p.employee_code, p.employee_name, p.net_pay, btrim(m->>'reason'), v_actor
  from jsonb_array_elements(v_exclusions) m
  join public.payroll_bn_payslips p
    on p.period_id = p_period_id
   and p.net_pay > 0
   and p.employee_code = btrim(m->>'employee_code')
  order by p.employee_code;

  insert into public.finance_zalo_notifications (
    event_type, entity_id, group_key, message_body, status
  ) values (
    'salary_payout_created',
    v_payout_id,
    'finance',
    coalesce(
      public.build_finance_zalo_salary_payout_message(v_payout_id, 'salary_payout_created'),
      'Chi lương: ' || v_payout_number
    ),
    'pending'
  )
  on conflict (event_type, entity_id) do nothing;

  v_result := jsonb_build_object(
    'payout_id', v_payout_id,
    'payout_number', v_payout_number,
    'period_name', v_period.period_name,
    'employee_count', v_employee_count,
    'total_amount', v_total,
    'status', 'pending',
    'replayed', false
  );

  insert into public.salary_payout_idempotency (
    idempotency_key, payout_id, result, created_by
  ) values (
    v_key, v_payout_id, v_result, v_actor
  )
  on conflict (idempotency_key) do nothing;

  return v_result;
end;
$$;

revoke all on function public.create_salary_payout(uuid, text, jsonb) from public, anon;
grant execute on function public.create_salary_payout(uuid, text, jsonb) to authenticated, service_role;
