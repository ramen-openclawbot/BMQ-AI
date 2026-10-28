/**
 * scan-invoice model layer: cash receipt and invoice-page calls.
 *
 * Both modes are wrapped in runTextFirst so an Indra OCR read can feed
 * DeepSeek text with the same prompt/tool. The per-request supplier template,
 * cost classifier and material preview stay in index.ts and run once.
 */
import { getScanAiConfig } from "../_shared/ai-vision-provider.ts";
import { AiOpenAIError, classifyOpenAIError } from "../_shared/openai-errors.ts";
import {
  CASH_RECEIPT_SYSTEM_PROMPT,
  CASH_RECEIPT_TOOL,
  classifyCashReceiptOpenAiError,
  normalizeCashReceipt,
  type NormalizedCashReceipt,
} from "../_shared/cash-receipt-ocr.ts";
import {
  buildOcrTextUserContent,
  callDeepSeekTool,
  OCR_TEXT_SYSTEM_SUFFIX,
  runTextFirst,
  type DeepSeekToolDefinition,
  type TextFirstEngine,
} from "../_shared/text-first-extract.ts";
import type { IndraOcrEnvGetter } from "../_shared/indra-ocr.ts";

export interface InvoiceSupplierLite {
  id: string;
  name: string;
}

export interface InvoiceTemplateRow {
  supplier_name_key: string;
  template_json: Record<string, unknown> | null;
}

export interface InvoiceAliasRow {
  supplier_id: string;
  alias_text: string;
}

export interface InvoicePromptInputs {
  supplierList: InvoiceSupplierLite[];
  templates: InvoiceTemplateRow[];
  aliases: InvoiceAliasRow[];
}

export const CASH_RECEIPT_USER_PROMPT =
  "Đọc số tiền thực trả, người nhận tiền và nội dung ngắn gọn từ chứng từ chi tiền mặt này.";
export const INVOICE_USER_PROMPT = "Please extract all invoice data from this image.";

export class InvoiceExtractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InvoiceExtractError";
    this.code = code;
  }
}

const envValue = (env: IndraOcrEnvGetter | undefined, name: string, fallback: string | undefined): string =>
  String((env ? env(name) : fallback) ?? "").trim();

function requireDeepSeek(env?: IndraOcrEnvGetter): { apiKey: string; model: string; config: ReturnType<typeof getScanAiConfig> } {
  const config = getScanAiConfig();
  const apiKey = envValue(env, config.keyName, config.apiKey);
  if (!apiKey) throw new Error(`Thiếu cấu hình AI key (${config.keyName})`);
  const model = envValue(env, "DEEPSEEK_SCAN_MODEL", config.model) || config.model;
  return { apiKey, model, config };
}

/** Today's invoice prompt, including the supplier list, learned templates and aliases. */
export function buildInvoicePrompts(inputs: InvoicePromptInputs): { systemPrompt: string; userPrompt: string } {
  const supplierList = inputs.supplierList;
  const templates = inputs.templates;
  const aliases = inputs.aliases;

  const knownSuppliersPrompt = supplierList.length
    ? `Known supplier master data (choose from this list when possible):\n${supplierList
        .slice(0, 120)
        .map((s) => `- ${s.name}`)
        .join("\n")}`
    : "";

  const learnedTemplatePrompt = templates.length
    ? `Learned supplier templates from prior scans:\n${templates
        .slice(0, 20)
        .map((t) => {
          const header = String(t.template_json?.header_hint || "");
          const aliases = Array.isArray(t.template_json?.aliases) ? t.template_json?.aliases.join(", ") : "";
          const preferred = String(t.template_json?.preferred_supplier_name || "");
          return `- key=${t.supplier_name_key}; preferred=${preferred}; header_hint=${header}; aliases=${aliases}`;
        })
        .join("\n")}`
    : "";

  const systemPrompt = `You are an expert invoice/delivery-note data extractor for Vietnamese documents.

Extract the following data:
1. Invoice number (Số hóa đơn, Số HD, No., Số phiếu)
2. Invoice date (Ngày, Date) - format as YYYY-MM-DD
3. Supplier name if visible (seller/exporter company at top of document, not buyer)
4. VAT amount if present (VAT, Thuế GTGT)
5. All line items with:
   - Product code (Mã hàng, Code) if available
   - Product name (Tên hàng, Tên sản phẩm, Description)
   - Unit (Đơn vị tính, ĐVT)
   - Quantity (Số lượng, SL)
   - Unit price (Đơn giá, Giá)

Important notes:
- Prioritize seller/company logo header text for supplier_name.
- Vietnamese numbers may use comma as decimal separator.
- Extract ALL visible line items.
- CHỈ lấy quantity từ cột Số lượng/SL của bảng hàng.\n- KHÔNG lấy số trong tên hàng/quy cách (ví dụ "(25kg)" không phải quantity).\n- For quantities and prices, convert to numbers.
${knownSuppliersPrompt}
${learnedTemplatePrompt}
${aliases.length ? `Known aliases (alias => canonical supplier):\n${aliases.slice(0,150).map((a)=>`- ${a.alias_text} => ${(supplierList.find((x)=>x.id===a.supplier_id)?.name)||a.supplier_id}`).join("\n")}` : ""}`;

  return { systemPrompt, userPrompt: INVOICE_USER_PROMPT };
}

