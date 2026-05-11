-- BMQ Cost Classification Phase 1
-- Hidden line-item classification foundation for Quản lý chi phí only.

create table if not exists public.cost_categories (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  label text not null,
  parent_code text references public.cost_categories(code),
  cost_group text not null check (cost_group in ('cogs', 'packaging', 'opex', 'capex', 'kitchen_supply', 'unmapped')),
  product_line text not null default 'general' check (product_line in ('bmq_bread', 'sweet_kitchen', 'shared', 'general')),
  is_revenue_related boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cost_classification_rules (
  id uuid primary key default gen_random_uuid(),
  priority integer not null,
  rule_name text not null unique,
  supplier_id uuid references public.suppliers(id),
  inventory_item_id uuid references public.inventory_items(id),
  sku_id uuid references public.product_skus(id),
  keyword_pattern text,
  match_scope text not null default 'item_text' check (match_scope in ('item_text', 'supplier_name', 'supplier_and_item', 'sku', 'inventory_item')),
  category_code text not null references public.cost_categories(code),
  product_line text not null check (product_line in ('bmq_bread', 'sweet_kitchen', 'shared', 'general')),
  revenue_channel text,
  allocation_rule text not null default 'none' check (allocation_rule in ('direct', 'manual', 'none')),
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  active boolean not null default true,
  effective_from date,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cost_classification_rules_effective_window_check
    check (effective_to is null or effective_from is null or effective_to >= effective_from)
);

create table if not exists public.cost_line_classifications (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('payment_request_item', 'invoice_item')),
  source_line_id uuid not null,
  payment_request_id uuid references public.payment_requests(id),
  invoice_id uuid references public.invoices(id),
  supplier_id uuid references public.suppliers(id),
  category_code text not null references public.cost_categories(code),
  product_line text not null check (product_line in ('bmq_bread', 'sweet_kitchen', 'shared', 'general')),
  revenue_channel text,
  allocation_rule text not null default 'none' check (allocation_rule in ('direct', 'manual', 'none')),
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  classification_source text not null check (classification_source in ('rule', 'supplier_mapping', 'item_mapping', 'sku_mapping', 'manual_override', 'fallback')),
  rule_id uuid references public.cost_classification_rules(id),
  review_status text not null default 'suggested' check (review_status in ('suggested', 'approved', 'rejected', 'needs_review')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cost_line_classifications_source_parent_check check (
    (source_type = 'payment_request_item' and payment_request_id is not null and invoice_id is null)
    or
    (source_type = 'invoice_item' and invoice_id is not null)
  ),
  unique (source_type, source_line_id)
);

create table if not exists public.cost_classification_audit_logs (
  id uuid primary key default gen_random_uuid(),
  classification_id uuid references public.cost_line_classifications(id),
  source_type text not null check (source_type in ('payment_request_item', 'invoice_item')),
  source_line_id uuid not null,
  action text not null check (action in ('created_by_backfill', 'updated_by_rule_refresh', 'manual_override', 'review_approved', 'review_rejected')),
  before jsonb,
  after jsonb not null,
  reason text,
  actor_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists cost_categories_group_idx
  on public.cost_categories(cost_group, product_line, is_active);

create index if not exists cost_classification_rules_active_priority_idx
  on public.cost_classification_rules(active, priority, category_code);

create index if not exists cost_classification_rules_supplier_idx
  on public.cost_classification_rules(supplier_id)
  where supplier_id is not null;

create index if not exists cost_classification_rules_inventory_item_idx
  on public.cost_classification_rules(inventory_item_id)
  where inventory_item_id is not null;

create index if not exists cost_classification_rules_sku_idx
  on public.cost_classification_rules(sku_id)
  where sku_id is not null;

create index if not exists cost_line_classifications_category_idx
  on public.cost_line_classifications(category_code, review_status);

create index if not exists cost_line_classifications_payment_request_idx
  on public.cost_line_classifications(payment_request_id)
  where payment_request_id is not null;

create index if not exists cost_line_classifications_invoice_idx
  on public.cost_line_classifications(invoice_id)
  where invoice_id is not null;

create index if not exists cost_line_classifications_supplier_idx
  on public.cost_line_classifications(supplier_id)
  where supplier_id is not null;

create index if not exists cost_classification_audit_logs_classification_idx
  on public.cost_classification_audit_logs(classification_id, created_at desc);

create or replace function public.touch_cost_classification_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_cost_categories on public.cost_categories;
create trigger trg_touch_cost_categories
  before update on public.cost_categories
  for each row execute function public.touch_cost_classification_updated_at();

drop trigger if exists trg_touch_cost_classification_rules on public.cost_classification_rules;
create trigger trg_touch_cost_classification_rules
  before update on public.cost_classification_rules
  for each row execute function public.touch_cost_classification_updated_at();

drop trigger if exists trg_touch_cost_line_classifications on public.cost_line_classifications;
create trigger trg_touch_cost_line_classifications
  before update on public.cost_line_classifications
  for each row execute function public.touch_cost_classification_updated_at();

insert into public.cost_categories (code, label, cost_group, product_line, is_revenue_related, sort_order)
values
  ('COGS_BMQ_BREAD', 'Chi phí bánh mì que / bánh mì lớn', 'cogs', 'bmq_bread', true, 10),
  ('COGS_SWEET_KITCHEN', 'Chi phí bếp bánh ngọt', 'cogs', 'sweet_kitchen', true, 20),
  ('PACKAGING_SALES', 'Bao bì / tem nhãn / vật tư bán hàng', 'packaging', 'shared', false, 30),
  ('OPEX_GENERAL', 'Chi phí vận hành chung', 'opex', 'general', false, 40),
  ('KITCHEN_SUPPLY_REPAIR', 'Kho bếp / CCDC / vệ sinh / sửa chữa', 'kitchen_supply', 'general', false, 50),
  ('CAPEX_ASSET_PROJECT', 'Tài sản / máy móc / thi công', 'capex', 'general', false, 60),
  ('UNMAPPED_REVIEW', 'Chưa phân loại / cần review', 'unmapped', 'general', false, 70)
on conflict (code) do update set
  label = excluded.label,
  cost_group = excluded.cost_group,
  product_line = excluded.product_line,
  is_revenue_related = excluded.is_revenue_related,
  sort_order = excluded.sort_order,
  is_active = true;

insert into public.cost_classification_rules (
  priority,
  rule_name,
  keyword_pattern,
  match_scope,
  category_code,
  product_line,
  allocation_rule,
  confidence
)
values
  (10, 'CAPEX keywords: thi công / assets / machinery', 'thi công|cọc thi công|nhà xưởng|tủ ủ bột|máy đánh bột|máy móc|tài sản|đợt 3 thi công', 'supplier_and_item', 'CAPEX_ASSET_PROJECT', 'general', 'none', 0.98),
  (100, 'BMQ bread keywords and safe suppliers', 'Tuyết Anh|Vietjet|bánh mì que|bánh mì lớn|bánh mì thịt nguội|pate|chà bông|jambon|giò lụa|chả lụa|mỡ cắt heo|nạc đùi heo|nạc vai heo', 'supplier_and_item', 'COGS_BMQ_BREAD', 'bmq_bread', 'direct', 0.90),
  (110, 'TT FOODS meat items', 'TT FOODS.*(mỡ cắt heo|nạc đùi heo|nạc vai heo|thịt|heo)|(mỡ cắt heo|nạc đùi heo|nạc vai heo|thịt|heo).*TT FOODS', 'supplier_and_item', 'COGS_BMQ_BREAD', 'bmq_bread', 'direct', 0.93),
  (120, 'Thiên An Sinh BMQ fillings', 'Thiên An Sinh.*(chà bông|jambon|giò|chả)|(chà bông|jambon|giò|chả).*Thiên An Sinh', 'supplier_and_item', 'COGS_BMQ_BREAD', 'bmq_bread', 'direct', 0.93),
  (200, 'Sweet kitchen ingredients', 'bơ lạt|Anchor|TH true Butter|cream cheese|creamcheese|phô mai|bột mì|whipping|socola|chocolate|trứng muối|hạnh nhân|nho khô', 'supplier_and_item', 'COGS_SWEET_KITCHEN', 'sweet_kitchen', 'direct', 0.90),
  (210, 'Sweet kitchen supplier context', '(Đại Tân Việt|Hoàng Minh|Thành Nguyên|Nguyên Hà).*(bơ|Anchor|cream|phô mai|whipping|socola|chocolate)|(bơ|Anchor|cream|phô mai|whipping|socola|chocolate).*(Đại Tân Việt|Hoàng Minh|Thành Nguyên|Nguyên Hà)', 'supplier_and_item', 'COGS_SWEET_KITCHEN', 'sweet_kitchen', 'direct', 0.92),
  (300, 'Packaging shared keywords', 'hộp|khay|tem|nhãn|túi|OPP|kraft|cuộn PE|bao bì', 'supplier_and_item', 'PACKAGING_SALES', 'shared', 'manual', 0.90),
  (310, 'Packaging suppliers with sales materials', '(Queen Pack|Siêu Thành|Mỹ Toàn|Ngọc Trân|Cô Trang).*(hộp|khay|tem|nhãn|túi|OPP|kraft|cuộn PE|bao bì)|(hộp|khay|tem|nhãn|túi|OPP|kraft|cuộn PE|bao bì).*(Queen Pack|Siêu Thành|Mỹ Toàn|Ngọc Trân|Cô Trang)', 'supplier_and_item', 'PACKAGING_SALES', 'shared', 'manual', 0.92),
  (320, 'Hoàng Tuấn label materials', 'Hoàng Tuấn.*(tem|nhãn)|(tem|nhãn).*Hoàng Tuấn', 'supplier_and_item', 'PACKAGING_SALES', 'shared', 'manual', 0.92),
  (400, 'OPEX operation keywords', 'điện|nước|gas|thuê kho|mặt bằng|rác|kiểm toán|vận chuyển|xe|internet', 'supplier_and_item', 'OPEX_GENERAL', 'general', 'none', 0.88),
  (500, 'Kitchen supply and repair keywords', 'vệ sinh máy lạnh|bảo trì tủ lạnh|nước rửa chén|sửa|bảo trì|CCDC|dụng cụ|văn phòng phẩm bếp/kho', 'supplier_and_item', 'KITCHEN_SUPPLY_REPAIR', 'general', 'none', 0.86)
on conflict (rule_name) do update set
  priority = excluded.priority,
  keyword_pattern = excluded.keyword_pattern,
  match_scope = excluded.match_scope,
  category_code = excluded.category_code,
  product_line = excluded.product_line,
  allocation_rule = excluded.allocation_rule,
  confidence = excluded.confidence,
  active = true;

create or replace view public.cost_classification_line_details
with (security_invoker = true)
as
select
  clc.id as classification_id,
  clc.source_type,
  clc.source_line_id,
  clc.payment_request_id,
  clc.invoice_id,
  coalesce(pr.request_number, inv.invoice_number) as source_number,
  coalesce(pr.created_at::date, inv.invoice_date) as source_date,
  coalesce(pr.status::text, 'invoice') as source_status,
  coalesce(pr.payment_status::text, null) as payment_status,
  clc.supplier_id,
  s.name as supplier_name,
  pri.product_name,
  pri.product_code,
  pri.unit,
  pri.quantity,
  pri.unit_price,
  coalesce(pri.line_total, pri.quantity * pri.unit_price, 0)::numeric as line_amount,
  clc.category_code,
  cc.label as category_label,
  cc.cost_group,
  clc.product_line,
  clc.revenue_channel,
  clc.allocation_rule,
  clc.confidence,
  clc.classification_source,
  clc.rule_id,
  clc.review_status,
  clc.updated_at
from public.cost_line_classifications clc
join public.payment_request_items pri
  on clc.source_type = 'payment_request_item'
  and clc.source_line_id = pri.id
left join public.payment_requests pr
  on pri.payment_request_id = pr.id
left join public.invoices inv
  on false
left join public.suppliers s
  on coalesce(clc.supplier_id, pr.supplier_id) = s.id
join public.cost_categories cc
  on clc.category_code = cc.code
union all
select
  clc.id as classification_id,
  clc.source_type,
  clc.source_line_id,
  clc.payment_request_id,
  clc.invoice_id,
  coalesce(inv.invoice_number, pr.request_number) as source_number,
  coalesce(inv.invoice_date, pr.created_at::date) as source_date,
  'invoice' as source_status,
  coalesce(pr.payment_status::text, null) as payment_status,
  clc.supplier_id,
  s.name as supplier_name,
  ii.product_name,
  ii.product_code,
  ii.unit,
  ii.quantity,
  ii.unit_price,
  coalesce(ii.line_total, ii.quantity * ii.unit_price, 0)::numeric as line_amount,
  clc.category_code,
  cc.label as category_label,
  cc.cost_group,
  clc.product_line,
  clc.revenue_channel,
  clc.allocation_rule,
  clc.confidence,
  clc.classification_source,
  clc.rule_id,
  clc.review_status,
  clc.updated_at
from public.cost_line_classifications clc
join public.invoice_items ii
  on clc.source_type = 'invoice_item'
  and clc.source_line_id = ii.id
left join public.invoices inv
  on ii.invoice_id = inv.id
left join public.payment_requests pr
  on inv.payment_request_id = pr.id
left join public.suppliers s
  on coalesce(clc.supplier_id, inv.supplier_id, pr.supplier_id) = s.id
join public.cost_categories cc
  on clc.category_code = cc.code;

create or replace view public.cost_classification_category_summary
with (security_invoker = true)
as
select
  category_code,
  category_label,
  cost_group,
  product_line,
  allocation_rule,
  review_status,
  count(*)::integer as line_count,
  coalesce(sum(line_amount), 0)::numeric as total_amount,
  min(source_date) as first_source_date,
  max(source_date) as last_source_date
from public.cost_classification_line_details
group by category_code, category_label, cost_group, product_line, allocation_rule, review_status;

create or replace view public.cost_classification_monthly_summary
with (security_invoker = true)
as
select
  date_trunc('month', source_date)::date as month,
  category_code,
  category_label,
  cost_group,
  product_line,
  allocation_rule,
  review_status,
  count(*)::integer as line_count,
  coalesce(sum(line_amount), 0)::numeric as total_amount
from public.cost_classification_line_details
group by date_trunc('month', source_date)::date, category_code, category_label, cost_group, product_line, allocation_rule, review_status;

alter table public.cost_categories enable row level security;
alter table public.cost_classification_rules enable row level security;
alter table public.cost_line_classifications enable row level security;
alter table public.cost_classification_audit_logs enable row level security;

drop policy if exists "finance_cost_select_cost_categories" on public.cost_categories;
create policy "finance_cost_select_cost_categories"
  on public.cost_categories for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_cost', 'view')
  );

drop policy if exists "finance_cost_edit_cost_categories" on public.cost_categories;
create policy "finance_cost_edit_cost_categories"
  on public.cost_categories for all to authenticated
  using (public.has_role((select auth.uid()), 'owner'))
  with check (public.has_role((select auth.uid()), 'owner'));

drop policy if exists "finance_cost_select_cost_classification_rules" on public.cost_classification_rules;
create policy "finance_cost_select_cost_classification_rules"
  on public.cost_classification_rules for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_cost', 'view')
  );

