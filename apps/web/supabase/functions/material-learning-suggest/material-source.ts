// Read-only, owner-scoped data source for the Material Master learning suggestion.
//
// This module is dependency-free (no Deno, no Supabase client import) so its real
// paging/coverage behavior can be exercised with an injected fake client. The
// entrypoint passes the caller-scoped Supabase client in as a `MaterialSourceClient`.

import {
  MaterialSuggestError,
  normalizeMaterialKey,
  shapeMaterialKey,
  type CandidateMaterial,
  type LegacyAliasRow,
  type MaterialMatchInput,
  type MaterialSuggestDataSource,
  type ScopedAliasRow,
  type SupplierProductRow,
} from "./material-suggest.ts";

export const SERVER_PAGE_SIZE = 500;
export const MAX_SERVER_PAGES = 40;
const MATERIAL_ID_CHUNK = 200;

// The procurement source tables actually present in the controller migrations.
// Each item row points at a parent header that owns the current supplier, so a
// stale request line cannot be validated against an old supplier.
const SOURCE_ITEM_CONTRACTS: Record<string, { parentTable: string; parentColumn: string; sourceTypes: Set<string> }> = {
  payment_request_items: { parentTable: "payment_requests", parentColumn: "payment_request_id", sourceTypes: new Set(["payment_request", "create_invoice_from_pr"]) },
  invoice_items: { parentTable: "invoices", parentColumn: "invoice_id", sourceTypes: new Set(["invoice"]) },
  purchase_order_items: { parentTable: "purchase_orders", parentColumn: "purchase_order_id", sourceTypes: new Set(["purchase_order"]) },
};

export interface ResolutionRequestRow {
  id: string;
  raw_name: string | null;
  raw_code: string | null;
  raw_unit: string | null;
  supplier_id: string | null;
  source_type: string | null;
  source_table: string | null;
  source_id: string | null;
  status: string | null;
}

export interface SkuFormulationRootRow {
  id: string;
  canonical_material_id: string | null;
}

export interface LegacyAliasDbRow {
  id: string;
  material_id: string | null;
  normalized_alias: string | null;
  source: string | null;
  active: boolean | null;
}

export interface ScopedAliasDbRow {
  id: string;
  material_id: string | null;
  supplier_id: string | null;
  normalized_alias: string | null;
  source_type: string | null;
  approved: boolean | null;
  active: boolean | null;
}

export interface SupplierProductDbRow extends SupplierProductRow {
  id: string;
}

export interface SourceItemRow {
  id: string;
  product_name: string | null;
  raw_product_name: string | null;
  product_code: string | null;
  unit: string | null;
  canonical_material_id: string | null;
  payment_request_id?: string | null;
  invoice_id?: string | null;
  purchase_order_id?: string | null;
}

export interface SourceParentRow {
  id: string;
  supplier_id: string | null;
}

// Minimal structural client so the real Supabase client and a deterministic fake
// can both drive the same paging code.
export interface MaterialSourceQuery<T> {
  select(columns: string): MaterialSourceQuery<T>;
  eq(column: string, value: unknown): MaterialSourceQuery<T>;
  is(column: string, value: null): MaterialSourceQuery<T>;
  not(column: string, operator: string, value: unknown): MaterialSourceQuery<T>;
  in(column: string, values: string[]): MaterialSourceQuery<T>;
  order(column: string, options?: { ascending?: boolean }): MaterialSourceQuery<T>;
  range(from: number, to: number): MaterialSourceQuery<T>;
  abortSignal(signal: AbortSignal): MaterialSourceQuery<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: unknown }>;
  then: PromiseLike<{ data: T[] | null; error: unknown }>["then"];
}

export interface MaterialSourceClient {
  from<T = unknown>(table: string): MaterialSourceQuery<T>;
}

// Deterministic full read: keep paging until an explicit empty page and advance by
// the rows actually returned, so a server row cap lower than the requested page
// size cannot silently truncate coverage. A repeated id or a page-budget overflow
// fails closed instead of returning a short list that looks complete.
export async function readAllPages<T extends { id?: unknown }>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (let page = 0; page < MAX_SERVER_PAGES; page += 1) {
    const { data, error } = await build(offset, offset + SERVER_PAGE_SIZE - 1);
    if (error) throw new MaterialSuggestError("source_unavailable", 503);
    const pageRows = data ?? [];
    if (pageRows.length === 0) return rows;
    for (const row of pageRows) {
      const id = typeof row.id === "string" ? row.id : "";
      if (id) {
        if (seen.has(id)) throw new MaterialSuggestError("source_incomplete_coverage", 503);
        seen.add(id);
      }
      rows.push(row);
    }
    offset += pageRows.length;
  }
  throw new MaterialSuggestError("source_incomplete_coverage", 503);
}

