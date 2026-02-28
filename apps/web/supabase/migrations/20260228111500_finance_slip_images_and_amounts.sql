alter table public.ceo_daily_closing_declarations
  add column if not exists qtm_slip_image_base64 text,
  add column if not exists unc_slip_image_base64 text,
  add column if not exists qtm_extracted_amount numeric(15,2),
  add column if not exists unc_extracted_amount numeric(15,2),
  add column if not exists extraction_meta jsonb;
