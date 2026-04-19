import type { KbAiParseSuggestion } from "./kbAiUtils";
import { extractDeliveryDateFromSubject } from "./poDraftUtils";

export const normalizeVietnameseText = (value?: string | null) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const parseEmailBodyToProductionItems = (
  subject?: string,
  body?: string,
  aiConfig?: KbAiParseSuggestion | null,
) => {
  const rawText = String(body || "").replace(/\r/g, " ");
  const text = rawText.replace(/\s+/g, " ").trim();

  const aiExchangeKeywords =
    Array.isArray(aiConfig?.exchange_rule?.keywords) && aiConfig?.exchange_rule?.keywords.length > 0
      ? aiConfig.exchange_rule.keywords.map((x) =>
          normalizeVietnameseText(String(x || "")).replace(/\s+/g, "\\s*"),
        )
      : Array.isArray(aiConfig?.exchange_keywords) && aiConfig?.exchange_keywords.length > 0
        ? aiConfig.exchange_keywords.map((x) =>
            normalizeVietnameseText(String(x || "")).replace(/\s+/g, "\\s*"),
          )
        : ["doi", "đổi"].map((x) => normalizeVietnameseText(x).replace(/\s+/g, "\\s*"));
  const exchangePattern = String(aiConfig?.exchange_rule?.pattern || "").trim();
  const exchangeRegex = exchangePattern
    ? new RegExp(exchangePattern, "i")
    : new RegExp(
        `(?:\\+\\s*)?(?:${aiExchangeKeywords.join("|")})\\s*[:=]?\\s*([0-9]+)`,
        "i",
      );
  const formula = String(
    aiConfig?.quantity_formula?.expression || "qty_total = qty_base + qty_exchange",
  ).toLowerCase();

  const normalize = (s: string) =>
    s
      .replace(/^[-•]+\s*/, "")
      .replace(/^\d+[.)]?\s*/, "")
      .replace(/Ð/g, "Đ")
      .replace(/\bdoi\b/gi, "đổi")
      .replace(/[;]+$/g, "")
      .trim();

  const cleanNote = (s: string) =>
    String(s || "")
      .trim()
      .replace(/^[-,;.]\s*/, "")
      .replace(/[.]+$/g, "")
      .trim();

  const extractExchangeQty = (s: string) => {
    const m = String(s || "").match(exchangeRegex);
    return Number(m?.[1] || 0);
  };

  const splitSegments = (() => {
    const splitRule = String(aiConfig?.item_split_rule || "").trim();
    if (splitRule === ",") {
      return text
        .split(/\s*,\s*/)
        .map((seg) => seg.trim())
        .filter(Boolean);
    }
    if (/comma/i.test(splitRule)) {
      return text
        .split(/\s*,\s*/)
        .map((seg) => seg.trim())
        .filter(Boolean);
    }
    const matches = Array.from(text.matchAll(/(?:^|\s)(\d+)\.\s*/g));
    if (!matches.length) return [text];
    const segments: string[] = [];
    for (let i = 0; i < matches.length; i += 1) {
      const start = matches[i].index ?? 0;
      const nextStart =
        i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
      const chunk = text
        .slice(start, nextStart)
        .replace(/^\s*\d+\.\s*/, "")
        .trim();
      if (chunk) segments.push(chunk);
    }
    return segments.length ? segments : [text];
  })();

  const compiledPatterns =
    Array.isArray(aiConfig?.location_quantity_patterns) &&
    aiConfig.location_quantity_patterns.length > 0
      ? aiConfig.location_quantity_patterns
          .map((pattern) => {
            try {
              return new RegExp(pattern, "i");
            } catch {
              return null;
            }
          })
          .filter(Boolean as unknown as <T>(x: T | null) => x is T)
      : ([] as RegExp[]);

  const items: any[] = [];
  const debugSegments: any[] = [];
  const pushParsedItem = (
    locationRaw: string,
    qtyBaseRaw: any,
    noteRaw = "",
    rawSegment = "",
  ) => {
    const location = normalize(String(locationRaw || "").replace(/:$/, "")).trim();
    const qtyBase = Number(qtyBaseRaw || 0);
    const note = cleanNote(String(noteRaw || ""));
    const qtyExchange = extractExchangeQty(note || rawSegment);
    const qtyTotal = formula.includes("-")
      ? (Number.isFinite(qtyBase) ? qtyBase : 0) -
        (Number.isFinite(qtyExchange) ? qtyExchange : 0)
      : (Number.isFinite(qtyBase) ? qtyBase : 0) +
        (Number.isFinite(qtyExchange) ? qtyExchange : 0);
    if (!location) return false;
    const parsedItem = {
      sku: "",
      product_name: location,
      unit: "cái",
      qty_base: qtyBase,
      qty_exchange: qtyExchange,
      qty_total: qtyTotal,
      qty: qtyTotal,
      unit_price: 0,
      line_total: 0,
      parse_source: aiConfig ? "email_body_ai_rule" : "email_body",
      note,
      raw_segment: rawSegment || `${location} ${qtyBase}${note ? `: ${note}` : ""}`,
    };
    items.push(parsedItem);
    debugSegments.push({
      raw_segment: rawSegment,
      product_name: location,
      qty_base: qtyBase,
      qty_exchange: qtyExchange,
      qty_total: qtyTotal,
      note,
      matched: true,
    });
    return true;
  };

  for (const raw of splitSegments) {
    const line = normalize(raw);
    if (!line) continue;

    let parsed = false;
    for (const regex of compiledPatterns) {
      const m = line.match(regex);
      if (m) {
        const location = m[1] || m.groups?.location || "";
        const qtyBase = m[2] || m.groups?.qty || m.groups?.base || "0";
        const note = m[3] || m.groups?.note || raw;
        if (pushParsedItem(location, qtyBase, note, raw)) {
          parsed = true;
          break;
        }
      }
    }
    if (parsed) continue;

    let m = line.match(/^(.+?)\s+([0-9]+)\s*:\s*(.*)$/i);
    if (m) {
      if (pushParsedItem(m[1], m[2], m[3], raw)) continue;
    }

    m = line.match(/^(.+?)\s*:\s*([0-9]+)\s*(.*)$/i);
    if (m) {
      if (pushParsedItem(m[1], m[2], m[3], raw)) continue;
    }

    m = line.match(/^(.+?)\s*:\s*\(([^)]*?)\)$/i);
    if (m) {
      const inside = String(m[2] || "");
      const qtyBase = Number(inside.match(/\d+/)?.[0] || "0");
      if (pushParsedItem(m[1], qtyBase, inside, raw)) continue;
    }

    debugSegments.push({
      raw_segment: raw,
      product_name: "",
      qty_base: 0,
      qty_exchange: 0,
      qty_total: 0,
      note: "",
      matched: false,
    });
  }

  const deliveryDate = extractDeliveryDateFromSubject(subject) || null;
  const matchedCount = debugSegments.filter((x) => x.matched).length;
  const confidence = splitSegments.length > 0 ? matchedCount / splitSegments.length : 0;
  return { items, deliveryDate, aiApplied: Boolean(aiConfig), debugSegments, confidence, splitSegments };
};