/** The function tool used by both invoice text and image requests. */
export const INVOICE_TOOL: DeepSeekToolDefinition = {
  name: "extract_invoice_data",
  description: "Extract structured invoice data from the image",
  parameters: {
    type: "object",
    properties: {
      invoice_number: { type: "string" },
      invoice_date: { type: "string" },
      supplier_name: { type: "string" },
      vat_amount: { type: "number" },
      seller_name_candidates: {
        type: "array",
        items: { type: "string" },
        description: "Danh sách tên ứng viên bên bán nhìn thấy trên phiếu",
      },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            product_code: { type: "string" },
            product_name: { type: "string" },
            unit: { type: "string" },
            quantity: { type: "number" },
            unit_price: { type: "number" },
          },
          required: ["product_name", "quantity", "unit_price"],
        },
      },
    },
    required: ["items"],
  },
};

const cashTool = CASH_RECEIPT_TOOL.function as DeepSeekToolDefinition;

export interface CashReceiptExtractOptions {
  imageBase64: string;
  mimeType?: string;
  env?: IndraOcrEnvGetter;
  fetcher?: typeof fetch;
  /** Benchmark-only engine override; never set from an HTTP request. */
  engineOverride?: "indra" | "deepseek";
}

export interface CashReceiptExtractResult {
  data: NormalizedCashReceipt | null;
  engine: TextFirstEngine;
  fallbackReason: string | null;
}

