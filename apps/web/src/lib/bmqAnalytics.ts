import { z } from "zod";
export type AnalyticsCitation = { id: string; title: string; source: string; updated_at: string };
export const uncImageSchema = z.object({id:z.string().regex(/^[a-f0-9]{64}$/),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),declarationId:z.string().max(100),paymentStatus:z.literal("submitted_unverified")});
export type UncImage = z.infer<typeof uncImageSchema>;
// Optional structured cost-line card. Every field is re-validated here; a block
// that does not match exactly is dropped so the widget keeps rendering the
// truthful plain-text answer instead of a partially trusted card.
const nullableText = (max: number) => z.string().max(max).nullable();
const costLineRuleSchema = z.object({ name: z.string().max(200), scope: z.string().max(60), priority: z.string().max(20), confidence: z.string().max(20), effectiveFrom: nullableText(10), effectiveTo: nullableText(10) });
const costLineAliasSchema = z.object({ sourceName: z.string().max(200), standardCode: z.string().max(60), canonicalName: z.string().max(200) });
export const costLineBlockSchema = z.object({
  v: z.literal(1), kind: z.literal("cost_line"), mode: z.enum(["example", "explanation"]),
  month: z.string().regex(/^\d{4}-\d{2}$/).nullable(),
  line: z.object({
    classificationId: z.string().min(1).max(64), sourceNumber: nullableText(120), sourceDate: nullableText(10),
    supplierName: nullableText(200), productName: z.string().min(1).max(200), amount: z.number().finite(),
    categoryLabel: nullableText(200), categoryCode: nullableText(60), reviewStatus: nullableText(40),
    confidence: nullableText(20), classificationSource: nullableText(60),
  }),
  evidence: z.object({ stored: z.boolean(), rule: costLineRuleSchema.nullable(), alias: costLineAliasSchema.nullable(), aliasStatus: nullableText(60) }),
  notes: z.array(z.string().max(2000)).max(8),
  source: z.object({ name: z.string().min(1).max(300), observedAt: z.string().min(1).max(40), snapshotId: z.string().min(1).max(200), semanticVersion: z.string().min(1).max(40), selectionRule: nullableText(120), matchCount: z.number().int().nonnegative().nullable(), truncated: z.boolean(), disclaimer: z.string().max(2000) }),
  followUp: z.literal("line_explanation").nullable(),
});
export type CostLineBlock = z.infer<typeof costLineBlockSchema>;
// The signed context binding, read only for UI enablement; the raw context is
// still echoed verbatim so the server can verify its own signature.
const costContextBindingSchema = z.object({ user: z.string().min(1).max(200), conv: z.string().regex(/^[A-Za-z0-9-]{8,64}$/), exp: z.number().int().positive(), selection: z.object({ line_ref: z.string().min(1), classification_id: z.string().min(1) }).optional() });
export type AnalyticsMessage = { id: string; role: "user" | "assistant"; text: string; images?: UncImage[]; citations?: AnalyticsCitation[]; details?: string; fx?: { vndPerUsd: number; updatedAt: string; source: string } | null; customerSelection?: unknown; costContext?: unknown; costBlock?: CostLineBlock };
const analyticsResponse = z.object({
  answer: z.string().trim().min(1), requestId: z.string().min(1),
  provenance: z.object({ images:z.array(uncImageSchema).max(8).optional(), details: z.string().max(100000).optional(), fx: z.object({vndPerUsd:z.number().finite().positive(), updatedAt:z.string(), source:z.literal("https://www.exchangerate-api.com")}).nullable().optional(), customerSelection: z.unknown().optional(), costContext: z.unknown().optional(), costBlock: z.unknown().optional(), lane: z.string(), model: z.string().nullable(), queries: z.array(z.unknown()), citations: z.array(z.object({ id: z.string(), title: z.string(), source: z.string(), updated_at: z.string() })).optional(), elapsedMs: z.number().finite().nonnegative() }),
});
export function buildAnalyticsRequest(question: string, route: string, label: string, history: AnalyticsMessage[], filters: Record<string, string> = {}, language: "en" | "vi" = "vi", conversationId?: string) {
  return { language, question: question.trim(), ...(conversationId ? { conversationId } : {}), page: { route, label, filters }, history: history.slice(-6).map(({ role, text, customerSelection, costContext }) => ({ role, text: text.slice(0, 2000), ...(role === "assistant" && customerSelection !== undefined ? {customerSelection} : {}), ...(role === "assistant" && costContext !== undefined ? {costContext} : {}) })) };
}
export function parseAnalyticsResponse(data: unknown, language: "en" | "vi" = "vi") {
  const result = analyticsResponse.safeParse(data);
  if (!result.success) throw new Error(language === "en" ? "Invalid BMQ response. Please retry." : "Phản hồi BMQ chưa hợp lệ. Vui lòng thử lại.");
  // Invalid optional presentation degrades to the existing truthful text.
  const parsedBlock = result.data.provenance.costBlock === undefined ? undefined : costLineBlockSchema.safeParse(result.data.provenance.costBlock);
  return { ...result.data, provenance: { ...result.data.provenance, fx: result.data.provenance.fx as AnalyticsMessage["fx"], citations: result.data.provenance.citations as AnalyticsCitation[] | undefined, costBlock: parsedBlock?.success ? parsedBlock.data : undefined } };
}

/**
 * A cost card may only offer a "this line" follow-up when its signed context is
 * still the current conversation's, still owned by the current user, not expired,
 * and (when the card names a row) selects exactly that row. Otherwise the
 * follow-up is disabled rather than sent, so an old or mismatched card can never
 * resolve against a newer selected row.
 */
export function isBoundCostFollowUp(value: unknown, options: { userId?: string | null; conversationId?: string; now?: number; classificationId?: string }): boolean {
  const binding = costContextBindingSchema.safeParse(value);
  if (!binding.success) return false;
  if (!options.userId || binding.data.user !== options.userId) return false;
  if (!options.conversationId || binding.data.conv !== options.conversationId) return false;
  if (options.classificationId && binding.data.selection?.classification_id !== options.classificationId) return false;
  return binding.data.exp > (options.now ?? Date.now()) + 5000;
}


export async function readAnalyticsError(error: unknown, language: "en" | "vi" = "vi"): Promise<string> {
  const fallback = language === "en" ? "Could not send your question to BMQ. Please retry." : "Chưa gửi được câu hỏi tới BMQ. Vui lòng thử lại.";
  if (!error || typeof error !== "object" || !("context" in error) || !(error.context instanceof Response)) return fallback;
  try {
    const body: unknown = await error.context.clone().json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      const message = body.error.replace(/\p{Cc}/gu, " ").trim().slice(0, 500);
      if (message) return message;
    }
  } catch { /* Invalid HTTP bodies must not hide the retry guidance. */ }
  return fallback;
}
