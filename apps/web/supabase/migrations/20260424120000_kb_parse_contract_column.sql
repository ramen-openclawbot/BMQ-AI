-- Add nullable parse_contract jsonb column to knowledge profile tables.
-- This column stores a structured CustomerParseContract for deterministic PO parsing.
-- Existing rows default to NULL (no contract yet).

alter table public.mini_crm_knowledge_profiles
  add column if not exists parse_contract jsonb default null;

alter table public.mini_crm_knowledge_profile_versions
  add column if not exists parse_contract jsonb default null;
