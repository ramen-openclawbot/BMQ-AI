-- Portal-only KFM intake. No historical rows are deleted, reclassified, or
-- rewritten; already-approved finance evidence remains available downstream.
create or replace function public.enforce_kfm_portal_only_intake()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_kfm boolean;
  v_was_kfm boolean := false;
  v_portal boolean;
begin
  v_is_kfm := lower(coalesce(new.from_email, '')) ~ '@([a-z0-9-]+\.)?kingfoodmart\.com$'
    or new.revenue_channel in ('cake_kingfoodmart', 'wholesale_kfm')
    or new.raw_payload #>> '{po_automation,rule}' = 'kingfood_po_automation'
    or exists (
      select 1 from public.mini_crm_customers c
      where c.id = new.matched_customer_id
        and (lower(c.customer_code) = 'b2b-kfm' or lower(c.customer_name) ~ 'king[[:space:]]*food|\mkfm\M')
    );
  if tg_op = 'UPDATE' then
    v_was_kfm := lower(coalesce(old.from_email, '')) ~ '@([a-z0-9-]+\.)?kingfoodmart\.com$'
      or old.revenue_channel in ('cake_kingfoodmart', 'wholesale_kfm')
      or old.raw_payload #>> '{po_automation,rule}' = 'kingfood_po_automation'
      or exists (
        select 1 from public.mini_crm_customers c
        where c.id = old.matched_customer_id
          and (lower(c.customer_code) = 'b2b-kfm' or lower(c.customer_name) ~ 'king[[:space:]]*food|\mkfm\M')
      );
  end if;
  if not (coalesce(v_is_kfm, false) or coalesce(v_was_kfm, false)) then return new; end if;

  v_portal := new.raw_payload ->> 'source' = 'kfm_portal'
    and new.gmail_message_id ~ '^kfm-portal:[0-9]+:[0-9]+$'
    and new.from_email = 'portal@kingfoodmart.com';
  if coalesce(v_portal, false) then
    -- Browser writes cannot fake the portal marker to evade the cutover guard.
    if coalesce(auth.role(), '') in ('anon', 'authenticated') then
      if tg_op = 'INSERT' then
        raise exception 'KFM portal intake requires the server bridge' using errcode = '42501';
      end if;
      if new.raw_payload is distinct from old.raw_payload
        or new.gmail_message_id is distinct from old.gmail_message_id
        or new.from_email is distinct from old.from_email
        or new.match_status is distinct from old.match_status
        or new.production_items is distinct from old.production_items
        or new.matched_customer_id is distinct from old.matched_customer_id
        or new.po_number is distinct from old.po_number
        or new.delivery_date is distinct from old.delivery_date
        or new.revenue_channel is distinct from old.revenue_channel
        or new.subtotal_amount is distinct from old.subtotal_amount
        or new.vat_amount is distinct from old.vat_amount
        or new.total_amount is distinct from old.total_amount then
        raise exception 'KFM portal PO decisions require the server bridge' using errcode = '42501';
      end if;
    end if;
    if tg_op = 'UPDATE' and old.raw_payload ->> 'source' is distinct from 'kfm_portal' then
      raise exception 'Historical KFM email evidence cannot be converted into portal evidence' using errcode = '23514';
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    raise exception 'kfm_email_source_retired: use the KFM portal intake' using errcode = '23514';
  end if;
  if (new.match_status = 'approved' and old.match_status is distinct from 'approved')
    or new.gmail_message_id is distinct from old.gmail_message_id
    or new.from_email is distinct from old.from_email
    or new.matched_customer_id is distinct from old.matched_customer_id
    or new.po_number is distinct from old.po_number
    or new.delivery_date is distinct from old.delivery_date
    or new.revenue_channel is distinct from old.revenue_channel
    or new.production_items is distinct from old.production_items
    or new.subtotal_amount is distinct from old.subtotal_amount
    or new.vat_amount is distinct from old.vat_amount
    or new.total_amount is distinct from old.total_amount
    or new.raw_payload -> 'parse_meta' is distinct from old.raw_payload -> 'parse_meta'
    or new.raw_payload -> 'parsed_items_preview' is distinct from old.raw_payload -> 'parsed_items_preview'
    or new.raw_payload -> 'po_automation' is distinct from old.raw_payload -> 'po_automation'
    or new.raw_payload -> 'source' is distinct from old.raw_payload -> 'source' then
    raise exception 'kfm_email_source_retired: historical email PO cannot be promoted or reparsed' using errcode = '23514';
  end if;
  -- Review notes, revenue audit/posting metadata and existing history remain usable.
  return new;
end;
$$;

revoke all on function public.enforce_kfm_portal_only_intake() from public;
drop trigger if exists kfm_portal_only_intake on public.customer_po_inbox;
create trigger kfm_portal_only_intake
before insert or update on public.customer_po_inbox
for each row execute function public.enforce_kfm_portal_only_intake();

-- Shared revenue schedules remain enabled for other customers and historical
-- already-approved finance. All Gmail callers are filtered in po-gmail-sync;
-- the scheduler no longer promotes outstanding KFM email evidence.