/** Today's cash-receipt image request, unchanged. */
async function extractCashFromImage(
  options: CashReceiptExtractOptions,
): Promise<NormalizedCashReceipt | null> {
  const { apiKey, model, config: scanAi } = requireDeepSeek(options.env);
  const fetcher = options.fetcher ?? fetch;

  console.log("[scan-invoice] Calling AI gateway (cash_receipt)");
  const cashResponse = await fetcher(scanAi.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      ...scanAi.extraBody,
      messages: [
        { role: "system", content: CASH_RECEIPT_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${options.mimeType || "image/jpeg"};base64,${options.imageBase64}`,
              },
            },
            {
              type: "text",
              text: CASH_RECEIPT_USER_PROMPT,
            },
          ],
        },
      ],
      tools: [CASH_RECEIPT_TOOL],
      tool_choice: { type: "function", function: { name: "extract_cash_receipt" } },
    }),
  });

  if (!cashResponse.ok) {
    const errorText = await cashResponse.text();
    const info = classifyCashReceiptOpenAiError(cashResponse.status, errorText);
    console.error(
      `[scan-invoice] AI gateway error (cash_receipt) kind=${info.kind}:`,
      cashResponse.status,
      errorText.slice(0, 300),
    );
    throw new AiOpenAIError(info);
  }

  const cashAiResponse = await cashResponse.json();
  const cashToolCall = cashAiResponse.choices?.[0]?.message?.tool_calls?.[0];
  if (!cashToolCall || cashToolCall.function?.name !== "extract_cash_receipt") {
    throw new InvoiceExtractError("model_invalid_tool", "Failed to extract cash receipt data from image");
  }

  const cashExtractedData = JSON.parse(cashToolCall.function.arguments || "{}");
  return normalizeCashReceipt(cashExtractedData);
}

export async function extractCashReceipt(
  options: CashReceiptExtractOptions,
): Promise<CashReceiptExtractResult> {
  const outcome = await runTextFirst<NormalizedCashReceipt | null>({
    label: "invoice-cash",
    images: [{ base64: options.imageBase64, mimeType: options.mimeType || "image/jpeg" }],
    textAttempt: async (ocr) => {
      const raw = await callDeepSeekTool({
        system: `${CASH_RECEIPT_SYSTEM_PROMPT}${OCR_TEXT_SYSTEM_SUFFIX}`,
        userContent: buildOcrTextUserContent(CASH_RECEIPT_USER_PROMPT, ocr),
        tool: cashTool,
        fetcher: options.fetcher,
        env: options.env,
      });
      return normalizeCashReceipt(raw) as NormalizedCashReceipt | null;
    },
    validate: (data) => (data === null ? "cash_receipt_invalid" : null),
    imageAttempt: () => extractCashFromImage(options),
    env: options.env,
    fetcher: options.fetcher,
    engineOverride: options.engineOverride,
  });

  return { data: outcome.result, engine: outcome.engine, fallbackReason: outcome.fallbackReason };
}

export interface InvoicePageExtractOptions extends InvoicePromptInputs {
  imageBase64: string;
  mimeType?: string;
  env?: IndraOcrEnvGetter;
  fetcher?: typeof fetch;
  /** Benchmark-only engine override; never set from an HTTP request. */
  engineOverride?: "indra" | "deepseek";
}

export interface InvoicePageExtractResult {
  data: Record<string, unknown>;
  engine: TextFirstEngine;
  fallbackReason: string | null;
  /** Number of pages the text read returned (1 for a normal photo). */
  ocrPageCount: number;
}

/** Today's generic invoice image request, unchanged. */
async function extractInvoiceFromImage(
  options: InvoicePageExtractOptions,
  systemPrompt: string,
): Promise<Record<string, unknown>> {
  const { apiKey, model, config: scanAi } = requireDeepSeek(options.env);
  const fetcher = options.fetcher ?? fetch;

  console.log("[scan-invoice] Calling AI gateway");
  const response = await fetcher(scanAi.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      ...scanAi.extraBody,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${options.mimeType || "image/jpeg"};base64,${options.imageBase64}`,
              },
            },
            {
              type: "text",
              text: INVOICE_USER_PROMPT,
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: INVOICE_TOOL,
        },
      ],
      tool_choice: { type: "function", function: { name: "extract_invoice_data" } },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const info = classifyOpenAIError(response.status, errorText);
    console.error(
      `[scan-invoice] AI gateway error kind=${info.kind}:`,
      response.status,
      errorText.slice(0, 300),
    );
    throw new AiOpenAIError(info);
  }

  const aiResponse = await response.json();
  const toolCall = aiResponse.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.function.name !== "extract_invoice_data") {
    throw new InvoiceExtractError("model_invalid_tool", "Failed to extract invoice data from image");
  }

  return JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
}

/** System prompt for the text-only PDF invoice extraction. */
export const INVOICE_TEXT_SYSTEM_PROMPT = `Bạn đọc hoá đơn GTGT (VAT) điện tử Việt Nam từ phần chữ đã tách khỏi file PDF.
- Chép nguyên các con số đã in; không tự tính lại, không làm tròn, không đổi thứ tự chữ số.
- Số in trên hoá đơn Việt Nam ngăn phần nghìn bằng dấu '.', ngăn phần thập phân bằng dấu ','.
- seller_name là bên bán / đơn vị phát hành hoá đơn, KHÔNG phải bên mua. "CÔNG TY CỔ PHẦN THỰC PHẨM BMQ" (MST 0311840107) là bên mua, không được trả về làm seller_name.
- invoice_date trả về đúng định dạng YYYY-MM-DD.
- Trường nào không xác định được thì trả null; không bịa số.
- lines là từng dòng hàng: name, unit, quantity, unit_price, amount, vat_rate.`;

