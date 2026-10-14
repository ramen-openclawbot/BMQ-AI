-- 2026-11-01 — Gợi ý tên chuẩn đầy đủ khi tạo mặt hàng mới (cache kết quả đọc ảnh hóa đơn).
--
-- Additive, write-nothing migration: it only creates one cache table for
-- public.suggest-stock-item-name (edge function). The function reads the
-- delivery-note / invoice image of a goods receipt line, asks the vision model
-- to transcribe the printed product names, then picks the matching invoice line
-- with pure code. The chosen full name is cached here so a later call for the
-- same goods_receipt_item_id is answered from the database instead of the AI.
--
-- No browser role may write: only the service_role edge function upserts a row.
-- authenticated may read a row (RLS restricts it to owner / Q7 stock admin via
-- public.material_alias_can_admin, the same gate as get_crate_receipt_lines).
--
-- One row per receipt line: goods_receipt_item_id is the primary key, so an
-- upsert replaces the cached answer. The cascade keeps the cache in step with
-- the receipt line it describes.

create table if not exists public.stock_item_name_suggestions (
  goods_receipt_item_id uuid primary key
    references public.goods_receipt_items(id) on delete cascade,
  full_name text not null,
  unit text,
  confidence numeric not null,
  model text,
  created_at timestamptz not null default now()
);

alter table public.stock_item_name_suggestions enable row level security;

drop policy if exists stock_item_name_suggestions_select on public.stock_item_name_suggestions;
create policy stock_item_name_suggestions_select on public.stock_item_name_suggestions
  for select to authenticated
  using (public.material_alias_can_admin((select auth.uid())));

revoke all on table public.stock_item_name_suggestions from public, anon, authenticated;
grant select on table public.stock_item_name_suggestions to authenticated, service_role;
grant insert, update, delete on table public.stock_item_name_suggestions to service_role;
