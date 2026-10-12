-- Rollback-only production smoke for migration
-- 20261029160000_fill_received_quantity.sql (phiếu nhập đã xác nhận:
-- số lượng nhận = số lượng đặt khi bị bỏ trống).
--
-- Run as one file:
--   supabase db query --linked -f apps/web/scripts/smoke_fill_received_quantity.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_fill_received_quantity.sql).
--
-- One transaction. It captures the before image, applies the migration SQL
-- inline (byte-for-byte), then asserts:
--   (a) exactly the pre-counted predicate rows were filled (about 420 live) and
--       the log holds the same number of source 'backfill_2026_10_12' rows;
--   (b) no row matching the predicate remains;
--   (c) every row outside the filled set has the same
--       md5(id|quantity|actual_quantity|ordered_quantity) as before;
--   (d) rows under draft receipts are byte-identical too;
--   (e) counts / status distributions of goods_receipts, payment_requests,
--       payment_request_items, invoices and invoice_items, and the invoice VAT
--       total, are unchanged;
--   (f) a new temporary confirmed receipt line with quantity 0 / ordered 7 gets
--       actual 7 on insert; a draft receipt line stays NULL until the receipt is
--       updated to confirmed, then becomes 7 (both log source 'trigger');
--   (g) update and delete on goods_receipt_quantity_fill_log are rejected.
-- The money-document readers listed in 20261029150000's header only produce
-- payment_requests / payment_request_items (VAT is payment_requests.vat_amount)
-- and invoices / invoice_items; there is no receipt-linked JEV table, so those
-- are the tables captured here.
-- The final RAISE aborts the transaction, so every change rolls back.
begin;

-- (0) The owner is taken from public.user_roles and impersonated through
-- request.jwt.claims.
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (
      select ur.user_id
      from public.user_roles ur
      where ur.role::text = 'owner'
      order by ur.created_at, ur.user_id
      limit 1
    ),
    'role', 'authenticated'
  )::text,
  true
);

-- (0b) Before image: counts, status distributions and the exact predicate ids.
drop table if exists smoke_fill_pre;
create temp table smoke_fill_pre as
select
  (select count(*) from public.goods_receipts) as gr_count,
  (select count(*) from public.goods_receipt_items) as gri_count,
  (select count(*) from public.payment_requests) as pr_count,
  (select count(*) from public.payment_request_items) as pri_count,
  (select count(*) from public.invoices) as inv_count,
  (select count(*) from public.invoice_items) as invi_count,
  (select coalesce(sum(inv.vat_amount), 0) from public.invoices inv) as inv_vat,
  (select jsonb_object_agg(s.status, s.c)
     from (select gr.status::text as status, count(*) as c
             from public.goods_receipts gr group by 1) s) as gr_status,
  (select jsonb_object_agg(s.status, s.c)
     from (select pr.status::text as status, count(*) as c
             from public.payment_requests pr group by 1) s) as pr_status,
  (select jsonb_object_agg(s.payment_status, s.c)
     from (select pr.payment_status::text as payment_status, count(*) as c
             from public.payment_requests pr group by 1) s) as pr_payment_status,
  (select count(*)
     from public.goods_receipt_items gri
     join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    where gr.status in ('confirmed', 'received')
      and gri.actual_quantity is null
      and coalesce(gri.quantity, 0) = 0
      and gri.ordered_quantity > 0) as predicate_count;

drop table if exists smoke_fill_predicate;
create temp table smoke_fill_predicate as
select gri.id as goods_receipt_item_id
from public.goods_receipt_items gri
join public.goods_receipts gr on gr.id = gri.goods_receipt_id
where gr.status in ('confirmed', 'received')
  and gri.actual_quantity is null
  and coalesce(gri.quantity, 0) = 0
  and gri.ordered_quantity > 0;

