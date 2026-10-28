-- Nhận NCC theo tên tài khoản ngân hàng (owner 29/10): tên người bán trên hoá đơn
-- ("CÔNG TY TNHH BAO BÌ NGỌC TRÂN") thường trùng tên tài khoản NH đã lưu của NCC
-- ("CTY TNHH BAO BI NGOC TRAN") dù tên NCC trong app khác ("Ngọc Trân- Cô Trang").
-- Trước khi hoá đơn mới được ghép: nếu chưa NCC nào có MST này, tìm đúng MỘT NCC có
-- tên tài khoản NH (bỏ dấu, bỏ CÔNG TY/CTY/TNHH/CỔ PHẦN/TM/DV…) bằng tên người bán,
-- rồi lưu MST vào NCC đó. match_incoming_invoice (bước MST) sẽ nhận ra NCC.

create or replace function public.supplier_name_core(p text)
returns text
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select btrim(regexp_replace(regexp_replace(
    lower(extensions.unaccent(replace(replace(coalesce(p, ''), 'đ', 'd'), 'Đ', 'D'))),
    '\m(cong ty|cty|ct|tnhh|co phan|cp|thuong mai|tm|dich vu|dv|tmdv|mtv|mot thanh vien|chi nhanh|tong|tap doan)\M|[^a-z0-9 ]',
    ' ', 'g'), '\s+', ' ', 'g'));
$$;

create or replace function public.incoming_invoice_learn_supplier_tax()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_core text;
  v_ids uuid[];
begin
  if new.supplier_id is not null
     or nullif(btrim(coalesce(new.seller_tax_code, '')), '') is null
     or nullif(btrim(coalesce(new.seller_name, '')), '') is null then
    return new;
  end if;
  if exists (select 1 from public.suppliers s
             where upper(btrim(s.tax_code)) = upper(btrim(new.seller_tax_code))) then
    return new;
  end if;
  v_core := public.supplier_name_core(new.seller_name);
  if length(v_core) < 4 then
    return new;
  end if;
  select array_agg(s.id) into v_ids
  from public.suppliers s
  where s.tax_code is null
    and nullif(btrim(coalesce(s.bank_account_name, '')), '') is not null
    and public.supplier_name_core(s.bank_account_name) = v_core;
  if coalesce(array_length(v_ids, 1), 0) = 1 then
    update public.suppliers set tax_code = btrim(new.seller_tax_code) where id = v_ids[1];
  end if;
  return new;
end;
$$;

drop trigger if exists trg_incoming_invoice_learn_supplier_tax on public.incoming_invoices;
create trigger trg_incoming_invoice_learn_supplier_tax
  before insert or update of seller_tax_code, seller_name on public.incoming_invoices
  for each row execute function public.incoming_invoice_learn_supplier_tax();
