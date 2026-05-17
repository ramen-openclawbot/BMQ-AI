-- Extend BMQ cost classification rules from May COGS review.
-- Owner corrections:
-- - Đá belongs to OPEX_GENERAL.
-- - Bột năng / Bột nang belongs to COGS_SWEET_KITCHEN.

insert into public.cost_classification_rules (
  priority,
  rule_name,
  keyword_pattern,
  match_scope,
  category_code,
  product_line,
  allocation_rule,
  confidence,
  active
)
values
  (
    620,
    'COGS review correction: ice is OPEX',
    '(^|[^[:alpha:]])đá([^[:alpha:]]|$)|(^|[^[:alpha:]])da([^[:alpha:]]|$)',
    'supplier_and_item',
    'OPEX_GENERAL',
    'general',
    'none',
    0.99,
    true
  ),
  (
    615,
    'COGS review correction: bot nang sweet kitchen',
    'bột năng|bột nang|bot nang|bot nang',
    'supplier_and_item',
    'COGS_SWEET_KITCHEN',
    'sweet_kitchen',
    'direct',
    0.99,
    true
  ),
  (
    214,
    'COGS review sweet kitchen dairy and pastry ingredients',
    'bơ na uy|bơ nauy|bơ lạt anchor|bơ cán|bơ imperial|bơ th|bột sữa|kem làm mềm bánh|kem sữa whipping|mật ong|nho khô|hạt óc chó|sữa đặc|sữa tươ|trứng gà|phô mai|xúc xích 250gr',
    'supplier_and_item',
    'COGS_SWEET_KITCHEN',
    'sweet_kitchen',
    'direct',
    0.94,
    true
  ),
  (
    126,
    'COGS review BMQ bread fillings and condiments',
    'giò lụa|jambon|pate|mỡ heo|tương ớt|dầu ăn olita|bột ngọt',
    'supplier_and_item',
    'COGS_BMQ_BREAD',
    'bmq_bread',
    'direct',
    0.94,
    true
  ),
  (
    326,
    'COGS review packaging operating materials',
    'bao pe|bao bánh mì|băng keo|cuộn pe|cuộn decal|hộp|khay|túi opp|sticker|tem',
    'supplier_and_item',
    'PACKAGING_SALES',
    'shared',
    'manual',
    0.94,
    true
  ),
  (
    506,
    'COGS review kitchen supply sanitation repair',
    'găng tay|nón sâu|chai thông cống|chai thông bể mỡ|vệ sinh máy lạnh',
    'supplier_and_item',
    'KITCHEN_SUPPLY_REPAIR',
    'general',
    'none',
    0.94,
    true
  )
on conflict (rule_name) do update set
  priority = excluded.priority,
  keyword_pattern = excluded.keyword_pattern,
  match_scope = excluded.match_scope,
  category_code = excluded.category_code,
  product_line = excluded.product_line,
  allocation_rule = excluded.allocation_rule,
  confidence = excluded.confidence,
  active = true,
  updated_at = now();

-- Normalize older learned manual rules so future rule refreshes do not keep the old category.
update public.cost_classification_rules
set
  category_code = 'OPEX_GENERAL',
  product_line = 'general',
  allocation_rule = 'none',
  confidence = greatest(confidence, 0.99),
  updated_at = now()
where active
  and lower(keyword_pattern) in ('đá', 'da');

update public.cost_classification_rules
set
  category_code = 'COGS_SWEET_KITCHEN',
  product_line = 'sweet_kitchen',
  allocation_rule = 'direct',
  confidence = greatest(confidence, 0.99),
  updated_at = now()
where active
  and lower(keyword_pattern) in ('bột năng', 'bột nang', 'bot nang', 'bot nang');

-- Apply the owner-approved correction to existing classified lines where they have not been deliberately rejected.
update public.cost_line_classifications clc
set
  category_code = 'OPEX_GENERAL',
  product_line = 'general',
  allocation_rule = 'none',
  confidence = greatest(clc.confidence, 0.99),
  classification_source = case when clc.classification_source = 'manual_override' then clc.classification_source else 'rule' end,
  review_status = case when clc.review_status = 'rejected' then clc.review_status else 'approved' end,
  note = concat_ws('; ', nullif(clc.note, ''), 'Owner correction 2026-05-17: Đá -> Chi phí vận hành chung'),
  updated_at = now()
from public.payment_request_items pri
where clc.source_type = 'payment_request_item'
  and clc.source_line_id = pri.id
  and lower(trim(coalesce(pri.product_name, ''))) in ('đá', 'da')
  and clc.review_status <> 'rejected';

update public.cost_line_classifications clc
set
  category_code = 'COGS_SWEET_KITCHEN',
  product_line = 'sweet_kitchen',
  allocation_rule = 'direct',
  confidence = greatest(clc.confidence, 0.99),
  classification_source = case when clc.classification_source = 'manual_override' then clc.classification_source else 'rule' end,
  review_status = case when clc.review_status = 'rejected' then clc.review_status else 'approved' end,
  note = concat_ws('; ', nullif(clc.note, ''), 'Owner correction 2026-05-17: Bột năng/Bột nang -> Chi phí bếp bánh ngọt'),
  updated_at = now()
from public.payment_request_items pri
where clc.source_type = 'payment_request_item'
  and clc.source_line_id = pri.id
  and lower(trim(coalesce(pri.product_name, ''))) in ('bột năng', 'bột nang', 'bot nang', 'bot nang')
  and clc.review_status <> 'rejected';

-- Cover both payment request and invoice classification rows through the canonical details view.
update public.cost_line_classifications clc
set
  category_code = 'OPEX_GENERAL',
  product_line = 'general',
  allocation_rule = 'none',
  confidence = greatest(clc.confidence, 0.99),
  classification_source = case when clc.classification_source = 'manual_override' then clc.classification_source else 'rule' end,
  review_status = 'approved',
  note = concat_ws('; ', nullif(clc.note, ''), 'Owner correction 2026-05-17: Đá -> Chi phí vận hành chung'),
  updated_at = now()
from public.cost_classification_line_details d
where clc.id = d.classification_id
  and lower(trim(coalesce(d.product_name, ''))) in ('đá', 'da')
  and clc.review_status <> 'rejected';

update public.cost_line_classifications clc
set
  category_code = 'COGS_SWEET_KITCHEN',
  product_line = 'sweet_kitchen',
  allocation_rule = 'direct',
  confidence = greatest(clc.confidence, 0.99),
  classification_source = case when clc.classification_source = 'manual_override' then clc.classification_source else 'rule' end,
  review_status = 'approved',
  note = concat_ws('; ', nullif(clc.note, ''), 'Owner correction 2026-05-17: Bột năng/Bột nang -> Chi phí bếp bánh ngọt'),
  updated_at = now()
from public.cost_classification_line_details d
where clc.id = d.classification_id
  and lower(trim(coalesce(d.product_name, ''))) in ('bột năng', 'bột nang', 'bot nang', 'bot nang')
  and clc.review_status <> 'rejected';
