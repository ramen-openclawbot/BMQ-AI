// Behavioral tests for the real read-only data source behind the suggestion
// endpoint. They use an injected fake client with a configurable server row cap so
// the >1000-row and cap-advance behavior is exercised without any live database.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMaterialDataSource,
  loadCogsRootedActiveMaterials,
  type MaterialSourceClient,
  type MaterialSourceQuery,
} from "./material-source.ts";
import { MaterialSuggestError } from "./material-suggest.ts";

interface FakeOptions {
  rows: Record<string, Array<Record<string, unknown>>>;
  serverCap?: number;
  /** Simulate a server that ignores the offset and returns the first page forever. */
  repeatFirstPage?: boolean;
}

function getPath(row: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), row);
}

class FakeQuery<T> implements MaterialSourceQuery<T> {
  private predicates: Array<(row: Record<string, unknown>) => boolean> = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private from = 0;
  private to = Number.MAX_SAFE_INTEGER;
  private readonly client: FakeClient;
  private readonly table: string;
  constructor(client: FakeClient, table: string) {
    this.client = client;
    this.table = table;
  }

  select(): MaterialSourceQuery<T> { return this; }
  eq(column: string, value: unknown) { this.predicates.push((row) => getPath(row, column) === value); return this; }
  is(column: string, value: null) { this.predicates.push((row) => getPath(row, column) === value); return this; }
  not(column: string, operator: string, value: unknown) {
    this.predicates.push((row) => operator === "is" && value === null ? getPath(row, column) != null : true);
    return this;
  }
  in(column: string, values: string[]) { const set = new Set(values); this.predicates.push((row) => set.has(getPath(row, column) as string)); return this; }
  order(column: string, options?: { ascending?: boolean }) { this.orders.push({ column, ascending: options?.ascending !== false }); return this; }
  range(from: number, to: number) { this.from = from; this.to = to; return this; }
  abortSignal() { return this; }

  private result(): { data: Array<Record<string, unknown>>; error: unknown } {
    let rows = [...(this.client.rows[this.table] ?? [])];
    for (const predicate of this.predicates) rows = rows.filter(predicate);
    for (const { column, ascending } of this.orders) {
      rows.sort((left, right) => {
        const a = String(getPath(left, column) ?? "");
        const b = String(getPath(right, column) ?? "");
        const compared = a < b ? -1 : a > b ? 1 : 0;
        return ascending ? compared : -compared;
      });
    }
    if (this.client.repeatFirstPage) rows = rows.slice(0, this.client.serverCap);
    else rows = rows.slice(this.from, this.from + Math.min(this.to - this.from + 1, this.client.serverCap));
    return { data: rows, error: null };
  }

  maybeSingle(): PromiseLike<{ data: T | null; error: unknown }> {
    const { data, error } = this.result();
    return Promise.resolve({ data: (data[0] as unknown as T) ?? null, error });
  }

  then<TResult1 = { data: T[] | null; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: T[] | null; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const { data, error } = this.result();
    return Promise.resolve({ data: data as unknown as T[], error }).then(onfulfilled, onrejected);
  }
}

class FakeClient implements MaterialSourceClient {
  readonly rows: Record<string, Array<Record<string, unknown>>>;
  readonly serverCap: number;
  readonly repeatFirstPage: boolean;
  constructor(options: FakeOptions) {
    this.rows = options.rows;
    this.serverCap = options.serverCap ?? 1000;
    this.repeatFirstPage = options.repeatFirstPage ?? false;
  }
  from<T = unknown>(table: string): MaterialSourceQuery<T> { return new FakeQuery<T>(this, table) as MaterialSourceQuery<T>; }
}

function roots(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `f${index}`,
    canonical_material_id: `m${index}`,
    product_skus: { sku_type: "finished_good" },
  }));
}

function materials(ids: string[], active = true) {
  return ids.map((id) => ({
    id,
    material_code: `NVL-${id}`,
    canonical_name: `Nguyên liệu ${id}`,
    normalized_name: `nguyen lieu ${id}`,
    default_unit: "kg",
    category: null,
    brand: null,
    specification: null,
    active,
  }));
}

test("loads every COGS-rooted active material past 1000 rows with a 100-row server cap", async () => {
  const ids = Array.from({ length: 1200 }, (_, index) => `m${index}`);
  const client = new FakeClient({ rows: { sku_formulations: roots(1200), sku_cogs_materials: materials(ids) }, serverCap: 100 });
  const loaded = await loadCogsRootedActiveMaterials(client, new AbortController().signal);
  assert.equal(loaded.length, 1200, "a 100-row server cap must not truncate coverage");
  assert.equal(new Set(loaded.map((row) => row.id)).size, 1200);
});