drop policy if exists "finance_cost_edit_cost_classification_rules" on public.cost_classification_rules;
create policy "finance_cost_edit_cost_classification_rules"
  on public.cost_classification_rules for all to authenticated
  using (public.has_role((select auth.uid()), 'owner'))
  with check (public.has_role((select auth.uid()), 'owner'));

drop policy if exists "finance_cost_select_cost_line_classifications" on public.cost_line_classifications;
create policy "finance_cost_select_cost_line_classifications"
  on public.cost_line_classifications for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_cost', 'view')
  );

drop policy if exists "finance_cost_edit_cost_line_classifications" on public.cost_line_classifications;
create policy "finance_cost_edit_cost_line_classifications"
  on public.cost_line_classifications for all to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_cost', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_cost', 'edit')
  );

drop policy if exists "finance_cost_select_cost_classification_audit_logs" on public.cost_classification_audit_logs;
create policy "finance_cost_select_cost_classification_audit_logs"
  on public.cost_classification_audit_logs for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_cost', 'view')
  );

drop policy if exists "finance_cost_insert_cost_classification_audit_logs" on public.cost_classification_audit_logs;
create policy "finance_cost_insert_cost_classification_audit_logs"
  on public.cost_classification_audit_logs for insert to authenticated
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_cost', 'edit')
  );