-- (0c) Before image of the rows outside the predicate set (the ones that must
-- stay byte-for-byte), plus the draft-receipt rows alone.
alter table smoke_fill_pre add column kept_hash text;
alter table smoke_fill_pre add column draft_hash text;
update smoke_fill_pre p
set kept_hash = (
      select md5(coalesce(string_agg(
        concat_ws('|', gri.id::text,
          coalesce(gri.quantity::text, '~'),
          coalesce(gri.actual_quantity::text, '~'),
          coalesce(gri.ordered_quantity::text, '~')), ',' order by gri.id), ''))
      from public.goods_receipt_items gri
      where not exists (
        select 1 from smoke_fill_predicate x
         where x.goods_receipt_item_id = gri.id)),
    draft_hash = (
      select md5(coalesce(string_agg(
        concat_ws('|', gri.id::text,
          coalesce(gri.quantity::text, '~'),
          coalesce(gri.actual_quantity::text, '~'),
          coalesce(gri.ordered_quantity::text, '~')), ',' order by gri.id), ''))
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      where gr.status not in ('confirmed', 'received'));

-- (1) Apply the migration SQL inline, byte-for-byte.

-- ============================================================================
-- Migration: Phiếu nhập đã xác nhận — số lượng nhận = số lượng đặt khi bỏ trống
--
-- 2026-10-29. A confirmed / received goods receipt line can be stored with
-- actual_quantity IS NULL, quantity = 0 and ordered_quantity > 0. Live data
-- shows 420 such lines in 66 receipts since late July 2026, all created from a
-- purchase order and a payment request (35 lines this week). This migration
-- makes the received quantity explicit once and forever:
--   * a one-off backfill of exactly those rows; and
--   * two triggers that keep doing it for new / updated rows.
-- Only public.goods_receipt_items.actual_quantity is written. No
-- goods_receipts row, payment request, payable, VAT or JEV document is created
-- or changed by this migration, and public.post_stock_goods_receipt_item /
-- public.goods_receipt_effective_quantity (20261029150000) stay byte-for-byte
-- as the no-op fallback that already handles these lines.
--
-- Which path leaves them NULL / 0?
--   * public.ensure_purchase_order_receipt_queue (20260817170000) creates the
--     receipt at status 'confirmed' (or promotes an existing 'draft' to
--     'confirmed') and then inserts every purchase_order_items line as
--     goods_receipt_items(ordered_quantity = poi.quantity, actual_quantity =
--     NULL, quantity = 0, purchase_order_item_id, sku_id), linking the receipt
--     to the PO and the just-created Duyệt chi PO payment request.
--   * public.ensure_payment_request_receipt_queue (20260629093000) does the
--     same for an old-order / công nợ payment request with no receipt yet:
--     goods_receipts(status 'confirmed', purchase_order_id, payment_request_id)
--     plus goods_receipt_items(ordered_quantity = pri.quantity, actual_quantity
--     = NULL, quantity = 0).
--   These are deliberate "queue placeholder" lines: the warehouse is supposed
--   to confirm the real received quantity later. It only happens through
--   public.auto_receive_goods_receipt (20261012160000) — when the linked
--   payment becomes 'paid', or when the owner runs
--   public.backfill_auto_receive_paid — which writes actual_quantity =
--   ordered_quantity and then finalizes. A receipt that is never paid, or paid
--   before the auto-receive trigger existed, keeps NULL / 0 forever.
--   * public.finalize_goods_receipt (20260730013000 and its wrappers) computes
--     v_actual_quantity := greatest(0, coalesce(actual_quantity, quantity, 0))
--     = 0 for such a line and then raises 'Cannot finalize receipt without
--     positive actual received quantities'; public.finalize_historical_paid_goods_receipt
--     (20260730013000) requires positive receipt lines and refuses with
--     'Historical paid receipt requires positive receipt and payment lines'. So
--     the queue lines are also un-finalizable until auto receive fills them. The
--     effective-quantity helper (20261029150000) only changed the readers; it
--     did not change the stored row. This migration closes that gap in the
--     stored data.
--
-- Trigger audit (live definitions across supabase/migrations), so that writing
-- actual_quantity is safe on every path:
--   * public.goods_receipt_items triggers react only to identity / material
--     columns — trg_guard_goods_receipt_item_material_resolution_update
--     (canonical_material_id, material_resolution_status,
--     material_resolution_request_id, raw_product_name),
--     goods_receipt_items_normalize_unit (unit),
--     normalize_supplier_goods_receipt_item (product_name, sku_id,
--     goods_receipt_id), trg_goods_receipt_items_validate_canonical_material
--     (canonical_material_id) and trg_goods_receipt_items_enforce_raw_material
--     (sku_id only in the live 20260603172000 definition; the superseded
--     20260603165000 one had listed actual_quantity, quantity). NONE reacts to
--     actual_quantity or quantity.
--   * public.goods_receipts triggers — goods_receipts_stock_ledger_post
--     (after update, all columns), auto_issue_goods_receipt_on_received and
--     trg_finance_zalo_goods_receipt (after update of status),
--     goods_receipts_stock_ledger_default_location and
--     goods_receipts_central_receiving_guard (before insert / receiving
--     location). NONE fires for a goods_receipt_items change, so filling a
--     line never re-enters the receipt, stock-ledger, auto-issue or Zalo
--     enqueue paths by itself.
--
-- The new AFTER UPDATE OF status trigger is named
-- 'a_goods_receipts_fill_received_quantity' so it runs before the other
-- AFTER UPDATE OF status / AFTER UPDATE triggers on goods_receipts —
-- 'auto_issue_goods_receipt_on_received', 'goods_receipts_stock_ledger_post'
-- and 'trg_finance_zalo_goods_receipt' (Postgres fires same-timing triggers in
-- name order). When a receipt becomes confirmed / received the lines are
-- filled first, so the stock-ledger trigger and the effective-quantity helper
-- see the same quantity.
--
-- This migration is written but NOT applied: the Maestro applies it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Append-only audit log of every fill.
-- ---------------------------------------------------------------------------
create table if not exists public.goods_receipt_quantity_fill_log (
  id uuid primary key default gen_random_uuid(),
  goods_receipt_item_id uuid not null,
  goods_receipt_id uuid not null,
  old_quantity numeric,
  old_actual_quantity numeric,
  new_actual_quantity numeric not null,
  source text not null check (source in ('backfill_2026_10_12', 'trigger')),
  created_at timestamptz not null default now()
);

