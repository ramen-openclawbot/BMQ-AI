import { Loader2 } from "lucide-react";
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
  editKbCalcNotes: string;
  editKbOperationalNotes: string;
  editKbBusinessDescription: string;
  editEmailBodyTemplate: string;
  kbAiSuggestion: KbAiParseSuggestion | null;
  kbAiStatus: string;
  kbChangeNote: string;
  templateFileName: string;
  templateAiContext: string;
  kbAiSuggestPending: boolean;
  submitPending: boolean;
  approvePending: boolean;
  pendingCount: number;
  onKbProfileNameChange: (v: string) => void;
  onKbPoModeChange: (v: string) => void;
  onKbPoSourceChange: (v: string) => void;
  onKbCalcNotesChange: (v: string) => void;
  onKbOperationalNotesChange: (v: string) => void;
  onKbBusinessDescriptionChange: (v: string) => void;
  onEmailBodyTemplateChange: (v: string) => void;
  onKbChangeNoteChange: (v: string) => void;
  onTemplateFileChange: (file: File | null) => void | Promise<void>;
  onClearTemplate: () => void | Promise<void>;
  onAiSuggest: () => void;
  onSubmitApproval: () => void;
  onApproveLatest: () => void;
};

export function KnowledgeBaseProfileEditor(props: Props) {
  const {
    poTemplates,
    editingCustomerId,
    editKbProfileName,
    editKbPoMode,
    editKbPoSource,
    editKbCalcNotes,
    editKbOperationalNotes,
    editKbBusinessDescription,
    editEmailBodyTemplate,
    kbAiSuggestion,
    kbAiStatus,
    kbChangeNote,
    templateFileName,
    templateAiContext,
    kbAiSuggestPending,
    submitPending,
    approvePending,
    pendingCount,
    onKbProfileNameChange,
    onKbPoModeChange,
    onKbPoSourceChange,
    onKbCalcNotesChange,
    onKbOperationalNotesChange,
    onKbBusinessDescriptionChange,
    onEmailBodyTemplateChange,
    onKbChangeNoteChange,
    onTemplateFileChange,
    onClearTemplate,
    onAiSuggest,
    onSubmitApproval,
    onApproveLatest,
  } = props;

  return (
    <div className="space-y-2 md:col-span-2 rounded-md border p-3">
      <Label>Knowledge Base Profile</Label>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Tên profile</Label>
          <Input value={editKbProfileName} onChange={(e) => onKbProfileNameChange(e.target.value)} placeholder="Ví dụ: Vietjet_PO_Standard" />
        </div>
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">PO mode</Label>
          <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={editKbPoMode} onChange={(e) => onKbPoModeChange(e.target.value)}>
            <option value="daily_new_po">PO mới theo ngày</option>
            <option value="cumulative_snapshot">PO cộng dồn (delta)</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Nguồn PO ưu tiên</Label>
          <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={editKbPoSource} onChange={(e) => onKbPoSourceChange(e.target.value)}>
            <option value="attachment_first">Ưu tiên file đính kèm</option>
            <option value="email_body_only">PO từ nội dung email</option>
          </select>
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label className="text-xs text-muted-foreground">Calculation notes</Label>
          <textarea className="min-h-[72px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={editKbCalcNotes} onChange={(e) => onKbCalcNotesChange(e.target.value)} placeholder="Ví dụ: qty_total = qty_base + qty_exchange; round half up 2 digits" />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label className="text-xs text-muted-foreground">Operational notes</Label>
          <textarea className="min-h-[72px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={editKbOperationalNotes} onChange={(e) => onKbOperationalNotesChange(e.target.value)} placeholder="Ví dụ: khách gửi email body, mỗi điểm giao cách nhau bằng dấu phẩy" />
        </div>
        <div className="space-y-2 md:col-span-2 rounded-md border p-3">
          <Label>Mẫu PO (.xlsx / .pdf / ảnh)</Label>
          <div className="text-xs">Active: {(poTemplates.find((t: any) => t.customer_id === editingCustomerId)?.file_name) || "Chưa có"}</div>
          <div className="flex gap-2">
            <Input type="file" accept=".xlsx,.pdf,image/*" onChange={(e) => onTemplateFileChange(e.target.files?.[0] || null)} />
            <Button type="button" variant="outline" onClick={onClearTemplate}>Xoá mẫu</Button>
          </div>
          {templateFileName && <div className="text-xs text-muted-foreground">Đã xác nhận mẫu mới: {templateFileName}</div>}
          {templateAiContext && <div className="text-xs text-muted-foreground line-clamp-3">Template context cho AI: {templateAiContext.slice(0, 240)}{templateAiContext.length > 240 ? "…" : ""}</div>}
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label className="text-xs text-muted-foreground">Mô tả business cho AI</Label>
          <textarea className="min-h-[96px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={editKbBusinessDescription} onChange={(e) => onKbBusinessDescriptionChange(e.target.value)} placeholder="Ví dụ: Khách hàng gửi PO qua email body, không có file đính kèm. Mỗi đoạn ngăn bởi dấu phẩy là một điểm giao. Số 'đổi' phải cộng vào số lượng chính." />
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label className="text-xs text-muted-foreground">Mẫu nội dung PO từ email (copy/paste)</Label>
          <textarea className="min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={editEmailBodyTemplate} onChange={(e) => onEmailBodyTemplateChange(e.target.value)} placeholder="Dán mẫu email PO để hệ thống lưu trong KB và tham chiếu khi parse body email." />
        </div>
        <div className="space-y-2 md:col-span-2 rounded-md border p-3 bg-muted/20">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <Label className="text-sm">AI Tính Toán</Label>
              <div className="text-xs text-muted-foreground">AI chỉ đề xuất rule có cấu trúc để anh/chị review, không tự động áp dụng nếu chưa lưu.</div>
            </div>
            <Button type="button" variant="outline" onClick={onAiSuggest} disabled={kbAiSuggestPending || (!editKbBusinessDescription.trim() && !editEmailBodyTemplate.trim() && !templateAiContext.trim())}>
              {kbAiSuggestPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              AI Tính Toán
            </Button>
          </div>
          {kbAiStatus && <div className="text-xs text-muted-foreground">{kbAiStatus}</div>}
          {kbAiSuggestion && (
            <div className="space-y-2 rounded-md border bg-background p-3 text-sm">
              <div><b>Tóm tắt AI:</b> {kbAiSuggestion.human_summary}</div>
              <div className="grid gap-2 md:grid-cols-2">
                <div><b>Parse strategy:</b> {kbAiSuggestion.parse_strategy}</div>
                <div><b>Confidence:</b> {Math.round(Number(kbAiSuggestion.confidence || 0) * 100)}%</div>
                <div className="md:col-span-2"><b>Split rule:</b> {kbAiSuggestion.item_split_rule}</div>
                <div className="md:col-span-2"><b>Patterns:</b> {(kbAiSuggestion.location_quantity_patterns || []).join(" • ") || "-"}</div>
                <div className="md:col-span-2"><b>Exchange keywords:</b> {(kbAiSuggestion.exchange_keywords || []).join(", ") || "-"}</div>
                <div className="md:col-span-2"><b>Formula:</b> {kbAiSuggestion.quantity_formula?.expression || "-"}</div>
                <div className="md:col-span-2"><b>Normalization:</b> {(kbAiSuggestion.normalization_rules || []).join(" • ") || "-"}</div>
              </div>
            </div>
          )}
        </div>
        <div className="space-y-2 md:col-span-2">
          <Label className="text-xs text-muted-foreground">Change note (bắt buộc khi gửi duyệt)</Label>
          <Input value={kbChangeNote} onChange={(e) => onKbChangeNoteChange(e.target.value)} placeholder="Mô tả thay đổi rule/profile" />
        </div>
        <div className="md:col-span-2 flex items-center justify-between gap-2 flex-wrap rounded-md bg-muted/30 p-2">
          <div className="text-xs text-muted-foreground">Pending requests: {pendingCount}</div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onSubmitApproval} disabled={submitPending || !kbChangeNote.trim()}>Gửi duyệt KB</Button>
            <Button type="button" variant="secondary" onClick={onApproveLatest} disabled={approvePending}>Duyệt & áp dụng KB</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
