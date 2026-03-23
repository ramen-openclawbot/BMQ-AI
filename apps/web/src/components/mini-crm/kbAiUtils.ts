export type KbAiParseSuggestion = {
  parse_strategy: "attachment_first" | "email_body_only" | "hybrid";
  item_split_rule: string;
  location_quantity_patterns: string[];
  exchange_keywords: string[];
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
    return parsed as KbAiParseSuggestion;
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