comment on table public.goods_receipt_quantity_fill_log is
  'Append-only audit of goods_receipt_items.actual_quantity fills from ordered_quantity: source backfill_2026_10_12 (the one-off backfill) or trigger (BEFORE goods_receipt_items + AFTER goods_receipts status). Writes only through the SECURITY DEFINER functions; the table rejects update and delete.';

create index if not exists goods_receipt_quantity_fill_log_item_idx
  on public.goods_receipt_quantity_fill_log (goods_receipt_item_id);
create index if not exists goods_receipt_quantity_fill_log_receipt_idx
  on public.goods_receipt_quantity_fill_log (goods_receipt_id);

-- Append-only: update and delete always fail, for every role.
create or replace function public.goods_receipt_quantity_fill_log_append_only()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'goods_receipt_quantity_fill_log is append-only' using errcode = '42501';
end;
$$;

revoke all on function public.goods_receipt_quantity_fill_log_append_only() from public, anon, authenticated;

drop trigger if exists goods_receipt_quantity_fill_log_append_only on public.goods_receipt_quantity_fill_log;
create trigger goods_receipt_quantity_fill_log_append_only
  before update or delete on public.goods_receipt_quantity_fill_log
  for each row execute function public.goods_receipt_quantity_fill_log_append_only();

-- RLS: read for signed-in users who can view goods receipts (the goods_receipts
-- module permission), or owner / Q7 stock admin. No client write policy: every
-- insert comes from the SECURITY DEFINER functions below.
alter table public.goods_receipt_quantity_fill_log enable row level security;

drop policy if exists goods_receipt_quantity_fill_log_read on public.goods_receipt_quantity_fill_log;
create policy goods_receipt_quantity_fill_log_read
  on public.goods_receipt_quantity_fill_log
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'goods_receipts', 'view')
    or public.material_alias_can_admin((select auth.uid()))
  );

revoke all on public.goods_receipt_quantity_fill_log from public, anon, authenticated;
grant select on public.goods_receipt_quantity_fill_log to authenticated;
grant all on public.goods_receipt_quantity_fill_log to service_role;

