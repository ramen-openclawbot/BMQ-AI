import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import {
  CEO_CASH_MAX_AMOUNT,
  CEO_CASH_UNMAPPED_CATEGORY,
  normalizeCeoCashExpenseOcr,
} from "../_shared/ceo-cash-expense.ts";
import {
  matchInvoiceSupplier,
  type SupplierAliasRow,
  type SupplierLite,
} from "../_shared/invoice-supplier-match.ts";

// Untyped database schema: the generated types are not shared with edge functions.
// deno-lint-ignore no-explicit-any
type AdminClient = ReturnType<typeof createClient<any>>;

const UNC_BUCKET = "payment-unc";
const CASH_OBJECT_PREFIX = "ceo-cash";
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const jsonResponse = (req: Request, status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });

const structuredError = (req: Request, status: number, code: string, detail?: string) =>
  jsonResponse(req, status, { success: false, error: code, code, detail });

async function requireOwner(
  req: Request,
  supabaseAdmin: AdminClient,
): Promise<{ id: string } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return structuredError(req, 401, "not_owner", "missing_authorization");
  }
  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return structuredError(req, 401, "not_owner", "invalid_token");

  const { data: roles, error: roleError } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id);
  if (roleError) return structuredError(req, 500, "role_lookup_failed");
  if (!(roles || []).some((row: { role?: string | null }) => row.role === "owner")) {
    return structuredError(req, 403, "not_owner", "owner_role_required");
  }
  return { id: user.id };
}

const decodeBase64 = (input: string): Uint8Array => {
  const raw = input.startsWith("data:") && input.includes(",")
    ? input.slice(input.indexOf(",") + 1)
    : input;
  const binary = atob(raw.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const vietnamYearMonth = (date: Date): { year: string; month: string } => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const valueOf = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";
  return { year: valueOf("year"), month: valueOf("month") };
};

const asTrimmed = (value: unknown): string => String(value ?? "").trim();

interface DraftRow {
  id: string;
  file_sha256: string;
  storage_path: string;
  status: string;
  ocr_json: unknown;
  ocr_error: string | null;
  payee_name: string | null;
  matched_supplier_id: string | null;
  expense_date: string | null;
  amount: number | null;
  description: string | null;
  cost_category_code: string | null;
  items: unknown;
  payment_request_id: string | null;
  payment_id: string | null;
}

const toDraft = (row: DraftRow, matchedSupplierName: string | null = null) => ({
  id: row.id,
  file_sha256: row.file_sha256,
  storage_path: row.storage_path,
  status: row.status,
  payee_name: row.payee_name,
  matched_supplier_id: row.matched_supplier_id,
  matched_supplier_name: matchedSupplierName,
  expense_date: row.expense_date,
  amount: row.amount,
  description: row.description,
  cost_category_code: row.cost_category_code,
  items: Array.isArray(row.items) ? row.items : [],
  ocr_error: row.ocr_error,
  payment_request_id: row.payment_request_id,
  payment_id: row.payment_id,
});

const loadActiveCategories = async (supabaseAdmin: AdminClient): Promise<string[]> => {
  const { data, error } = await supabaseAdmin
    .from("cost_categories")
    .select("code,sort_order")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("[ceo-cash-expense-scan] category load failed", error.message);
    return [CEO_CASH_UNMAPPED_CATEGORY];
  }
  const codes = (data || [])
    .map((row: { code?: string | null }) => String(row.code || "").trim())
    .filter(Boolean);
  if (!codes.includes(CEO_CASH_UNMAPPED_CATEGORY)) codes.push(CEO_CASH_UNMAPPED_CATEGORY);
  return codes;
};

interface CashExpenseOcrExtras {
  payeeName?: unknown;
  expenseDate?: unknown;
  amount?: unknown;
  description?: unknown;
  costCategory?: unknown;
  items?: unknown;
  [key: string]: unknown;
}

