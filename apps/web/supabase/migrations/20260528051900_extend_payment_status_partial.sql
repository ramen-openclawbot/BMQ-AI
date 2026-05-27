-- Extend payment request status for allocation-based payment tracking.

do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'payment_status'
      and e.enumlabel = 'partial'
  ) then
    alter type public.payment_status add value 'partial';
  end if;

  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'payment_status'
      and e.enumlabel = 'overpaid'
  ) then
    alter type public.payment_status add value 'overpaid';
  end if;
end $$;
