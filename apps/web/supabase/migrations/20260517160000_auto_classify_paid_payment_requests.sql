-- Auto-classify Duyệt chi line items when a payment request is marked paid.
-- Source of truth remains cost_line_classifications; UI reads the summary/detail views.

alter table public.payment_requests
  add column if not exists paid_at timestamptz;

-- Preserve historical paid rows with a stable bootstrap date so monthly classification does not drift with later edits.
-- Before paid_at existed, the closest audited business timestamp is approved_at; created_at is the fallback.
update public.payment_requests
set paid_at = coalesce(approved_at, created_at)
where payment_status = 'paid'
  and paid_at is null;

create or replace function public.set_payment_request_paid_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payment_status = 'paid'
    and coalesce(old.payment_status::text, '') is distinct from 'paid'
    and new.paid_at is null then
    new.paid_at = now();
  end if;

  return new;
end;
$$;

drop trigger if exists trg_set_payment_request_paid_at on public.payment_requests;
create trigger trg_set_payment_request_paid_at
  before update of payment_status, paid_at on public.payment_requests
  for each row
  execute function public.set_payment_request_paid_at();

create or replace function public.classify_paid_payment_request(_payment_request_id uuid, _actor_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  pr_row public.payment_requests%rowtype;
  item_row public.payment_request_items%rowtype;
  supplier_label text;
  item_text text;
  supplier_text text;
  haystack text;
  matched_rule public.cost_classification_rules%rowtype;
  existing_row public.cost_line_classifications%rowtype;
  before_row jsonb;
  next_payload jsonb;
  next_category_code text;
  next_product_line text;
  next_revenue_channel text;
  next_allocation_rule text;
  next_confidence numeric;
  next_source text;
  next_rule_id uuid;
  next_review_status text;
  written_id uuid;
  changed_count integer := 0;
begin
  select * into pr_row
  from public.payment_requests
  where id = _payment_request_id;

  if not found or pr_row.payment_status <> 'paid' then
    return 0;
  end if;

  select coalesce(s.name, '') into supplier_label
  from public.suppliers s
  where s.id = pr_row.supplier_id;
  supplier_label := coalesce(supplier_label, '');

  for item_row in
    select *
    from public.payment_request_items
    where payment_request_id = _payment_request_id
  loop
    item_text := concat_ws(' ', item_row.product_name, item_row.product_code, item_row.unit);
    supplier_text := supplier_label;
    haystack := concat_ws(' ', supplier_text, item_text);

    matched_rule := null;
    select r.* into matched_rule
    from public.cost_classification_rules r
    where r.active
      and r.confidence >= 0.7
      and (r.effective_from is null or r.effective_from <= coalesce(pr_row.paid_at::date, now()::date))
      and (r.effective_to is null or r.effective_to >= coalesce(pr_row.paid_at::date, now()::date))
      and (
        (r.match_scope = 'sku' and r.sku_id is not null and r.sku_id = item_row.sku_id)
        or (r.match_scope = 'inventory_item' and r.inventory_item_id is not null and r.inventory_item_id = item_row.inventory_item_id)
        or (r.match_scope = 'supplier_name' and r.keyword_pattern is not null and supplier_text ~* r.keyword_pattern)
        or (r.match_scope = 'item_text' and r.keyword_pattern is not null and item_text ~* r.keyword_pattern)
        or (r.match_scope = 'supplier_and_item' and r.keyword_pattern is not null and haystack ~* r.keyword_pattern)
      )
    order by r.priority asc, r.created_at asc
    limit 1;

    if found then
      next_category_code := matched_rule.category_code;
      next_product_line := matched_rule.product_line;
      next_revenue_channel := matched_rule.revenue_channel;
      next_allocation_rule := matched_rule.allocation_rule;
      next_confidence := matched_rule.confidence;
      next_source := 'rule';
      next_rule_id := matched_rule.id;
      next_review_status := 'suggested';
    else
      next_category_code := 'UNMAPPED_REVIEW';
      next_product_line := 'general';
      next_revenue_channel := null;
      next_allocation_rule := 'none';
      next_confidence := 0;
      next_source := 'fallback';
      next_rule_id := null;
      next_review_status := 'needs_review';
    end if;

    select * into existing_row
    from public.cost_line_classifications clc
    where clc.source_type = 'payment_request_item'
      and clc.source_line_id = item_row.id
    limit 1;

    if found and (
      existing_row.classification_source = 'manual_override'
      or existing_row.review_status = 'approved'
    ) then
      continue;
    end if;

    before_row := case when found then to_jsonb(existing_row) else null end;

    if found
      and existing_row.payment_request_id is not distinct from pr_row.id
      and existing_row.invoice_id is null
      and existing_row.supplier_id is not distinct from pr_row.supplier_id
      and existing_row.category_code = next_category_code
      and existing_row.product_line = next_product_line
      and existing_row.revenue_channel is not distinct from next_revenue_channel
      and existing_row.allocation_rule = next_allocation_rule
      and existing_row.confidence = next_confidence
      and existing_row.classification_source = next_source
      and existing_row.rule_id is not distinct from next_rule_id
      and existing_row.review_status = next_review_status then
      continue;
    end if;

    next_payload := jsonb_build_object(
      'source_type', 'payment_request_item',
      'source_line_id', item_row.id,
      'payment_request_id', pr_row.id,
      'invoice_id', null,
      'supplier_id', pr_row.supplier_id,
      'category_code', next_category_code,
      'product_line', next_product_line,
      'revenue_channel', next_revenue_channel,
      'allocation_rule', next_allocation_rule,
      'confidence', next_confidence,
      'classification_source', next_source,
      'rule_id', next_rule_id,
      'review_status', next_review_status,
      'note', 'Auto-classified when payment request was marked paid'
    );

    if found then
      update public.cost_line_classifications
      set
        payment_request_id = pr_row.id,
        invoice_id = null,
        supplier_id = pr_row.supplier_id,
        category_code = next_category_code,
        product_line = next_product_line,
        revenue_channel = next_revenue_channel,
        allocation_rule = next_allocation_rule,
        confidence = next_confidence,
        classification_source = next_source,
        rule_id = next_rule_id,
        review_status = next_review_status,
        note = 'Auto-classified when payment request was marked paid',
        updated_at = now()
      where id = existing_row.id
      returning id into written_id;
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
      ) values (
        'payment_request_item',
        item_row.id,
        pr_row.id,
        null,
        pr_row.supplier_id,
        next_category_code,
        next_product_line,
        next_revenue_channel,
        next_allocation_rule,
        next_confidence,
        next_source,
        next_rule_id,
        next_review_status,
        'Auto-classified when payment request was marked paid'
      )
      returning id into written_id;
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
    ) values (
      written_id,
      'payment_request_item',
      item_row.id,
      case when before_row is null then 'created_by_backfill' else 'updated_by_rule_refresh' end,
      before_row,
      next_payload,
      'paid_payment_request_auto_classification',
      _actor_id
    );

    changed_count := changed_count + 1;
  end loop;

  return changed_count;
