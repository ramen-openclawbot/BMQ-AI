import { Brain, CheckCircle2, ChevronDown, FileText, History, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  poTemplates: any[];
  editingCustomerId: string | null;
  editKbProfileName: string;
  editKbPoMode: string;
  editKbBusinessDescription: string;
  kbAiStatus: string;
  kbChangeNote: string;
  templateFileName: string;
  templateAiContext: string;
  submitPending: boolean;
  approvePending: boolean;
  pendingCount: number;
  canApproveLatest: boolean;
  approveDisabledReason?: string;
  activeKnowledgeProfile?: any | null;
  knowledgeVersionHistory?: any[];
  latestPendingRequest?: any | null;
  onKbProfileNameChange: (v: string) => void;
  onKbPoModeChange: (v: string) => void;
  onKbBusinessDescriptionChange: (v: string) => void;
  onKbChangeNoteChange: (v: string) => void;
  onTemplateFileChange: (file: File | null) => void | Promise<void>;
  onClearTemplate: () => void | Promise<void>;
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
    editKbBusinessDescription,
    kbAiStatus,
    kbChangeNote,
    templateFileName,
    templateAiContext,
    approvePending,
    pendingCount,
    canApproveLatest,
    approveDisabledReason,
    activeKnowledgeProfile,
    knowledgeVersionHistory = [],
    onKbProfileNameChange,
    onKbPoModeChange,
    onKbBusinessDescriptionChange,
    onKbChangeNoteChange,
    onTemplateFileChange,
    onClearTemplate,
    onApproveLatest,
  } = props;

  const [editorOpen, setEditorOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const activeTemplateName = poTemplates.find((t: any) => t.customer_id === editingCustomerId)?.file_name || "Chưa có";
  const latestVersion = knowledgeVersionHistory[0] || null;
  const visibleHistory = useMemo(() => knowledgeVersionHistory.slice(0, 3), [knowledgeVersionHistory]);
  const successTone = /thành công|đã duyệt|đã lưu/i.test(kbAiStatus || "");
  const errorTone = /thất bại|không thể|lỗi/i.test(kbAiStatus || "");

  return (
    <div className="md:col-span-2 space-y-4 rounded-2xl border border-border/70 bg-gradient-to-br from-background via-background to-muted/30 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Brain className="h-4 w-4 text-primary" />
            Cấu hình parse PO
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Mục tiêu: cấu hình parse, lưu mẫu và tạo version KB thật trước khi đưa sang flow sync → doanh thu.
          </p>
        </div>
        <div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs text-muted-foreground">
          Pending: <span className="font-semibold text-foreground">{pendingCount}</span>
        </div>
      </div>

      {!!kbAiStatus && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${successTone ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : errorTone ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300" : "border-border/60 bg-background/80 text-muted-foreground"}`}>
          <div className="flex items-center gap-2">
            {successTone ? <CheckCircle2 className="h-4 w-4" /> : null}
            <span>{kbAiStatus}</span>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border/70 bg-background/80 p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="text-sm font-semibold text-foreground">KB đang áp dụng</div>
            {activeKnowledgeProfile ? (
              <>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-medium text-emerald-700 dark:text-emerald-300">ACTIVE</span>
                  {latestVersion ? <span className="rounded-full border border-border/70 bg-muted/30 px-2.5 py-1">KB v{latestVersion.version_no}</span> : null}
                </div>
                <div className="text-lg font-semibold text-foreground">{activeKnowledgeProfile.profile_name || "KB hiện tại"}</div>
                <div className="grid gap-2 text-sm text-muted-foreground md:grid-cols-2">
                  <div>PO mode: <span className="font-medium text-foreground">{activeKnowledgeProfile.po_mode || "-"}</span></div>
                  <div>Template: <span className="font-medium text-foreground">{activeTemplateName}</span></div>
                </div>
              </>
            ) : (
              <div className="rounded-lg border border-dashed border-border/70 bg-background/70 px-4 py-5 text-sm text-muted-foreground">
                Khách hàng này chưa có KB active. Mở form bên dưới để tạo KB đầu tiên.
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => setHistoryOpen((v) => !v)}>
              <History className="mr-1 h-4 w-4" />
              {historyOpen ? "Ẩn lịch sử" : `Lịch sử KB${visibleHistory.length ? ` (${visibleHistory.length})` : ""}`}
            </Button>
            <Button type="button" variant="outline" onClick={() => setEditorOpen((v) => !v)}>
              <ChevronDown className={`mr-1 h-4 w-4 transition-transform ${editorOpen ? "rotate-180" : ""}`} />
              {editorOpen ? "Ẩn cấu hình" : activeKnowledgeProfile ? "Chỉnh sửa cấu hình" : "Tạo cấu hình"}
            </Button>
          </div>
        </div>
      </div>

      {historyOpen && visibleHistory.length > 0 && (
        <div className="rounded-xl border border-border/70 bg-background/80 p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <History className="h-4 w-4 text-primary" />
            Lịch sử KB gần đây
          </div>
          <div className="space-y-2">
            {visibleHistory.map((item: any, idx: number) => {
              const isCurrent = idx === 0;
              return (
                <div key={item.id || `${item.customer_id}-${item.version_no}`} className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-foreground">KB v{item.version_no}</span>
                    <span className={`text-xs ${isCurrent ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}`}>{isCurrent ? "CURRENT" : "OLD"}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">{item.change_note || item.profile_name || "-"}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {editorOpen && (
        <div className="space-y-4 rounded-xl border border-border/70 bg-muted/10 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <FileText className="h-4 w-4 text-primary" />
            Tạo version mới
          </div>

          <div className={sectionClass}>
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
              <FileText className="h-4 w-4 text-primary" />
              Bước 1 · Cấu hình parse
            </div>
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">Tên profile</Label>
                  <Input value={editKbProfileName} onChange={(e) => onKbProfileNameChange(e.target.value)} placeholder="Ví dụ: Đại lý cấp 1 - Anh Thanh Knowledge" />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">Template tham chiếu</Label>
                  <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm text-foreground/90">
                    {activeTemplateName}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-1">
                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">PO mode</Label>
                  <select className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm disabled:opacity-50 disabled:cursor-not-allowed" value={editKbPoMode} onChange={(e) => onKbPoModeChange(e.target.value)}>
                    <option value="daily_new_po">PO mới theo ngày</option>
                    <option value="cumulative_snapshot">PO cộng dồn (delta)</option>
                  </select>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Mô tả business</Label>
                <textarea
                  className={inputClass}
                  value={editKbBusinessDescription}
                  onChange={(e) => onKbBusinessDescriptionChange(e.target.value)}
                  placeholder="Ví dụ: mỗi dòng là một điểm bán, tên điểm nằm trước dấu :, ưu tiên qty_total để sản xuất"

                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Template / mẫu PO</Label>
                <div className="flex flex-col gap-2 lg:flex-row">
                  <Input type="file" accept=".xlsx,.pdf,image/*" onChange={(e) => onTemplateFileChange(e.target.files?.[0] || null)} />
                  <Button type="button" variant="outline" className="shrink-0" onClick={onClearTemplate}>Xoá mẫu</Button>
                </div>
                {templateFileName && (
                  <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                    Đã chọn mẫu mới: <b>{templateFileName}</b>
                  </div>
                )}
                {templateAiContext && (
                  <div className="rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-foreground/90 line-clamp-4">
                    {templateAiContext}
                  </div>
                )}
              </div>

            </div>
          </div>

          <div className="rounded-xl border border-border/70 bg-muted/20 p-4 space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-foreground">Bước 2 · Review & tạo version</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Sau khi tạo version thành công, hãy dùng flow sync → doanh thu để chạy hàng loạt.
                </div>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Change note</Label>
                <Input value={kbChangeNote} onChange={(e) => onKbChangeNoteChange(e.target.value)} placeholder="Mô tả thay đổi để tạo version KB mới" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" onClick={onApproveLatest} disabled={approvePending || !canApproveLatest}>
                  {approvePending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                  {approvePending ? "Đang tạo version..." : "Tạo version mới"}
                </Button>
              </div>
            </div>
            {!!approveDisabledReason && (
              <div className="text-xs text-muted-foreground">{approveDisabledReason}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
