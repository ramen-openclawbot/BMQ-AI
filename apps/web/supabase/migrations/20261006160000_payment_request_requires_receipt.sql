-- Phiếu chi không nhập kho (VAT, thuế, dịch vụ) — server side, additive only.
--
-- A payment request can be flagged as "không nhập kho": it has no goods receipt
-- and no invoice to deliver, so it is complete once paid. This migration only:
--   * adds requires_receipt / no_receipt_reason / no_receipt_set_by /
--     no_receipt_set_at to public.payment_requests (default true keeps every
--     existing row on the old delivery + invoice flow),
--   * adds a check constraint requiring a reason of at least 3 characters when
--     requires_receipt = false,
--   * adds the SECURITY DEFINER RPC public.set_payment_request_requires_receipt
--     for owner / payment_requests edit users to toggle the flag under lock,
--   * appends one audit_logs row using the existing table shape.
--
-- It does not change amounts, payments, payment_allocations, approval or
-- rejection functions and schedules no cron job. The UI is built separately.

-- ---------------------------------------------------------------------------
-- 1. Additive columns.
-- ---------------------------------------------------------------------------
alter table public.payment_requests
  add column if not exists requires_receipt boolean not null default true,
  add column if not exists no_receipt_reason text,
  add column if not exists no_receipt_set_by uuid,
  add column if not exists no_receipt_set_at timestamptz;

comment on column public.payment_requests.requires_receipt is
  'False for a phiếu chi không nhập kho (VAT/thuế/dịch vụ): no goods receipt or invoice is required. Legacy rows default to true.';
comment on column public.payment_requests.no_receipt_reason is
  'Operator reason for marking the request as không nhập kho (min 3 characters, required while requires_receipt = false).';
comment on column public.payment_requests.no_receipt_set_by is
  'Actor that switched the request to requires_receipt = false; null when switched back to true.';
comment on column public.payment_requests.no_receipt_set_at is
  'When the request was switched to requires_receipt = false; null when switched back to true.';

-- ---------------------------------------------------------------------------
-- 2. Check constraint: a no-receipt request must carry a reason >= 3 chars.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_requests_no_receipt_reason_check'
      and conrelid = 'public.payment_requests'::regclass
  ) then
    alter table public.payment_requests
      add constraint payment_requests_no_receipt_reason_check
      check (requires_receipt = true or length(btrim(no_receipt_reason)) >= 3);
  end if;

  -- `length(btrim(null))` is null, and a CHECK passes on null, so guard the
  -- presence of the reason explicitly to close that gap.
  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_requests_no_receipt_reason_present_check'
      and conrelid = 'public.payment_requests'::regclass
  ) then
    alter table public.payment_requests
      add constraint payment_requests_no_receipt_reason_present_check
      check (requires_receipt = true or no_receipt_reason is not null);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Server-authority toggle RPC.
--
-- Follows the actor/permission pattern of public.reject_payment_request
-- (20261003100000): the actor is mandatory for non-service callers and must be
-- owner or hold payment_requests edit permission. The row is locked FOR UPDATE
-- and a linked goods receipt / purchase order can never be switched to
-- no-receipt. Execute is revoked from public/anon.
-- ---------------------------------------------------------------------------
create or replace function public.set_payment_request_requires_receipt(
  p_request_id uuid,
  p_requires_receipt boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_requires boolean := coalesce(p_requires_receipt, true);
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

  select * into v_pr
  from public.payment_requests
  where id = p_request_id
  for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;

  if v_pr.status::text = 'rejected' then
    raise exception 'invalid_status' using errcode = 'P0001',
      detail = format('current_status=%s', v_pr.status);
  end if;

  if not v_requires then
    -- A request already bound to a goods receipt or a purchase order stays on
    -- the delivery + invoice flow; it cannot become không nhập kho.
    if v_pr.goods_receipt_id is not null or v_pr.purchase_order_id is not null then
      raise exception 'receipt_linked' using errcode = 'P0001';
    end if;
    if length(v_reason) < 3 then
      raise exception 'reason_required' using errcode = '22023';
    end if;

    update public.payment_requests
    set requires_receipt = false,
        no_receipt_reason = v_reason,
        no_receipt_set_by = v_actor,
        no_receipt_set_at = now(),
        updated_at = now()
    where id = p_request_id;
  else
    update public.payment_requests
    set requires_receipt = true,
        no_receipt_reason = null,
        no_receipt_set_by = null,
        no_receipt_set_at = null,
        updated_at = now()
    where id = p_request_id;
  end if;

  -- Existing audit_logs shape is (actor_id, action, target_id, metadata): it is
  -- compatible, so append one actor/time row there too.
  insert into public.audit_logs (actor_id, action, target_id, metadata)
  values (
    v_actor,
    'payment_request_requires_receipt_changed',
    p_request_id,
    jsonb_build_object(
      'requires_receipt', v_requires,
      'no_receipt_reason', case when v_requires then null else v_reason end,
      'changed_at', now()
    )
  );

  return jsonb_build_object(
    'id', p_request_id,
    'requires_receipt', v_requires,
    'no_receipt_reason', case when v_requires then null else v_reason end
  );
end;
$$;

revoke all on function public.set_payment_request_requires_receipt(uuid, boolean, text) from public, anon;
grant execute on function public.set_payment_request_requires_receipt(uuid, boolean, text) to authenticated, service_role;

comment on function public.set_payment_request_requires_receipt(uuid, boolean, text) is
  'Owner / payment_requests edit RPC: locks one payment request, switches it to không nhập kho with a reason >= 3 chars (or back to requiring a receipt), refuses rejected requests (invalid_status) and receipt/PO-linked requests (receipt_linked), appends an audit_logs row, and returns {id, requires_receipt, no_receipt_reason}.';