-- ---------------------------------------------------------------------------
-- 2. One-off backfill of the exact predicate, with an append-only log row
--    per filled line. Runs before the triggers below are created, so the log
--    source is always 'backfill_2026_10_12' (never double-logged as 'trigger').
--    Only goods_receipt_items.actual_quantity is written.
-- ---------------------------------------------------------------------------
do $$
declare
  v_logged integer := 0;
  v_filled integer := 0;
begin
  insert into public.goods_receipt_quantity_fill_log (
    goods_receipt_item_id, goods_receipt_id, old_quantity, old_actual_quantity,
    new_actual_quantity, source
  )
  select
    gri.id,
    gri.goods_receipt_id,
    gri.quantity,
    gri.actual_quantity,
    gri.ordered_quantity,
    'backfill_2026_10_12'
  from public.goods_receipt_items gri
  join public.goods_receipts gr on gr.id = gri.goods_receipt_id
  where gr.status in ('confirmed', 'received')
    and gri.actual_quantity is null
    and coalesce(gri.quantity, 0) = 0
    and gri.ordered_quantity > 0;
  get diagnostics v_logged = row_count;

  update public.goods_receipt_items gri
     set actual_quantity = gri.ordered_quantity
    from public.goods_receipts gr
   where gr.id = gri.goods_receipt_id
     and gr.status in ('confirmed', 'received')
     and gri.actual_quantity is null
     and coalesce(gri.quantity, 0) = 0
     and gri.ordered_quantity > 0;
  get diagnostics v_filled = row_count;

  if v_logged <> v_filled then
    raise exception 'fill_received_quantity backfill logged % row(s) but filled % row(s)',
      v_logged, v_filled;
  end if;

  raise notice 'fill_received_quantity backfill: % goods_receipt_items row(s) filled', v_filled;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Row trigger: a confirmed / received placeholder line is filled on insert
--    or whenever actual_quantity / quantity / ordered_quantity / goods_receipt_id
--    changes. SECURITY DEFINER so it can write the log; pins search_path. It
--    never touches goods_receipts, payment_requests, payables or money docs.
-- ---------------------------------------------------------------------------
create or replace function public.goods_receipt_items_fill_received_quantity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_old_quantity numeric;
  v_old_actual_quantity numeric;
begin
  select gr.status::text
    into v_status
    from public.goods_receipts gr
   where gr.id = new.goods_receipt_id;

  -- Only a confirmed / received parent is a real delivery.
  if v_status is null or v_status not in ('confirmed', 'received') then
    return new;
  end if;

  -- Exact predicate: nothing received yet, quantity stored as 0, something
  -- ordered. An explicit actual_quantity always wins.
  if new.actual_quantity is not null
     or coalesce(new.quantity, 0) <> 0
     or coalesce(new.ordered_quantity, 0) <= 0 then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_old_quantity := old.quantity;
    v_old_actual_quantity := old.actual_quantity;
  else
    v_old_quantity := new.quantity;
    v_old_actual_quantity := new.actual_quantity;
  end if;

  new.actual_quantity := new.ordered_quantity;

  -- NEW.id is already materialized here: column defaults (gen_random_uuid)
  -- are evaluated before BEFORE ROW triggers fire.
  insert into public.goods_receipt_quantity_fill_log (
    goods_receipt_item_id, goods_receipt_id, old_quantity, old_actual_quantity,
    new_actual_quantity, source
  ) values (
    new.id,
    new.goods_receipt_id,
    v_old_quantity,
    v_old_actual_quantity,
    new.actual_quantity,
    'trigger'
  );

  return new;
end;
$$;

comment on function public.goods_receipt_items_fill_received_quantity() is
  'BEFORE INSERT OR UPDATE OF actual_quantity, quantity, ordered_quantity, goods_receipt_id: when the parent receipt is confirmed / received and the line has actual_quantity NULL, quantity 0 and ordered_quantity > 0, set actual_quantity = ordered_quantity and append a goods_receipt_quantity_fill_log row (source trigger). SECURITY DEFINER, pinned search_path.';

revoke all on function public.goods_receipt_items_fill_received_quantity() from public, anon, authenticated, service_role;

drop trigger if exists goods_receipt_items_fill_received_quantity on public.goods_receipt_items;
create trigger goods_receipt_items_fill_received_quantity
  before insert or update of actual_quantity, quantity, ordered_quantity, goods_receipt_id
  on public.goods_receipt_items
  for each row execute function public.goods_receipt_items_fill_received_quantity();

