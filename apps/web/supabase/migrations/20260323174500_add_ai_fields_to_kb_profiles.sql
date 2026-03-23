alter table public.mini_crm_knowledge_profiles
  add column if not exists business_description text,
  add column if not exists ai_parse_config jsonb,
  add column if not exists template_context text;

alter table public.mini_crm_knowledge_profile_versions
  add column if not exists business_description text,
  add column if not exists ai_parse_config jsonb,
  add column if not exists template_context text;

alter table public.mini_crm_knowledge_change_requests
  add column if not exists business_description text,
  add column if not exists ai_parse_config jsonb,
  add column if not exists template_context text;

create index if not exists mini_crm_kb_profiles_ai_parse_config_gin
  on public.mini_crm_knowledge_profiles using gin (ai_parse_config);
