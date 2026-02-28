# PO XLSX Parser Test Cases

## Golden assertions

For each fixture, assert:
- `subtotal_amount`
- `vat_amount`
- `total_amount`
- `total_amount = subtotal_amount + vat_amount` (or explicit documented exception)
- re-parse idempotent results

## Cases

1. **normal-template.xlsx**
   - Standard Kingfood columns
   - Expected totals equal declared sheet totals

2. **shifted-columns.xlsx**
   - Header columns shifted left/right
   - Parser must still resolve totals by header names

3. **mixed-locale-money.xlsx**
   - Mix of `1.234.567,89` and `1,234,567.89`
   - Totals must remain correct

4. **line-total-corrupted.xlsx**
   - Wrong/overflow line-total column
   - Parser must fallback to qty*unit_price or declared sheet totals

## Pre-merge gate

- Run parser against all fixtures.
- Block merge on any mismatch.
