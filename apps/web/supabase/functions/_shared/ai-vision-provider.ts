/**
 * Cấu hình nhà cung cấp AI đọc ảnh (vision/OCR) dùng chung cho mọi chức năng scan.
 *
 * - DeepSeek là nhà cung cấp duy nhất: secret DEEPSEEK_API_KEY và model
 *   DEEPSEEK_SCAN_MODEL (mặc định "deepseek-flash").
 * - Secret SCAN_AI_PROVIDER vẫn được đọc để tương thích cấu hình cũ, nhưng mọi
 *   giá trị đều chuẩn hóa về "deepseek".
 *
 * Endpoint/key/model chỉ được chọn ở đây; các chức năng scan không viết cứng nữa.
 * Ảnh phải nằm trong message role "user" (DeepSeek từ chối ảnh trong system).
 */

export type ScanAiProvider = "deepseek";

export interface ScanAiConfig {
  provider: ScanAiProvider;
  endpoint: string;
  apiKey: string | undefined;
  model: string;
  keyName: "DEEPSEEK_API_KEY";
  /** Thêm vào body request. DeepSeek Flash mặc định bật thinking, mà thinking từ chối tool_choice bắt buộc. */
  extraBody: Record<string, unknown>;
}

export const DEEPSEEK_SCAN_ENDPOINT = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_SCAN_DEFAULT_MODEL = "deepseek-flash";

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

/** Chuẩn hóa provider; DeepSeek là lựa chọn duy nhất, mọi giá trị khác đều rơi về "deepseek". */
export function normalizeScanProvider(_raw?: string): ScanAiProvider {
  return "deepseek";
}

/**
 * SCAN_PROVIDER = (Deno.env.get('SCAN_AI_PROVIDER') || 'deepseek').trim().toLowerCase(),
 * chỉ có DeepSeek; giá trị lạ và sandbox không có quyền env rơi về deepseek.
 */
export const SCAN_PROVIDER: ScanAiProvider = (() => {
  try {
    return normalizeScanProvider((Deno.env.get("SCAN_AI_PROVIDER") || "deepseek").trim().toLowerCase());
  } catch {
    return "deepseek";
  }
})();

/** Trả endpoint, key, model và tên secret DeepSeek. */
export function getScanAiConfig(_providerOverride?: string): ScanAiConfig {
  return {
    provider: "deepseek",
    endpoint: DEEPSEEK_SCAN_ENDPOINT,
    apiKey: readEnv("DEEPSEEK_API_KEY"),
    model: (readEnv("DEEPSEEK_SCAN_MODEL") || DEEPSEEK_SCAN_DEFAULT_MODEL).trim(),
    keyName: "DEEPSEEK_API_KEY",
    extraBody: { thinking: { type: "disabled" } },
  };
}
