-- Demo 3 stage 3B — server-authority write safety RPCs.
--
-- Replaces two direct client writes with security-definer RPCs so the server
-- re-reads mutable state, locks the target row and applies business rules
-- atomically:
--   * public.reject_payment_request            (module: payment_requests)
--   * public.transition_warehouse_dispatch_status (module: inventory)
--
-- Follows the actor/permission pattern of
-- public.approve_payment_request_with_material_controller (20260817170000):
--   actor := auth.uid(); service_role may act without an actor, otherwise the
--   actor is mandatory and must hold owner role or edit permission on the
--   module. Execute is revoked from public/anon and granted to
--   authenticated/service_role only.

create or replace function public.reject_payment_request(
  p_payment_request_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_pr public.payment_requests%rowtype;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'authenticated actor required' using errcode = '42501'; end if;
  end if;
  if not (
    coalesce(public.material_master_jwt_role(), '') = 'service_role'
    or public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'payment_requests', 'edit')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if length(v_reason) < 3 then
    raise exception 'rejection_reason_required' using errcode = '22023';
  end if;

  select * into v_pr
  from public.payment_requests
  where id = p_payment_request_id
  for update;
  if not found then
    raise exception 'payment request not found' using errcode = 'P0002';
  end if;

  if v_pr.status::text = 'rejected' and v_pr.rejection_reason = v_reason then
    return jsonb_build_object(
      'status', 'rejected',
      'payment_request_id', p_payment_request_id,
      'idempotent', true
    );
  end if;

  if v_pr.status::text <> 'pending' then
    raise exception 'invalid_status' using errcode = 'P0001', detail = format('current_status=%s', v_pr.status);
  end if;

  if v_pr.payment_status::text <> 'unpaid'
     or exists (
       select 1 from public.payment_allocations
       where payment_request_id = p_payment_request_id
     ) then
    raise exception 'has_payments' using errcode = 'P0001', detail = format('payment_status=%s', v_pr.payment_status);
  end if;

  -- Keep the exact columns the legacy client wrote so the audit shape is
  -- unchanged; only the authority moved from client to server.
  update public.payment_requests
  set status = 'rejected'::payment_request_status,
      rejection_reason = v_reason,
      approved_by = null,
      approved_at = now(),
      updated_at = now()
  where id = p_payment_request_id;

  return jsonb_build_object(
    'status', 'rejected',
    'payment_request_id', p_payment_request_id,
    'idempotent', false
  );
end;
$$;

revoke execute on function public.reject_payment_request(uuid, text) from public, anon;
grant execute on function public.reject_payment_request(uuid, text) to authenticated, service_role;

comment on function public.reject_payment_request(uuid, text) is 'Stage3 server-authority rejection wrapper: locks the payment request, rejects only pending unpaid requests without allocations, and is idempotent for an identical repeated rejection.';

create or replace function public.transition_warehouse_dispatch_status(
  p_dispatch_id uuid,
  p_new_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_dispatch public.warehouse_dispatches%rowtype;
  v_item public.warehouse_dispatch_items%rowtype;
  v_inventory public.inventory_items%rowtype;
  v_match_count integer;
  v_new_status public.warehouse_dispatch_status;
  v_allowed boolean;
  v_deducted jsonb := '[]'::jsonb;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'authenticated actor required' using errcode = '42501'; end if;
  end if;
  if not (
    coalesce(public.material_master_jwt_role(), '') = 'service_role'
    or public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'inventory', 'edit')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select * into v_dispatch
  from public.warehouse_dispatches
  where id = p_dispatch_id
  for update;
  if not found then
    raise exception 'warehouse dispatch not found' using errcode = 'P0002';
  end if;

  -- Same status is a no-op: never deduct stock twice.
  if v_dispatch.status::text = p_new_status then
    return jsonb_build_object(
      'status', v_dispatch.status,
      'dispatch_id', p_dispatch_id,
      'idempotent', true,
      'deducted', '[]'::jsonb
    );
  end if;

  v_allowed :=
    (v_dispatch.status::text = 'pending' and p_new_status = 'picked')
    or (v_dispatch.status::text = 'picked' and p_new_status = 'dispatched')
    or (v_dispatch.status::text = 'dispatched' and p_new_status = 'delivered');
  if not v_allowed then
    raise exception 'invalid_transition' using errcode = 'P0001',
      detail = format('current_status=%s requested_status=%s', v_dispatch.status, p_new_status);
  end if;

  v_new_status := p_new_status::public.warehouse_dispatch_status;

  if p_new_status = 'dispatched' then
    for v_item in
      select * from public.warehouse_dispatch_items
      where dispatch_id = p_dispatch_id
      order by id
    loop
      if v_item.quantity is null
         or v_item.quantity <= 0
         or v_item.quantity <> trunc(v_item.quantity) then
        raise exception 'invalid_quantity' using errcode = 'P0001',
          detail = format('product_name=%s quantity=%s', v_item.product_name, v_item.quantity);
      end if;

      select count(*) into v_match_count
      from public.inventory_items
      where lower(btrim(name)) = lower(btrim(v_item.product_name));
      if v_match_count = 0 then
        raise exception 'inventory_item_not_found' using errcode = 'P0001', detail = v_item.product_name;
      elsif v_match_count > 1 then
        raise exception 'inventory_item_ambiguous' using errcode = 'P0001', detail = v_item.product_name;
      end if;

      select * into v_inventory
      from public.inventory_items
      where lower(btrim(name)) = lower(btrim(v_item.product_name))
      for update;

      -- Never clamp to zero: refuse the whole transaction when stock is short.
      if v_inventory.quantity < v_item.quantity then
        raise exception 'insufficient_stock' using errcode = 'P0001',
          detail = format('inventory_item_id=%s available=%s required=%s', v_inventory.id, v_inventory.quantity, v_item.quantity);
      end if;

      update public.inventory_items
      set quantity = quantity - v_item.quantity,
          updated_at = now()
      where id = v_inventory.id;

      insert into public.inventory_movements (
        movement_type,
        inventory_item_id,
        quantity,
        unit,
        reference_type,
        reference_id,
        movement_date,
        notes,
        created_by
      ) values (
        'dispatch_out'::public.inventory_movement_type,
        v_inventory.id,
        -v_item.quantity,
        v_item.unit,
        'dispatch',
        p_dispatch_id,
        (now() at time zone 'Asia/Ho_Chi_Minh')::date,
        'Xuất kho ' || v_dispatch.dispatch_number,
        v_actor
      );

      v_deducted := v_deducted || jsonb_build_object(
        'inventory_item_id', v_inventory.id,
        'quantity', v_item.quantity
      );
    end loop;
  end if;

  if p_new_status = 'delivered' then
    update public.warehouse_dispatches
    set status = v_new_status,
        delivered_date = (now() at time zone 'Asia/Ho_Chi_Minh')::date,
        updated_at = now()
    where id = p_dispatch_id;
  else
    update public.warehouse_dispatches
    set status = v_new_status,
        updated_at = now()
    where id = p_dispatch_id;
  end if;

  return jsonb_build_object(
    'status', v_new_status,
    'dispatch_id', p_dispatch_id,
    'idempotent', false,
    'deducted', v_deducted
  );
end;
$$;

revoke execute on function public.transition_warehouse_dispatch_status(uuid, text) from public, anon;
grant execute on function public.transition_warehouse_dispatch_status(uuid, text) to authenticated, service_role;

comment on function public.transition_warehouse_dispatch_status(uuid, text) is 'Stage3 server-authority dispatch transition wrapper: locks the dispatch, allows only pending->picked, picked->dispatched, dispatched->delivered, deducts stock with movement ledger on dispatch without clamping negative stock, and is idempotent when the requested status equals the current status.';
