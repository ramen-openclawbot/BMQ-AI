-- Staff decisions are durable before any partner write. Browser cannot write this ledger.
create table if not exists public.kfm_po_intake_attempts (
  vendor_id bigint not null check (vendor_id > 0),
  order_id bigint not null check (order_id > 0),
  po_number text not null unique check (po_number = upper(btrim(po_number)) and po_number <> ''),
  actor_id uuid not null references auth.users(id),
  request_id uuid not null unique,
  decision text not null check (decision in ('confirm','reject')),
  reason text,
  state text not null default 'sending' check (state in ('sending','imported','rejected')),
  content_revision text not null,
  snapshot jsonb not null,
  inbox_id uuid references public.customer_po_inbox(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (vendor_id, order_id),
  check (decision <> 'reject' or (reason is not null and length(btrim(reason)) between 1 and 1000))
);
alter table public.kfm_po_intake_attempts enable row level security;
revoke all on public.kfm_po_intake_attempts from public, anon, authenticated;
grant all on public.kfm_po_intake_attempts to service_role;

-- Existing Kingfood email PO numbers are canonical dedupe evidence, never re-imported.
create or replace function public.kfm_existing_po_numbers()
returns table(po_number text)
language sql stable security definer set search_path = public
as $$
  select distinct upper(btrim(i.po_number)) from public.customer_po_inbox i
  where i.po_number is not null and (lower(i.from_email) in ('dathang@kingfoodmart.com','portal@kingfoodmart.com') or i.raw_payload->>'source' = 'kfm_portal');
$$;
revoke all on function public.kfm_existing_po_numbers() from public, anon, authenticated;
grant execute on function public.kfm_existing_po_numbers() to service_role;

-- Resolve only existing unambiguous CRM evidence; no fuzzy customer-name guess.
create or replace function public.kfm_intake_customer_id()
returns uuid language plpgsql stable security definer set search_path = public
as $$
declare v_count integer; v_customer uuid;
begin
  select count(distinct matched_customer_id), (array_agg(distinct matched_customer_id) filter (where matched_customer_id is not null))[1]
  into v_count, v_customer from public.customer_po_inbox where lower(from_email) = 'dathang@kingfoodmart.com';
  if v_count <> 1 or v_customer is null then raise exception 'Kingfood customer mapping is missing or ambiguous'; end if;
  return v_customer;
end;
$$;
revoke all on function public.kfm_intake_customer_id() from public, anon, authenticated;
grant execute on function public.kfm_intake_customer_id() to service_role;

-- The Edge handler calls this only after portal confirmation AND content readback.
-- Serialize by canonical PO as well as request, so recovery cannot duplicate inbox rows.
create or replace function public.kfm_import_confirmed_po(p_vendor_id bigint, p_order_id bigint, p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public
as $$
declare
  v_attempt public.kfm_po_intake_attempts%rowtype;
  v_inbox uuid;
  v_customer uuid;
  v_code text := upper(btrim(p_payload->>'po_number'));
begin
  select * into v_attempt from public.kfm_po_intake_attempts
  where vendor_id = p_vendor_id and order_id = p_order_id for update;
  if not found or v_attempt.decision <> 'confirm' then raise exception 'Confirmed intake claim required'; end if;
  if v_attempt.state = 'imported' then return v_attempt.inbox_id; end if;
  if v_code is null or v_code = '' or v_code <> v_attempt.po_number
    or (p_payload->'raw_payload'->>'source') is distinct from 'kfm_portal'
    or coalesce((p_payload->'raw_payload'->>'portal_sub_status')::integer, -1) not in (5,6,9)
    or (p_payload->'raw_payload'->>'kfm_order_id')::bigint is distinct from p_order_id
    or (p_payload->'raw_payload'->>'vendor_id')::bigint is distinct from p_vendor_id
  then raise exception 'Portal readback mismatch'; end if;
  if jsonb_typeof(p_payload->'production_items') is distinct from 'array' then raise exception 'PO items required'; end if;
  if jsonb_array_length(p_payload->'production_items') = 0 or exists (
    select 1 from jsonb_array_elements(p_payload->'production_items') item
    where coalesce((item->>'qty')::numeric, 0) <= 0
       or coalesce(item->>'product_name', '') = '' or coalesce(item->>'sku_id', '') = ''
  ) then raise exception 'Invalid PO items'; end if;
  perform pg_advisory_xact_lock(hashtextextended('kfm-po:' || v_code, 0));
  -- Never replace old email payloads or an existing production source.
  select id into v_inbox from public.customer_po_inbox
  where upper(btrim(po_number)) = v_code
    and (lower(from_email) in ('dathang@kingfoodmart.com','portal@kingfoodmart.com') or raw_payload->>'source' = 'kfm_portal')
  order by created_at asc limit 1;
  if v_inbox is null then
    v_customer := public.kfm_intake_customer_id();
    insert into public.customer_po_inbox (
      gmail_message_id, from_email, from_name, email_subject, matched_customer_id,
      po_number, delivery_date, production_items, subtotal_amount, vat_amount, total_amount,
      match_status, reviewed_by, reviewed_at, raw_payload, has_attachments, attachment_names
    ) values (
      'kfm-portal:' || p_vendor_id || ':' || p_order_id, 'portal@kingfoodmart.com', 'KINGFOOD MART', p_payload->>'email_subject', v_customer,
      v_code, (p_payload->>'delivery_date')::date, p_payload->'production_items', (p_payload->>'subtotal_amount')::numeric,
      (p_payload->>'vat_amount')::numeric, (p_payload->>'total_amount')::numeric, 'approved', v_attempt.actor_id, now(),
      p_payload->'raw_payload', false, '{}'::text[]
    ) returning id into v_inbox;
  end if;
  update public.kfm_po_intake_attempts set state = 'imported', inbox_id = v_inbox, updated_at = now()
  where vendor_id = p_vendor_id and order_id = p_order_id;
  return v_inbox;
end;
$$;
revoke all on function public.kfm_import_confirmed_po(bigint,bigint,jsonb) from public, anon, authenticated;
grant execute on function public.kfm_import_confirmed_po(bigint,bigint,jsonb) to service_role;
