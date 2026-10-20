-- BMQ cost category tree, approved 2026-10-20.
--
-- This migration is configuration only:
--   (a) adds the nullable cost_categories.sushi_hint used as the Sushi example;
--   (b) upserts four parents and their 24 leaves;
--   (c) deactivates the six old codes (kept, never deleted) and the rules that
--       point at any now-inactive category;
--   (d) replaces the service-role writer with the product-line aware version;
--   (e) replaces the candidate reader so unapproved rows under the old tree are
--       asked once more.
--
-- It never inserts, updates or deletes cost_line_classifications, payment or
-- invoice rows; all such writes stay inside the existing audited RPCs.

-- ===========================================================================
-- 1. Sushi example hint
-- ===========================================================================

alter table public.cost_categories
  add column if not exists sushi_hint text;

-- ===========================================================================
-- 2. Parents
-- ===========================================================================

insert into public.cost_categories (
  code,
  label,
  parent_code,
  cost_group,
  product_line,
  allocation_rule,
  sushi_hint,
  is_active,
  sort_order
)
values
  ('A_COGS', 'Giá vốn hàng bán', null, 'cogs', 'shared', 'none', null, true, 100),
  ('B_SELLING', 'Chi phí bán hàng', null, 'opex', 'shared', 'none', null, true, 200),
  ('C_OPERATING', 'Chi phí vận hành, quản lý', null, 'opex', 'shared', 'none', null, true, 300),
  ('D_INVESTMENT', 'Đầu tư (khấu hao)', null, 'capex', 'shared', 'none', null, true, 400)
on conflict (code) do update set
  label = excluded.label,
  parent_code = excluded.parent_code,
  cost_group = excluded.cost_group,
  product_line = excluded.product_line,
  allocation_rule = excluded.allocation_rule,
  sushi_hint = excluded.sushi_hint,
  is_active = true,
  sort_order = excluded.sort_order,
  updated_at = now();

-- ===========================================================================
-- 3. Leaves: A_COGS (7), B_SELLING (4), C_OPERATING (11), D_INVESTMENT (2)
-- ===========================================================================

