-- Merchant draft guard warnings (advisory, never blocking).
-- This migration is intentionally NOT applied by the coding agent.

alter table public.merchant_staged_changes
  add column if not exists guard_notes text[] not null default '{}';

alter table public.merchant_staged_changes
  add column if not exists guard_provider text;

comment on column public.merchant_staged_changes.guard_notes is
  'Vietnamese advisory warnings from merchant-draft-guard; empty when the guard was unavailable or found nothing.';

comment on column public.merchant_staged_changes.guard_provider is
  'Decisions provider that produced guard_notes (openai/typesafe/fallback), or unavailable when the guard failed.';
