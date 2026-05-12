-- Allow finance_cost editors to review cost classification lines and persist manual category memory.

grant update on public.cost_line_classifications to authenticated;
grant insert on public.cost_classification_audit_logs to authenticated;
grant insert, update on public.cost_classification_rules to authenticated;

-- Manual review should be possible for finance cost editors, not only owners.
drop policy if exists "finance_cost_edit_cost_classification_rules" on public.cost_classification_rules;
create policy "finance_cost_edit_cost_classification_rules"
  on public.cost_classification_rules for all to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_cost', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_cost', 'edit')
  );
