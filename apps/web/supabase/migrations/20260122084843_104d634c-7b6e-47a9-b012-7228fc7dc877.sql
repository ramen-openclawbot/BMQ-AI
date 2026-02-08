-- Add vat_amount column to payment_requests table
ALTER TABLE payment_requests 
ADD COLUMN vat_amount numeric DEFAULT 0;

COMMENT ON COLUMN payment_requests.vat_amount IS 'VAT amount for payment request';