-- ---------------------------------------------------------------------------
-- 4. Status trigger: when a receipt becomes confirmed / received, fill its
--    matching lines the same way. It only UPDATEs goods_receipt_items (touching
--    ordered_quantity so the row trigger above does the write + log); it never
--    updates goods_receipts itself. Named 'a_...' to sort before
--    goods_receipts_stock_ledger_post.
-- ---------------------------------------------------------------------------
create or replace function public.goods_receipts_fill_received_quantity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status::text not in ('confirmed', 'received') then
    return new;
  end if;

  update public.goods_receipt_items gri
     set ordered_quantity = gri.ordered_quantity
   where gri.goods_receipt_id = new.id
     and gri.actual_quantity is null
     and coalesce(gri.quantity, 0) = 0
     and coalesce(gri.ordered_quantity, 0) > 0;

  return new;
end;
$$;

comment on function public.goods_receipts_fill_received_quantity() is
  'AFTER UPDATE OF status on goods_receipts: when the new status is confirmed / received, run the goods_receipt_items fill trigger over the receipt matching lines. Only writes goods_receipt_items (never goods_receipts).';

revoke all on function public.goods_receipts_fill_received_quantity() from public, anon, authenticated, service_role;

drop trigger if exists a_goods_receipts_fill_received_quantity on public.goods_receipts;
create trigger a_goods_receipts_fill_received_quantity
  after update of status on public.goods_receipts
  for each row
  when (old.status is distinct from new.status and new.status::text in ('confirmed', 'received'))
  execute function public.goods_receipts_fill_received_quantity();

-- (2) After image immediately after the migration, before any test row is
-- inserted.
drop table if exists smoke_fill_post;
create temp table smoke_fill_post as
select
  (select count(*) from public.goods_receipts) as gr_count,
  (select count(*) from public.goods_receipt_items) as gri_count,
  (select count(*) from public.payment_requests) as pr_count,
  (select count(*) from public.payment_request_items) as pri_count,
  (select count(*) from public.invoices) as inv_count,
  (select count(*) from public.invoice_items) as invi_count,
  (select coalesce(sum(inv.vat_amount), 0) from public.invoices inv) as inv_vat,
  (select jsonb_object_agg(s.status, s.c)
     from (select gr.status::text as status, count(*) as c
             from public.goods_receipts gr group by 1) s) as gr_status,
  (select jsonb_object_agg(s.status, s.c)
     from (select pr.status::text as status, count(*) as c
             from public.payment_requests pr group by 1) s) as pr_status,
  (select jsonb_object_agg(s.payment_status, s.c)
     from (select pr.payment_status::text as payment_status, count(*) as c
             from public.payment_requests pr group by 1) s) as pr_payment_status,
  (select count(*)
     from public.goods_receipt_quantity_fill_log l
    where l.source = 'backfill_2026_10_12') as backfill_log_count,
  (select count(*)
     from public.goods_receipt_items gri
     join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    where gr.status in ('confirmed', 'received')
      and gri.actual_quantity is null
      and coalesce(gri.quantity, 0) = 0
      and gri.ordered_quantity > 0) as remaining_predicate,
  (select md5(coalesce(string_agg(
        concat_ws('|', gri.id::text,
          coalesce(gri.quantity::text, '~'),
          coalesce(gri.actual_quantity::text, '~'),
          coalesce(gri.ordered_quantity::text, '~')), ',' order by gri.id), ''))
     from public.goods_receipt_items gri
     where not exists (
       select 1 from smoke_fill_predicate x
        where x.goods_receipt_item_id = gri.id)) as kept_hash,
  (select md5(coalesce(string_agg(
        concat_ws('|', gri.id::text,
          coalesce(gri.quantity::text, '~'),
          coalesce(gri.actual_quantity::text, '~'),
          coalesce(gri.ordered_quantity::text, '~')), ',' order by gri.id), ''))
     from public.goods_receipt_items gri
     join public.goods_receipts gr on gr.id = gri.goods_receipt_id
     where gr.status not in ('confirmed', 'received')) as draft_hash;

