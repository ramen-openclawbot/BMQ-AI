-- Read-only smoke check for public.supplier_profile_overview().
--
-- Run against a database where the migration has been applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/smoke_supplier_profile_overview.sql
--
-- Everything runs inside BEGIN ... ROLLBACK, so no row is written.

begin;

set local request.jwt.claim.role = 'service_role';

do $$
declare
  v_result jsonb;
  v_first jsonb;
  v_key text;
  v_keys text[] := array[
    'id',
    'name',
    'email',
    'phone',
    'contact_name',
    'address',
    'default_receiving_location',
    'payment_terms_days',
    'default_payment_method',
    'order_item_count',
    'last_purchase_at',
    'active_60d',
    'unpaid_count',
    'unpaid_amount',
    'missing'
  ];
  v_row_count bigint;
  v_supplier_count bigint;
begin
  v_result := public.supplier_profile_overview();

  if jsonb_typeof(v_result) <> 'array' then
    raise exception 'supplier_profile_overview must return a jsonb array, got %',
      jsonb_typeof(v_result);
  end if;

  v_row_count := jsonb_array_length(v_result);

  select count(*) into v_supplier_count from public.suppliers;
  if v_row_count <> v_supplier_count then
    raise exception 'supplier_profile_overview returned % rows, suppliers has %',
      v_row_count, v_supplier_count;
  end if;

  if v_row_count > 0 then
    v_first := v_result -> 0;

    foreach v_key in array v_keys loop
      if not (v_first ? v_key) then
        raise exception 'supplier_profile_overview first row is missing key %', v_key;
      end if;
    end loop;

    if jsonb_typeof(v_first -> 'missing') <> 'array' then
      raise exception 'supplier_profile_overview first row missing must be an array, got %',
        jsonb_typeof(v_first -> 'missing');
    end if;
  end if;

  raise notice 'supplier_profile_overview smoke OK: % rows', v_row_count;
end $$;

rollback;
