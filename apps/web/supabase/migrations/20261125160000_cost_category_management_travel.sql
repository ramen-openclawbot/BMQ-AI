-- Owner decision 2026-11-25: GREEN SM is the CEO's travel (management cost),
-- not delivery. Add C12_TRAVEL and pin that supplier to it.

insert into public.cost_categories
  (code, label, parent_code, cost_group, product_line, allocation_rule, sushi_hint, is_active, sort_order)
values
  ('C12_TRAVEL', 'Đi lại, công tác quản lý', 'C_OPERATING', 'opex', 'shared', 'none',
   'đi lại, công tác của ban giám đốc; GREEN SM', true, 312)
on conflict (code) do nothing;

-- Both P&L functions carry an English label per code; add the new one in place.
do $$
declare
  fn regprocedure;
  src text;
  anchor constant text := 'when ''C11_BANK_TAX_OTHER'' then ''Bank fees, tax & other''';
begin
  for fn in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('finance_month_lines', 'finance_pnl_accrual_label')
  loop
    src := pg_get_functiondef(fn);
    if position('C12_TRAVEL' in src) > 0 then continue; end if;
    if position(anchor in src) = 0 then raise exception 'label anchor missing in %', fn; end if;
    execute replace(src, anchor, anchor || ' when ''C12_TRAVEL'' then ''Management travel''');
  end loop;
end $$;

-- Suppliers whose payment lines always belong to one category.
create table if not exists public.finance_supplier_fixed_categories (
  supplier_id uuid primary key references public.suppliers(id) on delete cascade,
  category_code text not null references public.cost_categories(code),
  reason text not null,
  created_at timestamptz not null default now()
);
alter table public.finance_supplier_fixed_categories enable row level security;
revoke all on public.finance_supplier_fixed_categories from public, anon, authenticated;

insert into public.finance_supplier_fixed_categories (supplier_id, category_code, reason)
select id, 'C12_TRAVEL', 'Chủ xác nhận: chi phí đi lại cho CEO, không phải giao hàng'
from public.suppliers where id = '917a4196-a389-407d-b0af-69f537c31e08'
on conflict (supplier_id) do nothing;

-- A new line is classified as an approved manual choice, so neither Sushi nor
-- the keyword rules move it back to delivery. A person can still change it.
create or replace function public.finance_apply_supplier_fixed_category()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.cost_line_classifications (
    source_type, source_line_id, payment_request_id, supplier_id, category_code, product_line,
    allocation_rule, confidence, classification_source, review_status, note
  )
  select 'payment_request_item', new.id, pr.id, pr.supplier_id, f.category_code, 'shared',
         'none', 1, 'manual_override', 'approved', f.reason
  from public.payment_requests pr
  join public.finance_supplier_fixed_categories f on f.supplier_id = pr.supplier_id
  where pr.id = new.payment_request_id
  on conflict (source_type, source_line_id) do nothing;
  return new;
exception when others then
  -- Classification must never block saving a payment request.
  raise warning 'supplier fixed category skipped for item %: %', new.id, sqlerrm;
  return new;
end $$;
revoke all on function public.finance_apply_supplier_fixed_category() from public, anon, authenticated;

drop trigger if exists finance_supplier_fixed_category on public.payment_request_items;
create trigger finance_supplier_fixed_category
  after insert on public.payment_request_items
  for each row execute function public.finance_apply_supplier_fixed_category();

-- Existing GREEN SM lines (October and November 2026).
update public.cost_line_classifications c
set category_code = f.category_code, product_line = 'shared', allocation_rule = 'none', confidence = 1,
    classification_source = 'manual_override', review_status = 'approved', rule_id = null,
    reviewed_at = now(), note = f.reason, updated_at = now()
from public.finance_supplier_fixed_categories f
where c.source_type = 'payment_request_item' and c.supplier_id = f.supplier_id;