insert into public.cost_categories (
  code,
  label,
  parent_code,
  cost_group,
  product_line,
  allocation_rule,
  sushi_hint,
  is_active,
  sort_order
)
values
  ('A1_BREAD_BOUGHT', 'Bánh mì thành phẩm mua ngoài', 'A_COGS', 'cogs', 'shared', 'direct', 'bánh mì que, bánh mì lớn mua của HKD Tuyết Anh', true, 101),
  ('A2_MEAT_OFFAL', 'Thịt và nội tạng', 'A_COGS', 'cogs', 'shared', 'direct', 'mỡ heo, nạc đùi, gan heo làm pate', true, 102),
  ('A3_FLOSS_FILLING', 'Chà bông, nhân chế biến sẵn', 'A_COGS', 'cogs', 'shared', 'direct', 'chà bông, chà bông cay, nhân làm sẵn', true, 103),
  ('A4_DAIRY_EGG', 'Bơ, sữa, trứng, phô mai', 'A_COGS', 'cogs', 'shared', 'direct', 'bơ lạt, bơ Peerless, Anchor, phô mai, trứng gà, sữa', true, 104),
  ('A5_DRY_SPICE', 'NVL khô, gia vị', 'A_COGS', 'cogs', 'shared', 'direct', 'bột mì, men, đường, tiêu, dầu ăn, tương ớt, bột năng', true, 105),
  ('A6_FRESH_PRODUCE', 'Rau củ tươi', 'A_COGS', 'cogs', 'shared', 'direct', 'cà rốt, củ cải, tỏi lột, rau', true, 106),
  ('A7_PACKAGING', 'Bao bì, tem nhãn', 'A_COGS', 'packaging', 'shared', 'manual', 'túi bánh mì, hộp, khay, decal, nhãn, sticker, băng keo, bao hút chân không', true, 107),
  ('B1_DELIVERY', 'Vận chuyển, giao hàng', 'B_SELLING', 'opex', 'shared', 'none', 'xe lôi, Ahamove, Green SM, cước giao bánh', true, 201),
  ('B2_KIOSK_RENT', 'Mặt bằng điểm bán', 'B_SELLING', 'opex', 'shared', 'none', 'tiền mặt bằng điểm bán, kiosk', true, 202),
  ('B3_MARKETING', 'Marketing, quảng cáo', 'B_SELLING', 'opex', 'shared', 'none', 'quảng cáo, in ấn khuyến mãi', true, 203),
  ('B4_PLATFORM_FEE', 'Phí sàn, app giao hàng', 'B_SELLING', 'opex', 'shared', 'none', 'phí Grab, Shopee, sàn', true, 204),
  ('C1_WAREHOUSE_RENT', 'Thuê kho, bếp', 'C_OPERATING', 'opex', 'shared', 'none', 'tiền thuê kho Q7, kho Tân Tạo, bếp', true, 301),
  ('C2_ELECTRICITY', 'Điện', 'C_OPERATING', 'opex', 'shared', 'none', 'tiền điện, điện lực', true, 302),
  ('C3_WATER_WASTE', 'Nước, rác', 'C_OPERATING', 'opex', 'shared', 'none', 'tiền nước, tiền rác', true, 303),
  ('C4_GAS', 'Gas', 'C_OPERATING', 'opex', 'shared', 'none', 'gas, khí hóa lỏng LPG', true, 304),
  ('C5_TELECOM', 'Internet, điện thoại', 'C_OPERATING', 'opex', 'shared', 'none', 'cước điện thoại, internet, VNPT, số điện thoại', true, 305),
  ('C6_PAYROLL', 'Lương, thưởng', 'C_OPERATING', 'opex', 'shared', 'none', 'lương, thưởng, tạm ứng lương', true, 306),
  ('C7_SOCIAL_INSURANCE', 'Bảo hiểm xã hội', 'C_OPERATING', 'opex', 'shared', 'none', 'BHXH, bảo hiểm', true, 307),
  ('C8_REPAIR', 'Sửa chữa, bảo trì', 'C_OPERATING', 'kitchen_supply', 'shared', 'none', 'sửa máy lạnh, vệ sinh máy lạnh, bơm gas máy lạnh, sửa cửa cuốn', true, 308),
  ('C9_TOOLS_CLEANING', 'CCDC, vệ sinh', 'C_OPERATING', 'kitchen_supply', 'shared', 'none', 'nước rửa chén, dụng cụ bếp, đồ vệ sinh, đá viên, nước uống', true, 309),
  ('C10_ONE_OFF', 'Chi phí một lần, di dời', 'C_OPERATING', 'opex', 'shared', 'none', 'chuyển bếp, di dời, đặt cọc vận chuyển', true, 310),
  ('C11_BANK_TAX_OTHER', 'Phí ngân hàng, thuế, phí khác', 'C_OPERATING', 'opex', 'shared', 'none', 'phí chuyển khoản, thuế, lệ phí', true, 311),
  ('D1_CONSTRUCTION', 'Xây dựng, lắp đặt', 'D_INVESTMENT', 'capex', 'shared', 'none', 'thi công, xây dựng, lắp ráp, quyết toán công trình', true, 401),
  ('D2_EQUIPMENT', 'Máy móc, thiết bị', 'D_INVESTMENT', 'capex', 'shared', 'none', 'mua máy, tủ, lò, thiết bị', true, 402)
on conflict (code) do update set
  label = excluded.label,
  parent_code = excluded.parent_code,
  cost_group = excluded.cost_group,
  product_line = excluded.product_line,
  allocation_rule = excluded.allocation_rule,
  sushi_hint = excluded.sushi_hint,
  is_active = true,
  sort_order = excluded.sort_order,
  updated_at = now();

-- ===========================================================================
-- 4. Old codes and old rules: inactive, never deleted
-- ===========================================================================

update public.cost_categories
set
  is_active = false,
  updated_at = now()
