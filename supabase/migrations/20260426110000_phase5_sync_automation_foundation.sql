-- Phase 5A: Automation scheduler foundation
-- Adds persistent scheduler configuration for revenue sync automation UI.

CREATE TABLE IF NOT EXISTS po_sync_schedules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key     text NOT NULL DEFAULT 'default',
  customer_id    uuid REFERENCES mini_crm_customers(id) ON DELETE SET NULL,
  is_enabled     boolean NOT NULL DEFAULT false,
  scope_mode     text NOT NULL DEFAULT 'tier1_only'
                         CHECK (scope_mode IN ('all_root_customers', 'single_customer', 'tier1_only')),
  schedule_mode  text NOT NULL DEFAULT 'daily'
                         CHECK (schedule_mode IN ('daily')),
  run_hour_local text NOT NULL DEFAULT '06:00',
  timezone       text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  lookback_days  integer NOT NULL DEFAULT 1 CHECK (lookback_days >= 1 AND lookback_days <= 30),
  notes          text,
  last_job_id    uuid REFERENCES po_sync_jobs(id) ON DELETE SET NULL,
  last_run_at    timestamptz,
  created_by     text,
  updated_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_sync_schedules_customer ON po_sync_schedules(customer_id);
CREATE INDEX IF NOT EXISTS idx_po_sync_schedules_enabled ON po_sync_schedules(is_enabled);
CREATE UNIQUE INDEX IF NOT EXISTS idx_po_sync_schedules_config_key ON po_sync_schedules(config_key);
