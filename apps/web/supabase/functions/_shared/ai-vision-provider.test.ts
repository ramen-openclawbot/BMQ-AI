import {
  DEEPSEEK_SCAN_DEFAULT_MODEL,
  DEEPSEEK_SCAN_ENDPOINT,
  OPENAI_SCAN_DEFAULT_MODEL,
  OPENAI_SCAN_ENDPOINT,
  SCAN_PROVIDER,
  getScanAiConfig,
  normalizeScanProvider,
} from "./ai-vision-provider.ts";

function assertEqual<T>(actual: T, expected: T, message = "values differ"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test("mặc định là deepseek khi không cấu hình SCAN_AI_PROVIDER", () => {
  assertEqual(SCAN_PROVIDER, "deepseek");
  const config = getScanAiConfig();
  assertEqual(config.provider, "deepseek");
  assertEqual(config.endpoint, DEEPSEEK_SCAN_ENDPOINT);
  assertEqual(config.keyName, "DEEPSEEK_API_KEY");
  assertEqual(config.model, DEEPSEEK_SCAN_DEFAULT_MODEL);
});

Deno.test("'openai' chọn đúng endpoint, key và model", () => {
  const config = getScanAiConfig("openai");
  assertEqual(config.provider, "openai");
  assertEqual(config.endpoint, OPENAI_SCAN_ENDPOINT);
  assertEqual(config.keyName, "OPENAI_API_KEY");
  assertEqual(config.model, OPENAI_SCAN_DEFAULT_MODEL);
});

Deno.test("giá trị SCAN_AI_PROVIDER lạ rơi về deepseek", () => {
  for (const raw of ["gemini", "  GeMiNi  ", "", "claude"]) {
    assertEqual(normalizeScanProvider(raw), "deepseek");
    const config = getScanAiConfig(raw);
    assertEqual(config.provider, "deepseek");
    assertEqual(config.endpoint, DEEPSEEK_SCAN_ENDPOINT);
    assertEqual(config.keyName, "DEEPSEEK_API_KEY");
    assertEqual(config.model, DEEPSEEK_SCAN_DEFAULT_MODEL);
  }
});

Deno.test("'OPENAI' viết hoa cũng nhận đúng provider openai", () => {
  assertEqual(normalizeScanProvider("OPENAI"), "openai");
  assertEqual(getScanAiConfig("  OpenAI  ").provider, "openai");
});

Deno.test("deepseek tắt thinking (để dùng tool_choice bắt buộc), openai không thêm gì", () => {
  assertEqual(JSON.stringify(getScanAiConfig("deepseek").extraBody), JSON.stringify({ thinking: { type: "disabled" } }));
  assertEqual(JSON.stringify(getScanAiConfig("openai").extraBody), "{}");
});
