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
