-- Editing a pending PR/PO line failed with "procurement source identity is immutable once
-- material evidence exists" whenever the stored unit was a legacy spelling ("Hôp", "Cuôn")
-- or the supplier alias table had since learned a new canonical name. The BEFORE UPDATE
-- normalizers rewrote unit/product_name even though the user did not touch them, and the
-- identity guard (which fires later) then saw a change. Seen 22/10 on PR-5C3C04AC.
--
-- Fix: on UPDATE, each normalizer only acts when its own column actually changed.
-- INSERT behaviour is unchanged, and a real unit/name change is still normalized
-- (and still rejected by the guard for evidence-bearing lines, as designed).

create or replace function public.stock_document_line_normalize_unit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_label text;
begin
  if tg_op = 'UPDATE' and new.unit is not distinct from old.unit then
    return new;
  end if;
  if new.unit is not null then
    v_code := public.stock_unit_code(new.unit);
    if v_code is not null then
      select u.label into v_label from public.stock_units u where u.code = v_code;
      if v_label is not null then
        new.unit := v_label;
      end if;
    end if;
  end if;
  return new;
end;
$$;

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
  if tg_op = 'UPDATE' and new.product_name is not distinct from old.product_name then
    return new;
  end if;

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
