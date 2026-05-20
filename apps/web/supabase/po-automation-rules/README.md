# Revenue PO Automation Rules

These rule outputs stay in the repo during the trial period. Do not write them to app KB or customer CRM yet.

## Accounting Guardrail

`revenue_ledger_lines` from trusted `revenue_source_documents` is the accounting source of truth. Gmail/PO parser output is operational evidence until finance reviews it or imports trusted ledger data.

## Daily Schedule

- Run daily at `23:59 Asia/Ho_Chi_Minh`.
- Vercel cron equivalent is `59 16 * * *` UTC.
- Goal: users can review PO revenue evidence the next morning.

## Customer Rules

- Kingfoodmart: parse `Export-PO-Data.xlsx` when valid. PDF-only emails go to manual review. Cancellation emails are `cancel_signal` and must not create normal revenue drafts.
- Thuy direct dealer: `mi@bmq.vn` is direct company dealer evidence, not NPP child evidence. Missing email days are accepted as ledger-only gaps when the trusted ledger has the accounting rows.
- Dam/XESG: parsed Gmail quantities are `sent_qty` order evidence. Trusted ledger provides `sold_qty` accounting truth. T4 has a `662 bánh` inventory/unsold note, so automation must preserve inventory context and never auto-post sent quantity as sold revenue.
