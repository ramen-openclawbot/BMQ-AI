-- Rollback-only smoke on PR-5C3C04AC (pending): lines stored with legacy units "Hôp"/"Cuôn".
-- 1) a no-op/qty edit of those lines must pass, 2) the app's edit controller must accept the
-- unchanged document, 3) a real unit change on an evidence line must still be rejected.
begin;
__MIGRATION__
do $$
declare r jsonb; v_lines jsonb; blocked boolean := false;
begin
  update public.payment_request_items set notes = notes
   where payment_request_id = 'c76ce066-3b73-4501-b3af-441b7592d121' and unit in ('Hôp','Cuôn');
  if not found then raise exception 'SMOKE fixture lines not found'; end if;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select jsonb_agg(jsonb_build_object('id', id, 'product_name', product_name, 'unit', unit, 'quantity', quantity, 'unit_price', unit_price, 'notes', notes))
    into v_lines from public.payment_request_items where payment_request_id = 'c76ce066-3b73-4501-b3af-441b7592d121';
  r := public.update_procurement_document_with_material_controller('payment_request', 'c76ce066-3b73-4501-b3af-441b7592d121', '{}'::jsonb, v_lines, null);
  if (r->>'updated_items_count')::int <> jsonb_array_length(v_lines) then raise exception 'SMOKE controller %', r; end if;

  begin
    update public.payment_request_items set unit = 'kg'
     where payment_request_id = 'c76ce066-3b73-4501-b3af-441b7592d121' and unit = 'Hôp';
  exception when sqlstate '23514' then blocked := true;
  end;
  if not blocked then raise exception 'SMOKE identity guard no longer blocks a real unit change'; end if;
  raise exception 'SMOKE_RESULT ok controller=%', r;
end $$;
rollback;