test("only active finished-good formulation roots become candidates", async () => {
  const client = new FakeClient({
    rows: {
      sku_formulations: [
        { id: "f1", canonical_material_id: "m1", product_skus: { sku_type: "finished_good" } },
        { id: "f2", canonical_material_id: "m2", product_skus: { sku_type: "finished_good" } },
        { id: "f3", canonical_material_id: "m3", product_skus: { sku_type: "raw" } },
        { id: "f4", canonical_material_id: null, product_skus: { sku_type: "finished_good" } },
      ],
      sku_cogs_materials: [...materials(["m1", "m3"]), ...materials(["m2"], false)],
    },
  });
  const loaded = await loadCogsRootedActiveMaterials(client, new AbortController().signal);
  assert.deepEqual(loaded.map((row) => row.id).sort(), ["m1"]);
});

test("a repeated page or page-budget overflow fails closed instead of a short list", async () => {
  const client = new FakeClient({
    rows: { sku_formulations: roots(500), sku_cogs_materials: materials(Array.from({ length: 500 }, (_, index) => `m${index}`)) },
    serverCap: 100,
    repeatFirstPage: true,
  });
  await assert.rejects(
    () => loadCogsRootedActiveMaterials(client, new AbortController().signal),
    (error: unknown) => error instanceof MaterialSuggestError && error.code === "source_incomplete_coverage",
  );
});

test("non-pending and changed-source requests are rejected before any matching", async () => {
  const request = { id: "req", raw_name: "Bơ Peerless", raw_code: null, raw_unit: "kg", supplier_id: null, source_type: "payment_request", source_table: "payment_request_items", source_id: "it1", status: "pending" };
  const base = { sku_formulations: roots(1), sku_cogs_materials: materials(["m0"]) };

  const resolved = new FakeClient({ rows: { ...base, material_resolution_requests: [{ ...request, status: "resolved_existing" }] } });
  await assert.rejects(() => createMaterialDataSource(resolved).loadMatchInput("req", new AbortController().signal), (error: unknown) => error instanceof MaterialSuggestError && error.code === "request_not_pending");

  const changed = new FakeClient({ rows: { ...base, material_resolution_requests: [request], payment_request_items: [{ id: "it1", product_name: "Tên khác", raw_product_name: "Tên khác", unit: "kg", canonical_material_id: null }] } });
  await assert.rejects(() => createMaterialDataSource(changed).loadMatchInput("req", new AbortController().signal), (error: unknown) => error instanceof MaterialSuggestError && error.code === "source_changed");

  const alreadyLinked = new FakeClient({ rows: { ...base, material_resolution_requests: [request], payment_request_items: [{ id: "it1", product_name: "Bơ Peerless", raw_product_name: null, unit: "kg", canonical_material_id: "m0" }] } });
  await assert.rejects(() => createMaterialDataSource(alreadyLinked).loadMatchInput("req", new AbortController().signal), (error: unknown) => error instanceof MaterialSuggestError && error.code === "source_changed");
});

test("only approved active scoped aliases match while legacy and source aliases stay as provenance", async () => {
  const request = { id: "req", raw_name: "Đậu phộng rang", raw_code: null, raw_unit: "kg", supplier_id: "sup1", source_type: "payment_request", source_table: null, source_id: null, status: "pending" };
  const client = new FakeClient({
    rows: {
      sku_formulations: roots(1),
      sku_cogs_materials: materials(["m0"]),
      material_resolution_requests: [request],
      suppliers: [{ id: "sup1", name: "TV Food" }],
      material_scoped_aliases: [
        { id: "sa1", material_id: "m0", supplier_id: "sup1", normalized_alias: "dau phong rang", source_type: "payment_request", approved: true, active: true },
        { id: "sa2", material_id: "m0", supplier_id: "sup1", normalized_alias: "ten chua duyet", source_type: "payment_request", approved: false, active: true },
        { id: "sa3", material_id: "m0", supplier_id: null, normalized_alias: "nguon q7", source_type: "kitchen_inventory", approved: null, active: true },
      ],
      material_supplier_products: [],
      sku_cogs_material_aliases: [
        { id: "ga1", material_id: "m0", normalized_alias: "bo peerless", source: "existing_cogs", active: true },
      ],
    },
  });
  const input = await createMaterialDataSource(client).loadMatchInput("req", new AbortController().signal);
  assert.ok(input);
  assert.deepEqual(input.scoped_aliases.map((row) => row.normalized_alias), ["dau phong rang"]);
  const provenance = input.legacy_aliases ?? [];
  assert.ok(provenance.some((row) => row.kind === "legacy_global_alias" && row.source === "existing_cogs"));
  assert.ok(provenance.some((row) => row.kind === "source_alias" && row.source === "kitchen_inventory"));
  assert.ok(provenance.some((row) => row.kind === "source_alias" && row.approved === false));
});