/** Forced function tool for a text-only PDF invoice request. */
export const INVOICE_TEXT_TOOL: DeepSeekToolDefinition = {
  name: "invoice_fields",
  description: "Trả về số liệu hoá đơn GTGT đã đọc từ phần chữ của PDF",
  parameters: {
    type: "object",
    properties: {
      seller_name: { type: ["string", "null"] },
      seller_tax_code: { type: ["string", "null"] },
      buyer_tax_code: { type: ["string", "null"] },
      invoice_series: { type: ["string", "null"] },
      invoice_number: { type: ["string", "null"] },
      invoice_date: { type: ["string", "null"] },
      subtotal: { type: ["number", "null"] },
      vat_amount: { type: ["number", "null"] },
      total_amount: { type: ["number", "null"] },
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: ["string", "null"] },
            unit: { type: ["string", "null"] },
            quantity: { type: ["number", "null"] },
            unit_price: { type: ["number", "null"] },
            amount: { type: ["number", "null"] },
            vat_rate: { type: ["number", "null"] },
          },
          required: ["name", "quantity", "unit_price", "amount"],
        },
      },
    },
    required: [
      "seller_name",
      "seller_tax_code",
      "invoice_number",
      "invoice_date",
      "total_amount",
      "lines",
    ],
  },
};

export interface InvoiceTextExtractOptions {
  text: string;
  env?: IndraOcrEnvGetter;
}

/**
 * Text-only invoice read: same gateway/key/model/extraBody as
 * extractInvoicePage, but the user message is plain PDF text and the answer
 * is forced into the 'invoice_fields' tool. Never touches the image path.
 */
export async function extractInvoiceFromText(
  options: InvoiceTextExtractOptions,
): Promise<Record<string, unknown>> {
  const { apiKey, model, config: scanAi } = requireDeepSeek(options.env);

  console.log("[scan-invoice] Calling AI gateway (pdf_text)");
  const response = await fetch(scanAi.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      ...scanAi.extraBody,
      messages: [
        { role: "system", content: INVOICE_TEXT_SYSTEM_PROMPT },
        { role: "user", content: options.text },
      ],
      tools: [
        {
          type: "function",
          function: INVOICE_TEXT_TOOL,
        },
      ],
      tool_choice: { type: "function", function: { name: "invoice_fields" } },
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const info = classifyOpenAIError(response.status, errorText);
    console.error(
      `[scan-invoice] AI gateway error (pdf_text) kind=${info.kind}:`,
      response.status,
      errorText.slice(0, 300),
    );
    throw new AiOpenAIError(info);
  }

  const aiResponse = await response.json();
  const toolCall = aiResponse.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.function?.name !== "invoice_fields") {
    throw new InvoiceExtractError(
      "model_invalid_tool",
      "Failed to extract invoice data from PDF text",
    );
  }

  const rawArguments = toolCall.function.arguments;
  if (typeof rawArguments !== "string") {
    throw new InvoiceExtractError(
      "model_invalid_tool",
      "Failed to extract invoice data from PDF text",
    );
  }
  try {
    const parsed = JSON.parse(rawArguments || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new InvoiceExtractError(
      "model_invalid_tool",
      "Failed to extract invoice data from PDF text",
    );
  }
}

export async function extractInvoicePage(
  options: InvoicePageExtractOptions,
): Promise<InvoicePageExtractResult> {
  const { systemPrompt, userPrompt } = buildInvoicePrompts(options);
  let ocrPageCount = 0;

  const outcome = await runTextFirst<Record<string, unknown>>({
    label: "invoice",
    images: [{ base64: options.imageBase64, mimeType: options.mimeType || "image/jpeg" }],
    textAttempt: async (ocr) => {
      ocrPageCount = ocr.pages.length;
      return await callDeepSeekTool({
        system: `${systemPrompt}${OCR_TEXT_SYSTEM_SUFFIX}`,
        userContent: buildOcrTextUserContent(userPrompt, ocr),
        tool: INVOICE_TOOL,
        fetcher: options.fetcher,
        env: options.env,
      });
    },
    validate: (data) => {
      const items = Array.isArray(data.items) ? data.items : [];
      const invoiceNumber = String(data.invoice_number ?? "").trim();
      return items.length === 0 && !invoiceNumber ? "no_items" : null;
    },
    imageAttempt: () => extractInvoiceFromImage(options, systemPrompt),
    env: options.env,
    fetcher: options.fetcher,
    engineOverride: options.engineOverride,
  });

  return {
    data: outcome.result,
    engine: outcome.engine,
    fallbackReason: outcome.fallbackReason,
    ocrPageCount,
  };
}
