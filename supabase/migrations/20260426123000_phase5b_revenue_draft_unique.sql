-- Phase 5B: Prevent duplicate revenue drafts per sales PO document

with ranked_drafts as (
  select
    ctid,
    row_number() over (
      partition by sales_po_doc_id
      order by updated_at desc nulls last, created_at desc nulls last, id desc
    ) as rn
  from revenue_drafts
)
delete from revenue_drafts rd
using ranked_drafts ranked
where rd.ctid = ranked.ctid
  and ranked.rn > 1;

create unique index if not exists uq_revenue_drafts_sales_po_doc_id
  on revenue_drafts(sales_po_doc_id);

create table if not exists po_sync_runtime_locks (
  lock_key text primary key,
  locked_by text,
  locked_at timestamptz not null default now()
);