where code in (
  'COGS_BMQ_BREAD',
  'COGS_SWEET_KITCHEN',
  'PACKAGING_SALES',
  'OPEX_GENERAL',
  'KITCHEN_SUPPLY_REPAIR',
  'CAPEX_ASSET_PROJECT'
);

update public.cost_classification_rules r
set
  active = false,
  updated_at = now()
from public.cost_categories cc
where cc.code = r.category_code
  and cc.is_active = false;

-- ===========================================================================
-- 5. Writer: the 6-argument, parent-refusing, product-line aware RPC
-- ===========================================================================

drop function if exists public.robot_apply_cost_classification(text, uuid, text, numeric, text);

create or replace function public.robot_apply_cost_classification(
  p_source_type text,
  p_source_line_id uuid,
  p_category_code text,
  p_probability numeric,
  p_note text,
  p_product_line text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_category public.cost_categories%rowtype;
  v_settings public.robot_settings%rowtype;
  v_existing public.cost_line_classifications%rowtype;
  v_written public.cost_line_classifications%rowtype;
  v_before jsonb;
  v_payment_request_id uuid;
  v_invoice_id uuid;
  v_supplier_id uuid;
  v_product_name text;
  v_subject_key text;
  v_review_status text;
  v_exists boolean;
  v_today_count integer;
  v_action_id uuid;
  v_allocation_rule text;
  v_product_line text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'robot_apply_cost_classification requires service role' using errcode = '42501';
  end if;

  if p_source_type is null or p_source_type not in ('payment_request_item', 'invoice_item') then
    return jsonb_build_object('status', 'skipped', 'reason', 'invalid_source_type');
  end if;
  if p_probability is null or p_probability < 0 or p_probability > 1 then
    return jsonb_build_object('status', 'skipped', 'reason', 'invalid_probability');
  end if;

  if p_source_type = 'payment_request_item' then
    select pri.payment_request_id, pr.supplier_id, pri.product_name
      into v_payment_request_id, v_supplier_id, v_product_name
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    where pri.id = p_source_line_id;
  else
    select ii.invoice_id,
           coalesce(inv.supplier_id, pr.supplier_id),
           ii.product_name
      into v_invoice_id, v_supplier_id, v_product_name
    from public.invoice_items ii
    join public.invoices inv on inv.id = ii.invoice_id
    left join public.payment_requests pr on pr.id = inv.payment_request_id
    where ii.id = p_source_line_id;
  end if;
  if not found or v_product_name is null then
    return jsonb_build_object('status', 'skipped', 'reason', 'line_not_found');
  end if;

  select * into v_category
  from public.cost_categories cc
  where cc.code = p_category_code
    and cc.is_active;
  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'invalid_category');
  end if;

  -- A parent is a grouping node, never an assignable category.
  if exists (
    select 1
    from public.cost_categories child
    where child.parent_code = v_category.code
      and child.is_active
  ) then
    return jsonb_build_object('status', 'skipped', 'reason', 'invalid_category');
  end if;

  -- Lock any existing row before the manual_override / approved gate.
  select * into v_existing
  from public.cost_line_classifications clc
  where clc.source_type = p_source_type
    and clc.source_line_id = p_source_line_id
  for update;
  v_exists := found;

  if v_exists and (
    v_existing.classification_source = 'manual_override'
    or v_existing.review_status = 'approved'
  ) then
    return jsonb_build_object('status', 'skipped', 'reason', 'manual_override_or_approved');
  end if;

  v_before := case when v_exists then to_jsonb(v_existing) else null end;

  select * into v_settings from public.robot_settings where id = true;
  if not found then
    v_settings.cost_daily_cap := 200;
    v_settings.cost_threshold := 0.95;
    v_settings.cost_auto_enabled := true;
  end if;

  select count(*) into v_today_count
  from public.robot_auto_actions a
  where a.kind = 'cost_category'
    and a.status = 'applied'
    and (a.applied_at at time zone 'Asia/Ho_Chi_Minh')::date
        = (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  if v_today_count >= v_settings.cost_daily_cap then
    return jsonb_build_object('status', 'cap_reached');
  end if;

  v_review_status := case
    when p_category_code <> 'UNMAPPED_REVIEW' then 'suggested'
    else 'needs_review'
  end;
  v_allocation_rule := coalesce(
    v_category.allocation_rule,
    case v_category.cost_group
      when 'cogs' then 'direct'
      when 'packaging' then 'manual'
      else 'none'
    end
  );
  v_product_line := case
    when p_product_line in ('bmq_bread', 'sweet_kitchen', 'shared') then p_product_line
    else v_category.product_line
  end;
  v_subject_key := lower(
    coalesce(v_supplier_id::text, '') || '|' ||
    coalesce(public.normalize_stock_item_name(v_product_name), '')
  );

  if v_exists then
    update public.cost_line_classifications
    set
      payment_request_id = v_payment_request_id,
      invoice_id = v_invoice_id,
      supplier_id = coalesce(v_supplier_id, v_existing.supplier_id),
      category_code = p_category_code,
      product_line = v_product_line,
      allocation_rule = v_allocation_rule,
      confidence = p_probability,
      classification_source = 'sushi',
      rule_id = null,
      review_status = v_review_status,
      note = p_note,
      updated_at = now()
    where id = v_existing.id
    returning * into v_written;
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
      p_source_type,
      p_source_line_id,
      v_payment_request_id,
      v_invoice_id,
      v_supplier_id,
      p_category_code,
      v_product_line,
      null,
      v_allocation_rule,
      p_probability,
      'sushi',
      null,
      v_review_status,
      p_note
    )
    returning * into v_written;
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
    v_written.id,
    p_source_type,
    p_source_line_id,
    case when v_before is null then 'created_by_sushi' else 'updated_by_sushi' end,
    v_before,
    to_jsonb(v_written),
    coalesce(p_note, 'sushi_cost_classification'),
    null
  );

  insert into public.robot_auto_actions (
    kind, subject_key, target, robot_probability, payload, status
  ) values (
    'cost_category',
    v_subject_key,
    jsonb_build_object(
      'source_type', p_source_type,
      'source_line_id', p_source_line_id,
      'category_code', p_category_code,
      'classification_id', v_written.id
    ),
    p_probability,
    jsonb_build_object(
      'before', v_before,
      'after', to_jsonb(v_written),
      'note', p_note
    ),
    'applied'
  )
  returning id into v_action_id;

  return jsonb_build_object(
    'status', 'applied',
    'classification_id', v_written.id,
    'action_id', v_action_id,
    'category_code', v_written.category_code,
    'product_line', v_written.product_line,
    'review_status', v_written.review_status
  );
