-- Form riêng "Tạo chi tiền mặt": nhiều khoản lẻ, đọc nhiều hoá đơn, không cần
-- NCC và không nhập kho.
--
-- Additive only. This migration:
--   (a) adds public.cash_pr_idempotency (server-side replay ledger, service-role
--       only: no client read/write),
--   (b) adds public.create_cash_payment_request(p_payload jsonb, p_idempotency_key text):
--       one atomic, idempotent cash payment request with 1..30 khoản.
--
-- The existing payment_request_created enqueue trigger (20261006120000) reads
-- only the PR header (request_number, supplier, total, PO/GRN) and never the
-- items, so inserting the payment_requests row first and its items afterwards
-- yields exactly one correct Zalo notice. No existing function or trigger is
-- changed by this migration.

-- ---------------------------------------------------------------------------
-- 1. Idempotency ledger.
-- ---------------------------------------------------------------------------
create table if not exists public.cash_pr_idempotency (
  idempotency_key text primary key,
  payment_request_id uuid not null references public.payment_requests(id) on delete cascade,
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.cash_pr_idempotency enable row level security;
revoke all on public.cash_pr_idempotency from public, anon, authenticated;
grant all on public.cash_pr_idempotency to service_role;

comment on table public.cash_pr_idempotency is
  'Server-side replay ledger for public.create_cash_payment_request: one key maps to one cash payment request. Never exposed to clients.';

-- ---------------------------------------------------------------------------
-- 2. create_cash_payment_request: one atomic cash phiếu with several khoản.
-- ---------------------------------------------------------------------------
create or replace function public.create_cash_payment_request(
  p_payload jsonb,
  p_idempotency_key text
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
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_title text;
  v_description text;
  v_items jsonb;
  v_item_count integer;
  v_item jsonb;
  v_name text;
  v_amount numeric;
  v_category text;
  v_total numeric := 0;
  v_request_number text;
  v_pr_id uuid;
  v_prior record;
  v_attempt integer;
  v_result jsonb;
begin
  -- Exactly the users the payment_requests INSERT policy allows: owner or an
  -- explicit payment_requests edit permission (service_role for trusted
  -- automation). Anything else fails closed.
  if not (
    v_is_service
    or (
      v_actor is not null
      and (
        public.has_role(v_actor, 'owner')
        or public.has_module_permission(v_actor, 'payment_requests', 'edit')
      )
    )
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if v_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  -- Idempotent replay by key (checked before and after the advisory lock).
  select i.payment_request_id, pr.request_number, pr.total_amount
    into v_prior
  from public.cash_pr_idempotency i
  join public.payment_requests pr on pr.id = i.payment_request_id
  where i.idempotency_key = v_key;
  if found then
    return jsonb_build_object(
      'payment_request_id', v_prior.payment_request_id,
      'request_number', v_prior.request_number,
      'total', coalesce(v_prior.total_amount, 0),
      'replayed', true
    );
  end if;

  perform pg_advisory_xact_lock(hashtext('cash_pr_create:' || v_key));

  select i.payment_request_id, pr.request_number, pr.total_amount
    into v_prior
  from public.cash_pr_idempotency i
  join public.payment_requests pr on pr.id = i.payment_request_id
  where i.idempotency_key = v_key;
  if found then
    return jsonb_build_object(
      'payment_request_id', v_prior.payment_request_id,
      'request_number', v_prior.request_number,
      'total', coalesce(v_prior.total_amount, 0),
      'replayed', true
    );
  end if;

  -- --- Title ---------------------------------------------------------------
  v_title := nullif(btrim(coalesce(v_payload->>'title', '')), '');
  if v_title is null or length(v_title) > 200 then
    raise exception 'invalid_title' using errcode = '22023';
  end if;

  v_description := nullif(btrim(coalesce(v_payload->>'description', '')), '');

  -- --- Items: shape, count, names and amounts ------------------------------
  v_items := v_payload->'items';
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'items_required' using errcode = '22023';
  end if;
  v_item_count := jsonb_array_length(v_items);
  if v_item_count < 1 then
    raise exception 'items_required' using errcode = '22023';
  end if;
  if v_item_count > 30 then
    raise exception 'too_many_items' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(v_items) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'invalid_item' using errcode = '22023';
    end if;

    v_name := nullif(btrim(coalesce(v_item->>'name', '')), '');
    if v_name is null or length(v_name) > 200 then
      raise exception 'invalid_item_name' using errcode = '22023';
    end if;

    if jsonb_typeof(v_item->'amount') <> 'number' then
      raise exception 'invalid_amount' using errcode = '22023';
    end if;

    v_amount := (v_item->>'amount')::numeric;
    if v_amount is null
       or v_amount <> trunc(v_amount)
       or v_amount < 1 then
      raise exception 'invalid_amount' using errcode = '22023';
    end if;
    if v_amount > 50000000 then
      raise exception 'amount_over_limit' using errcode = '22023';
    end if;

    v_total := v_total + v_amount;
  end loop;

  if v_total > 200000000 then
    raise exception 'total_over_limit' using errcode = '22023';
  end if;

  -- --- Payment request: PR-<8 upper hex> with retry on collision -----------
  v_attempt := 0;
  loop
    v_attempt := v_attempt + 1;
    v_request_number := 'PR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    begin
      insert into public.payment_requests (
        request_number,
        title,
        description,
        supplier_id,
        total_amount,
        vat_amount,
        status,
        delivery_status,
        payment_status,
        payment_type,
        payment_method,
        requires_receipt,
        no_receipt_reason,
        no_receipt_set_by,
        no_receipt_set_at,
        created_by
      ) values (
        v_request_number,
        v_title,
        v_description,
        null,
        v_total,
        0,
        'pending',
        'pending',
        'unpaid',
        'new_order',
        'cash',
        false,
        'Chi tiền mặt — không nhập kho',
        v_actor,
        now(),
        v_actor
      )
      returning id into v_pr_id;
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  -- Items after the PR so the payment_request_created trigger (header only)
  -- produces exactly one notice with the correct request_number and total.
  for v_item in select value from jsonb_array_elements(v_items) loop
    v_amount := (v_item->>'amount')::numeric;
    v_name := left(btrim(v_item->>'name'), 200);

    v_category := upper(nullif(btrim(coalesce(v_item->>'cost_category_code', '')), ''));
    if v_category is null or not exists (
      select 1
      from public.cost_categories c
      where c.code = v_category and c.is_active
    ) then
      v_category := 'UNMAPPED_REVIEW';
    end if;

    insert into public.payment_request_items (
      payment_request_id,
      product_name,
      quantity,
      unit,
      unit_price,
      line_total,
      cost_category_code,
      cost_review_routing,
      standard_cost_code_type
    ) values (
      v_pr_id,
      v_name,
      1,
      'lần',
      v_amount,
      v_amount,
      v_category,
      case when v_category = 'UNMAPPED_REVIEW' then 'needs_review' else 'none' end,
      'OTHER'
    );
  end loop;

  v_result := jsonb_build_object(
    'payment_request_id', v_pr_id,
    'request_number', v_request_number,
    'total', v_total,
    'replayed', false
  );

  insert into public.cash_pr_idempotency (idempotency_key, payment_request_id, created_by)
  values (v_key, v_pr_id, v_actor)
  on conflict (idempotency_key) do nothing;

  return v_result;
end;
$$;

revoke all on function public.create_cash_payment_request(jsonb, text) from public, anon;
grant execute on function public.create_cash_payment_request(jsonb, text) to authenticated, service_role;

comment on function public.create_cash_payment_request(jsonb, text) is
  'Owner / payment_requests edit (or service_role): validate {title, description?, items:[{name, amount, cost_category_code?}]} (1..30 items, name 1..200 chars, integer amount 1..50,000,000, total <= 200,000,000, active cost category else UNMAPPED_REVIEW), then insert one cash payment request (payment_method cash, payment_type new_order, pending/unpaid, no supplier, requires_receipt false with a no-receipt reason) and one item per khoản (quantity 1, unit lần, unit_price = line_total = amount, standard_cost_code_type OTHER) with a server-generated PR-XXXXXXXX number. Idempotent by key. Returns {payment_request_id, request_number, total, replayed}.';
