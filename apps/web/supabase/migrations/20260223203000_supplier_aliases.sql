CREATE EXTENSION IF NOT EXISTS unaccent;

-- Supplier Alias Manager: map OCR variants/abbreviations to canonical suppliers

CREATE TABLE IF NOT EXISTS public.supplier_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  alias_text text NOT NULL,
  alias_key text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_aliases_alias_key_key UNIQUE (alias_key)
);

CREATE INDEX IF NOT EXISTS idx_supplier_aliases_supplier_id ON public.supplier_aliases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_aliases_active ON public.supplier_aliases(active);

CREATE OR REPLACE FUNCTION public.set_supplier_alias_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.alias_key := lower(trim(regexp_replace(unaccent(coalesce(NEW.alias_text, '')), '[^a-zA-Z0-9\s]+', ' ', 'g')));
  NEW.alias_key := regexp_replace(NEW.alias_key, '\s+', ' ', 'g');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_supplier_alias_key ON public.supplier_aliases;
CREATE TRIGGER trg_set_supplier_alias_key
BEFORE INSERT OR UPDATE ON public.supplier_aliases
FOR EACH ROW
EXECUTE FUNCTION public.set_supplier_alias_key();

ALTER TABLE public.supplier_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "supplier_aliases_read" ON public.supplier_aliases;
CREATE POLICY "supplier_aliases_read"
ON public.supplier_aliases
FOR SELECT
TO authenticated
USING (true);

DROP POLICY IF EXISTS "supplier_aliases_write" ON public.supplier_aliases;
CREATE POLICY "supplier_aliases_write"
ON public.supplier_aliases
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);
