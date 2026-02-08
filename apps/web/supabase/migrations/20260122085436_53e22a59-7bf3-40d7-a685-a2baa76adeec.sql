-- Add payment_slip_url column to invoices table for bank payment slip
ALTER TABLE invoices 
ADD COLUMN payment_slip_url text;

COMMENT ON COLUMN invoices.payment_slip_url IS 'URL of bank payment slip (UNC) image';