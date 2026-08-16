-- Retire legacy Kingfood/KFM daily material issue RPC side effects.
-- Historical kfm_daily_material_issue* tables and rows are intentionally kept
-- for audit/print history. This follow-up only closes EXECUTE on the legacy
-- browser-callable RPCs so ProductionPlanning cannot accidentally invoke them.

revoke execute on function public.upsert_kfm_daily_material_issue(date) from public;
revoke execute on function public.upsert_kfm_daily_material_issue(date) from anon;
revoke execute on function public.upsert_kfm_daily_material_issue(date) from authenticated;
revoke execute on function public.upsert_kfm_daily_material_issue(date) from service_role;

revoke execute on function public.mark_kfm_daily_material_issue_printed(uuid) from public;
revoke execute on function public.mark_kfm_daily_material_issue_printed(uuid) from anon;
revoke execute on function public.mark_kfm_daily_material_issue_printed(uuid) from authenticated;
revoke execute on function public.mark_kfm_daily_material_issue_printed(uuid) from service_role;
