-- Add VAT configuration field to suppliers table
ALTER TABLE public.suppliers 
ADD COLUMN IF NOT EXISTS vat_included_in_price boolean DEFAULT false;

COMMENT ON COLUMN public.suppliers.vat_included_in_price IS 
'Nếu true: NCC này có giá đã bao gồm VAT trong đơn giá, không cần scan dòng VAT riêng';