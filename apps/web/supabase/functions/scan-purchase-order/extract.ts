/**
 * scan-purchase-order model layer.
 *
 * Relative shared imports only, so node tests and the benchmark can load this
 * module without the Deno edge runtime.
 */
import { getScanAiConfig } from "../_shared/ai-vision-provider.ts";
import { AiOpenAIError, classifyOpenAIError } from "../_shared/openai-errors.ts";
import { applyNameSuffixUnits } from "../_shared/po-line-unit.ts";
import { checkScanTotals } from "../_shared/scan-total-check.ts";
import {
  buildOcrTextUserContent,
  callDeepSeekTool,
  OCR_TEXT_SYSTEM_SUFFIX,
  runTextFirst,
  type DeepSeekToolDefinition,
  type TextFirstEngine,
} from "../_shared/text-first-extract.ts";
import type { IndraOcrEnvGetter } from "../_shared/indra-ocr.ts";

export interface PurchaseOrderVatConfig {
  vat_included_in_price?: boolean;
}

export interface PurchaseOrderPromptInputs {
  supplierVatConfig?: PurchaseOrderVatConfig | null;
}

export interface PurchaseOrderPrompts {
  systemPrompt: string;
  userPrompt: string;
}

export const PURCHASE_ORDER_USER_PROMPT = "Vui lòng trích xuất tất cả dữ liệu từ đơn đặt hàng này.";

/** Today's system/user prompt, including the supplier-specific VAT instruction. */
export function buildPurchaseOrderPrompts(promptInputs: PurchaseOrderPromptInputs = {}): PurchaseOrderPrompts {
  const supplierVatConfig = promptInputs.supplierVatConfig ?? undefined;

  // Conditional VAT instruction based on supplier's learned preference
  const vatInstruction = supplierVatConfig?.vat_included_in_price
    ? `LƯU Ý QUAN TRỌNG: NCC này có giá đã bao gồm VAT. KHÔNG trích xuất dòng VAT riêng biệt. Để vat_amount = 0 hoặc null.`
    : `6. Thuế VAT nếu có (VAT, Thuế GTGT) - số tiền riêng`;

  const systemPrompt = `Bạn là chuyên gia trích xuất dữ liệu từ đơn đặt hàng (Purchase Order). Phân tích ảnh đơn đặt hàng và trích xuất tất cả thông tin liên quan.

Trích xuất các thông tin sau từ đơn đặt hàng:
1. Số đơn hàng (Số CT, Số ĐH, PO Number) - VD: "nh/9SO-006551/01-26"
2. Ngày đặt hàng (Ngày CT, Order Date) - format YYYY-MM-DD
3. Ngày giao dự kiến nếu có (Ngày giao) - format YYYY-MM-DD
4. Tên nhà cung cấp (Supplier name) - thường ở header đơn hàng
5. ${vatInstruction}
6. Tất cả các dòng sản phẩm với:
   - Mã hàng (Mã SP, Product Code)
   - Tên hàng (Tên sản phẩm, Product Name)
   - Đơn vị tính (ĐVT, Unit) - kg, g, con, thùng, chai, lon, gói, hộp, etc.
   - Số lượng (SL, Quantity)
   - Đơn giá (Unit Price)
   - Thành tiền (Line Total) nếu có
   - Ghi chú (Notes) nếu có - VD: NSX, HSD, thông tin thêm

Lưu ý quan trọng:
- Chỉ trích xuất MỘT chứng từ chính nằm giữa/rõ nhất; bỏ qua mọi tờ hóa đơn, phiếu khác lọt vào mép ảnh.
- Với hóa đơn bán lẻ in tên hàng trên một dòng và đơn giá / SL / thành tiền ở dòng ngay bên dưới, mỗi sản phẩm = dòng tên + dòng số ngay dưới nó, không ghép số của sản phẩm kế tiếp; số dòng sản phẩm trả về phải bằng số tên hàng in trên chứng từ.
- Trích Tổng tiền hàng (Cộng tiền hàng, trước VAT) vào subtotal_amount.
- Chép nguyên văn tên hàng đúng như chữ trên chứng từ; không tự đổi sang một tên vật liệu hoặc nhóm hàng khác.
- Không được suy diễn chất liệu từ công dụng hoặc hình dáng bao bì. Ví dụ: nếu chứng từ ghi "Bao bánh mì" thì phải trả đúng "Bao bánh mì", tuyệt đối không đổi thành "Bao bì nhựa".
- Đơn vị tính thường nằm trong ngoặc ở cuối tên hàng; hãy lấy đúng đơn vị đó.
- Đơn đặt hàng Việt Nam thường có chữ tiếng Việt
- Số có thể dùng dấu chấm/phẩy làm separator (VD: 1.000.000 = 1000000)
- Trích xuất TẤT CẢ các dòng sản phẩm trong bảng
- Nếu không thấy giá trị, để null hoặc chuỗi rỗng
- Chuyển số lượng và giá về dạng number (bỏ separator)
${supplierVatConfig?.vat_included_in_price ? '- NCC này có giá đã bao gồm VAT trong đơn giá, không có dòng VAT riêng' : ''}`;

  return { systemPrompt, userPrompt: PURCHASE_ORDER_USER_PROMPT };
}