-- (3) Assertions. Any failure aborts the transaction before the final PASS.
do $smoke$
declare
  v_owner uuid;
  v_pre record;
  v_post record;
  v_suffix text;
  v_count integer;
  v_bad integer;
  v_actual numeric;
  v_conf_receipt uuid;
  v_conf_line uuid;
  v_draft_receipt uuid;
  v_draft_line uuid;
  v_log_id uuid;
  v_blocked boolean;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL no_owner';
  end if;

  select * into v_pre from smoke_fill_pre;
  select * into v_post from smoke_fill_post;

  ------------------------------------------------------------------
  -- (a) exactly the pre-counted predicate rows were filled, and the
  --     backfill log holds exactly one row per filled line
  ------------------------------------------------------------------
  if v_post.backfill_log_count <> v_pre.predicate_count then
    raise exception 'SMOKE_RESULT FAIL backfill_log_count logged=% expected=%',
      v_post.backfill_log_count, v_pre.predicate_count;
  end if;

  select count(*) into v_bad
  from public.goods_receipt_items gri
  where exists (
    select 1 from smoke_fill_predicate x
     where x.goods_receipt_item_id = gri.id)
    and gri.actual_quantity is distinct from gri.ordered_quantity;
  if v_bad <> 0 then
    raise exception 'SMOKE_RESULT FAIL filled_not_ordered %', v_bad;
  end if;

  ------------------------------------------------------------------
  -- (b) no matching rows remain
  ------------------------------------------------------------------
  if v_post.remaining_predicate <> 0 then
    raise exception 'SMOKE_RESULT FAIL remaining_predicate %',
      v_post.remaining_predicate;
  end if;

  ------------------------------------------------------------------
  -- (c) rows outside the predicate set are byte-identical
  ------------------------------------------------------------------
  if v_post.kept_hash is distinct from v_pre.kept_hash then
    raise exception 'SMOKE_RESULT FAIL kept_hash_changed';
  end if;

  ------------------------------------------------------------------
  -- (d) draft receipts untouched
  ------------------------------------------------------------------
  if v_post.draft_hash is distinct from v_pre.draft_hash then
    raise exception 'SMOKE_RESULT FAIL draft_hash_changed';
  end if;

  ------------------------------------------------------------------
  -- (e) counts and status distributions unchanged
  ------------------------------------------------------------------
  if v_post.gr_count <> v_pre.gr_count then
    raise exception 'SMOKE_RESULT FAIL gr_count % -> %', v_pre.gr_count, v_post.gr_count;
  end if;
  if v_post.gri_count <> v_pre.gri_count then
    raise exception 'SMOKE_RESULT FAIL gri_count % -> %', v_pre.gri_count, v_post.gri_count;
  end if;
  if v_post.pr_count <> v_pre.pr_count then
    raise exception 'SMOKE_RESULT FAIL pr_count % -> %', v_pre.pr_count, v_post.pr_count;
  end if;
  if v_post.pri_count <> v_pre.pri_count then
    raise exception 'SMOKE_RESULT FAIL pri_count % -> %', v_pre.pri_count, v_post.pri_count;
  end if;
  if v_post.inv_count <> v_pre.inv_count then
    raise exception 'SMOKE_RESULT FAIL inv_count % -> %', v_pre.inv_count, v_post.inv_count;
  end if;
  if v_post.invi_count <> v_pre.invi_count then
    raise exception 'SMOKE_RESULT FAIL invi_count % -> %', v_pre.invi_count, v_post.invi_count;
  end if;
  if v_post.inv_vat <> v_pre.inv_vat then
    raise exception 'SMOKE_RESULT FAIL inv_vat % -> %', v_pre.inv_vat, v_post.inv_vat;
  end if;
  if v_post.gr_status is distinct from v_pre.gr_status then
    raise exception 'SMOKE_RESULT FAIL gr_status % -> %', v_pre.gr_status, v_post.gr_status;
  end if;
  if v_post.pr_status is distinct from v_pre.pr_status then
    raise exception 'SMOKE_RESULT FAIL pr_status % -> %', v_pre.pr_status, v_post.pr_status;
  end if;
  if v_post.pr_payment_status is distinct from v_pre.pr_payment_status then
    raise exception 'SMOKE_RESULT FAIL pr_payment_status % -> %',
      v_pre.pr_payment_status, v_post.pr_payment_status;
  end if;

  raise notice 'SMOKE notice: fill backfilled % goods_receipt_items line(s)',
    v_pre.predicate_count;

  ------------------------------------------------------------------
  -- (f1) a new confirmed receipt line with quantity 0 / ordered 7 gets
  --      actual 7 on insert and logs source 'trigger'
  ------------------------------------------------------------------
  v_suffix := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.goods_receipts (receipt_number, receipt_date, status, payable_status)
  values ('SMOKE-FILL-CONF-' || v_suffix, current_date, 'confirmed', 'not_generated')
  returning id into v_conf_receipt;

  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, quantity, ordered_quantity, actual_quantity, unit)
  values
    (v_conf_receipt, 'SMOKE fill confirmed ' || v_suffix, 0, 7, null, 'kg')
  returning id into v_conf_line;

  select gri.actual_quantity into v_actual
  from public.goods_receipt_items gri
  where gri.id = v_conf_line;
  if v_actual is distinct from 7 then
    raise exception 'SMOKE_RESULT FAIL confirmed_insert_actual %', v_actual;
  end if;

  select count(*) into v_count
  from public.goods_receipt_quantity_fill_log l
  where l.goods_receipt_item_id = v_conf_line
    and l.source = 'trigger'
    and l.new_actual_quantity = 7;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL confirmed_insert_log %', v_count;
  end if;

  ------------------------------------------------------------------
  -- (f2) a draft receipt line stays NULL until the receipt is confirmed
  ------------------------------------------------------------------
  insert into public.goods_receipts (receipt_number, receipt_date, status, payable_status)
  values ('SMOKE-FILL-DRAFT-' || v_suffix, current_date, 'draft', 'not_generated')
  returning id into v_draft_receipt;

  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, quantity, ordered_quantity, actual_quantity, unit)
  values
    (v_draft_receipt, 'SMOKE fill draft ' || v_suffix, 0, 7, null, 'kg')
  returning id into v_draft_line;

  select gri.actual_quantity into v_actual
  from public.goods_receipt_items gri
  where gri.id = v_draft_line;
  if v_actual is not null then
    raise exception 'SMOKE_RESULT FAIL draft_insert_actual %', v_actual;
  end if;
  select count(*) into v_count
  from public.goods_receipt_quantity_fill_log l
  where l.goods_receipt_item_id = v_draft_line;
  if v_count <> 0 then
    raise exception 'SMOKE_RESULT FAIL draft_insert_log %', v_count;
  end if;

  update public.goods_receipts
     set status = 'confirmed'
   where id = v_draft_receipt;

  select gri.actual_quantity into v_actual
  from public.goods_receipt_items gri
  where gri.id = v_draft_line;
  if v_actual is distinct from 7 then
    raise exception 'SMOKE_RESULT FAIL draft_confirm_actual %', v_actual;
  end if;
  select count(*) into v_count
  from public.goods_receipt_quantity_fill_log l
  where l.goods_receipt_item_id = v_draft_line
    and l.source = 'trigger'
    and l.new_actual_quantity = 7;
  if v_count <> 1 then
    raise exception 'SMOKE_RESULT FAIL draft_confirm_log %', v_count;
  end if;

  ------------------------------------------------------------------
  -- (g) the log is append-only: update and delete are rejected
  ------------------------------------------------------------------
  select l.id into v_log_id
  from public.goods_receipt_quantity_fill_log l
  order by l.created_at desc, l.id desc
  limit 1;
  if v_log_id is null then
    raise exception 'SMOKE_RESULT FAIL log_empty';
  end if;

  v_blocked := false;
  begin
    update public.goods_receipt_quantity_fill_log
       set new_actual_quantity = new_actual_quantity
     where id = v_log_id;
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'SMOKE_RESULT FAIL log_update_allowed';
  end if;

  v_blocked := false;
  begin
    delete from public.goods_receipt_quantity_fill_log
     where id = v_log_id;
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'SMOKE_RESULT FAIL log_delete_allowed';
  end if;

  raise exception 'SMOKE_RESULT PASS: fill received quantity';
end;
$smoke$;
