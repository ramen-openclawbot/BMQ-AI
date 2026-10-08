-- Khoá đặt hàng thủ công cho đại lý nợ công nợ — server side, additive only.
--
-- A Mini CRM customer can be manually locked from placing dealer orders. This
-- migration only:
--   * adds order_locked / order_locked_at / order_locked_by / order_lock_reason
--     to public.mini_crm_customers (default false keeps every existing customer
--     ordering as before),
--   * adds revoked_reason to public.dealer_sessions so a lock can distinguish
--     revoked sessions that were closed by this feature,
--   * adds the SECURITY DEFINER RPC public.set_dealer_order_lock for owner /
--     crm edit users to toggle the lock under row lock and revoke every active
--     dealer session of the customer,
--   * appends one audit_logs row using the existing table shape.
--
-- It does not change existing RLS policies, the is_active (Tạm ngưng) flow or
-- any other dealer endpoint. The UI is built separately.

-- ---------------------------------------------------------------------------
-- 1. Additive columns.
-- ---------------------------------------------------------------------------
alter table public.mini_crm_customers
  add column if not exists order_locked boolean not null default false,
  add column if not exists order_locked_at timestamptz,
  add column if not exists order_locked_by uuid,
  add column if not exists order_lock_reason text;

comment on column public.mini_crm_customers.order_locked is
  'True while the dealer is manually blocked from placing orders (công nợ). Legacy rows default to false.';
comment on column public.mini_crm_customers.order_locked_at is
  'When the customer was switched to order_locked = true; cleared on unlock.';
comment on column public.mini_crm_customers.order_locked_by is
  'Actor that switched the customer to order_locked = true; cleared on unlock.';
comment on column public.mini_crm_customers.order_lock_reason is
  'Optional operator reason captured when the customer was locked; cleared on unlock.';

alter table public.dealer_sessions
  add column if not exists revoked_reason text;

comment on column public.dealer_sessions.revoked_reason is
  'Why a dealer session was revoked; "order_locked" when the customer order lock revoked it.';

-- ---------------------------------------------------------------------------
-- 2. Server-authority toggle RPC.
--
-- Only owner or holders of crm edit permission may call it. The customer row is
-- locked FOR UPDATE, all active dealer sessions are revoked when locking, and an
-- audit_logs row is appended for every accepted call.
-- ---------------------------------------------------------------------------
create or replace function public.set_dealer_order_lock(
  p_customer_id uuid,
  p_locked boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_locked boolean := coalesce(p_locked, false);
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_customer public.mini_crm_customers%rowtype;
  v_revoked integer := 0;
begin
  if auth.uid() is null then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if not (
    public.has_role(auth.uid(), 'owner')
    or public.has_module_permission(auth.uid(), 'crm', 'edit')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select * into v_customer
  from public.mini_crm_customers
  where id = p_customer_id
  for update;
  if not found then
    raise exception 'customer_not_found' using errcode = 'P0002';
  end if;

  -- Idempotent: only rewrite the lock fields when the state actually changes.
  if v_customer.order_locked is distinct from v_locked then
    if v_locked then
      update public.mini_crm_customers
      set order_locked = true,
          order_locked_at = now(),
          order_locked_by = v_actor,
          order_lock_reason = v_reason
      where id = p_customer_id;
    else
      update public.mini_crm_customers
      set order_locked = false,
          order_locked_at = null,
          order_locked_by = null,
          order_lock_reason = null
      where id = p_customer_id;
    end if;
  end if;

  -- Locking revokes every still-active session of this customer exactly once.
  -- Unlocking never restores or touches sessions.
  if v_locked then
    update public.dealer_sessions
    set revoked_at = now(),
        revoked_reason = 'order_locked'
    where customer_id = p_customer_id
      and revoked_at is null;
    get diagnostics v_revoked = row_count;
  end if;

  -- Existing audit_logs shape is (actor_id, action, target_id, metadata).
  insert into public.audit_logs (actor_id, action, target_id, metadata)
  values (
    v_actor,
    case when v_locked then 'dealer_order_lock' else 'dealer_order_unlock' end,
    p_customer_id,
    jsonb_build_object(
      'reason', case when v_locked then v_reason else null end,
      'revoked_session_count', v_revoked
    )
  );

  return jsonb_build_object(
    'customer_id', p_customer_id,
    'order_locked', v_locked,
    'revoked_sessions', v_revoked
  );
end;
$$;

revoke all on function public.set_dealer_order_lock(uuid, boolean, text) from public, anon;
grant execute on function public.set_dealer_order_lock(uuid, boolean, text) to authenticated, service_role;

comment on function public.set_dealer_order_lock(uuid, boolean, text) is
  'Owner / crm edit RPC: locks or unlocks manual dealer ordering for one Mini CRM customer, revokes every active dealer session when locking, appends an audit_logs row and returns {customer_id, order_locked, revoked_sessions}.';
