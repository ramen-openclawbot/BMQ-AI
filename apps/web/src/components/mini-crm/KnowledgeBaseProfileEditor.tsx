import { Brain, FileText, Loader2, Sparkles, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { KbAiParseSuggestion } from "./kbAiUtils";

type Props = {
  poTemplates: any[];
  editingCustomerId: string | null;
  editKbProfileName: string;
  editKbPoMode: string;
  editKbPoSource: string;
  editKbBusinessDescription: string;
  kbAiSuggestion: KbAiParseSuggestion | null;
  kbAiStatus: string;
  kbChangeNote: string;
  templateFileName: string;
  templateAiContext: string;
  kbAiSuggestPending: boolean;
  submitPending: boolean;
  approvePending: boolean;
  pendingCount: number;
  canApproveLatest: boolean;
  approveDisabledReason?: string;
  onKbProfileNameChange: (v: string) => void;
  onKbPoModeChange: (v: string) => void;
  onKbPoSourceChange: (v: string) => void;
  onKbBusinessDescriptionChange: (v: string) => void;
  onKbChangeNoteChange: (v: string) => void;
  onTemplateFileChange: (file: File | null) => void | Promise<void>;
  onClearTemplate: () => void | Promise<void>;
  onAiSuggest: () => void;
  onSubmitApproval: () => void;
  onApproveLatest: () => void;
};

const sectionClass = "rounded-xl border border-border/70 bg-background/70 p-4 shadow-sm";
const inputClass = "min-h-[88px] w-full rounded-lg border border-input bg-background px-3 py-2 text-sm leading-6";

export function KnowledgeBaseProfileEditor(props: Props) {
  const {
    poTemplates,
    editingCustomerId,
    editKbProfileName,
    editKbPoMode,
    editKbPoSource,
    editKbBusinessDescription,
    kbAiSuggestion,
    kbAiStatus,
    kbChangeNote,
    templateFileName,
    templateAiContext,
    kbAiSuggestPending,
    submitPending,
    approvePending,
    pendingCount,
    canApproveLatest,
    approveDisabledReason,
    onKbProfileNameChange,
    onKbPoModeChange,
    onKbPoSourceChange,
    onKbBusinessDescriptionChange,
    onKbChangeNoteChange,
    onTemplateFileChange,
    onClearTemplate,
    onAiSuggest,
    onSubmitApproval,
    onApproveLatest,
  } = props;

  const activeTemplateName = poTemplates.find((t: any) => t.customer_id === editingCustomerId)?.file_name || "Chưa có";
  const canRunAi = Boolean(editKbBusinessDescription.trim() || templateAiContext.trim());

  return (
    <div className="md:col-span-2 space-y-4 rounded-2xl border border-border/70 bg-gradient-to-br from-background via-background to-muted/30 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Brain className="h-4 w-4 text-primary" />
            Knowledge Base cho PO bán hàng
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Cấu hình cách hệ thống hiểu PO của khách hàng: nguồn dữ liệu, ngữ nghĩa business, mẫu email, và rule AI đã duyệt.
          </p>
        </div>
        <div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs text-muted-foreground">
          Pending requests: <span className="font-semibold text-foreground">{pendingCount}</span>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.05fr_1.35fr]">
        <div className="space-y-4">
          <div className={sectionClass}>
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
              <FileText className="h-4 w-4 text-primary" />
              Hồ sơ KB cơ bản
            </div>
            <div className="grid gap-3">
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Tên profile</Label>
                <Input value={editKbProfileName} onChange={(e) => onKbProfileNameChange(e.target.value)} placeholder="Ví dụ: NPP_EmailBody_CommaSegments" />
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">PO mode</Label>
                  <select className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm" value={editKbPoMode} onChange={(e) => onKbPoModeChange(e.target.value)}>
                    <option value="daily_new_po">PO mới theo ngày</option>
                    <option value="cumulative_snapshot">PO cộng dồn (delta)</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">Nguồn PO ưu tiên</Label>
                  <select className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm" value={editKbPoSource} onChange={(e) => onKbPoSourceChange(e.target.value)}>
                    <option value="attachment_first">Ưu tiên file đính kèm</option>
                    <option value="email_body_only">PO từ nội dung email</option>
                  </select>
                </div>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Chọn <b>email body only</b> nếu khách thường đặt hàng ngay trong nội dung mail, không có file đính kèm chuẩn.
              </div>
            </div>
          </div>

          <div className={sectionClass}>
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
              <FileText className="h-4 w-4 text-primary" />
              Template tham chiếu
            </div>
            <div className="space-y-3">
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Active template: <span className="font-medium text-foreground">{activeTemplateName}</span>
              </div>
              <div className="flex flex-col gap-2 lg:flex-row">
                <Input type="file" accept=".xlsx,.pdf,image/*" onChange={(e) => onTemplateFileChange(e.target.files?.[0] || null)} />
                <Button type="button" variant="outline" className="shrink-0" onClick={onClearTemplate}>Xoá mẫu</Button>
              </div>
              <div className="text-xs text-muted-foreground">
                Hỗ trợ <b>.xlsx</b>, <b>.pdf</b> và <b>ảnh</b>. File này giúp AI hiểu cấu trúc PO và cách khách hàng thường trình bày dữ liệu.
              </div>
              {templateFileName && (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                  Đã chọn mẫu mới: <b>{templateFileName}</b>
                </div>
              )}
              {templateAiContext && (
                <div className="rounded-lg border border-border/60 bg-background px-3 py-2">
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Template context cho AI</div>
                  <div className="line-clamp-4 text-sm leading-6 text-foreground/90">{templateAiContext}</div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className={sectionClass}>
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
              <Sparkles className="h-4 w-4 text-primary" />
              Ngữ cảnh business & dữ liệu mẫu
            </div>
            <div className="space-y-3">
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Mô tả business cho AI</Label>
                <textarea
                  className={inputClass}
                  value={editKbBusinessDescription}
                  onChange={(e) => onKbBusinessDescriptionChange(e.target.value)}
                  placeholder="Ví dụ: Khách gửi PO trong email body, mỗi đoạn ngăn bởi dấu phẩy là một điểm giao. Số 'đổi' phải cộng vào số lượng chính."
                />
              </div>
              <div className="rounded-lg border border-primary/15 bg-primary/5 px-3 py-2 text-sm leading-6 text-foreground/85">
                AI sẽ suy ra parse rule và công thức tính từ <b>mô tả business</b> + <b>template context</b> mà anh/chị upload. Không cần nhập tay email mẫu, calculation notes hay operational notes nữa.
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-primary/20 bg-gradient-to-br from-primary/5 via-background to-background p-4 shadow-sm">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Wand2 className="h-4 w-4 text-primary" />
                  AI Tính Toán
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  AI chỉ đề xuất rule có cấu trúc để anh/chị review. Chưa lưu thì chưa thành KB chính thức.
                </p>
              </div>
              <Button type="button" variant="default" onClick={onAiSuggest} disabled={kbAiSuggestPending || !canRunAi}>
                {kbAiSuggestPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                AI Tính Toán
              </Button>
            </div>

            {kbAiStatus && (
              <div className="mb-3 rounded-lg border border-border/60 bg-background/80 px-3 py-2 text-xs text-muted-foreground">
                {kbAiStatus}
              </div>
            )}

            {kbAiSuggestion ? (
              <div className="space-y-3 rounded-xl border border-border/70 bg-background p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium text-foreground">Đề xuất AI hiện tại</div>
                  <div className="rounded-full border border-border/70 bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground">
                    Confidence: <span className="font-semibold text-foreground">{Math.round(Number(kbAiSuggestion.confidence || 0) * 100)}%</span>
                  </div>
                </div>
                <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm leading-6 text-foreground/90">
                  {kbAiSuggestion.human_summary}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <InfoTile label="Parse strategy" value={kbAiSuggestion.parse_strategy} />
                  <InfoTile label="Split rule" value={kbAiSuggestion.item_split_rule} />
                  <InfoTile label="Exchange keywords" value={(kbAiSuggestion.exchange_keywords || []).join(", ") || "-"} wide />
                  <InfoTile label="Formula" value={kbAiSuggestion.quantity_formula?.expression || "-"} wide />
                  <InfoTile label="Patterns" value={(kbAiSuggestion.location_quantity_patterns || []).join(" • ") || "-"} wide />
                  <InfoTile label="Normalization" value={(kbAiSuggestion.normalization_rules || []).join(" • ") || "-"} wide />
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border/70 bg-background/70 px-4 py-6 text-sm text-muted-foreground">
                Chưa có đề xuất AI. Anh/chị nhập mô tả business, nội dung email mẫu hoặc template PO rồi bấm <b>AI Tính Toán</b>.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border/70 bg-muted/20 p-4">
        <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Change note</Label>
            <Input value={kbChangeNote} onChange={(e) => onKbChangeNoteChange(e.target.value)} placeholder="Mô tả thay đổi KB để gửi duyệt hoặc lưu version" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={onSubmitApproval} disabled={submitPending || !kbChangeNote.trim()}>
              Gửi duyệt KB
            </Button>
            <Button type="button" variant="secondary" onClick={onApproveLatest} disabled={approvePending || !canApproveLatest}>
              Duyệt & áp dụng KB
            </Button>
          </div>
        </div>
        {!!approveDisabledReason && (
          <div className="mt-2 text-xs text-muted-foreground">
            {approveDisabledReason}
          </div>
        )}
      </div>
    </div>
  );
}

function InfoTile({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`rounded-lg border border-border/70 bg-muted/20 px-3 py-2 ${wide ? "md:col-span-2" : ""}`}>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm leading-6 text-foreground/90">{value}</div>
    </div>
  );
}
