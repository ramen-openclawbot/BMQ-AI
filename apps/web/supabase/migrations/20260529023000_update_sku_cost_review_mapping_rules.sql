-- Approved SKU-cost reconciliation rules from May-2026 manual review.
-- Purpose: let OCR/payment-request classification and SKU cost analysis reuse reviewed mappings.

with rules(source_name, source_name_key, standard_cost_code, canonical_cost_item_name, unit_conversion_note, source_review_note) as (
  values
    ('Chả bống cay', 'cha bong cay', 'NVL-CHA-BONG-CAY', 'Chà bông cay', 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg', 'Owner reviewed SKU cost May-2026 reconciliation: PR-MPF87BI5 contains Chả bống cay.'),
    ('Chà bông cay', 'cha bong cay', 'NVL-CHA-BONG-CAY', 'Chà bông cay', 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg', 'Owner reviewed SKU cost May-2026 reconciliation: PR-MPF87BI5 contains Chả bống cay.'),
    ('Giấm trắng', 'giam trang', 'NVL-GIAM-GAO-AJINOMOTO-400ML', 'Giấm Gạo Ajinomoto 400ml', 'Quy đổi chai 400ml: giá mua / 400 để ra giá/ml', 'Owner reviewed SKU cost May-2026 reconciliation: PR-MP0O8ZUS contains Giấm trắng.'),
    ('Men Khô Ngọt Mauripan - Vàng', 'men kho ngot mauripan vang', 'NVL-MEN-KHO-MEIZAN-NHAN-VANG-0-5-10KG-THUN', 'Men Tươi 5 Sao', 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg; thùng 0.5kg x 10 thì /10000', 'Owner reviewed SKU cost May-2026 reconciliation: PR-MPEX9N62 contains Men Khô Ngọt Mauripan - Vàng.'),
    ('Sữa Bột Béo New Zealand', 'sua bot beo new zealand', 'NVL-SUA-BOT-BEO-NEW-ZEALAND-25KG', 'Sữa Bột Béo New Zealand (25kg)', 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg; bao 25kg thì /25000', 'Owner reviewed SKU cost May-2026 reconciliation: PR-MPM8EYJY contains Sữa Bột Béo New Zealand.')
), updated as (
  update public.cost_item_alias_mappings m
     set standard_cost_code_type = 'NVL',
         standard_cost_code = r.standard_cost_code,
         canonical_cost_item_name = r.canonical_cost_item_name,
         category_code = 'COGS_BMQ_BREAD',
         product_line = 'bmq_bread',
         allocation_rule = 'direct',
         unit_conversion_note = r.unit_conversion_note,
         source_review_note = r.source_review_note,
         mapping_status = 'approved',
         active = true,
         updated_at = now()
    from rules r
   where m.source_name_key = r.source_name_key
  returning m.source_name_key
)
insert into public.cost_item_alias_mappings (
  source_name, source_name_key, standard_cost_code_type, standard_cost_code,
  canonical_cost_item_name, category_code, product_line, allocation_rule,
  unit_conversion_note, source_review_note, mapping_status, active, effective_from
)
select r.source_name, r.source_name_key, 'NVL', r.standard_cost_code,
       r.canonical_cost_item_name, 'COGS_BMQ_BREAD', 'bmq_bread', 'direct',
       r.unit_conversion_note, r.source_review_note, 'approved', true, date '2026-05-01'
from rules r
where not exists (select 1 from updated u where u.source_name_key = r.source_name_key)
  and not exists (select 1 from public.cost_item_alias_mappings m where m.source_name_key = r.source_name_key);

-- Backfill the specific reviewed PR item rows so current analysis can use the new mapping immediately.
update public.payment_request_items pri
set confirmed_standard_cost_code = case
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%chả bống cay%' or lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%chà bông cay%' then 'NVL-CHA-BONG-CAY'
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%giấm trắng%' then 'NVL-GIAM-GAO-AJINOMOTO-400ML'
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%men khô ngọt mauripan%' then 'NVL-MEN-KHO-MEIZAN-NHAN-VANG-0-5-10KG-THUN'
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%sữa bột béo new zealand%' then 'NVL-SUA-BOT-BEO-NEW-ZEALAND-25KG'
      else pri.confirmed_standard_cost_code end,
    suggested_standard_cost_code = case
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%chả bống cay%' or lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%chà bông cay%' then 'NVL-CHA-BONG-CAY'
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%giấm trắng%' then 'NVL-GIAM-GAO-AJINOMOTO-400ML'
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%men khô ngọt mauripan%' then 'NVL-MEN-KHO-MEIZAN-NHAN-VANG-0-5-10KG-THUN'
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%sữa bột béo new zealand%' then 'NVL-SUA-BOT-BEO-NEW-ZEALAND-25KG'
      else pri.suggested_standard_cost_code end,
    canonical_cost_item_name = case
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%chả bống cay%' or lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%chà bông cay%' then 'Chà bông cay'
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%giấm trắng%' then 'Giấm Gạo Ajinomoto 400ml'
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%men khô ngọt mauripan%' then 'Men Tươi 5 Sao'
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%sữa bột béo new zealand%' then 'Sữa Bột Béo New Zealand (25kg)'
      else pri.canonical_cost_item_name end,
    unit_conversion_note = case
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%chả bống cay%' or lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%chà bông cay%' then 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%giấm trắng%' then 'Quy đổi chai 400ml: giá mua / 400 để ra giá/ml'
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%men khô ngọt mauripan%' then 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg; thùng 0.5kg x 10 thì /10000'
      when lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%sữa bột béo new zealand%' then 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg; bao 25kg thì /25000'
      else pri.unit_conversion_note end
from public.payment_requests pr
where pri.payment_request_id = pr.id
  and pr.request_number in ('PR-MPF87BI5','PR-MP0O8ZUS','PR-MPEX9N62','PR-MPM8EYJY')
  and (
    lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%chả bống cay%' or
    lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%chà bông cay%' or
    lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%giấm trắng%' or
    lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%men khô ngọt mauripan%' or
    lower(coalesce(pri.product_name, pri.raw_product_name, '')) like '%sữa bột béo new zealand%'
  );
