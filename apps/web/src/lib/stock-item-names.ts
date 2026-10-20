/**
 * Pure helpers for showing the current warehouse item name on payment-request
 * and purchase-order lines.
 *
 * The warehouse game writes the name links in public.stock_material_aliases.
 * The RPC returns only the lines it could resolve; these helpers keep a broken
 * response from hiding the document's own product name.
 */

export type StockNameLine = {
  key: string;
  supplier_id: string | null;
  name: string;
  location: string | null;
};

export type StockItemName = {
  key: string;
  item_id: string;
  item_name: string;
  item_code: string | null;
  unit: string | null;
  location: string | null;
  match: string;
};

export type StockNameSourceItem = {
  id: string;
  product_name?: string | null;
  raw_product_name?: string | null;
};

function cleanText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build the payload for get_stock_item_names_for_lines. A line uses
 * raw_product_name when it has text, otherwise product_name; blank names are
 * dropped because the SQL normalizer would skip them anyway.
 */
export function buildStockNameLines(
  items: StockNameSourceItem[],
  supplierId: string | null,
  location: string | null = null,
): StockNameLine[] {
  const lines: StockNameLine[] = [];
  for (const item of items) {
    const rawName = cleanText(item.raw_product_name);
    const name = rawName !== "" ? rawName : cleanText(item.product_name);
    if (name === "") continue;
    lines.push({
      key: item.id,
      supplier_id: supplierId,
      name,
      location: location ?? null,
    });
  }
  return lines;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Tolerant reader for get_stock_item_names_for_lines(). Non-array payloads and
 * malformed entries are skipped instead of throwing.
 */
export function parseStockItemNames(data: unknown): Map<string, StockItemName> {
  const names = new Map<string, StockItemName>();
  if (!Array.isArray(data)) return names;

  for (const entry of data) {
    const row = asRecord(entry);
    if (row === null) continue;

    const key = row.key;
    const itemId = row.item_id;
    const itemName = row.item_name;
    const match = row.match;
    if (
      typeof key !== "string" ||
      typeof itemId !== "string" ||
      typeof itemName !== "string" ||
      typeof match !== "string"
    ) {
      continue;
    }

    names.set(key, {
      key,
      item_id: itemId,
      item_name: itemName,
      item_code: asNullableString(row.item_code),
      unit: asNullableString(row.unit),
      location: asNullableString(row.location),
      match,
    });
  }

  return names;
}

/**
 * Keep the document's own product name unless the warehouse has a resolved
 * name. sourceName is only populated when the document name differs from the
 * warehouse name after trimming and case-folding.
 */
export function displayNameFor(
  item: StockNameSourceItem,
  names: Map<string, StockItemName>,
): { name: string; sourceName: string | null; stock: StockItemName | null } {
  const productName = cleanText(item.product_name);
  const rawName = cleanText(item.raw_product_name);
  const documentName = rawName !== "" ? rawName : productName;
  const stock = names.get(item.id) ?? null;

  if (stock === null) {
    return { name: productName, sourceName: null, stock: null };
  }

  const stockName = stock.item_name;
  const differs =
    documentName !== "" &&
    documentName.toLocaleLowerCase("vi") !== stockName.trim().toLocaleLowerCase("vi");

  return {
    name: stockName,
    sourceName: differs ? documentName : null,
    stock,
  };
}
