-- Mã số thuế NCC (owner 29/10): hoá đơn 00009194 của "CÔNG TY TNHH DV TM NÔNG TRẠI XANH"
-- không nhận ra NCC Green Farm vì tên khác hẳn. match_incoming_invoice đã ưu tiên
-- cột suppliers.tax_code nếu có (bước 8.1), nên chỉ cần thêm cột và điền MST:
--   (a) từ hoá đơn đã gắn NCC (mỗi NCC lấy MST xuất hiện nhiều nhất);
--   (b) 4 NCC owner/kế toán đối chiếu theo tên tài khoản ngân hàng / tên NCC;
--   (c) chạy lại ghép cho hoá đơn chưa có NCC: chỉ gắn vào phiếu chi đã có, không lập phiếu mới.

alter table public.suppliers add column if not exists tax_code text;
create index if not exists idx_suppliers_tax_code on public.suppliers (upper(btrim(tax_code)));

-- (a)
with counted as (
  select supplier_id, seller_tax_code, count(*) as n,
         row_number() over (partition by supplier_id order by count(*) desc, seller_tax_code) as rn
  from public.incoming_invoices
  where supplier_id is not null
    and nullif(btrim(coalesce(seller_tax_code, '')), '') is not null
    and status <> 'ignored'
  group by supplier_id, seller_tax_code
)
update public.suppliers s
   set tax_code = c.seller_tax_code
  from counted c
 where c.supplier_id = s.id and c.rn = 1 and s.tax_code is null;

-- (b) tên trên hoá đơn = tên tài khoản ngân hàng / tên NCC trong hệ thống
update public.suppliers set tax_code = '4101526614'
 where id = (select id from public.suppliers where bank_account_name = 'CT TNHH DV THUONG MAI NONG TRAI XANH' limit 1) and tax_code is null;
update public.suppliers set tax_code = '0317131227'
 where id = (select id from public.suppliers where bank_account_name = 'CTY TNHH BAO BI NGOC TRAN' limit 1) and tax_code is null;
update public.suppliers set tax_code = '3703119967'
 where id = (select id from public.suppliers where btrim(name) = 'CTY TMDV Nam Thành An' limit 1) and tax_code is null;
update public.suppliers set tax_code = '0315013683'
 where id = (select id from public.suppliers where btrim(name) = 'CÔNG TY TNHH TM THIÊN HẬU' limit 1) and tax_code is null;