end;
$$;

revoke all on function public.robot_apply_cost_classification(text, uuid, text, numeric, text, text)
  from public, anon, authenticated;
grant execute on function public.robot_apply_cost_classification(text, uuid, text, numeric, text, text)
  to service_role;

-- ===========================================================================
-- 6. Candidate reader: re-ask every unapproved line under the new tree once
-- ===========================================================================

create or replace function public.cost_classify_sushi_candidates(p_limit int)
returns table (
  source_type text,
  source_line_id uuid,
  supplier_id uuid,
  supplier_name text,
  product_name text,
  product_code text,
  unit text,
  quantity numeric,
  unit_price numeric,
  line_amount numeric,
  document_date date,
  note text,
  subject_key text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'cost_classify_sushi_candidates requires service role' using errcode = '42501';
  end if;

  return query
  with candidates as (
    select
      'payment_request_item'::text as source_type,
      pri.id as source_line_id,
      pr.supplier_id,
      s.name as supplier_name,
      pri.product_name,
      pri.product_code,
      pri.unit,
      pri.quantity,
      pri.unit_price,
      coalesce(pri.line_total, pri.quantity * pri.unit_price, 0)::numeric as line_amount,
      coalesce(pr.paid_at::date, pr.created_at::date) as document_date,
      nullif(concat_ws(' · ', nullif(pr.title, ''), nullif(pr.description, ''), nullif(pr.notes, '')), '') as note,
      pri.created_at as line_created_at
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    left join public.suppliers s on s.id = pr.supplier_id
    left join public.cost_line_classifications clc
      on clc.source_type = 'payment_request_item'
      and clc.source_line_id = pri.id
    left join public.cost_categories cc on cc.code = clc.category_code
    where clc.id is null
       or (
         clc.classification_source <> 'manual_override'
         and clc.review_status <> 'approved'
         and (
           cc.is_active = false
           or (
             clc.category_code = 'UNMAPPED_REVIEW'
             and clc.classification_source in ('fallback', 'rule')
           )
           or (
             clc.classification_source = 'sushi'
             and clc.category_code = 'UNMAPPED_REVIEW'
             and clc.updated_at < (
               select max(greatest(cc2.created_at, cc2.updated_at))
               from public.cost_categories cc2
             )
           )
         )
       )

    union all

    select
      'invoice_item'::text as source_type,
      ii.id as source_line_id,
      coalesce(inv.supplier_id, pr.supplier_id) as supplier_id,
      s.name as supplier_name,
      ii.product_name,
      ii.product_code,
      ii.unit,
      ii.quantity,
      ii.unit_price,
      coalesce(ii.line_total, ii.quantity * ii.unit_price, 0)::numeric as line_amount,
      coalesce(inv.invoice_date, inv.created_at::date) as document_date,
      nullif(
        concat_ws(
          ' · ',
          nullif(inv.notes, ''),
          nullif(pr.title, ''),
          nullif(pr.description, ''),
          nullif(pr.notes, '')
        ),
        ''
      ) as note,
      ii.created_at as line_created_at
    from public.invoice_items ii
    join public.invoices inv on inv.id = ii.invoice_id
    left join public.payment_requests pr on pr.id = inv.payment_request_id
    left join public.suppliers s on s.id = coalesce(inv.supplier_id, pr.supplier_id)
    left join public.cost_line_classifications clc
      on clc.source_type = 'invoice_item'
      and clc.source_line_id = ii.id
    left join public.cost_categories cc on cc.code = clc.category_code
    where clc.id is null
       or (
         clc.classification_source <> 'manual_override'
         and clc.review_status <> 'approved'
         and (
           cc.is_active = false
           or (
             clc.category_code = 'UNMAPPED_REVIEW'
             and clc.classification_source in ('fallback', 'rule')
           )
           or (
             clc.classification_source = 'sushi'
             and clc.category_code = 'UNMAPPED_REVIEW'
             and clc.updated_at < (
               select max(greatest(cc2.created_at, cc2.updated_at))
               from public.cost_categories cc2
             )
           )
         )
       )
  )
  select
    c.source_type,
    c.source_line_id,
    c.supplier_id,
    c.supplier_name,
    c.product_name,
    c.product_code,
    c.unit,
    c.quantity,
    c.unit_price,
    c.line_amount,
    c.document_date,
    c.note,
    lower(
      coalesce(c.supplier_id::text, '') || '|' ||
      coalesce(public.normalize_stock_item_name(c.product_name), '')
    ) as subject_key
  from candidates c
  order by c.document_date desc nulls last, c.line_created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 50));
end;
$$;

revoke all on function public.cost_classify_sushi_candidates(int) from public, anon, authenticated;
grant execute on function public.cost_classify_sushi_candidates(int) to service_role;

-- ===========================================================================
-- 7. Paid-PR rule pass leaves Sushi rows alone
-- ===========================================================================
-- classify_paid_payment_request (20260517160000) re-runs the rules when a
-- payment request is paid and used to overwrite any row that was not
-- manual_override/approved. With every rule now inactive it would turn a
-- Sushi-classified line back into a fallback UNMAPPED_REVIEW row, losing the
-- answer and spending the daily cap again. Re-created from the live definition
-- with only the 'sushi' skip added.

create or replace function public.classify_paid_payment_request(_payment_request_id uuid, _actor_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
      or existing_row.classification_source = 'sushi'
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
