-- Create product_skus table for SKU management
CREATE TABLE public.product_skus (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sku_code TEXT NOT NULL UNIQUE,
  product_name TEXT NOT NULL,
  unit TEXT DEFAULT 'kg',
  unit_price NUMERIC DEFAULT 0,
  supplier_id UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  category TEXT,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create index for faster lookups
CREATE INDEX idx_product_skus_sku_code ON public.product_skus(sku_code);
CREATE INDEX idx_product_skus_product_name ON public.product_skus(product_name);

-- Enable RLS
ALTER TABLE public.product_skus ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
CREATE POLICY "Authenticated users can view SKUs"
ON public.product_skus
FOR SELECT
USING (true);

CREATE POLICY "Staff and owners can insert SKUs"
ON public.product_skus
FOR INSERT
WITH CHECK (has_role(auth.uid(), 'owner'::app_role) OR has_role(auth.uid(), 'staff'::app_role));

CREATE POLICY "Staff and owners can update SKUs"
ON public.product_skus
FOR UPDATE
USING (has_role(auth.uid(), 'owner'::app_role) OR has_role(auth.uid(), 'staff'::app_role));

CREATE POLICY "Owners can delete SKUs"
ON public.product_skus
FOR DELETE
USING (has_role(auth.uid(), 'owner'::app_role));

-- Add trigger for auto-updating updated_at
CREATE TRIGGER update_product_skus_updated_at
BEFORE UPDATE ON public.product_skus
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();