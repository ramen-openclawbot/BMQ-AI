# BMQ-AI Handoff — SKU Giá vốn: Mã NVL (`material_code`)

**Updated:** 2026-05-27 13:38 +07  
**Owner/user:** anh Tam  
**Repo:** `/home/ubuntu/projects/BMQ-AI`  
**Branch:** `main`  
**Latest pushed commit:** `704b533 Add NVL material codes to SKU formulations`  
**Production domain to verify:** `https://ai.banhmique.vn`  

---

## 1) What was requested

Anh approved adding a visible, stable **Mã NVL** to finished-SKU formulation rows in **Giá vốn → Quản trị SKU** so another workflow/agent can continue using canonical NVL codes.

Approved scope for this slice:

- Add `material_code` to `sku_formulations`.
- Backfill all existing formulation rows.
- Auto-generate `material_code` for new/edited SKU formula rows.
- Show **Mã NVL** in the SKU detail and create/edit dialogs.
- Do not touch OCR/classifier flows in this slice.

---

## 2) Completed changes

### Database / migration

Created:

```text
apps/web/supabase/migrations/20260527130226_add_material_code_to_sku_formulations.sql
```

Migration does the following:

1. Creates/replaces DB helper:

```sql
public.generate_sku_material_code(p_name text)
```

2. Adds column:

```sql
alter table public.sku_formulations
  add column if not exists material_code text;
```

3. Backfills existing rows:

```sql
update public.sku_formulations
set material_code = public.generate_sku_material_code(ingredient_name)
where material_code is null or btrim(material_code) = '';
```

4. Adds index:

```sql
create index if not exists idx_sku_formulations_material_code
  on public.sku_formulations(material_code);
```

### Frontend

Modified:

```text
apps/web/src/pages/SkuCostsManagement.tsx
```

Added frontend helper:

```ts
const buildMaterialCode = (name: unknown) => {
  const normalized = String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return `NVL-${normalized || "CHUA-DAT-TEN"}`;
};
```

Auto-generates `material_code` in:

- `buildFormulaRowsFromDraft()` when saving SKU formula rows.
- `addFormula()` legacy helper.
- Draft rows created manually or from scanned data.

Visible UI now includes **Mã NVL** in:

- SKU detail modal formula table.
- SKU create/edit desktop table.
- SKU create/edit mobile cards.

Example generated codes:

```text
Chà bông                    -> NVL-CHA-BONG
Bột mì 888 Cam (25kg)       -> NVL-BOT-MI-888-CAM-25KG
Bánh mì tươi                -> NVL-BANH-MI-TUOI
Phụ gia BM ngọt Mauri       -> NVL-PHU-GIA-BM-NGOT-MAURI
```

---

## 3) Production DB status

Migration was applied directly to Supabase production via Management API, then migration history was repaired.

Production verify query result:

```text
sku_formulations total_rows: 151
rows_with_material_code: 151
rows_missing_material_code: 0
```

Production sample:

```text
Bột mì 888 Cam (25kg) -> NVL-BOT-MI-888-CAM-25KG
Bột mì 999 cam        -> NVL-BOT-MI-999-CAM
Bánh mì tươi          -> NVL-BANH-MI-TUOI
```

Migration history verify showed:

```text
20260527130226 | 20260527130226 | 2026-05-27 13:02:26
```

Important Supabase command nuance for this repo:

- `npx supabase migration repair --workdir supabase ...` failed with “Cannot find project ref”.
- Working command was run from `apps/web` without `--workdir`:

```bash
cd /home/ubuntu/projects/BMQ-AI/apps/web
npx supabase migration repair --status applied 20260527130226 --linked
npx supabase migration list --linked
```

---

## 4) Verification already run

From:

```bash
cd /home/ubuntu/projects/BMQ-AI/apps/web
```

Build:

```bash
npm run build
```

Result: ✅ pass.

Targeted ESLint:

```bash
npx eslint src/pages/SkuCostsManagement.tsx
```

Result: ❌ failed due to existing file-wide lint debt, mostly:

- `@typescript-eslint/no-explicit-any`
- `no-empty`

These were pre-existing style/debt issues in `SkuCostsManagement.tsx`; build passed and the material-code slice did not introduce TypeScript build errors.

Supabase local lint:

```bash
npx supabase db lint --workdir supabase
```

Result: ❌ local DB not running / port 54322 refused. Production SQL dry-run/apply via Management API succeeded.

Git whitespace check:

```bash
git diff --check -- apps/web/src/pages/SkuCostsManagement.tsx apps/web/supabase/migrations/20260527130226_add_material_code_to_sku_formulations.sql
```

Result: ✅ pass.

---

## 5) Current repo state after push

Latest pushed commit:

```text
704b533 Add NVL material codes to SKU formulations
```

Known unrelated working tree items after push:

```text
 M apps/web/supabase/.temp/cli-latest
?? .hermes/
?? docs/
?? sketches/
```

Do not include these unrelated paths in future commits unless explicitly reviewing them.

