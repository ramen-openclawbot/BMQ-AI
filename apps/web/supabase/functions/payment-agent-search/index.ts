/* eslint-disable @typescript-eslint/no-explicit-any */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

type PaymentAgentAction = "supplier_suggestions" | "material_suggestions" | "supplier_search" | "material_search";

type PaymentRequestSearchSupplier = {
  id: string;
  name?: string | null;
  short_code?: string | null;
};

type SupplierSuggestion = PaymentRequestSearchSupplier & {
  pr_count?: number;
};

type PaymentRequestSearchRow = {
  id: string;
  request_number: string | null;
  title: string | null;
  total_amount: number | null;
  payment_status: string | null;
  payment_method: string | null;
  status: string | null;
  approved_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  invoice_id: string | null;
  supplier_id: string | null;
  invoices?: { invoice_number?: string | null; invoice_date?: string | null } | null;
  suppliers?: { name?: string | null; short_code?: string | null } | null;
};

type PaymentRequestMaterialItem = {
  product_name?: string | null;
  product_code?: string | null;
  unit?: string | null;
  payment_request_id?: string | null;
  created_at?: string | null;
  quantity?: number | null;
  unit_price?: number | null;
  line_total?: number | null;
};

type MaterialSuggestion = {
  product_name: string;
  product_code: string | null;
  unit: string | null;
  pr_count: number;
  line_count: number;
  latest_item_at: string | null;
};

type PaymentRequestMaterialSearchRow = PaymentRequestSearchRow & {
  matching_line_total: number;
  matching_line_count: number;
  matching_products: string[];
  matching_lines: Array<{
    product_name: string | null;
    product_code: string | null;
    quantity: number | null;
    unit: string | null;
    line_total: number;
  }>;
};

const NORMALIZED_SUPPLIER_CANDIDATE_LIMIT = 500;
const NORMALIZED_MATERIAL_CANDIDATE_LIMIT = 500;
const MIN_SUGGESTIONS_BEFORE_NORMALIZED_FALLBACK = 5;
const SUPPLIER_SUGGESTION_LIMIT = 10;
const MATERIAL_SUGGESTION_LIMIT = 10;
const PAYMENT_REQUEST_LIMIT = 100;
const MATERIAL_ITEM_LIMIT = 200;
const MAX_SEARCH_TERM_LENGTH = 80;

const PAYMENT_REQUEST_SELECT = [
  "id",
  "request_number",
  "title",
  "total_amount",
  "payment_status",
  "payment_method",
  "status",
  "approved_at",
  "created_at",
  "updated_at",
  "invoice_id",
  "supplier_id",
  "invoices!payment_requests_invoice_id_fkey(invoice_number,invoice_date)",
  "suppliers!payment_requests_supplier_id_fkey(name,short_code)",
].join(",");

const MATERIAL_ITEM_SELECT = [
  "product_name",
  "product_code",
  "unit",
  "payment_request_id",
  "created_at",
  "quantity",
  "unit_price",
  "line_total",
].join(",");