/** The function tool used by both text and image requests. */
export const PURCHASE_ORDER_TOOL: DeepSeekToolDefinition = {
  name: "extract_purchase_order_data",
  description: "Trích xuất dữ liệu đơn đặt hàng từ ảnh",
  parameters: {
    type: "object",
    properties: {
      po_number: {
        type: "string",
        description: "Số đơn đặt hàng/Purchase Order number",
      },
      order_date: {
        type: "string",
        description: "Ngày đặt hàng format YYYY-MM-DD",
      },
      expected_date: {
        type: "string",
        description: "Ngày giao dự kiến format YYYY-MM-DD",
      },
      supplier_name: {
        type: "string",
        description: "Tên nhà cung cấp",
      },
      vat_amount: {
        type: "number",
        description: "Số tiền thuế VAT (VND)",
      },
      subtotal_amount: {
        type: "number",
        description: "Tổng tiền hàng trước VAT in trên chứng từ (Cộng tiền hàng / Tổng tiền hàng)",
      },
      total_amount: {
        type: "number",
        description: "Tổng tiền đơn hàng (VND)",
      },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            product_code: {
              type: "string",
              description: "Mã sản phẩm",
            },
            product_name: {
              type: "string",
              description: "Tên sản phẩm",
            },
            unit: {
              type: "string",
              description: "Đơn vị tính (kg, g, con, etc.)",
            },
            quantity: {
              type: "number",
              description: "Số lượng đặt",
            },
            unit_price: {
              type: "number",
              description: "Đơn giá (VND)",
            },
            line_total: {
              type: "number",
              description: "Thành tiền (VND)",
            },
            notes: {
              type: "string",
              description: "Ghi chú (NSX, HSD, etc.)",
            },
          },
          required: ["product_name", "quantity"],
        },
      },
      notes: {
        type: "string",
        description: "Ghi chú chung của đơn hàng",
      },
    },
    required: ["items"],
  },
};

/** The model answered with text instead of the forced PO tool call. */
export class PurchaseOrderExtractError extends Error {
  readonly kind: "not_po" | "no_tool";
  readonly details: string;

  constructor(kind: "not_po" | "no_tool", details: string) {
    super(kind === "not_po" ? "Hình ảnh không phải là đơn đặt hàng (PO)" : "Không thể trích xuất dữ liệu từ hình ảnh");
    this.name = "PurchaseOrderExtractError";
    this.kind = kind;
    this.details = details;
  }
}

export interface ExtractPurchaseOrderOptions {
  imageBase64: string;
  mimeType?: string;
  promptInputs?: PurchaseOrderPromptInputs;
  env?: IndraOcrEnvGetter;
  fetcher?: typeof fetch;
  /** Benchmark-only engine override; never set from an HTTP request. */
  engineOverride?: "indra" | "deepseek";
}

