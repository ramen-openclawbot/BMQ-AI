-- Owner 2026-10-09: payroll editors (e.g. kế toán trưởng with payroll can_edit)
-- manage the payslip-portal phones too, not only the owner. Publishing payslips
-- stays owner-only (payroll_bn_publish_payslips is unchanged).
drop policy if exists payroll_bn_employee_contacts_select on public.payroll_bn_employee_contacts;
create policy payroll_bn_employee_contacts_select on public.payroll_bn_employee_contacts
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_employee_contacts_insert on public.payroll_bn_employee_contacts;
create policy payroll_bn_employee_contacts_insert on public.payroll_bn_employee_contacts
  for insert to authenticated
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_employee_contacts_update on public.payroll_bn_employee_contacts;
create policy payroll_bn_employee_contacts_update on public.payroll_bn_employee_contacts
  for update to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_employee_contacts_delete on public.payroll_bn_employee_contacts;
create policy payroll_bn_employee_contacts_delete on public.payroll_bn_employee_contacts
  for delete to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );
