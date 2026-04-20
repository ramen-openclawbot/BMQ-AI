-- Phase 2: Revenue sync tables
-- Adds is_tier1 flag to existing mini_crm_customers
-- Creates po_sync_jobs, po_parse_runs, sales_po_documents, revenue_drafts

-- Add is_tier1 to mini_crm_customers (safe: IF NOT EXISTS)
ALTER TABLE IF EXISTS mini_crm_customers
  ADD COLUMN IF NOT EXISTS is_tier1 boolean NOT NULL DEFAULT false;

-- ── po_sync_jobs ──────────────────────────────────────────────────────────────
-- Records each manual sync run triggered from the accountant UI.
CREATE TABLE IF NOT EXISTS po_sync_jobs (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id          uuid        REFERENCES mini_crm_customers(id) ON DELETE SET NULL,
  date_from            date        NOT NULL,
  date_to              date        NOT NULL,
  status               text        NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending', 'running', 'done', 'failed')),
  triggered_by         text,
  inbox_rows_found     int         NOT NULL DEFAULT 0,
  inbox_rows_processed int         NOT NULL DEFAULT 0,
  error_message        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz
);

-- ── po_parse_runs ─────────────────────────────────────────────────────────────
-- One record per customer_po_inbox row processed inside a sync job.
CREATE TABLE IF NOT EXISTS po_parse_runs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_job_id       uuid        NOT NULL REFERENCES po_sync_jobs(id) ON DELETE CASCADE,
  inbox_row_id      uuid        NOT NULL,
  customer_id       uuid        REFERENCES mini_crm_customers(id) ON DELETE SET NULL,
  status            text        NOT NULL DEFAULT 'ok'
                                CHECK (status IN ('ok', 'skipped', 'error', 'exception')),
  outcome           text,
  kb_profile_id     uuid,
  kb_version_id     uuid,
  parse_source      text,
  parsed_item_count int         NOT NULL DEFAULT 0,
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ── sales_po_documents ────────────────────────────────────────────────────────
-- Canonical sales PO record derived from a customer_po_inbox row.
-- Unique on inbox_row_id to ensure idempotency across re-runs.
CREATE TABLE IF NOT EXISTS sales_po_documents (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_row_id    uuid           NOT NULL,
  customer_id     uuid           REFERENCES mini_crm_customers(id) ON DELETE SET NULL,
  sync_job_id     uuid           REFERENCES po_sync_jobs(id) ON DELETE SET NULL,
  parse_run_id    uuid           REFERENCES po_parse_runs(id) ON DELETE SET NULL,
  po_number       text,
  po_order_date   date,
  delivery_date   date,
  subtotal_amount numeric(18, 2) NOT NULL DEFAULT 0,
  vat_amount      numeric(18, 2) NOT NULL DEFAULT 0,
  total_amount    numeric(18, 2) NOT NULL DEFAULT 0,
  revenue_channel text,
  parse_source    text,
  items           jsonb          NOT NULL DEFAULT '[]'::jsonb,
  kb_profile_id   uuid,
  kb_version_id   uuid,
  status          text           NOT NULL DEFAULT 'pending_review'
                                 CHECK (status IN ('pending_review', 'approved', 'rejected', 'exception')),
  exception_reason text,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT sales_po_documents_inbox_row_unique UNIQUE (inbox_row_id)
);

-- ── revenue_drafts ────────────────────────────────────────────────────────────
-- Accountant operating queue. One draft per sales_po_document.
-- Tier-1 customers → status='pending' (awaiting approval).
-- Non-Tier-1 customers → status='exception' (need manual review).
CREATE TABLE IF NOT EXISTS revenue_drafts (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_po_doc_id uuid           NOT NULL REFERENCES sales_po_documents(id) ON DELETE CASCADE,
  customer_id     uuid           REFERENCES mini_crm_customers(id) ON DELETE SET NULL,
  sync_job_id     uuid           REFERENCES po_sync_jobs(id) ON DELETE SET NULL,
  po_number       text,
  po_order_date   date,
  delivery_date   date,
  subtotal_amount numeric(18, 2) NOT NULL DEFAULT 0,
  vat_amount      numeric(18, 2) NOT NULL DEFAULT 0,
  total_amount    numeric(18, 2) NOT NULL DEFAULT 0,
  revenue_channel text,
  product_group   text,
  status          text           NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'approved', 'rejected', 'exception')),
  exception_reason text,
  approved_by     text,
  approved_at     timestamptz,
  rejected_by     text,
  rejected_at     timestamptz,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now()
);

-- ── indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_po_parse_runs_sync_job    ON po_parse_runs(sync_job_id);
CREATE INDEX IF NOT EXISTS idx_po_parse_runs_inbox_row   ON po_parse_runs(inbox_row_id);
CREATE INDEX IF NOT EXISTS idx_sales_po_docs_customer    ON sales_po_documents(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_po_docs_status      ON sales_po_documents(status);
CREATE INDEX IF NOT EXISTS idx_revenue_drafts_customer   ON revenue_drafts(customer_id);
CREATE INDEX IF NOT EXISTS idx_revenue_drafts_status     ON revenue_drafts(status);
CREATE INDEX IF NOT EXISTS idx_revenue_drafts_sync_job   ON revenue_drafts(sync_job_id);