function paged<T extends { id?: unknown }>(db: MaterialSourceClient, table: string, columns: string, signal: AbortSignal) {
  return readAllPages<T>((from, to) => db.from<T>(table).select(columns).order("id", { ascending: true }).range(from, to).abortSignal(signal));
}

export async function loadCogsRootedActiveMaterials(db: MaterialSourceClient, signal: AbortSignal): Promise<CandidateMaterial[]> {
  // Candidate roots are the materials actually used by a finished-good formulation,
  // not every active material in the catalog. Inactive roots are excluded.
  const rootRows = await readAllPages<SkuFormulationRootRow>((from, to) => db.from<SkuFormulationRootRow>("sku_formulations")
    .select("id, canonical_material_id, product_skus!sku_formulations_sku_id_fkey!inner(sku_type)")
    .eq("product_skus.sku_type", "finished_good")
    .not("canonical_material_id", "is", null)
    .order("id", { ascending: true })
    .range(from, to)
    .abortSignal(signal));
  const rootIds = [...new Set(rootRows.map((row) => row.canonical_material_id).filter((id): id is string => Boolean(id)))];
  const materials: CandidateMaterial[] = [];
  for (let index = 0; index < rootIds.length; index += MATERIAL_ID_CHUNK) {
    const chunk = rootIds.slice(index, index + MATERIAL_ID_CHUNK);
    const rows = await readAllPages<CandidateMaterial>((from, to) => db.from<CandidateMaterial>("sku_cogs_materials")
      .select("id, material_code, canonical_name, normalized_name, default_unit, category, brand, specification, active")
      .in("id", chunk)
      .eq("active", true)
      .order("canonical_name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
      .abortSignal(signal));
    materials.push(...rows);
  }
  return materials;
}

export async function loadLegacyAliases(db: MaterialSourceClient, signal: AbortSignal): Promise<LegacyAliasRow[]> {
  const rows = await paged<LegacyAliasDbRow>(db, "sku_cogs_material_aliases", "id, material_id, normalized_alias, source, active", signal);
  return rows
    .filter((row) => Boolean(row.material_id))
    .map((row) => ({
      material_id: row.material_id as string,
      normalized_alias: row.normalized_alias,
      source: row.source,
      approved: null,
      active: row.active,
      kind: "legacy_global_alias" as const,
    }));
}

export async function loadSourceAliases(db: MaterialSourceClient, supplierId: string | null, signal: AbortSignal): Promise<LegacyAliasRow[]> {
  const rows = await paged<ScopedAliasDbRow>(db, "material_scoped_aliases", "id, material_id, supplier_id, normalized_alias, source_type, approved, active", signal);
  return rows
    .filter((row) => row.supplier_id === null || row.supplier_id === supplierId)
    .filter((row) => Boolean(row.material_id))
    .map((row) => ({
      material_id: row.material_id as string,
      normalized_alias: row.normalized_alias,
      source: row.source_type,
      approved: row.approved,
      active: row.active,
      supplier_id: row.supplier_id,
      kind: "source_alias" as const,
    }));
}

export function createMaterialDataSource(db: MaterialSourceClient): MaterialSuggestDataSource {
  return {
    async loadMatchInput(requestId: string, signal: AbortSignal): Promise<MaterialMatchInput | null> {
      const request = await db.from<ResolutionRequestRow>("material_resolution_requests")
        .select("id, raw_name, raw_code, raw_unit, supplier_id, source_type, source_table, source_id, status")
        .eq("id", requestId)
        .abortSignal(signal)
        .maybeSingle();
      if (request.error) throw new MaterialSuggestError("source_unavailable", 503);
      const requestRow = request.data ?? null;
      if (!requestRow) return null;
      // A resolved/rejected request is stale evidence and must never be re-suggested.
      if (requestRow.status !== "pending") throw new MaterialSuggestError("request_not_pending", 409);

      const supplierId = requestRow.supplier_id ?? null;
      // When the exact source line is still available, its current state must agree
      // with the request row or the request is stale and must not be used. The name
      // uses the shape-preserving key so `BỘ PEERLESS` and `Bơ Peerless` cannot be
      // treated as the same source merely because tone folding makes both `bo`.
      const sourceContract = requestRow.source_table ? SOURCE_ITEM_CONTRACTS[requestRow.source_table] : undefined;
      if (sourceContract && requestRow.source_id) {
        if (requestRow.source_type && !sourceContract.sourceTypes.has(requestRow.source_type)) {
          throw new MaterialSuggestError("source_changed", 409);
        }
        const source = await db.from<SourceItemRow>(requestRow.source_table as string)
          .select(`id, product_name, raw_product_name, product_code, unit, canonical_material_id, ${sourceContract.parentColumn}`)
          .eq("id", requestRow.source_id)
          .abortSignal(signal)
          .maybeSingle();
        if (source.error) throw new MaterialSuggestError("source_unavailable", 503);
        const sourceRow = source.data ?? null;
        if (!sourceRow || sourceRow.canonical_material_id) throw new MaterialSuggestError("source_changed", 409);
        const requestName = (requestRow.raw_name ?? "").trim();
        if (requestName) {
          const currentName = (sourceRow.raw_product_name || sourceRow.product_name || "").trim();
          if (!currentName || shapeMaterialKey(currentName) !== shapeMaterialKey(requestName)) {
            throw new MaterialSuggestError("source_changed", 409);
          }
        }
        const requestUnit = (requestRow.raw_unit ?? "").trim();
        if (requestUnit && (sourceRow.unit ?? "").trim().toLowerCase() !== requestUnit.toLowerCase()) {
          throw new MaterialSuggestError("source_changed", 409);
        }
        const requestCode = (requestRow.raw_code ?? "").trim();
        if (requestCode && normalizeMaterialKey(sourceRow.product_code) !== normalizeMaterialKey(requestCode)) {
          throw new MaterialSuggestError("source_changed", 409);
        }
        // The owning header's current supplier must still match the supplier the
        // request was captured for; a missing parent is an orphan line, not evidence.
        const parentId = (sourceRow as unknown as Record<string, unknown>)[sourceContract.parentColumn];
        if (typeof parentId !== "string" || !parentId) throw new MaterialSuggestError("source_changed", 409);
        const parent = await db.from<SourceParentRow>(sourceContract.parentTable)
          .select("id, supplier_id")
          .eq("id", parentId)
          .abortSignal(signal)
          .maybeSingle();
        if (parent.error) throw new MaterialSuggestError("source_unavailable", 503);
        const parentRow = parent.data ?? null;
        if (!parentRow) throw new MaterialSuggestError("source_changed", 409);
        if (supplierId != null && parentRow.supplier_id !== supplierId) throw new MaterialSuggestError("source_changed", 409);
      }

      const materials = await loadCogsRootedActiveMaterials(db, signal);

      let supplierName: string | null = null;
      let scopedAliases: ScopedAliasRow[] = [];
      let supplierProducts: SupplierProductRow[] = [];
      if (supplierId) {
        const supplier = await db.from<{ id: string; name: string | null }>("suppliers").select("id, name").eq("id", supplierId).abortSignal(signal).maybeSingle();
        if (supplier.error) throw new MaterialSuggestError("source_unavailable", 503);
        supplierName = supplier.data?.name ?? null;

        const aliases = await paged<ScopedAliasDbRow>(db, "material_scoped_aliases", "id, material_id, supplier_id, normalized_alias, source_type, approved, active", signal);
        scopedAliases = aliases
          .filter((row) => row.supplier_id === supplierId && row.approved === true && row.active === true && Boolean(row.material_id))
          .map((row) => ({ material_id: row.material_id as string, supplier_id: row.supplier_id, normalized_alias: row.normalized_alias, approved: row.approved, active: row.active }));

        const products = await paged<SupplierProductDbRow>(db, "material_supplier_products", "id, material_id, supplier_id, normalized_supplier_product_name, purchase_unit, approved, active", signal);
        supplierProducts = products
          .filter((row) => row.supplier_id === supplierId && row.approved === true && row.active === true && Boolean(row.material_id))
          .map((row) => ({ material_id: row.material_id as string, supplier_id: row.supplier_id, normalized_supplier_product_name: row.normalized_supplier_product_name, purchase_unit: row.purchase_unit, approved: row.approved, active: row.active }));
      }

      // Recognized legacy global aliases and source aliases stay as candidate
      // knowledge with provenance; the core never auto-resolves through them.
      const legacyAliases = [
        ...await loadLegacyAliases(db, signal),
        ...await loadSourceAliases(db, supplierId, signal),
      ];

      return {
        request_id: requestRow.id,
        raw_name: requestRow.raw_name ?? "",
        raw_code: requestRow.raw_code ?? null,
        raw_unit: requestRow.raw_unit ?? null,
        supplier_id: supplierId,
        supplier_name: supplierName,
        source_type: requestRow.source_type ?? null,
        materials,
        scoped_aliases: scopedAliases,
        supplier_products: supplierProducts,
        legacy_aliases: legacyAliases,
      };
    },
  };
}
