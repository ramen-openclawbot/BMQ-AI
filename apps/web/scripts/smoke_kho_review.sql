-- Smoke test for 20261102720000_kho_review.sql.
--
-- The Maestro applies the migration first, then runs this file in the same
-- transaction.  The file ends with RAISE EXCEPTION, so NOTHING commits: the
-- alias upsert and any ledger posting of the probe call are rolled back.
--
-- Claims are the owner account (auth.users.email = ramen@bmq.vn) so the RPC
-- gate runs through q7_material_inventory_can_edit / owner, not service_role.
--
-- Run with:  psql "$DATABASE_URL" -f scripts/smoke_kho_review.sql

begin;

select set_config(
  'request.jwt.claim.sub',
  coalesce((select id::text from auth.users where lower(email) = 'ramen@bmq.vn' limit 1), ''),
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role', 'authenticated',
    'sub', coalesce((select id::text from auth.users where lower(email) = 'ramen@bmq.vn' limit 1), '')
  )::text,
  true
);

-- 1. Counts of item gaps, material gaps and all candidates.
with payload as (
  select public.kho_review_list() as p
)
select
  jsonb_array_length(coalesce(p -> 'items', '[]'::jsonb)) as item_count,
  jsonb_array_length(coalesce(p -> 'materials', '[]'::jsonb)) as material_count,
  (
    select coalesce(sum(jsonb_array_length(coalesce(i -> 'candidates', '[]'::jsonb))), 0)
    from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) i
  )
  + (
    select coalesce(sum(jsonb_array_length(coalesce(m -> 'candidates', '[]'::jsonb))), 0)
    from jsonb_array_elements(coalesce(p -> 'materials', '[]'::jsonb)) m
  ) as candidate_count
from payload;

-- 2. Link one real candidate line to the item the review suggests.
with payload as (
  select public.kho_review_list() as p
),
chosen as (
  select
    i ->> 'item_id' as item_id,
    i ->> 'name' as item_name,
    i ->> 'location' as item_location,
    c ->> 'receipt_item_id' as receipt_item_id,
    c ->> 'product_name' as product_name,
    c ->> 'receipt_date' as receipt_date,
    c ->> 'score' as score
  from payload p
  cross join lateral jsonb_array_elements(coalesce(p.p -> 'items', '[]'::jsonb)) i
  cross join lateral jsonb_array_elements(coalesce(i -> 'candidates', '[]'::jsonb)) c
  where (c ->> 'linked_item_id') is null
     or (c ->> 'linked_item_id') = (i ->> 'item_id')
  order by (c ->> 'score')::numeric desc, (c ->> 'receipt_date') desc, i ->> 'name'
  limit 1
)
select
  chosen.item_name,
  chosen.item_location,
  chosen.receipt_item_id,
  chosen.product_name,
  chosen.receipt_date,
  chosen.score,
  public.kho_review_link_line(
    chosen.receipt_item_id::uuid,
    chosen.item_id::uuid,
    1,
    gen_random_uuid()
  ) as link_result
from chosen;

do $$
begin
  raise exception 'kho_review smoke complete — rolled back on purpose';
end;
$$;
