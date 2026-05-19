-- Separate debt-recipient emails from PO/CRM recognition emails.
-- Existing customer recognition emails are copied once as the initial debt recipient list.

ALTER TABLE public.mini_crm_customers
  ADD COLUMN IF NOT EXISTS debt_emails text[] NOT NULL DEFAULT '{}';

UPDATE public.mini_crm_customers c
SET debt_emails = COALESCE(src.emails, '{}')
FROM (
  SELECT
    customer_id,
    array_agg(DISTINCT lower(btrim(email)) ORDER BY lower(btrim(email))) FILTER (WHERE btrim(email) <> '') AS emails
  FROM public.mini_crm_customer_emails
  GROUP BY customer_id
) src
WHERE c.id = src.customer_id
  AND COALESCE(array_length(c.debt_emails, 1), 0) = 0
  AND COALESCE(array_length(src.emails, 1), 0) > 0;

COMMENT ON COLUMN public.mini_crm_customers.debt_emails IS 'Email recipients used for customer debt statements. Seeded from recognition emails but editable independently.';