---

## 6) Next task for the next agent

### Task: Post-deploy UI verification + propagate Mã NVL to related material flows

**Goal:** Confirm the pushed UI is live on `https://ai.banhmique.vn`, then extend the new `material_code` to downstream material/production flows where operators expect to see Mã NVL.

### Required context

Load relevant skills before work:

- `bmq-kitchen-inventory-control`
- `bmq-ai-workspace-setup`
- `bmq-ai-navigation-route-audit` if changing sidebar/routes
- `systematic-debugging` if production UI does not match expected state

### Step 1 — Verify deployment on custom domain

Use only the custom production domain unless anh explicitly asks for Vercel preview:

```text
https://ai.banhmique.vn
```

Check:

1. Log into the app if needed.
2. Go to **Giá vốn → Quản trị SKU** (`/sku-costs/management`).
3. Open any existing finished SKU.
4. Confirm detail modal table includes **Mã NVL** column.
5. Click **Sửa** on a SKU.
6. Confirm edit dialog desktop/mobile layout includes **Mã NVL**.
7. Confirm existing rows show non-empty codes.
8. If creating a throwaway test row, do not save destructive changes unless explicitly approved.

Expected visible examples include codes like:

```text
NVL-BOT-MI-888-CAM-25KG
NVL-BOT-MI-999-CAM
NVL-BANH-MI-TUOI
```

### Step 2 — Audit where formulation material rows are consumed

Inspect these files first:

```text
apps/web/src/pages/WarehouseDispatch.tsx
apps/web/src/hooks/useSkuCostBridge.ts
apps/web/supabase/migrations/20260523124000_production_material_issues.sql
apps/web/src/pages/TraceabilityPublic.tsx
```

Current known references:

- `WarehouseDispatch.tsx` queries `sku_formulations` for material issue previews.
- `useSkuCostBridge.ts` queries formula rows for SKU cost bridge/analysis.
- `20260523124000_production_material_issues.sql` calculates production material issue items from `sku_formulations`.
- `TraceabilityPublic.tsx` already expects `production_batch_materials.material_code`, but this is a different downstream table.

### Step 3 — Decide/implement propagation target

Recommended first propagation target:

1. Add `material_code` selection in frontend queries that read `sku_formulations`.
2. Show **Mã NVL** in material issue/warehouse dispatch previews if the page has a material row table/card.
3. If production material issue item rows should persist the code, add a migration to `production_material_issue_items`:

```sql
alter table public.production_material_issue_items
  add column if not exists material_code text;
```

Then update the RPC in `20260523124000_production_material_issues.sql` or a new migration to insert/update:

```sql
coalesce(formulation_row.material_code, public.generate_sku_material_code(formulation_row.ingredient_name))
```

Do not rewrite old applied migration files for production; create a new migration.

### Step 4 — Keep DB compatibility safe

If adding columns/functions, use `if not exists` and keep fallbacks:

```ts
row.material_code || buildMaterialCode(row.ingredient_name)
```

Do not rely only on frontend code; if a downstream table persists material lines, generate/fallback in DB too.

### Step 5 — Verification commands

Run from:

```bash
cd /home/ubuntu/projects/BMQ-AI/apps/web
```

Required:

```bash
npm run build
```

Targeted lint, depending on changed files:

```bash
npx eslint src/pages/SkuCostsManagement.tsx src/pages/WarehouseDispatch.tsx src/hooks/useSkuCostBridge.ts src/pages/TraceabilityPublic.tsx
```

If lint fails from pre-existing `any`/empty-block debt, report it honestly and distinguish new errors from existing debt.

For SQL:

- Prefer Supabase Management API dry-run with `begin; <migration>; rollback;` if local DB is unavailable.
- If applying production SQL directly, also run migration repair for the exact migration version.
- Never print Supabase tokens.

### Step 6 — Commit/push discipline

Only commit intentional files. Avoid unrelated dirty paths:

```bash
git status --short
git add <exact changed files>
git commit -m "Propagate NVL material codes to material flows"
git push origin main
```

### Acceptance criteria

- `/sku-costs/management` still builds and shows **Mã NVL**.
- Downstream material flow selected for this task shows or persists **Mã NVL**.
- Existing rows have fallback codes if DB column is missing/null in any legacy data.
- Production SQL is dry-run verified before apply.
- `npm run build` passes.
- Changes are committed and pushed to `main`.

---

## 7) Notes / pitfalls for next agent

- Do not treat `product_skus.sku_code` as Mã NVL. The new code is `sku_formulations.material_code` and is generated from the formula ingredient name.
- Same ingredient name intentionally gets the same code across formulas.
- This code is owner/operator-friendly, not a unique DB primary key. Multiple rows can share the same `material_code`.
- Do not create a unique index on `material_code` alone.
- Do not edit already-applied migration `20260523124000_production_material_issues.sql`; add a new migration for production-safe changes.
- User only cares about `https://ai.banhmique.vn` for production verification.
