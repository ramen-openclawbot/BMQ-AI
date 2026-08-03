-- Supplier-scoped canonical product aliases for procurement OCR/import flows.
-- Prevents an OCR hallucination for Bao bì Minh Tuấn from turning
-- "Bao bánh mì" into the different material "Bao bì nhựa".

create table if not exists public.supplier_product_aliases (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  alias_name text not null,
  normalized_alias text not null,
  canonical_product_name text not null,
  sku_id uuid references public.product_skus(id) on delete restrict,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (supplier_id, normalized_alias)
);

alter table public.supplier_product_aliases enable row level security;
revoke all on public.supplier_product_aliases from anon;
grant select on public.supplier_product_aliases to authenticated;

drop policy if exists supplier_product_aliases_authenticated_read on public.supplier_product_aliases;
create policy supplier_product_aliases_authenticated_read
  on public.supplier_product_aliases
  for select
  to authenticated
  using (true);

insert into public.supplier_product_aliases (
  supplier_id,
  alias_name,
  normalized_alias,
  canonical_product_name,
  sku_id,
  notes
)
values
  (
    '25130d62-a087-4308-afd0-dfbc7f43daa6',
    'Bao bì nhựa',
    public.normalize_ocr_cost_key('Bao bì nhựa'),
    'Bao bánh mì',
    '20e6bf63-32fd-4d46-be55-151dd1629e11',
    'OCR alias observed on PO-000705 and PO-000706; supplier invoice says Bao bánh mì.'
  ),
  (
    '25130d62-a087-4308-afd0-dfbc7f43daa6',
    'Bao bánh mì',
    public.normalize_ocr_cost_key('Bao bánh mì'),
    'Bao bánh mì',
    '20e6bf63-32fd-4d46-be55-151dd1629e11',
    'Canonical supplier label; also collapses case/diacritic variants onto the current cái SKU.'
  )
on conflict (supplier_id, normalized_alias) do update set
  alias_name = excluded.alias_name,
  canonical_product_name = excluded.canonical_product_name,
  sku_id = excluded.sku_id,
  is_active = true,
  notes = excluded.notes,
  updated_at = now();

create or replace function public.normalize_supplier_procurement_item()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_supplier_id uuid;
  v_canonical_product_name text;
  v_sku_id uuid;
begin
  if tg_table_name = 'purchase_order_items' then
    select po.supplier_id into v_supplier_id
    from public.purchase_orders po
    where po.id = new.purchase_order_id;
  elsif tg_table_name = 'payment_request_items' then
    select pr.supplier_id into v_supplier_id
    from public.payment_requests pr
    where pr.id = new.payment_request_id;
  elsif tg_table_name = 'goods_receipt_items' then
    select gr.supplier_id into v_supplier_id
    from public.goods_receipts gr
    where gr.id = new.goods_receipt_id;
  elsif tg_table_name = 'invoice_items' then
    select inv.supplier_id into v_supplier_id
    from public.invoices inv
    where inv.id = new.invoice_id;
  else
    return new;
  end if;

  if v_supplier_id is null or nullif(btrim(new.product_name), '') is null then
    return new;
  end if;

  select a.canonical_product_name, a.sku_id
    into v_canonical_product_name, v_sku_id
  from public.supplier_product_aliases a
  where a.supplier_id = v_supplier_id
    and a.normalized_alias = public.normalize_ocr_cost_key(new.product_name)
    and a.is_active
  limit 1;

  if v_canonical_product_name is null then
    return new;
  end if;

  if tg_table_name in ('payment_request_items', 'invoice_items') then
    new.raw_product_name := coalesce(nullif(btrim(new.raw_product_name), ''), new.product_name);
  end if;

  new.product_name := v_canonical_product_name;

  if tg_table_name <> 'invoice_items' and v_sku_id is not null then
    new.sku_id := v_sku_id;
  end if;

  return new;
end;
$$;

revoke all on function public.normalize_supplier_procurement_item() from public;
revoke all on function public.normalize_supplier_procurement_item() from anon;
revoke all on function public.normalize_supplier_procurement_item() from authenticated;
revoke all on function public.normalize_supplier_procurement_item() from service_role;

drop trigger if exists normalize_supplier_purchase_order_item on public.purchase_order_items;
create trigger normalize_supplier_purchase_order_item
before insert or update of product_name, sku_id, purchase_order_id on public.purchase_order_items
for each row execute function public.normalize_supplier_procurement_item();

drop trigger if exists normalize_supplier_payment_request_item on public.payment_request_items;
create trigger normalize_supplier_payment_request_item
before insert or update of product_name, sku_id, payment_request_id on public.payment_request_items
for each row execute function public.normalize_supplier_procurement_item();

drop trigger if exists normalize_supplier_goods_receipt_item on public.goods_receipt_items;
create trigger normalize_supplier_goods_receipt_item
before insert or update of product_name, sku_id, goods_receipt_id on public.goods_receipt_items
for each row execute function public.normalize_supplier_procurement_item();

