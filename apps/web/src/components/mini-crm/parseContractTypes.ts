/**
 * Structured, deterministic parse contract for a customer's sales PO.
 * Simpler and more explicit than KbAiParseSuggestion — intended to be
 * stored in mini_crm_knowledge_profiles.parse_contract (jsonb).
 *
 * Shape is intentionally conservative so it can be extended without
 * breaking existing stored values.
 */

export const PARSE_CONTRACT_VERSION = 1 as const;

/** Lifecycle of a contract relative to human review. */
export type ParseContractStatus = "draft" | "locked" | "deprecated";

/**
 * Which part of the incoming email carries the PO data.
 * This is the parsing *input source*, not the origin of the contract record.
 */
export type ParseContractSource = "attachment" | "email_body" | "auto";

/**
 * Business PO accumulation mode.
 * - daily_new_po: each email is a fresh, independent order.
 * - cumulative_snapshot: each email replaces/updates the running total.
 */
export type PoMode = "daily_new_po" | "cumulative_snapshot";

/** How the email body should be parsed when it is the active source. */
export type EmailBodyConfig = {
  /**
   * Delimiter or token used to split the body into individual line-items.
   * Use a literal delimiter string (e.g. "\n", ";") — not a regex.
   */
  line_split: string;
  /** Zero-based token position (within a split line) of the product name. */
  product_name_position: number;
  /** Keywords that signal an exchange / return line-item. */
  exchange_keywords: string[];
  /** Keywords that signal a decrease / reduction line-item. */
  decrease_keywords: string[];
  /** Literal substrings — lines containing any of these are skipped. */
  ignore_lines_containing: string[];
};

/** How attachments should be parsed when they are the active source. */
export type AttachmentConfig = {
  /** Expected file type to look for. "auto" means try all supported types. */
  file_type: "xlsx" | "csv" | "pdf" | "auto";
  /** 1-based row number that contains column headers. */
  header_row: number;
  /** 1-based row number where data rows begin. */
  data_start_row: number;
  /**
   * Maps semantic role names (e.g. "product", "quantity") to the actual
   * column header string found in the file. null means not yet configured.
   */
  columns: Record<string, string> | null;
  /**
   * Describes where/how totals appear in the attachment.
   * null means totals are not present or not parsed.
   */
  totals: { row_label?: string; position?: "last" | "first" } | null;
  /** Fall back to email body if no matching attachment is found. */
  fallback_to_email_body: boolean;
};

/** Mapping of semantic quantity roles to source field names. */
export type QuantityFields = {
  /** Column / label that holds the base (ordered) quantity. */
  base: string;
  /** Column / label that holds the exchange quantity (may be empty string). */
  exchange: string;
  /** Column / label that holds a compensation adjustment (may be empty string). */
  compensation: string;
  /** Column / label that holds a decrease adjustment (may be empty string). */
  decrease: string;
  /**
   * Optional arithmetic expression used to derive the final quantity.
   * e.g. "base + exchange - decrease"
   */
  formula?: string;
};

/** A single piece of evidence used to validate the contract. */
export type ParseContractEvidence = {
  /** Short label describing the test case. */
  label: string;
  /** Raw input snippet used as evidence. */
  input_snippet: string;
  /** Expected parsed output (free-form, for human review). */
  expected_output: string;
};

/** The top-level structured parse contract. */
export type CustomerParseContract = {
  /** Schema version — increment when shape changes in a breaking way. */
  version: typeof PARSE_CONTRACT_VERSION;
  status: ParseContractStatus;
  /** Which part of the email carries the PO data (input source selection). */
  source: ParseContractSource;
  /** Business PO accumulation mode. */
  po_mode: PoMode;
  email_body_config: EmailBodyConfig;
  attachment_config: AttachmentConfig;
  quantity_fields: QuantityFields;
  /** Evidence records used to validate this contract before locking. */
  test_evidence: ParseContractEvidence[];
  /** ISO-8601 timestamp of last modification. */
  updated_at: string;
  /** Optional human-readable notes about this contract version. */
  notes?: string;
};
