
-- Create enum types for new modules
CREATE TYPE goods_receipt_status AS ENUM ('draft', 'confirmed', 'received');
CREATE TYPE purchase_order_status AS ENUM ('draft', 'sent', 'in_transit', 'completed', 'cancelled');
CREATE TYPE payment_type AS ENUM ('old_order', 'new_order');

-- Create goods_receipts table (Phiếu Nhập Kho)
CREATE TABLE public.goods_receipts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  receipt_number TEXT NOT NULL,
  supplier_id UUID REFERENCES public.suppliers(id),
  receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
  image_url TEXT,
  status goods_receipt_status NOT NULL DEFAULT 'draft',
  total_quantity NUMERIC DEFAULT 0,
  notes TEXT,
  purchase_order_id UUID,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create goods_receipt_items table
CREATE TABLE public.goods_receipt_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  goods_receipt_id UUID NOT NULL REFERENCES public.goods_receipts(id) ON DELETE CASCADE,
  sku_id UUID REFERENCES public.product_skus(id),
  product_name TEXT NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 0,
  unit TEXT DEFAULT 'kg',
  inventory_item_id UUID REFERENCES public.inventory_items(id),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create purchase_orders table (Đơn Đặt Hàng)
CREATE TABLE public.purchase_orders (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  po_number TEXT NOT NULL,
  supplier_id UUID REFERENCES public.suppliers(id),
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_date DATE,
  status purchase_order_status NOT NULL DEFAULT 'draft',
  total_amount NUMERIC DEFAULT 0,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create purchase_order_items table
CREATE TABLE public.purchase_order_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  purchase_order_id UUID NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  sku_id UUID REFERENCES public.product_skus(id),
  product_name TEXT NOT NULL,
  quantity NUMERIC NOT NULL DEFAULT 0,
  unit TEXT DEFAULT 'kg',
  unit_price NUMERIC DEFAULT 0,
  line_total NUMERIC DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Add foreign key from goods_receipts to purchase_orders
ALTER TABLE public.goods_receipts 
ADD CONSTRAINT fk_goods_receipts_purchase_order 
FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id);

-- Update payment_requests table with new columns
ALTER TABLE public.payment_requests 
ADD COLUMN goods_receipt_id UUID REFERENCES public.goods_receipts(id),
ADD COLUMN payment_type payment_type DEFAULT 'old_order';

-- Enable RLS on all new tables
ALTER TABLE public.goods_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goods_receipt_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_order_items ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for goods_receipts
CREATE POLICY "Authenticated users full access to goods_receipts" 
ON public.goods_receipts 
FOR ALL 
USING (auth.uid() IS NOT NULL);

CREATE POLICY "public_full_access" 
ON public.goods_receipts 
FOR ALL 
USING (true)
WITH CHECK (true);

-- Create RLS policies for goods_receipt_items
CREATE POLICY "Authenticated users full access to goods_receipt_items" 
ON public.goods_receipt_items 
FOR ALL 
USING (auth.uid() IS NOT NULL);

CREATE POLICY "public_full_access" 
ON public.goods_receipt_items 
FOR ALL 
USING (true)
WITH CHECK (true);

-- Create RLS policies for purchase_orders
CREATE POLICY "Authenticated users full access to purchase_orders" 
ON public.purchase_orders 
FOR ALL 
USING (auth.uid() IS NOT NULL);

CREATE POLICY "public_full_access" 
ON public.purchase_orders 
FOR ALL 
USING (true)
WITH CHECK (true);

-- Create RLS policies for purchase_order_items
CREATE POLICY "Authenticated users full access to purchase_order_items" 
ON public.purchase_order_items 
FOR ALL 
USING (auth.uid() IS NOT NULL);

CREATE POLICY "public_full_access" 
ON public.purchase_order_items 
FOR ALL 
USING (true)
WITH CHECK (true);

-- Create updated_at triggers
CREATE TRIGGER update_goods_receipts_updated_at
BEFORE UPDATE ON public.goods_receipts
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_purchase_orders_updated_at
BEFORE UPDATE ON public.purchase_orders
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create function to generate receipt number
CREATE OR REPLACE FUNCTION public.generate_receipt_number()
RETURNS TEXT
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  next_num INT;
  new_number TEXT;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(receipt_number FROM 5) AS INT)), 0) + 1
  INTO next_num
  FROM public.goods_receipts
  WHERE receipt_number LIKE 'GRN-%';
  
  new_number := 'GRN-' || LPAD(next_num::TEXT, 6, '0');
  RETURN new_number;
END;
$$;

-- Create function to generate PO number
CREATE OR REPLACE FUNCTION public.generate_po_number()
RETURNS TEXT
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  next_num INT;
  new_number TEXT;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(po_number FROM 4) AS INT)), 0) + 1
  INTO next_num
  FROM public.purchase_orders
  WHERE po_number LIKE 'PO-%';
  
  new_number := 'PO-' || LPAD(next_num::TEXT, 6, '0');
  RETURN new_number;
END;
$$;