function jsonResponse(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

async function requireOwner(req: Request, supabaseAdmin: any) {
  const corsHeaders = getCorsHeaders(req);
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Response(JSON.stringify({ error: "Missing authorization header" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    throw new Response(JSON.stringify({ error: "Invalid or expired token" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: roleRows } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .limit(10);

  const isOwner = (roleRows || []).some((row: any) => row.role === "owner");
  if (!isOwner) {
    throw new Response(JSON.stringify({ error: "Forbidden. Owner role required." }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return user;
}

function escapeIlikePattern(value: string): string {
  return value.replace(/[%_]/g, "\\$&");
}

function normalizeVietnamese(value: string): string {
  return String(value || "")
    .replace(/[đĐ]/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ");
}

function normalizedTokens(value: string): string[] {
  return normalizeVietnamese(value).split(" ").filter(Boolean);
}

function isNoAccentInput(value: string): boolean {
  const compactOriginal = String(value || "").toLowerCase().trim().replace(/\s+/g, " ");
  return Boolean(compactOriginal) && compactOriginal === normalizeVietnamese(value);
}

function hasTokensInOrder(haystack: string, tokens: string[]): boolean {
  let cursor = 0;
  for (const token of tokens) {
    const nextIndex = haystack.indexOf(token, cursor);
    if (nextIndex < 0) return false;
    cursor = nextIndex + token.length;
  }
  return true;
}

function getNormalizedMatchRank(query: string, labels: Array<string | null | undefined>): number | null {
  const normalizedQuery = normalizeVietnamese(query);
  const tokens = normalizedTokens(query);
  if (!normalizedQuery || !tokens.length) return null;

  const normalizedLabels = labels.map((label) => normalizeVietnamese(label || "")).filter(Boolean);
  if (!normalizedLabels.length) return null;

  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  const compactLabels = normalizedLabels.map((label) => label.replace(/\s+/g, ""));
  if (normalizedLabels.some((label) => label === normalizedQuery)) return 0;
  if (compactLabels.some((label) => label === compactQuery)) return 0;
  if (normalizedLabels.some((label) => label.startsWith(normalizedQuery))) return 1;
  if (compactLabels.some((label) => label.startsWith(compactQuery))) return 1;
  if (normalizedLabels.some((label) => label.includes(normalizedQuery))) return 2;
  if (compactLabels.some((label) => label.includes(compactQuery))) return 2;
  if (normalizedLabels.some((label) => hasTokensInOrder(label, tokens))) return 3;

  const combined = normalizedLabels.join(" ");
  if (hasTokensInOrder(combined, tokens)) return 4;
  if (tokens.every((token) => combined.includes(token))) return 5;
  return null;
}

function compareText(a: string | null | undefined, b: string | null | undefined): number {
  return String(a || "").localeCompare(String(b || ""), "vi");
}

function supplierLabels(supplier: PaymentRequestSearchSupplier): Array<string | null | undefined> {
  return [supplier.name, supplier.short_code];
}

function materialLabels(item: PaymentRequestMaterialItem | MaterialSuggestion): Array<string | null | undefined> {
  return [item.product_name, item.product_code];
}

function sortSuppliersForTerm<T extends PaymentRequestSearchSupplier>(term: string, suppliers: T[]): T[] {
  return [...suppliers].sort((a, b) => {
    const rankA = getNormalizedMatchRank(term, supplierLabels(a)) ?? Number.MAX_SAFE_INTEGER;
    const rankB = getNormalizedMatchRank(term, supplierLabels(b)) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;

    const countA = "pr_count" in a ? Number(a.pr_count || 0) : 0;
    const countB = "pr_count" in b ? Number(b.pr_count || 0) : 0;
    if (countB !== countA) return countB - countA;

    return compareText(a.name || a.short_code || a.id, b.name || b.short_code || b.id);
  });
}

function sortMaterialSuggestions(term: string, suggestions: MaterialSuggestion[]): MaterialSuggestion[] {
  return [...suggestions].sort((a, b) => {
    const rankA = getNormalizedMatchRank(term, materialLabels(a)) ?? Number.MAX_SAFE_INTEGER;
    const rankB = getNormalizedMatchRank(term, materialLabels(b)) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    if (b.pr_count !== a.pr_count) return b.pr_count - a.pr_count;

    const dateA = new Date(a.latest_item_at || 0).getTime();
    const dateB = new Date(b.latest_item_at || 0).getTime();
    if (dateB !== dateA) return dateB - dateA;

    if (b.line_count !== a.line_count) return b.line_count - a.line_count;
    return compareText(a.product_name, b.product_name);
  });
}

function materialRowKey(item: PaymentRequestMaterialItem): string {
  return [
    item.payment_request_id || "",
    item.product_name || "",
    item.product_code || "",
    item.unit || "",
    item.created_at || "",
  ].map((part) => String(part).toLowerCase()).join("__");
}

function mergeMaterialRows(...groups: PaymentRequestMaterialItem[][]): PaymentRequestMaterialItem[] {
  const rowMap = new Map<string, PaymentRequestMaterialItem>();
  groups.flat().forEach((row) => {
    const key = materialRowKey(row);
    if (!rowMap.has(key)) rowMap.set(key, row);
  });
  return Array.from(rowMap.values());
}

function getMaterialLineAmount(item: PaymentRequestMaterialItem): number {
  const lineTotal = Number(item.line_total || 0);
  if (Number.isFinite(lineTotal) && lineTotal > 0) return lineTotal;

  const quantity = Number(item.quantity ?? 0);
  const unitPrice = Number(item.unit_price ?? 0);
  if (Number.isFinite(quantity) && Number.isFinite(unitPrice) && quantity > 0 && unitPrice > 0) return quantity * unitPrice;
  return 0;
}

function getMaterialQuantity(item: PaymentRequestMaterialItem): number | null {
  const quantity = Number(item.quantity ?? NaN);
  return Number.isFinite(quantity) ? quantity : null;
}

function aggregateMaterialSuggestions(rows: PaymentRequestMaterialItem[]): MaterialSuggestion[] {
  const suggestionMap = new Map<string, MaterialSuggestion & { requestIds: Set<string> }>();

  rows.forEach((row) => {
    const productName = String(row.product_name || "").trim();
    if (!productName) return;

    const unit = row.unit || null;
    const productCode = row.product_code || null;
    const key = `${productName.toLowerCase()}__${String(unit || "").toLowerCase()}`;
    const current = suggestionMap.get(key) || {
      product_name: productName,
      product_code: productCode,
      unit,
      pr_count: 0,
      line_count: 0,
      latest_item_at: row.created_at || null,
      requestIds: new Set<string>(),
    };

    current.line_count += 1;
    if (!current.product_code && productCode) current.product_code = productCode;
    if (row.payment_request_id) current.requestIds.add(row.payment_request_id);
    if (row.created_at && (!current.latest_item_at || new Date(row.created_at).getTime() > new Date(current.latest_item_at).getTime())) {
      current.latest_item_at = row.created_at;
    }
    current.pr_count = current.requestIds.size;
    suggestionMap.set(key, current);
  });

  return Array.from(suggestionMap.values())
    .sort((a, b) => {
      if (b.pr_count !== a.pr_count) return b.pr_count - a.pr_count;
      const dateA = new Date(a.latest_item_at || 0).getTime();
      const dateB = new Date(b.latest_item_at || 0).getTime();
      if (dateB !== dateA) return dateB - dateA;
      return b.line_count - a.line_count;
    })
    .slice(0, MATERIAL_SUGGESTION_LIMIT)
    .map(({ requestIds: _requestIds, ...suggestion }) => suggestion);
}

async function fetchSuppliersByIlike(supabaseAdmin: any, term: string, limit: number): Promise<PaymentRequestSearchSupplier[]> {
  const pattern = `%${escapeIlikePattern(term)}%`;
  const [nameResult, shortCodeResult] = await Promise.all([
    supabaseAdmin.from("suppliers").select("id,name,short_code").ilike("name", pattern).limit(limit),
    supabaseAdmin.from("suppliers").select("id,name,short_code").ilike("short_code", pattern).limit(limit),
  ]);

  if (nameResult.error) throw nameResult.error;
  if (shortCodeResult.error) throw shortCodeResult.error;

  const supplierMap = new Map<string, PaymentRequestSearchSupplier>();
  [...(nameResult.data || []), ...(shortCodeResult.data || [])].forEach((supplier: PaymentRequestSearchSupplier) => {
    if (supplier?.id) supplierMap.set(supplier.id, supplier);
  });

  return Array.from(supplierMap.values()).slice(0, limit);
}

async function fetchSupplierById(supabaseAdmin: any, supplierId: string): Promise<PaymentRequestSearchSupplier | null> {
  const { data, error } = await supabaseAdmin
    .from("suppliers")
    .select("id,name,short_code")
    .eq("id", supplierId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function fetchNormalizedSupplierCandidates(supabaseAdmin: any, term: string): Promise<PaymentRequestSearchSupplier[]> {
  const { data, error } = await supabaseAdmin
    .from("suppliers")
    .select("id,name,short_code")
    .order("name", { ascending: true })
    .limit(NORMALIZED_SUPPLIER_CANDIDATE_LIMIT);

  if (error) throw error;

  return sortSuppliersForTerm(
    term,
    (data || []).filter((supplier: PaymentRequestSearchSupplier) => getNormalizedMatchRank(term, supplierLabels(supplier)) !== null),
  );
}

async function enrichSupplierSuggestionCounts(supabaseAdmin: any, suppliers: PaymentRequestSearchSupplier[]): Promise<SupplierSuggestion[]> {
  if (!suppliers.length) return [];

  const counts = new Map<string, number>();
  const { data: requestData, error } = await supabaseAdmin
    .from("payment_requests")
    .select("id,supplier_id")
    .in("supplier_id", suppliers.map((supplier) => supplier.id))
    .limit(1000);

  if (error) throw error;

  (requestData || []).forEach((row: Pick<PaymentRequestSearchRow, "supplier_id">) => {
    if (row.supplier_id) counts.set(row.supplier_id, (counts.get(row.supplier_id) || 0) + 1);
  });

  return suppliers.map((supplier) => ({ ...supplier, pr_count: counts.get(supplier.id) || 0 }));
}

async function searchSupplierSuggestions(supabaseAdmin: any, term: string): Promise<SupplierSuggestion[]> {
  const directSuppliers = await fetchSuppliersByIlike(supabaseAdmin, term, SUPPLIER_SUGGESTION_LIMIT);
  const supplierMap = new Map<string, PaymentRequestSearchSupplier>();

  directSuppliers.forEach((supplier) => {
    if (supplier?.id) supplierMap.set(supplier.id, supplier);
  });

  if (directSuppliers.length < MIN_SUGGESTIONS_BEFORE_NORMALIZED_FALLBACK || isNoAccentInput(term)) {
    const normalizedSuppliers = await fetchNormalizedSupplierCandidates(supabaseAdmin, term);
    normalizedSuppliers.forEach((supplier) => {
      if (supplier?.id) supplierMap.set(supplier.id, supplier);
    });
  }

  const suppliers = sortSuppliersForTerm(term, Array.from(supplierMap.values())).slice(0, SUPPLIER_SUGGESTION_LIMIT);
  return sortSuppliersForTerm(term, await enrichSupplierSuggestionCounts(supabaseAdmin, suppliers)).slice(0, SUPPLIER_SUGGESTION_LIMIT);
}

async function fetchNormalizedMaterialRows(supabaseAdmin: any, term: string, select: string, limit: number): Promise<PaymentRequestMaterialItem[]> {
  const { data, error } = await supabaseAdmin
    .from("payment_request_items")
    .select(select)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  return (data || [])
    .filter((item: PaymentRequestMaterialItem) => getNormalizedMatchRank(term, materialLabels(item)) !== null)
    .sort((a: PaymentRequestMaterialItem, b: PaymentRequestMaterialItem) => {
      const rankA = getNormalizedMatchRank(term, materialLabels(a)) ?? Number.MAX_SAFE_INTEGER;
      const rankB = getNormalizedMatchRank(term, materialLabels(b)) ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;

      const dateA = new Date(a.created_at || 0).getTime();
      const dateB = new Date(b.created_at || 0).getTime();
      if (dateB !== dateA) return dateB - dateA;

      return compareText(a.product_name, b.product_name);
    });
}

async function fetchMaterialRowsByIlike(
  supabaseAdmin: any,
  term: string,
  select: string,
  limit: number,
): Promise<PaymentRequestMaterialItem[]> {
  const pattern = `%${escapeIlikePattern(term)}%`;
  const [nameResult, codeResult] = await Promise.all([
    supabaseAdmin
      .from("payment_request_items")
      .select(select)
      .ilike("product_name", pattern)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabaseAdmin
      .from("payment_request_items")
      .select(select)
      .ilike("product_code", pattern)
      .order("created_at", { ascending: false })
      .limit(limit),
  ]);

  if (nameResult.error) throw nameResult.error;
  if (codeResult.error) throw codeResult.error;

  return mergeMaterialRows(nameResult.data || [], codeResult.data || []).slice(0, limit);
}

async function searchMaterialSuggestions(supabaseAdmin: any, term: string): Promise<MaterialSuggestion[]> {
  const directRows = await fetchMaterialRowsByIlike(
    supabaseAdmin,
    term,
    "product_name,product_code,unit,payment_request_id,created_at",
    80,
  );
  let rows = directRows;
  const directSuggestions = aggregateMaterialSuggestions(directRows);

  if (directSuggestions.length < MIN_SUGGESTIONS_BEFORE_NORMALIZED_FALLBACK || isNoAccentInput(term)) {
    const normalizedRows = await fetchNormalizedMaterialRows(
      supabaseAdmin,
      term,
      "product_name,product_code,unit,payment_request_id,created_at",
      NORMALIZED_MATERIAL_CANDIDATE_LIMIT,
    );
    rows = mergeMaterialRows(directRows, normalizedRows);
  }

  return sortMaterialSuggestions(term, aggregateMaterialSuggestions(rows)).slice(0, MATERIAL_SUGGESTION_LIMIT);
}

async function resolveStrongSupplierSuggestion(supabaseAdmin: any, term: string): Promise<SupplierSuggestion | null> {
  const suggestions = await searchSupplierSuggestions(supabaseAdmin, term);
  const topSuggestion = suggestions[0];
  if (!topSuggestion) return null;

  const topRank = getNormalizedMatchRank(term, supplierLabels(topSuggestion));
  if (topRank === null) return null;
  if (topRank <= 1) return topSuggestion;

  const secondRank = suggestions[1] ? getNormalizedMatchRank(term, supplierLabels(suggestions[1])) : null;
  if (topRank <= 3 && (secondRank === null || secondRank > topRank)) return topSuggestion;
  return null;
}

async function searchPaymentRequestsBySupplier(
  supabaseAdmin: any,
  term: string,
  exactSupplier?: PaymentRequestSearchSupplier,
): Promise<{ suppliers: PaymentRequestSearchSupplier[]; rows: PaymentRequestSearchRow[] }> {
  let suppliers: PaymentRequestSearchSupplier[] = [];

  if (exactSupplier?.id) {
    const supplier = await fetchSupplierById(supabaseAdmin, exactSupplier.id);
    suppliers = supplier ? [supplier] : [];
  } else {
    suppliers = await fetchSuppliersByIlike(supabaseAdmin, term, SUPPLIER_SUGGESTION_LIMIT);
    if (!suppliers.length) {
      const normalizedSupplier = await resolveStrongSupplierSuggestion(supabaseAdmin, term);
      suppliers = normalizedSupplier ? [normalizedSupplier] : [];
      exactSupplier = normalizedSupplier || undefined;
    }
  }

  if (!suppliers.length) return { suppliers: [], rows: [] };

  let requestQuery = supabaseAdmin
    .from("payment_requests")
    .select(PAYMENT_REQUEST_SELECT)
    .order("created_at", { ascending: false })
    .limit(PAYMENT_REQUEST_LIMIT);

  requestQuery = exactSupplier?.id
    ? requestQuery.eq("supplier_id", exactSupplier.id)
    : requestQuery.in("supplier_id", suppliers.map((supplier) => supplier.id));

  const { data, error } = await requestQuery;

  if (error) throw error;
  return { suppliers, rows: data || [] };
}

async function searchPaymentRequestsByMaterial(
  supabaseAdmin: any,
  term: string,
  exactProductName = false,
): Promise<PaymentRequestMaterialSearchRow[]> {
  let items: PaymentRequestMaterialItem[] = [];

  if (exactProductName) {
    const { data: exactData, error: exactError } = await supabaseAdmin
      .from("payment_request_items")
      .select(MATERIAL_ITEM_SELECT)
      .eq("product_name", term)
      .order("created_at", { ascending: false })
      .limit(MATERIAL_ITEM_LIMIT);
    if (exactError) throw exactError;
    items = exactData || [];
  } else {
    items = await fetchMaterialRowsByIlike(supabaseAdmin, term, MATERIAL_ITEM_SELECT, MATERIAL_ITEM_LIMIT);
  }
  if (!exactProductName && !items.length) {
    items = (await fetchNormalizedMaterialRows(supabaseAdmin, term, MATERIAL_ITEM_SELECT, NORMALIZED_MATERIAL_CANDIDATE_LIMIT)).slice(0, MATERIAL_ITEM_LIMIT);
  }

  const requestIds = Array.from(new Set(items.map((item) => item.payment_request_id).filter(Boolean))) as string[];
  if (!requestIds.length) return [];

  const { data: requestData, error: requestError } = await supabaseAdmin
    .from("payment_requests")
    .select(PAYMENT_REQUEST_SELECT)
    .in("id", requestIds)
    .order("created_at", { ascending: false })
    .limit(PAYMENT_REQUEST_LIMIT);

  if (requestError) throw requestError;

  const requestMap = new Map<string, PaymentRequestSearchRow>((requestData || []).map((row: PaymentRequestSearchRow) => [row.id, row]));
  const itemAggregate = new Map<string, {
    matching_line_total: number;
    matching_line_count: number;
    matching_products: Set<string>;
    matching_lines: PaymentRequestMaterialSearchRow["matching_lines"];
  }>();

  items.forEach((item) => {
    if (!item.payment_request_id) return;
    const current = itemAggregate.get(item.payment_request_id) || {
      matching_line_total: 0,
      matching_line_count: 0,
      matching_products: new Set<string>(),
      matching_lines: [],
    };
    const lineTotal = getMaterialLineAmount(item);
    current.matching_line_total += lineTotal;
    current.matching_line_count += 1;
    if (item.product_name) current.matching_products.add(item.product_name);
    current.matching_lines.push({
      product_name: item.product_name || null,
      product_code: item.product_code || null,
      quantity: getMaterialQuantity(item),
      unit: item.unit || null,
      line_total: lineTotal,
    });
    itemAggregate.set(item.payment_request_id, current);
  });

  return Array.from(itemAggregate.entries()).flatMap(([requestId, aggregate]) => {
    const request = requestMap.get(requestId);
    if (!request) return [];
    return [{
      ...request,
      matching_line_total: aggregate.matching_line_total,
      matching_line_count: aggregate.matching_line_count,
      matching_products: Array.from(aggregate.matching_products),
      matching_lines: aggregate.matching_lines.slice(0, 20),
    }];
  });
}

function parseBody(body: any): { action: PaymentAgentAction; term: string; exactSupplier?: PaymentRequestSearchSupplier; exactProductName?: boolean } {
  const action = String(body?.action || "") as PaymentAgentAction;
  if (!["supplier_suggestions", "material_suggestions", "supplier_search", "material_search"].includes(action)) {
    throw new Response(JSON.stringify({ error: "Unsupported action" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const term = String(body?.term || "").trim();
  if (term.length < 2) {
    throw new Response(JSON.stringify({ error: "Search term must be at least 2 characters" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (term.length > MAX_SEARCH_TERM_LENGTH) {
    throw new Response(JSON.stringify({ error: "Search term is too long" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const exactSupplier = body?.exactSupplier && typeof body.exactSupplier === "object"
    ? {
      id: String(body.exactSupplier.id || "").trim(),
      name: body.exactSupplier.name ? String(body.exactSupplier.name) : null,
      short_code: body.exactSupplier.short_code ? String(body.exactSupplier.short_code) : null,
    }
    : undefined;

  return {
    action,
    term,
    exactSupplier: exactSupplier?.id ? exactSupplier : undefined,
    exactProductName: Boolean(body?.exactProductName),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  if (req.method !== "POST") return jsonResponse(req, 405, { error: "Method not allowed" });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    await requireOwner(req, supabaseAdmin);
    const body = await req.json().catch(() => ({}));
    const { action, term, exactSupplier, exactProductName } = parseBody(body);

    if (action === "supplier_suggestions") {
      const suggestions = await searchSupplierSuggestions(supabaseAdmin, term);
      return jsonResponse(req, 200, { suggestions });
    }

    if (action === "material_suggestions") {
      const suggestions = await searchMaterialSuggestions(supabaseAdmin, term);
      return jsonResponse(req, 200, { suggestions });
    }

    if (action === "supplier_search") {
      const result = await searchPaymentRequestsBySupplier(supabaseAdmin, term, exactSupplier);
      return jsonResponse(req, 200, result);
    }

    const rows = await searchPaymentRequestsByMaterial(supabaseAdmin, term, exactProductName);
    return jsonResponse(req, 200, { rows });
  } catch (error: any) {
    if (error instanceof Response) {
      const headers = { ...getCorsHeaders(req), "Content-Type": "application/json" };
      return new Response(error.body, { status: error.status, headers });
    }

    console.error("[payment-agent-search] fatal", error);
    return jsonResponse(req, 500, { error: "Internal error" });
  }
});
