import type {
  CustomerParseContract,
  ParseContractSource,
  PoMode,
} from "./parseContractTypes";
import { PARSE_CONTRACT_VERSION } from "./parseContractTypes";

export type KbAiParseSuggestion = {
  parse_strategy: "attachment_first" | "email_body_only" | "hybrid";
  item_split_rule: string;
  location_quantity_patterns: string[];
  exchange_keywords: string[];
  exchange_rule?: {
    keywords: string[];
    pattern?: string;
  };
  quantity_formula: {
    base_field: string;
    exchange_field: string;
    total_field: string;
    expression: string;
  };
  normalization_rules: string[];
  confidence: number;
  human_summary: string;
};

const BUSINESS_DESC_START = "[KB_BUSINESS_DESCRIPTION_START]";
const BUSINESS_DESC_END = "[KB_BUSINESS_DESCRIPTION_END]";
const AI_CONFIG_START = "[KB_AI_CONFIG_START]";
const AI_CONFIG_END = "[KB_AI_CONFIG_END]";

export const extractKbBusinessDescription = (note?: string | null) => {
  const m = String(note || "").match(/\[KB_BUSINESS_DESCRIPTION_START\]([\s\S]*?)\[KB_BUSINESS_DESCRIPTION_END\]/i);
  return String(m?.[1] || "").trim();
};

export const extractKbAiConfig = (note?: string | null): KbAiParseSuggestion | null => {
  const m = String(note || "").match(/\[KB_AI_CONFIG_START\]([\s\S]*?)\[KB_AI_CONFIG_END\]/i);
  if (!m?.[1]) return null;
  try {
    const parsed = JSON.parse(String(m[1] || "{}"));
    if (!parsed || typeof parsed !== "object") return null;
    const normalized = {
      ...parsed,
      exchange_rule: parsed.exchange_rule || {
        keywords: Array.isArray(parsed.exchange_keywords) ? parsed.exchange_keywords : [],
      },
    };
    return normalized as KbAiParseSuggestion;
  } catch {
    return null;
  }
};

export const stripKbAiMarkers = (note?: string | null) =>
  String(note || "")
    .replace(/\s*\[KB_BUSINESS_DESCRIPTION_START\][\s\S]*?\[KB_BUSINESS_DESCRIPTION_END\]\s*/gi, " ")
    .replace(/\s*\[KB_AI_CONFIG_START\][\s\S]*?\[KB_AI_CONFIG_END\]\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

export const composeKbAiMarkers = (businessDescription?: string, aiConfig?: KbAiParseSuggestion | null) => {
  const parts: string[] = [];
  const desc = String(businessDescription || "").trim();
  if (desc) {
    parts.push(`${BUSINESS_DESC_START}\n${desc}\n${BUSINESS_DESC_END}`);
  }
  if (aiConfig) {
    parts.push(`${AI_CONFIG_START}\n${JSON.stringify(aiConfig)}\n${AI_CONFIG_END}`);
  }
  return parts.join("\n").trim();
};

// ---------------------------------------------------------------------------
// Bridge helpers — convert between KbAiParseSuggestion and CustomerParseContract.
// Neither helper mutates its input. Both are pure functions.
// ---------------------------------------------------------------------------

/**
 * Maps the legacy parse_strategy value to the new contract source field.
 * parse_strategy describes which input medium carries the PO data, which is
 * exactly what contract.source represents.
 */
const parseStrategyToSource = (
  strategy: KbAiParseSuggestion["parse_strategy"],
): ParseContractSource => {
  if (strategy === "attachment_first") return "attachment";
  if (strategy === "email_body_only") return "email_body";
  return "auto"; // hybrid
};

/** Reverse of parseStrategyToSource, for round-trip reconstruction. */
const sourceToParseStrategy = (
  source: ParseContractSource,
): KbAiParseSuggestion["parse_strategy"] => {
  if (source === "attachment") return "attachment_first";
  if (source === "email_body") return "email_body_only";
  return "hybrid"; // auto
};

/**
 * Derives a draft CustomerParseContract from an AI suggestion.
 * Always produces status:"draft" because human review is required before use.
 *
 * @param suggestion - The AI-generated parse suggestion.
 * @param options.po_mode - Business PO mode override. Defaults to "daily_new_po"
 *   because the AI suggestion has no knowledge of accumulation semantics.
 */
export const aiSuggestionToParseContract = (
  suggestion: KbAiParseSuggestion,
  options?: { po_mode?: PoMode },
): CustomerParseContract => {
  const exchangeKeywords =
    suggestion.exchange_rule?.keywords ?? suggestion.exchange_keywords ?? [];

  // item_split_rule from the legacy shape is often a regex or prose description.
  // Map it to the structured line_split field only when it looks like a plain
  // delimiter; otherwise fall back to the safe default "\n".
  const rawSplit = String(suggestion.item_split_rule || "").trim();
  const line_split = rawSplit && !rawSplit.includes("(") && !rawSplit.includes("[")
    ? rawSplit
    : "\n";

  return {
    version: PARSE_CONTRACT_VERSION,
    status: "draft",
    source: parseStrategyToSource(suggestion.parse_strategy),
    po_mode: options?.po_mode ?? "daily_new_po",
    email_body_config: {
      line_split,
      product_name_position: 0,
      exchange_keywords: exchangeKeywords,
      decrease_keywords: [],
      ignore_lines_containing: [],
    },
    attachment_config: {
      file_type: "auto",
      header_row: 1,
      data_start_row: 2,
      columns: null,
      totals: null,
      fallback_to_email_body: suggestion.parse_strategy !== "attachment_first",
    },
    quantity_fields: {
      base: suggestion.quantity_formula.base_field,
      exchange: suggestion.quantity_formula.exchange_field,
      compensation: "",
      decrease: "",
      formula: suggestion.quantity_formula.expression || undefined,
    },
    test_evidence: [],
    updated_at: new Date().toISOString(),
    notes: suggestion.human_summary || undefined,
  };
};

/**
 * Reconstructs a KbAiParseSuggestion from a CustomerParseContract so that
 * existing KB marker storage continues to work unchanged.
 * confidence is set to 0 because the contract is the authoritative source
 * and the numeric score is not meaningful on the round-trip.
 */
export const parseContractToAiSuggestion = (
  contract: CustomerParseContract,
): KbAiParseSuggestion => ({
  parse_strategy: sourceToParseStrategy(contract.source),
  item_split_rule: contract.email_body_config.line_split,
  location_quantity_patterns: [],
  exchange_keywords: contract.email_body_config.exchange_keywords,
  exchange_rule: {
    keywords: contract.email_body_config.exchange_keywords,
  },
  quantity_formula: {
    base_field: contract.quantity_fields.base,
    exchange_field: contract.quantity_fields.exchange,
    total_field: "",
    expression: contract.quantity_fields.formula ?? "",
  },
  normalization_rules: [],
  confidence: 0,
  human_summary: contract.notes ?? "",
});