create or replace function public.upsert_cost_line_classification_with_audit(
  _classification jsonb,
  _before jsonb default null,
  _action text default 'created_by_backfill',
  _actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_row public.cost_line_classifications;
  before_row jsonb;
  written_row public.cost_line_classifications;
  next_row jsonb;
  existing_compare jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'cost classification backfill RPC requires service role';
  end if;

  if _action not in ('created_by_backfill', 'updated_by_rule_refresh') then
    raise exception 'Unsupported cost classification backfill action: %', _action;
  end if;

  select *
    into existing_row
  from public.cost_line_classifications clc
  where clc.source_type = _classification->>'source_type'
    and clc.source_line_id = (_classification->>'source_line_id')::uuid
  limit 1;

  if found then
    before_row = to_jsonb(existing_row);

    if existing_row.review_status = 'approved'
      or existing_row.classification_source = 'manual_override' then
      return before_row;
    end if;

    next_row = jsonb_build_object(
      'payment_request_id', nullif(_classification->>'payment_request_id', '')::uuid,
      'invoice_id', nullif(_classification->>'invoice_id', '')::uuid,
      'supplier_id', nullif(_classification->>'supplier_id', '')::uuid,
      'category_code', _classification->>'category_code',
      'product_line', _classification->>'product_line',
      'revenue_channel', nullif(_classification->>'revenue_channel', ''),
      'allocation_rule', _classification->>'allocation_rule',
      'confidence', (_classification->>'confidence')::numeric,
      'classification_source', _classification->>'classification_source',
      'rule_id', nullif(_classification->>'rule_id', '')::uuid,
      'review_status', _classification->>'review_status',
      'note', nullif(_classification->>'note', '')
    );
    existing_compare = jsonb_build_object(
      'payment_request_id', existing_row.payment_request_id,
      'invoice_id', existing_row.invoice_id,
      'supplier_id', existing_row.supplier_id,
      'category_code', existing_row.category_code,
      'product_line', existing_row.product_line,
      'revenue_channel', existing_row.revenue_channel,
      'allocation_rule', existing_row.allocation_rule,
      'confidence', existing_row.confidence,
      'classification_source', existing_row.classification_source,
      'rule_id', existing_row.rule_id,
      'review_status', existing_row.review_status,
      'note', existing_row.note
    );

    if existing_compare = next_row then
      return before_row;
    end if;

    update public.cost_line_classifications
    set
      payment_request_id = (next_row->>'payment_request_id')::uuid,
      invoice_id = (next_row->>'invoice_id')::uuid,
      supplier_id = (next_row->>'supplier_id')::uuid,
      category_code = next_row->>'category_code',
      product_line = next_row->>'product_line',
      revenue_channel = next_row->>'revenue_channel',
      allocation_rule = next_row->>'allocation_rule',
      confidence = (next_row->>'confidence')::numeric,
      classification_source = next_row->>'classification_source',
      rule_id = (next_row->>'rule_id')::uuid,
      review_status = next_row->>'review_status',
      note = next_row->>'note',
      updated_at = now()
    where id = existing_row.id
    returning * into written_row;
  else
    insert into public.cost_line_classifications (
      source_type,
      source_line_id,
      payment_request_id,
      invoice_id,
      supplier_id,
      category_code,
      product_line,
      revenue_channel,
      allocation_rule,
      confidence,
      classification_source,
      rule_id,
      review_status,
      note
    )
    values (
      _classification->>'source_type',
      (_classification->>'source_line_id')::uuid,
      nullif(_classification->>'payment_request_id', '')::uuid,
      nullif(_classification->>'invoice_id', '')::uuid,
      nullif(_classification->>'supplier_id', '')::uuid,
      _classification->>'category_code',
      _classification->>'product_line',
      nullif(_classification->>'revenue_channel', ''),
      _classification->>'allocation_rule',
      (_classification->>'confidence')::numeric,
      _classification->>'classification_source',
      nullif(_classification->>'rule_id', '')::uuid,
      _classification->>'review_status',
      nullif(_classification->>'note', '')
    )
    returning * into written_row;
  end if;

  insert into public.cost_classification_audit_logs (
    classification_id,
    source_type,
    source_line_id,
    action,
    before,
    after,
    reason,
    actor_id
  )
  values (
    written_row.id,
    written_row.source_type,
    written_row.source_line_id,
    case when before_row is null then 'created_by_backfill' else _action end,
    coalesce(before_row, _before),
    _classification,
    'cost_classification_phase1_backfill',
    _actor_id
  );

  return to_jsonb(written_row);
end;
$$;

revoke all on function public.upsert_cost_line_classification_with_audit(jsonb, jsonb, text, uuid) from public;
revoke all on function public.upsert_cost_line_classification_with_audit(jsonb, jsonb, text, uuid) from anon;
revoke all on function public.upsert_cost_line_classification_with_audit(jsonb, jsonb, text, uuid) from authenticated;
grant execute on function public.upsert_cost_line_classification_with_audit(jsonb, jsonb, text, uuid) to service_role;

grant select on public.cost_categories to authenticated;
grant select on public.cost_classification_rules to authenticated;
grant select on public.cost_line_classifications to authenticated;
grant select on public.cost_classification_audit_logs to authenticated;
grant select on public.cost_classification_line_details to authenticated;
grant select on public.cost_classification_category_summary to authenticated;
grant select on public.cost_classification_monthly_summary to authenticated;
