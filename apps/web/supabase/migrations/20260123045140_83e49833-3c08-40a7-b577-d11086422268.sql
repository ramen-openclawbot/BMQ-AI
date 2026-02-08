-- Add purchase_order_id column to payment_requests table
ALTER TABLE public.payment_requests 
ADD COLUMN purchase_order_id uuid REFERENCES public.purchase_orders(id);

-- Add comment for documentation
COMMENT ON COLUMN public.payment_requests.purchase_order_id IS 'Liên kết trực tiếp với đơn đặt hàng (PO)';