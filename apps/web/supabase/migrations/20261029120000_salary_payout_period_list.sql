-- Chi lương: the period picker read payroll_bn_payslips directly, whose RLS is owner-only, so an
-- accountant with quyền Chi lương saw "Chưa có kỳ lương nào công bố". This function returns only
-- the period id, name and publish date (no employee, no amount) to the owner and to users with
-- salary_cash view/edit. The payslips table policy is unchanged.
create or replace function public.list_salary_payout_periods()
returns table (period_id uuid, period_name text, published_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if not (
    v_uid is not null
    and (
      public.has_role(v_uid, 'owner')
      or public.has_module_permission(v_uid, 'salary_cash', 'edit')
      or public.has_module_permission(v_uid, 'salary_cash', 'view')
    )
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  select p.period_id, max(p.period_name), max(p.published_at)
  from public.payroll_bn_payslips p
  where p.period_id is not null
  group by p.period_id
  order by max(p.published_at) desc nulls last;
end;
$$;

revoke all on function public.list_salary_payout_periods() from public, anon;
grant execute on function public.list_salary_payout_periods() to authenticated, service_role;

comment on function public.list_salary_payout_periods() is
  'Owner / salary_cash: payroll Q7 periods (id, name, publish date) for the Chi lương picker; no employee or amount data.';
