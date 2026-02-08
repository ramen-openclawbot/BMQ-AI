-- Create storage bucket for invoice images
INSERT INTO storage.buckets (id, name, public)
VALUES ('invoices', 'invoices', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for invoice images
CREATE POLICY "Staff and owners can upload invoices"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'invoices' AND 
  (has_role(auth.uid(), 'owner') OR has_role(auth.uid(), 'staff'))
);

CREATE POLICY "Staff and owners can view invoices"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'invoices' AND 
  (has_role(auth.uid(), 'owner') OR has_role(auth.uid(), 'staff'))
);

CREATE POLICY "Staff and owners can update invoices"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'invoices' AND 
  (has_role(auth.uid(), 'owner') OR has_role(auth.uid(), 'staff'))
);

CREATE POLICY "Owners can delete invoice images"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'invoices' AND 
  has_role(auth.uid(), 'owner')
);

-- Create invoices table
CREATE TABLE public.invoices (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_number TEXT NOT NULL,
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
  supplier_id UUID REFERENCES public.suppliers(id) ON DELETE SET NULL,
  subtotal NUMERIC DEFAULT 0,
  vat_amount NUMERIC DEFAULT 0,
  total_amount NUMERIC DEFAULT 0,
  image_url TEXT,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create invoice_items table
CREATE TABLE public.invoice_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  product_code TEXT,
  product_name TEXT NOT NULL,
  unit TEXT DEFAULT 'kg',
  quantity NUMERIC NOT NULL DEFAULT 0,
  unit_price NUMERIC NOT NULL DEFAULT 0,
  line_total NUMERIC GENERATED ALWAYS AS (quantity * unit_price) STORED,
  inventory_item_id UUID REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;

-- RLS policies for invoices
CREATE POLICY "Staff and owners can view invoices"
ON public.invoices FOR SELECT
USING (has_role(auth.uid(), 'owner') OR has_role(auth.uid(), 'staff'));

CREATE POLICY "Staff and owners can insert invoices"
ON public.invoices FOR INSERT
WITH CHECK (has_role(auth.uid(), 'owner') OR has_role(auth.uid(), 'staff'));

CREATE POLICY "Staff and owners can update invoices"
ON public.invoices FOR UPDATE
USING (has_role(auth.uid(), 'owner') OR has_role(auth.uid(), 'staff'));

CREATE POLICY "Owners can delete invoices"
ON public.invoices FOR DELETE
USING (has_role(auth.uid(), 'owner'));

-- RLS policies for invoice_items
CREATE POLICY "Staff and owners can view invoice items"
ON public.invoice_items FOR SELECT
USING (has_role(auth.uid(), 'owner') OR has_role(auth.uid(), 'staff'));

CREATE POLICY "Staff and owners can manage invoice items"
ON public.invoice_items FOR ALL
USING (has_role(auth.uid(), 'owner') OR has_role(auth.uid(), 'staff'));

-- Trigger for updated_at
CREATE TRIGGER update_invoices_updated_at
BEFORE UPDATE ON public.invoices
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();