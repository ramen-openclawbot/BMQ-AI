-- Create enum for payment request status
CREATE TYPE public.payment_request_status AS ENUM ('pending', 'approved', 'rejected');

-- Create enum for delivery status
CREATE TYPE public.delivery_status AS ENUM ('pending', 'delivered');

-- Create enum for payment status
CREATE TYPE public.payment_status AS ENUM ('unpaid', 'paid');

-- Create payment_requests table
CREATE TABLE public.payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  supplier_id UUID REFERENCES public.suppliers(id),
  total_amount NUMERIC DEFAULT 0,
  status payment_request_status NOT NULL DEFAULT 'pending',
  delivery_status delivery_status NOT NULL DEFAULT 'pending',
  payment_status payment_status NOT NULL DEFAULT 'unpaid',
  image_url TEXT,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id),
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMP WITH TIME ZONE,
  rejection_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create payment_request_items table
CREATE TABLE public.payment_request_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_request_id UUID NOT NULL REFERENCES public.payment_requests(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL,
  product_code TEXT,
  quantity NUMERIC NOT NULL DEFAULT 0,
  unit TEXT DEFAULT 'kg',
  unit_price NUMERIC NOT NULL DEFAULT 0,
  line_total NUMERIC,
  inventory_item_id UUID REFERENCES public.inventory_items(id),
  last_price NUMERIC,
  price_change_percent NUMERIC,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.payment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_request_items ENABLE ROW LEVEL SECURITY;

-- RLS policies for payment_requests
-- Authenticated users can view all requests
CREATE POLICY "Staff and owners can view payment requests"
ON public.payment_requests
FOR SELECT
USING (has_role(auth.uid(), 'owner') OR has_role(auth.uid(), 'staff'));

-- Staff and owners can insert
CREATE POLICY "Staff and owners can insert payment requests"
ON public.payment_requests
FOR INSERT
WITH CHECK (has_role(auth.uid(), 'owner') OR has_role(auth.uid(), 'staff'));

-- Only owners can approve/reject (update)
CREATE POLICY "Owners can update payment requests"
ON public.payment_requests
FOR UPDATE
USING (has_role(auth.uid(), 'owner'));

-- Staff can update their own pending requests
CREATE POLICY "Staff can update own pending requests"
ON public.payment_requests
FOR UPDATE
USING (has_role(auth.uid(), 'staff') AND created_by = auth.uid() AND status = 'pending');

-- Only owners can delete
CREATE POLICY "Owners can delete payment requests"
ON public.payment_requests
FOR DELETE
USING (has_role(auth.uid(), 'owner'));

-- RLS policies for payment_request_items
CREATE POLICY "Staff and owners can view payment request items"
ON public.payment_request_items
FOR SELECT
USING (has_role(auth.uid(), 'owner') OR has_role(auth.uid(), 'staff'));

CREATE POLICY "Staff and owners can manage payment request items"
ON public.payment_request_items
FOR ALL
USING (has_role(auth.uid(), 'owner') OR has_role(auth.uid(), 'staff'));

-- Add trigger for updated_at
CREATE TRIGGER update_payment_requests_updated_at
BEFORE UPDATE ON public.payment_requests
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();