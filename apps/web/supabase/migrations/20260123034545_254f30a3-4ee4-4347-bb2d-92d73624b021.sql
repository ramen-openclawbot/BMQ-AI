-- Add VAT column to purchase_orders table
ALTER TABLE public.purchase_orders 
ADD COLUMN vat_amount numeric DEFAULT 0;