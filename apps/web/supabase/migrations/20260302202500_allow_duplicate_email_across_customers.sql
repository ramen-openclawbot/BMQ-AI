-- Allow one sender email to be mapped to multiple CRM customers/agencies.
-- Keep uniqueness only within the same customer.

DO $$
DECLARE
  c record;
BEGIN
  -- Drop UNIQUE(email) constraints if they exist
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.mini_crm_customer_emails'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE 'UNIQUE (email)%'
  LOOP
    EXECUTE format('ALTER TABLE public.mini_crm_customer_emails DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

-- Ensure same email is not duplicated within one customer
CREATE UNIQUE INDEX IF NOT EXISTS mini_crm_customer_emails_customer_id_email_key
  ON public.mini_crm_customer_emails (customer_id, email);

-- Fast lookup by email for sync matching
CREATE INDEX IF NOT EXISTS mini_crm_customer_emails_email_idx
  ON public.mini_crm_customer_emails (email);
