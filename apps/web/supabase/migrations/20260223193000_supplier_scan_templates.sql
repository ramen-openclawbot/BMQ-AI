-- Learn supplier-specific scan templates to improve future extraction

CREATE TABLE IF NOT EXISTS public.supplier_scan_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NULL REFERENCES public.suppliers(id) ON DELETE SET NULL,
  supplier_name_key text NOT NULL,
  template_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  hit_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_scan_templates_supplier_name_key_key UNIQUE (supplier_name_key)
);

CREATE INDEX IF NOT EXISTS idx_supplier_scan_templates_supplier_id ON public.supplier_scan_templates(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_scan_templates_last_used_at ON public.supplier_scan_templates(last_used_at DESC);

CREATE OR REPLACE FUNCTION public.increment_supplier_template_hit(p_supplier_name_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.supplier_scan_templates
  SET hit_count = hit_count + 1,
      last_used_at = now(),
      updated_at = now()
  WHERE supplier_name_key = p_supplier_name_key;
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_supplier_template_hit(text) TO anon, authenticated, service_role;
