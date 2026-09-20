// Verified, reviewed DeepSeek pricing for the owner-only synthetic generation lane.
//
// The price is NOT invented and NOT a required env placeholder. It is taken from
// the DeepSeek OFFICIAL public documentation, which the coordinator captured
// read-only into `generated/deepseek/coordinator/pricing.txt`:
//   * the official Models & Pricing page lists `deepseek-flash`
//     (DeepSeek-V4.1-Flash) and `deepseek-v4-pro` (DeepSeek-V4-Pro-0813);
//   * prices are per 1M tokens with a peak and an off-peak tier (off-peak is half
//     of peak; peak hours are 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri);
//   * the budget uses the PEAK CACHE-MISS input rate and the PEAK output rate,
//     which is the conservative worst case for this generator;
//   * the model-switch parameter, `max_tokens`, the JSON-output request shape and
//     the usage cache-hit/cache-miss breakdown are documented on the official Chat
//     Completions API page.
//
// DeepSeek does NOT report a dollar cost; the call cost is computed from the
// usage tokens DeepSeek DOES report (see `usageCostUpperBoundUsd`). An explicit server-side
// env override is still allowed, but then its provenance is recorded honestly as
// an override instead of the official price list.
//
// No retention guarantee is claimed anywhere for DeepSeek: the docs reviewed here
// do not state one, so none is asserted.

export interface GenerationPricing {
  /** Conservative cache-MISS input price per 1k tokens (peak tier). */
  inputPer1kUsd: number;
  /** Output price per 1k tokens (peak tier). */
  outputPer1kUsd: number;
  /** Cache-HIT input price per 1k tokens (peak tier); used for reported usage only. */
  cachedInputPer1kUsd: number;
  provenance: Record<string, unknown>;
}

export const DEEPSEEK_PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing";
export const DEEPSEEK_CHAT_API_URL = "https://api-docs.deepseek.com/api/create-chat-completion";
export const DEEPSEEK_JSON_OUTPUT_URL = "https://api-docs.deepseek.com/guides/json_mode";
export const DEEPSEEK_ERROR_CODES_URL = "https://api-docs.deepseek.com/quick_start/error_codes";
export const DEEPSEEK_MODEL_LIST_URL = "https://api-docs.deepseek.com/";
export const DEEPSEEK_PRICING_SNAPSHOT = "generated/deepseek/coordinator/pricing.txt";
export const DEEPSEEK_CHAT_SNAPSHOT = "generated/deepseek/coordinator/chat.txt";
export const DEEPSEEK_PRICING_CAPTURED_AT = "2026-09-21";

/**
 * Verified peak-tier pricing copied from the official price list. Every entry
 * records its own provenance so a generated asset can never cite a price that
 * cannot be traced back to reviewed evidence.
 */
const VERIFIED_PRICING: Record<string, GenerationPricing> = {
  "deepseek-flash": {
    inputPer1kUsd: 0.0003, // peak cache miss: $0.30 / 1M
    outputPer1kUsd: 0.0012, // peak output: $1.20 / 1M
    cachedInputPer1kUsd: 0.000006, // peak cache hit: $0.006 / 1M
    provenance: {
      source: "deepseek-official-pricing",
      provider: "DeepSeek",
      modelId: "deepseek-flash",
      modelVersion: "DeepSeek-V4.1-Flash",
      pricingUrl: DEEPSEEK_PRICING_URL,
      pricingSnapshot: DEEPSEEK_PRICING_SNAPSHOT,
      chatApiUrl: DEEPSEEK_CHAT_API_URL,
      chatApiSnapshot: DEEPSEEK_CHAT_SNAPSHOT,
      capturedAt: DEEPSEEK_PRICING_CAPTURED_AT,
      billedModelParameter: "deepseek-flash",
      pricingTier: "peak",
      budgetBasis: "peak-cache-miss-input + peak-output (conservative worst case)",
      peakPer1MUsd: { cacheMissInput: 0.3, cacheHitInput: 0.006, output: 1.2 },
      offPeakPer1MUsd: { cacheMissInput: 0.15, cacheHitInput: 0.003, output: 0.6 },
      peakHoursUtc: "01:00-04:00 and 06:00-10:00, Monday-Friday",
      retention: "not asserted by the reviewed official docs",
    },
  },
  "deepseek-v4-pro": {
    inputPer1kUsd: 0.00132, // peak cache miss: $1.32 / 1M
    outputPer1kUsd: 0.00396, // peak output: $3.96 / 1M
    cachedInputPer1kUsd: 0.000044, // peak cache hit: $0.044 / 1M
    provenance: {
      source: "deepseek-official-pricing",
      provider: "DeepSeek",
      modelId: "deepseek-v4-pro",
      modelVersion: "DeepSeek-V4-Pro-0813",
      pricingUrl: DEEPSEEK_PRICING_URL,
      pricingSnapshot: DEEPSEEK_PRICING_SNAPSHOT,
      chatApiUrl: DEEPSEEK_CHAT_API_URL,
      chatApiSnapshot: DEEPSEEK_CHAT_SNAPSHOT,
      capturedAt: DEEPSEEK_PRICING_CAPTURED_AT,
      billedModelParameter: "deepseek-v4-pro",
      pricingTier: "peak",
      budgetBasis: "peak-cache-miss-input + peak-output (conservative worst case)",
      peakPer1MUsd: { cacheMissInput: 1.32, cacheHitInput: 0.044, output: 3.96 },
      offPeakPer1MUsd: { cacheMissInput: 0.66, cacheHitInput: 0.022, output: 1.98 },
      peakHoursUtc: "01:00-04:00 and 06:00-10:00, Monday-Friday",
      retention: "not asserted by the reviewed official docs",
    },
  },
};

/** The reviewed official price for a known model, else null (caller fails closed). */
export function verifiedGenerationPricing(model: string): GenerationPricing | null {
  const entry = VERIFIED_PRICING[model];
  if (!entry) return null;
  return {
    inputPer1kUsd: entry.inputPer1kUsd,
    outputPer1kUsd: entry.outputPer1kUsd,
    cachedInputPer1kUsd: entry.cachedInputPer1kUsd,
    provenance: { ...entry.provenance },
  };
}