end;
$$;

revoke all on function public.classify_paid_payment_request(uuid, uuid) from public;
revoke all on function public.classify_paid_payment_request(uuid, uuid) from anon;
revoke all on function public.classify_paid_payment_request(uuid, uuid) from authenticated;
grant execute on function public.classify_paid_payment_request(uuid, uuid) to service_role;

create or replace function public.handle_paid_payment_request_cost_classification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payment_status = 'paid'
    and coalesce(old.payment_status::text, '') is distinct from 'paid' then
    perform public.classify_paid_payment_request(new.id, auth.uid());
  end if;

  return new;
end;
$$;

drop trigger if exists trg_classify_paid_payment_request on public.payment_requests;
create trigger trg_classify_paid_payment_request
  after update of payment_status on public.payment_requests
  for each row
  execute function public.handle_paid_payment_request_cost_classification();

-- Keep the classification detail date aligned with actual payment timing for PR costs.
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
  coalesce(pr.paid_at::date, pr.created_at::date, inv.invoice_date) as source_date,
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
  coalesce(pr.paid_at::date, inv.invoice_date, pr.created_at::date) as source_date,
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

-- Backfill current paid payment requests that do not have line classifications yet.
do $$
declare
  paid_pr record;
begin
  for paid_pr in
    select id
    from public.payment_requests
    where payment_status = 'paid'
  loop
    perform public.classify_paid_payment_request(paid_pr.id, null);
  end loop;
end;
$$;

grant select on public.cost_classification_line_details to authenticated;
grant select on public.cost_classification_category_summary to authenticated;
grant select on public.cost_classification_monthly_summary to authenticated;
