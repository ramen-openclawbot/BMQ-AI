// Mode-specific presentation copy for the cost business block.
//
// The card shows the plain document facts a human reads first (date, supplier,
// item, amount). Everything that is metadata — document number, category,
// confidence, classification source, stored rule/alias and long evidence notes —
// belongs in the collapsed "Chi tiết nguồn" panel. Explanation turns do not repeat
// the monetary card: they must lead a short, grounded statement about what the
// stored evidence can and cannot prove, and never invent a cause. The reason a row
// is "needs review" is not derivable from the absence of a stored rule, so no copy
// here links the two.
import type { CostLineBlock } from "../../lib/bmqAnalytics";

export type CostBlockLanguage = "en" | "vi";

type CostBlockLabels = {
  title: string;
  example: string;
  date: string;
  supplier: string;
  item: string;
  amount: string;
  document: string;
  category: string;
  confidence: string;
  classificationSource: string;
  rule: string;
  alias: string;
  aliasStatus: string;
  priority: string;
  ruleConfidence: string;
  openEnded: string;
  notes: string;
  source: string;
  observed: string;
  snapshot: string;
  semanticVersion: string;
  selectionRule: string;
  matchCount: string;
  truncated: string;
  followUp: string;
  followUpDisabled: string;
  openSourceHint: string;
  missing: string;
  headingNeedsReview: string;
  headingBasis: string;
  evidenceUnavailable: string;
  noCauseBasis: string;
  storedRuleLinked: string;
  statuses: Record<string, string>;
};

export const COST_BLOCK_LABELS: Record<CostBlockLanguage, CostBlockLabels> = {
  vi: {
    title: "PHIẾU CHI PHÍ",
    example: "Ví dụ xác định",
    date: "Ngày",
    supplier: "Nhà cung cấp",
    item: "Mặt hàng",
    amount: "Số tiền",
    document: "Chứng từ",
    category: "Nhóm",
    confidence: "Độ tin cậy",
    classificationSource: "Nguồn phân loại",
    rule: "Rule đã lưu",
    alias: "Ánh xạ alias",
    aliasStatus: "Trạng thái ánh xạ alias",
    priority: "ưu tiên",
    ruleConfidence: "độ tin cậy",
    openEnded: "không giới hạn",
    notes: "Ghi chú bằng chứng",
    source: "Chi tiết nguồn",
    observed: "Dữ liệu đồng bộ lúc",
    snapshot: "Bản chụp",
    semanticVersion: "Phiên bản ngữ nghĩa",
    selectionRule: "Quy tắc chọn ví dụ",
    matchCount: "Số dòng trong phạm vi",
    truncated: "Chỉ hiển thị một phần danh sách",
    followUp: "Vì sao dòng này?",
    followUpDisabled: "Chỉ dòng mới nhất trong cuộc trò chuyện mới hỏi tiếp được.",
    openSourceHint: "Mở Chi tiết nguồn để đối chiếu.",
    missing: "—",
    headingNeedsReview: "CẦN KIỂM TRA",
    headingBasis: "CĂN CỨ PHÂN LOẠI",
    evidenceUnavailable: "Chưa lấy được bằng chứng phân loại đã lưu cho dòng này; hệ thống không tự suy diễn lý do.",
    noCauseBasis: "Chưa đủ căn cứ để kết luận nguyên nhân.",
    storedRuleLinked: "Có liên kết quy tắc đã lưu; chưa đủ để kết luận nguyên nhân lịch sử.",
    statuses: { needs_review: "Cần review", suggested: "Gợi ý", approved: "Đã duyệt", rejected: "Từ chối" },
  },
  en: {
    title: "EXPENSE VOUCHER",
    example: "Deterministic example",
    date: "Date",
    supplier: "Supplier",
    item: "Item",
    amount: "Amount",
    document: "Document",
    category: "Category",
    confidence: "Confidence",
    classificationSource: "Classification source",
    rule: "Stored rule",
    alias: "Alias mapping",
    aliasStatus: "Alias mapping status",
    priority: "priority",
    ruleConfidence: "confidence",
    openEnded: "open",
    notes: "Evidence notes",
    source: "Source details",
    observed: "Synced at",
    snapshot: "Snapshot",
    semanticVersion: "Semantic version",
    selectionRule: "Example selection rule",
    matchCount: "Lines in scope",
    truncated: "Showing a partial list",
    followUp: "Why is this line?",
    followUpDisabled: "Only the newest line in this conversation can be asked about.",
    openSourceHint: "Open Source details to compare.",
    missing: "—",
    headingNeedsReview: "NEEDS REVIEW",
    headingBasis: "CLASSIFICATION BASIS",
    evidenceUnavailable: "Stored classification evidence is unavailable for this line right now; no reason was invented.",
    noCauseBasis: "Not enough evidence to conclude the cause.",
    storedRuleLinked: "A stored rule link exists; still not enough to conclude the historical cause.",
    statuses: { needs_review: "Needs review", suggested: "Suggested", approved: "Approved", rejected: "Rejected" },
  },
};

// The explanation block heading is descriptive, never a causal "why review" claim.
export function costBlockHeading(block: CostLineBlock, language: CostBlockLanguage): string {
  const labels = COST_BLOCK_LABELS[language];
  return block.line.reviewStatus === "needs_review" ? labels.headingNeedsReview : labels.headingBasis;
}

// Only a genuinely missing stored evidence record is critical enough to warn about
// above the fold; it must never be hidden inside the collapsed source panel.
export function costBlockVisibleWarning(block: CostLineBlock, language: CostBlockLanguage): string | null {
  return block.evidence.stored ? null : COST_BLOCK_LABELS[language].evidenceUnavailable;
}

// Grounded statement of what the stored evidence supports. A linked rule only
// proves a link exists in the current snapshot; it never proves what caused the
// historical classification, and a missing rule does not explain the review status.
export function costBlockExplanationSummary(block: CostLineBlock, language: CostBlockLanguage): string[] {
  const labels = COST_BLOCK_LABELS[language];
  if (block.evidence.stored && block.evidence.rule) return [labels.storedRuleLinked];
  return [labels.noCauseBasis];
}
