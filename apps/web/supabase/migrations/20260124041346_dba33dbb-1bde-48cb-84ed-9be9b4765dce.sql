-- Create app_settings table for system configuration
CREATE TABLE public.app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Insert default values
INSERT INTO public.app_settings (key, value) VALUES
  ('app_version', '1'),
  ('maintenance_mode', 'false'),
  ('maintenance_message', 'Hệ thống đang cập nhật, vui lòng chờ trong giây lát...');

-- Enable RLS
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Everyone can read app_settings (needed for version/maintenance check)
CREATE POLICY "Anyone can read app_settings"
  ON public.app_settings FOR SELECT
  TO public
  USING (true);

-- Only owners can update app_settings
CREATE POLICY "Only owners can update app_settings"
  ON public.app_settings FOR UPDATE
  TO authenticated
  USING (has_role(auth.uid(), 'owner'::app_role));

-- Enable realtime for app_settings
ALTER PUBLICATION supabase_realtime ADD TABLE public.app_settings;