-- Create enum for payment method
CREATE TYPE public.payment_method_type AS ENUM ('bank_transfer', 'cash');

-- Add payment_method column to payment_requests
ALTER TABLE public.payment_requests 
ADD COLUMN payment_method public.payment_method_type DEFAULT 'bank_transfer';

-- Add invoice_id to link payment request to invoice
ALTER TABLE public.payment_requests 
ADD COLUMN invoice_id uuid REFERENCES public.invoices(id);

-- Add invoice_created flag for tracking
ALTER TABLE public.payment_requests 
ADD COLUMN invoice_created boolean DEFAULT false;

-- Add payment_request_id to invoices for reverse lookup
ALTER TABLE public.invoices 
ADD COLUMN payment_request_id uuid REFERENCES public.payment_requests(id);