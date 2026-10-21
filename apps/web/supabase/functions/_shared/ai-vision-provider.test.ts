import {
  DEEPSEEK_SCAN_DEFAULT_MODEL,
  DEEPSEEK_SCAN_ENDPOINT,
  SCAN_PROVIDER,
  getScanAiConfig,
  normalizeScanProvider,
} from "./ai-vision-provider.ts";

function assertEqual<T>(actual: T, expected: T, message = "values differ"): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test("DeepSeek là provider duy nhất khi không cấu hình SCAN_AI_PROVIDER", () => {
  assertEqual(SCAN_PROVIDER, "deepseek");
  const config = getScanAiConfig();
  assertEqual(config.provider, "deepseek");
  assertEqual(config.endpoint, DEEPSEEK_SCAN_ENDPOINT);
  assertEqual(config.keyName, "DEEPSEEK_API_KEY");
  assertEqual(config.model, DEEPSEEK_SCAN_DEFAULT_MODEL);
});

Deno.test("mọi giá trị provider cũ đều rơi về deepseek", () => {
  for (const raw of ["openai", "OPENAI", "gemini", "  GeMiNi  ", "", "claude"]) {
    assertEqual(normalizeScanProvider(raw), "deepseek");
    const config = getScanAiConfig(raw);
    assertEqual(config.provider, "deepseek");
    assertEqual(config.endpoint, DEEPSEEK_SCAN_ENDPOINT);
    assertEqual(config.keyName, "DEEPSEEK_API_KEY");
    assertEqual(config.model, DEEPSEEK_SCAN_DEFAULT_MODEL);
  }
});

Deno.test("deepseek tắt thinking (để dùng tool_choice bắt buộc)", () => {
  assertEqual(JSON.stringify(getScanAiConfig().extraBody), JSON.stringify({ thinking: { type: "disabled" } }));
  assertEqual(JSON.stringify(getScanAiConfig("openai").extraBody), JSON.stringify({ thinking: { type: "disabled" } }));
});