const callCashExpenseOcr = async (
  imageBase64: string,
  mimeType: string,
  allowedCategories: string[],
): Promise<CashExpenseOcrExtras> => {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("missing_openai_api_key");

  const categoryList = allowedCategories.length
    ? allowedCategories.join(", ")
    : CEO_CASH_UNMAPPED_CATEGORY;

  const systemPrompt = `Bạn là chuyên gia đọc chứng từ CHI TIỀN MẶT bán lẻ ở Việt Nam (phiếu chi, hoá đơn bán lẻ, biên nhận, giấy viết tay).

Trích xuất:
1. payee_name: tên người/đơn vị nhận tiền (không lấy số điện thoại/tài khoản).
2. expense_date: ngày chi, định dạng YYYY-MM-DD nếu đọc được.
3. total_amount: tổng số tiền thực chi, dạng SỐ NGUYÊN VND (bỏ dấu phân cách). Ví dụ "1.250.000" => 1250000.
4. description: nội dung chi ngắn gọn.
5. items: các dòng hàng/dịch vụ nhìn thấy, mỗi dòng gồm product_name, quantity, unit, unit_price, line_total, cost_category_code.
6. cost_category_code: nhóm chi phí cho cả phiếu; chỉ được chọn trong danh sách: ${categoryList}.

Quy tắc quan trọng:
- total_amount là tổng tiền mặt đã chi, KHÔNG lấy số điện thoại, số chứng từ, ngày tháng, số dư.
- Mỗi cost_category_code (của phiếu và của từng dòng) CHỈ được nằm trong danh sách trên. Nếu không chắc, dùng ${CEO_CASH_UNMAPPED_CATEGORY}.
- Nếu ảnh mờ hoặc không đọc được, vẫn trả total_amount = 0 và description mô tả ngắn.
- Không bịa thêm dòng hàng không có trên ảnh.

Trả về qua tool call.`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}`,
                detail: "high",
              },
            },
            { type: "text", text: "Đọc chứng từ chi tiền mặt này và trả về đúng schema." },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "extract_cash_expense",
            description: "Extract retail Vietnam cash-expense voucher fields from an image",
            parameters: {
              type: "object",
              properties: {
                payee_name: { type: ["string", "null"] },
                expense_date: { type: ["string", "null"] },
                total_amount: { type: ["number", "string", "null"] },
                description: { type: ["string", "null"] },
                cost_category_code: { type: ["string", "null"] },
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      product_name: { type: "string" },
                      quantity: { type: ["number", "string", "null"] },
                      unit: { type: ["string", "null"] },
                      unit_price: { type: ["number", "string", "null"] },
                      line_total: { type: ["number", "string", "null"] },
                      cost_category_code: { type: ["string", "null"] },
                    },
                    required: ["product_name"],
                  },
                },
              },
              required: ["total_amount"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "extract_cash_expense" } },
      max_tokens: 1500,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error("[ceo-cash-expense-scan] OpenAI error", response.status, body.slice(0, 240));
    throw new Error(`openai_http_${response.status}`);
  }

  const payload = await response.json();
  const toolCall = payload.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.function?.name !== "extract_cash_expense") {
    throw new Error("ocr_tool_call_missing");
  }
  try {
    return JSON.parse(toolCall.function.arguments || "{}") as CashExpenseOcrExtras;
  } catch {
    throw new Error("ocr_arguments_invalid_json");
  }
};

const loadSuppliers = async (supabaseAdmin: AdminClient): Promise<SupplierLite[]> => {
  const { data, error } = await supabaseAdmin
    .from("suppliers")
    .select("id,name")
    .order("name", { ascending: true })
    .limit(1000);
  if (error) {
    console.error("[ceo-cash-expense-scan] supplier load failed", error.message);
    return [];
  }
  return (data || [])
    .map((row: { id?: unknown; name?: unknown }) => ({
      id: String(row.id || ""),
      name: String(row.name || "").trim(),
    }))
    .filter((row) => row.id && row.name);
};

const loadAliases = async (supabaseAdmin: AdminClient): Promise<SupplierAliasRow[]> => {
  const { data, error } = await supabaseAdmin
    .from("supplier_aliases")
    .select("id,supplier_id,alias_text,alias_key,active")
    .eq("active", true)
    .limit(500);
  if (error) {
    console.error("[ceo-cash-expense-scan] alias load failed", error.message);
    return [];
  }
  return (data || []) as SupplierAliasRow[];
};

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  if (req.method !== "POST") return structuredError(req, 405, "method_not_allowed");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return structuredError(req, 500, "server_misconfigured");
  }

  const supabaseAdmin: AdminClient = createClient<any>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const owner = await requireOwner(req, supabaseAdmin);
  if (owner instanceof Response) return owner;

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return structuredError(req, 400, "invalid_json");
  }

  const imageBase64 = asTrimmed(body.image_base64 || body.imageBase64);
  if (!imageBase64) return structuredError(req, 400, "image_required");

  const mimeType = asTrimmed(body.mime_type || body.mimeType) || "image/jpeg";
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    return structuredError(req, 400, "invalid_image_type");
  }
  if (imageBase64.length > 10 * 1024 * 1024) {
    return structuredError(req, 400, "image_too_large");
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(imageBase64);
  } catch {
    return structuredError(req, 400, "invalid_image_encoding");
  }

  const fileSha256 = await sha256Hex(bytes);
  const { year, month } = vietnamYearMonth(new Date());
  const extension = MIME_EXTENSIONS[mimeType] || "jpg";
  const objectPath = `${CASH_OBJECT_PREFIX}/${year}/${month}/${fileSha256}.${extension}`;
  const storagePath = `${UNC_BUCKET}/${objectPath}`;

  // Duplicate image: return the existing draft/recorded row without re-running OCR.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("ceo_cash_expense_drafts")
    .select("*")
    .eq("file_sha256", fileSha256)
    .in("status", ["draft", "recorded"])
    .maybeSingle();
  if (existingError) {
    console.error("[ceo-cash-expense-scan] duplicate lookup failed", existingError.message);
    return structuredError(req, 500, "draft_lookup_failed");
  }
  if (existing) {
    return jsonResponse(req, 200, {
      success: true,
      duplicate: true,
      draft: toDraft(existing as DraftRow),
    });
  }

  const { error: uploadError } = await supabaseAdmin.storage
    .from(UNC_BUCKET)
    .upload(objectPath, bytes, { contentType: mimeType, upsert: true });
  if (uploadError) {
    console.error("[ceo-cash-expense-scan] upload failed", uploadError.message);
    return structuredError(req, 500, "upload_failed");
  }

  const allowedCategories = await loadActiveCategories(supabaseAdmin);

  let ocrError: string | null = null;
  let normalized = normalizeCeoCashExpenseOcr(null, allowedCategories);
  try {
    const raw = await callCashExpenseOcr(imageBase64, mimeType, allowedCategories);
    normalized = normalizeCeoCashExpenseOcr(raw, allowedCategories);
  } catch (error) {
    ocrError = error instanceof Error ? error.message : "ocr_failed";
    console.error("[ceo-cash-expense-scan] OCR failed", ocrError);
  }

  let matchedSupplierId: string | null = null;
  let matchedSupplierName: string | null = null;
  if (!ocrError && normalized.payee_name) {
    const [suppliers, aliases] = await Promise.all([
      loadSuppliers(supabaseAdmin),
      loadAliases(supabaseAdmin),
    ]);
    const supplierMatch = await matchInvoiceSupplier({
      scannedSupplierName: normalized.payee_name,
      aliases,
      suppliers,
      resolveSupplier: async (supplierId) => {
        const fromList = suppliers.find((supplier) => supplier.id === supplierId);
        if (fromList) return fromList;
        const { data } = await supabaseAdmin
          .from("suppliers")
          .select("id,name")
          .eq("id", supplierId)
          .maybeSingle();
        return data
          ? { id: String((data as { id?: unknown }).id), name: String((data as { name?: unknown }).name || "") }
          : null;
      },
    });
    if (supplierMatch) {
      matchedSupplierId = supplierMatch.id;
      matchedSupplierName = supplierMatch.name;
    }
  }

  const insertPayload = {
    file_sha256: fileSha256,
    storage_path: storagePath,
    status: "draft",
    ocr_json: ocrError ? null : normalized,
    ocr_error: ocrError,
    payee_name: ocrError ? null : normalized.payee_name,
    matched_supplier_id: matchedSupplierId,
    expense_date: ocrError ? null : normalized.expense_date,
    amount: ocrError || normalized.amount <= 0 ? null : normalized.amount,
    description: ocrError ? null : (normalized.description || null),
    cost_category_code: ocrError ? null : normalized.cost_category_code,
    items: ocrError ? [] : normalized.items,
    created_by: owner.id,
  };

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("ceo_cash_expense_drafts")
    .insert(insertPayload)
    .select("*")
    .single();

  if (insertError) {
    // Concurrent upload of the same image: the unique partial index wins and we
    // return the winner instead of failing.
    if ((insertError as { code?: string }).code === "23505") {
      const { data: raced } = await supabaseAdmin
        .from("ceo_cash_expense_drafts")
        .select("*")
        .eq("file_sha256", fileSha256)
        .in("status", ["draft", "recorded"])
        .maybeSingle();
      if (raced) {
        return jsonResponse(req, 200, {
          success: true,
          duplicate: true,
          draft: toDraft(raced as DraftRow),
        });
      }
    }
    console.error("[ceo-cash-expense-scan] draft insert failed", insertError.message);
    return structuredError(req, 500, "draft_save_failed");
  }

  return jsonResponse(req, 200, {
    success: true,
    duplicate: false,
    draft: toDraft(inserted as DraftRow, matchedSupplierName),
  });
});
