// Verified, reviewed model pricing for the owner-only synthetic generation lane.
//
// The price is NOT invented and NOT a required env placeholder. It is taken from
// the Vercel AI Gateway PUBLIC model catalog that the coordinator captured
// read-only into `generated/coordinator/gateway-models.json`:
//   * model `openai/gpt-5.6-luna` EXISTS in the public catalog;
//   * its default tier is 0.0000002 USD/input token and 0.0000012 USD/output
//     token, with the long-context tier starting at 272000 tokens;
//   * the generator's hard bound (<= GENERATION_MAX_INPUT_TOKENS input + <= 12000
//     output) is far below 272000 tokens, so the default tier always applies;
//   * the catalog marks the model `zdr: "some"`, and the client still sends
//     `providerOptions.gateway.zeroDataRetention = true` on every call.
//
// An explicit server-side env override is still allowed, but then its provenance
// is recorded honestly as an override instead of the catalog.
//
// ZDR: verified catalog metadata only, no secret is read here.

export interface GenerationPricing {
  inputPer1kUsd: number;
  outputPer1kUsd: number;
  provenance: Record<string, unknown>;
}

export const GATEWAY_CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";
export const GATEWAY_CATALOG_SNAPSHOT = "generated/coordinator/gateway-models.json";
export const GATEWAY_CATALOG_CAPTURED_AT = "2026-09-21";

/**
 * Verified default-tier pricing copied from the captured public catalog. Every
 * entry records its own provenance so a generated asset can never cite a price
 * that cannot be traced back to reviewed evidence.
 */
const VERIFIED_PRICING: Record<string, GenerationPricing> = {
  "openai/gpt-5.6-luna": {
    inputPer1kUsd: 0.0002,
    outputPer1kUsd: 0.0012,
    provenance: {
      source: "vercel-ai-gateway-public-model-catalog",
      catalogUrl: GATEWAY_CATALOG_URL,
      catalogSnapshot: GATEWAY_CATALOG_SNAPSHOT,
      capturedAt: GATEWAY_CATALOG_CAPTURED_AT,
      modelId: "openai/gpt-5.6-luna",
      pricingTier: "default",
      perToken: { input: "0.0000002", output: "0.0000012" },
      longContextThresholdTokens: 272000,
      zdr: "some",
    },
  },
};

/** The reviewed catalog price for a known model, else null (caller fails closed). */
export function verifiedGenerationPricing(model: string): GenerationPricing | null {
  const entry = VERIFIED_PRICING[model];
  if (!entry) return null;
  return {
    inputPer1kUsd: entry.inputPer1kUsd,
    outputPer1kUsd: entry.outputPer1kUsd,
    provenance: { ...entry.provenance },
  };
}
