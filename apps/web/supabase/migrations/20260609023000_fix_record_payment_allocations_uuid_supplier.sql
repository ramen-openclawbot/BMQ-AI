-- Fix record_payment_allocations on PostgreSQL: uuid has no built-in min(uuid)
-- aggregate. Pick the single supplier via ordered array aggregation instead.

create or replace function public.record_payment_allocations(
  p_allocations jsonb,
  p_payment_method public.payment_method_type default null,
  p_payment_date date default current_date,
  p_reference_number text default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  payment_id uuid;
  payment_total numeric;
  supplier_count integer;
  selected_supplier_id uuid;
begin
  if not (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
  ) then
    raise exception 'Insufficient permission to record payments';
  end if;

  if jsonb_typeof(p_allocations) is distinct from 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Payment allocations must be a non-empty JSON array';
  end if;

  drop table if exists pg_temp.tmp_payment_allocations;
  create temporary table tmp_payment_allocations (
    payment_request_id uuid primary key,
    amount numeric not null
  ) on commit drop;

  insert into tmp_payment_allocations(payment_request_id, amount)
  select
    (item->>'payment_request_id')::uuid,
    (item->>'amount')::numeric
  from jsonb_array_elements(p_allocations) item;

  if exists (select 1 from tmp_payment_allocations where amount <= 0) then
    raise exception 'Payment allocation amount must be greater than zero';
  end if;

  if exists (
    select 1
    from tmp_payment_allocations a
    left join public.payment_requests pr on pr.id = a.payment_request_id
    where pr.id is null
  ) then
    raise exception 'One or more payment requests do not exist';
  end if;

  perform 1
  from public.payment_requests pr
  join tmp_payment_allocations a on a.payment_request_id = pr.id
  for update of pr;

  if exists (
    select 1
    from tmp_payment_allocations a
    join public.payment_requests pr on pr.id = a.payment_request_id
    where a.amount > greatest(coalesce(pr.total_amount, 0) - coalesce((
      select sum(pa.amount)
      from public.payment_allocations pa
      where pa.payment_request_id = pr.id
    ), 0), 0)
  ) then
    raise exception 'Payment allocation exceeds remaining amount';
  end if;

  select sum(amount) into payment_total from tmp_payment_allocations;

  select
    count(distinct pr.supplier_id),
    (array_agg(distinct pr.supplier_id order by pr.supplier_id))[1]
  into supplier_count, selected_supplier_id
  from tmp_payment_allocations a
  join public.payment_requests pr on pr.id = a.payment_request_id;

  perform pg_advisory_xact_lock(hashtext('public.payments.payment_number'));

  insert into public.payments (
    payment_number,
    supplier_id,
    payment_date,
    amount,
    payment_method,
    reference_number,
    notes,
    created_by
  )
  values (
    public.next_payment_number(),
    case when supplier_count = 1 then selected_supplier_id else null end,
    coalesce(p_payment_date, current_date),
    payment_total,
    p_payment_method,
    nullif(trim(p_reference_number), ''),
    nullif(trim(p_notes), ''),
    auth.uid()
  )
  returning id into payment_id;

  insert into public.payment_allocations(payment_id, payment_request_id, amount, created_by)
  select payment_id, payment_request_id, amount, auth.uid()
  from tmp_payment_allocations;

  return payment_id;
end;
$$;

grant execute on function public.record_payment_allocations(jsonb, public.payment_method_type, date, text, text) to authenticated;
grant execute on function public.record_payment_allocations(jsonb, public.payment_method_type, date, text, text) to service_role;