drop trigger if exists normalize_supplier_invoice_item on public.invoice_items;
create trigger normalize_supplier_invoice_item
before insert or update of product_name, invoice_id on public.invoice_items
for each row execute function public.normalize_supplier_procurement_item();

create or replace function public.guard_supplier_product_sku_alias()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_alias public.supplier_product_aliases%rowtype;
begin
  if new.supplier_id is null or nullif(btrim(new.product_name), '') is null then
    return new;
  end if;

  select * into v_alias
  from public.supplier_product_aliases a
  where a.supplier_id = new.supplier_id
    and a.normalized_alias = public.normalize_ocr_cost_key(new.product_name)
    and a.is_active
  limit 1;

  if v_alias.id is not null and v_alias.sku_id is distinct from new.id then
    raise exception using
      errcode = '23505',
      message = format(
        'Tên SKU "%s" là alias của "%s"; dùng SKU %s thay vì tạo SKU mới.',
        new.product_name,
        v_alias.canonical_product_name,
        v_alias.sku_id
      );
  end if;

  return new;
end;
$$;

revoke all on function public.guard_supplier_product_sku_alias() from public;
revoke all on function public.guard_supplier_product_sku_alias() from anon;
revoke all on function public.guard_supplier_product_sku_alias() from authenticated;
revoke all on function public.guard_supplier_product_sku_alias() from service_role;

drop trigger if exists guard_supplier_product_sku_alias on public.product_skus;
create trigger guard_supplier_product_sku_alias
before insert or update of product_name, supplier_id on public.product_skus
for each row execute function public.guard_supplier_product_sku_alias();

-- Repair the two source POs and their linked downstream documents only.
update public.purchase_order_items poi
set product_name = 'Bao bánh mì',
    sku_id = '20e6bf63-32fd-4d46-be55-151dd1629e11'
from public.purchase_orders po
where po.id = poi.purchase_order_id
  and po.supplier_id = '25130d62-a087-4308-afd0-dfbc7f43daa6'
  and po.po_number in ('PO-000705', 'PO-000706')
  and public.normalize_ocr_cost_key(poi.product_name) = public.normalize_ocr_cost_key('Bao bì nhựa');

update public.payment_request_items pri
set raw_product_name = coalesce(nullif(btrim(pri.raw_product_name), ''), pri.product_name),
    product_name = 'Bao bánh mì',
    sku_id = '20e6bf63-32fd-4d46-be55-151dd1629e11'
from public.payment_requests pr
join public.purchase_orders po on po.id = pr.purchase_order_id
where pr.id = pri.payment_request_id
  and po.supplier_id = '25130d62-a087-4308-afd0-dfbc7f43daa6'
  and po.po_number in ('PO-000705', 'PO-000706')
  and public.normalize_ocr_cost_key(pri.product_name) = public.normalize_ocr_cost_key('Bao bì nhựa');

update public.goods_receipt_items gri
set product_name = 'Bao bánh mì',
    sku_id = '20e6bf63-32fd-4d46-be55-151dd1629e11'
from public.goods_receipts gr
join public.purchase_orders po on po.id = gr.purchase_order_id
where gr.id = gri.goods_receipt_id
  and po.supplier_id = '25130d62-a087-4308-afd0-dfbc7f43daa6'
  and po.po_number in ('PO-000705', 'PO-000706')
  and public.normalize_ocr_cost_key(gri.product_name) = public.normalize_ocr_cost_key('Bao bì nhựa');

update public.invoice_items ii
set raw_product_name = coalesce(nullif(btrim(ii.raw_product_name), ''), ii.product_name),
    product_name = 'Bao bánh mì'
from public.invoices inv
where inv.id = ii.invoice_id
  and inv.supplier_id = '25130d62-a087-4308-afd0-dfbc7f43daa6'
  and exists (
    select 1
    from public.purchase_orders po
    where po.supplier_id = '25130d62-a087-4308-afd0-dfbc7f43daa6'
      and po.po_number in ('PO-000705', 'PO-000706')
      and (
        po.id = inv.purchase_order_id
        or exists (
          select 1
          from public.payment_requests pr
          where pr.id = inv.payment_request_id
            and pr.purchase_order_id = po.id
        )
        or exists (
          select 1
          from public.goods_receipts gr
          where gr.id = inv.goods_receipt_id
            and gr.purchase_order_id = po.id
        )
      )
  )
  and public.normalize_ocr_cost_key(ii.product_name) = public.normalize_ocr_cost_key('Bao bì nhựa');

-- This generated duplicate only had one PR reference, reassigned above.
-- Foreign keys deliberately make the migration fail atomically if another reference exists.
delete from public.product_skus
where id = 'a3fdfd14-ec17-4ea2-a91a-35993fcdf014';