export interface ExtractPurchaseOrderResult {
  data: Record<string, unknown>;
  engine: TextFirstEngine;
  fallbackReason: string | null;
}

const warningCount = (data: Record<string, unknown>): number | null => {
  if (!Array.isArray(data.items) || data.items.length === 0) return null;
  const copy = { ...data, items: applyNameSuffixUnits(data.items as Record<string, unknown>[]) };
  return checkScanTotals(copy).warnings.length;
};

/** Today's DeepSeek image request, unchanged. */
async function extractFromImage(
  options: ExtractPurchaseOrderOptions,
  systemPrompt: string,
): Promise<Record<string, unknown>> {
  const scanAi = getScanAiConfig();
  const read = options.env;
  const apiKey = String((read ? read(scanAi.keyName) : scanAi.apiKey) ?? "").trim();
  const model = String((read ? read("DEEPSEEK_SCAN_MODEL") : "") || scanAi.model).trim();
  if (!apiKey) throw new Error(`${scanAi.keyName} is not configured`);
  const fetcher = options.fetcher ?? fetch;

  console.log("[scan-purchase-order] Calling AI gateway");
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
              text: PURCHASE_ORDER_USER_PROMPT,
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: PURCHASE_ORDER_TOOL,
        },
      ],
      tool_choice: { type: "function", function: { name: "extract_purchase_order_data" } },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const info = classifyOpenAIError(response.status, errorText);
    console.error(
      `[scan-purchase-order] AI gateway error kind=${info.kind}:`,
      response.status,
      errorText.slice(0, 300),
    );
    throw new AiOpenAIError(info);
  }

  const aiResponse = await response.json();
  const message = aiResponse.choices?.[0]?.message;
  const toolCall = message?.tool_calls?.[0];

  // If AI didn't return a tool call, it might have returned text explaining why.
  if (!toolCall || toolCall.function.name !== "extract_purchase_order_data") {
    const textContent = message?.content || "";
    console.error("[scan-purchase-order] AI did not return tool call. Response:", JSON.stringify(message));
    const lower = String(textContent).toLowerCase();
    const notPo = lower.includes("not a purchase order")
      || lower.includes("không phải")
      || lower.includes("refund")
      || lower.includes("receipt");
    throw new PurchaseOrderExtractError(notPo ? "not_po" : "no_tool", textContent || "AI không trả về dữ liệu cấu trúc");
  }

  return JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
}

export async function extractPurchaseOrder(
  options: ExtractPurchaseOrderOptions,
): Promise<ExtractPurchaseOrderResult> {
  const { systemPrompt, userPrompt } = buildPurchaseOrderPrompts(options.promptInputs);

  const outcome = await runTextFirst<Record<string, unknown>>({
    label: "purchase-order",
    images: [{ base64: options.imageBase64, mimeType: options.mimeType || "image/jpeg" }],
    textAttempt: (ocr) =>
      callDeepSeekTool({
        system: `${systemPrompt}${OCR_TEXT_SYSTEM_SUFFIX}`,
        userContent: buildOcrTextUserContent(userPrompt, ocr),
        tool: PURCHASE_ORDER_TOOL,
        fetcher: options.fetcher,
        env: options.env,
      }),
    validate: (data) => {
      const count = warningCount(data);
      if (count === null) return "no_items";
      return count > 0 ? "total_check" : null;
    },
    imageAttempt: () => extractFromImage(options, systemPrompt),
    chooseOnDoubleFailure: (textResult, imageResult) => {
      const textWarnings = warningCount(textResult) ?? Number.POSITIVE_INFINITY;
      const imageWarnings = warningCount(imageResult) ?? Number.POSITIVE_INFINITY;
      return imageWarnings < textWarnings ? "image" : "text";
    },
    env: options.env,
    fetcher: options.fetcher,
    engineOverride: options.engineOverride,
  });

  return { data: outcome.result, engine: outcome.engine, fallbackReason: outcome.fallbackReason };
}
