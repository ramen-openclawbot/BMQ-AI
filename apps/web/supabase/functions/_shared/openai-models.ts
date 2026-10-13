// Model đọc ảnh (vision/OCR) dùng chung cho mọi chức năng scan.
// Đổi model bằng secret OPENAI_SCAN_MODEL; để trống thì dùng mặc định.
export const OPENAI_SCAN_MODEL = (Deno.env.get("OPENAI_SCAN_MODEL") || "gpt-4.1-mini").trim();
