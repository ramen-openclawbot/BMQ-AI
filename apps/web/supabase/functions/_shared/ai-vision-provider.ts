/**
 * Cấu hình nhà cung cấp AI đọc ảnh (vision/OCR) dùng chung cho mọi chức năng scan.
 *
 * - Secret SCAN_AI_PROVIDER: "deepseek" (mặc định) hoặc "openai"; giá trị khác rơi về deepseek.
 * - DeepSeek dùng secret DEEPSEEK_API_KEY và model DEEPSEEK_SCAN_MODEL (mặc định "deepseek-flash").
 * - OpenAI dùng secret OPENAI_API_KEY và model OPENAI_SCAN_MODEL (mặc định "gpt-4.1-mini").
 *
 * Endpoint/key/model chỉ được chọn ở đây; các chức năng scan không viết cứng nữa.
 * Ảnh phải nằm trong message role "user" (DeepSeek từ chối ảnh trong system).
 */

export type ScanAiProvider = "deepseek" | "openai";

export interface ScanAiConfig {
  provider: ScanAiProvider;
  endpoint: string;
  apiKey: string | undefined;
  model: string;
  keyName: "DEEPSEEK_API_KEY" | "OPENAI_API_KEY";
  /** Thêm vào body request. DeepSeek Flash mặc định bật thinking, mà thinking từ chối tool_choice bắt buộc. */
  extraBody: Record<string, unknown>;
}

export const DEEPSEEK_SCAN_ENDPOINT = "https://api.deepseek.com/chat/completions";
export const OPENAI_SCAN_ENDPOINT = "https://api.openai.com/v1/chat/completions";
export const DEEPSEEK_SCAN_DEFAULT_MODEL = "deepseek-flash";
export const OPENAI_SCAN_DEFAULT_MODEL = "gpt-4.1-mini";

/**
 * Đọc secret an toàn: sandbox không cấp quyền env (ví dụ `deno test` mặc định)
 * được coi như chưa cấu hình thay vì làm sập module.
 */
function readEnv(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

/** Chuẩn hóa provider; chỉ nhận "openai", mọi giá trị khác (kể cả rỗng/lạ) rơi về "deepseek". */
export function normalizeScanProvider(raw: string | undefined): ScanAiProvider {
  return (raw || "deepseek").trim().toLowerCase() === "openai" ? "openai" : "deepseek";
}

/**
 * SCAN_PROVIDER = (Deno.env.get('SCAN_AI_PROVIDER') || 'deepseek').trim().toLowerCase(),
 * chỉ nhận 'deepseek' hoặc 'openai'; giá trị lạ và sandbox không có quyền env rơi về deepseek.
 */
export const SCAN_PROVIDER: ScanAiProvider = (() => {
  try {
    return normalizeScanProvider((Deno.env.get("SCAN_AI_PROVIDER") || "deepseek").trim().toLowerCase());
  } catch {
    return "deepseek";
  }
})();

/** Trả endpoint, key, model và tên secret tương ứng với provider (mặc định SCAN_PROVIDER). */
export function getScanAiConfig(providerOverride?: string): ScanAiConfig {
  const provider = providerOverride === undefined
    ? SCAN_PROVIDER
    : normalizeScanProvider(providerOverride);

  if (provider === "openai") {
    return {
      provider: "openai",
      endpoint: OPENAI_SCAN_ENDPOINT,
      apiKey: readEnv("OPENAI_API_KEY"),
      model: (readEnv("OPENAI_SCAN_MODEL") || OPENAI_SCAN_DEFAULT_MODEL).trim(),
      keyName: "OPENAI_API_KEY",
      extraBody: {},
    };
  }
  return {
    provider: "deepseek",
    endpoint: DEEPSEEK_SCAN_ENDPOINT,
    apiKey: readEnv("DEEPSEEK_API_KEY"),
    model: (readEnv("DEEPSEEK_SCAN_MODEL") || DEEPSEEK_SCAN_DEFAULT_MODEL).trim(),
    keyName: "DEEPSEEK_API_KEY",
    extraBody: { thinking: { type: "disabled" } },
  };
}
