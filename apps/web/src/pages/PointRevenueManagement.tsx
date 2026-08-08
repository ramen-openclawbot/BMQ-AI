import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CalendarDays, CheckCircle2, ClipboardList, Loader2, Save, Search, ShieldCheck, Store, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import {
  detectPointRevenueIssues,
  parsePointReportDetail,
  parsePointRevenueRows,
  PointReportInventoryRow,
  PointRevenueChannel,
  PointRevenueReport,
  PointRevenueReviewStatus,
  summarizePointRevenue,
} from "@/lib/point-revenue";
import "./point-revenue-management.css";

type ReviewFilter = "all" | PointRevenueReviewStatus;
type ChannelAmounts = Record<string, number>;
type ChannelQuantities = Record<string, number>;
type ChannelNotes = Record<string, string>;

type PointRevenueAuditEntry = {
  action?: string | null;
  created_at?: string | null;
  actor_name?: string | null;
  review_status?: string | null;
  note?: string | null;
};

const todayIso = () => new Date().toISOString().slice(0, 10);
const daysAgoIso = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
};

const moneyFormatter = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });

function formatMoney(value: number) {
  return moneyFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatNumber(value: number) {
  return numberFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }).format(parsed);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function channelMark(channelCode: string) {
  const marks: Record<string, string> = {
    khach_le: "KL",
    shopeefood: "SF",
    grabfood: "GR",
    befood: "BE",
  };
  return marks[channelCode] ?? channelCode.slice(0, 2).toUpperCase();
}

function statusLabel(status: PointRevenueReviewStatus) {
  if (status === "reviewed") return "Đã kiểm tra";
  if (status === "in_review") return "Đang kiểm tra";
  return "Chờ kiểm tra";
}

function statusClass(status: PointRevenueReviewStatus) {
  if (status === "reviewed") return "pr-status pr-status--reviewed";
  if (status === "in_review") return "pr-status pr-status--in-review";
  return "pr-status pr-status--unreviewed";
}

function toAmountMap(report: PointRevenueReport | null): ChannelAmounts {
  return Object.fromEntries((report?.channels ?? []).map((channel) => [channel.channel_code, channel.effective_amount_vnd]));
}

function parseMoneyInput(value: string) {
  const normalized = value.replace(/[^0-9]/g, "");
  const parsed = Number(normalized || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recalculateInventory(rows: PointReportInventoryRow[]) {
  const breadstickSold = Math.max(0, rows.find((row) => row.product_code === "banh_mi_que")?.sold_quantity ?? 0);
  return rows.map((row) => {
    const consumed = row.consumption_is_manual
      ? Math.max(0, row.consumed_quantity)
      : Math.round(breadstickSold * row.breadstick_consumption_ratio * 1000) / 1000;
    const closing = row.opening_quantity
      + row.received_quantity
      - row.shortage_quantity
      + row.transfer_quantity
      - row.waste_quantity
      - row.returns_quantity
      - row.sold_quantity
      - consumed;
    return { ...row, consumed_quantity: consumed, closing_quantity: closing };
  });
}

function currentAmountsFor(report: PointRevenueReport | null, edits: ChannelAmounts) {
  return (report?.channels ?? []).map((channel) => ({
    ...channel,
    effective_amount_vnd: edits[channel.channel_code] ?? channel.effective_amount_vnd,
    corrected: (edits[channel.channel_code] ?? channel.effective_amount_vnd) !== channel.source_amount_vnd,
  }));
}

function usePointRevenueReviews(startDate: string, endDate: string, status: ReviewFilter) {
  return useQuery({
    queryKey: ["point-revenue-reviews", startDate, endDate, status],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_kiosk_point_revenue_reviews" as never, {
        p_start_date: startDate,
        p_end_date: endDate,
        p_location_id: null,
        p_review_status: status === "all" ? null : status,
      } as never);

      if (error) throw error;
      return parsePointRevenueRows((data ?? []) as unknown[]);
    },
  });
}

function usePointRevenueAudit(reportId: string | null) {
  return useQuery({
    queryKey: ["point-revenue-audit", reportId],
    enabled: Boolean(reportId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_kiosk_point_revenue_audit" as never, {
        p_report_id: reportId,
      } as never);
      if (error) throw error;
      return (data ?? []) as PointRevenueAuditEntry[];
    },
  });
}

function usePointReportDetail(reportId: string | null) {
  return useQuery({
    queryKey: ["point-report-detail", reportId],
    enabled: Boolean(reportId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_kiosk_point_report_detail" as never, {
        p_report_id: reportId,
      } as never);
      if (error) throw error;
      return parsePointReportDetail(data);
    },
  });
}

function ChannelEditor({
  channel,
  quantity,
  amount,
  notes,
  idPrefix,
  disabled,
  onQuantityChange,
  onAmountChange,
  onNotesChange,
}: {
  channel: PointRevenueChannel;
  quantity: number;
  amount: number;
  notes: string;
  idPrefix: string;
  disabled: boolean;
  onQuantityChange: (channelCode: string, quantity: number) => void;
  onAmountChange: (channelCode: string, amount: number) => void;
  onNotesChange: (channelCode: string, notes: string) => void;
}) {
  const delta = amount - channel.source_amount_vnd;
  const isRetail = channel.channel_code.trim().toLowerCase() === "khach_le";

  return (
    <div className="pr-channel-row" data-testid="point-report-channel-editor">
      <div className="pr-channel-main">
        <span className="pr-channel-code" aria-hidden="true">{channelMark(channel.channel_code)}</span>
        <div>
          <p className="pr-channel-name">{channel.channel_name || channel.channel_code}</p>
          {isRetail && <p className="pr-channel-qty">Khách lẻ tự tính 12.000đ × số lượng</p>}
        </div>
      </div>
      <div className="pr-channel-fields">
        <div className="pr-field-block">
          <Label htmlFor={`point-quantity-${idPrefix}-${channel.channel_code}`}>Số lượng</Label>
          <Input
            id={`point-quantity-${idPrefix}-${channel.channel_code}`}
            inputMode="decimal"
            className="pr-quantity-input"
            value={quantity}
            disabled={disabled}
            onChange={(event) => onQuantityChange(channel.channel_code, Number(event.target.value || 0))}
          />
        </div>
        <div className="pr-field-block">
          <Label htmlFor={`point-revenue-${idPrefix}-${channel.channel_code}`}>Thành tiền</Label>
          <Input
            id={`point-revenue-${idPrefix}-${channel.channel_code}`}
            inputMode="numeric"
            className="pr-amount-input"
            value={formatNumber(amount)}
            disabled={disabled || isRetail}
            onChange={(event) => onAmountChange(channel.channel_code, parseMoneyInput(event.target.value))}
          />
        </div>
        <div className="pr-field-block pr-field-block--notes">
          <Label htmlFor={`point-channel-note-${idPrefix}-${channel.channel_code}`}>Ghi chú</Label>
          <Input
            id={`point-channel-note-${idPrefix}-${channel.channel_code}`}
            value={notes}
            disabled={disabled}
            onChange={(event) => onNotesChange(channel.channel_code, event.target.value)}
          />
        </div>
        <output className={delta === 0 ? "pr-delta" : "pr-delta pr-delta--changed"}>
          {delta === 0 ? "Khớp" : `${delta > 0 ? "+" : ""}${formatMoney(delta)}`}
        </output>
      </div>
    </div>
  );
}

const INVENTORY_FIELDS: Array<{ key: keyof PointReportInventoryRow; label: string }> = [
  { key: "opening_quantity", label: "Tồn đầu" },
  { key: "received_quantity", label: "Nhập" },
  { key: "shortage_quantity", label: "Thiếu" },
  { key: "transfer_quantity", label: "Chuyển" },
  { key: "waste_quantity", label: "Hủy" },
  { key: "returns_quantity", label: "Trả" },
  { key: "sold_quantity", label: "Bán" },
  { key: "consumed_quantity", label: "Tiêu thụ" },
];

function InventoryEditor({
  rows,
  disabled,
  onChange,
}: {
  rows: PointReportInventoryRow[];
  disabled: boolean;
  onChange: (productCode: string, field: keyof PointReportInventoryRow, value: number | string) => void;
}) {
  return (
    <section className="pr-full-report-section" data-testid="point-report-inventory-editor">
      <div className="pr-section-heading">
        <div><p className="pr-eyebrow">Sửa toàn bộ phiếu</p><h3>Kho và tiêu thụ</h3></div>
        <small>Tồn cuối tự tính; sửa phiếu cũ sẽ đồng bộ tồn đầu các ngày sau.</small>
      </div>
      <div className="pr-inventory-list">
        {rows.map((row) => (
          <article className="pr-inventory-card" key={row.product_code}>
            <header><strong>{row.product_name}</strong><span>Tồn cuối: {formatNumber(row.closing_quantity)}</span></header>
            <div className="pr-inventory-grid">
              {INVENTORY_FIELDS.map((field) => {
                const derivedConsumption = field.key === "consumed_quantity" && !row.consumption_is_manual;
                return (
                  <Label key={field.key}>
                    <span>{field.label}</span>
                    <Input
                      type="number"
                      step="0.001"
                      value={String(row[field.key] ?? 0)}
                      disabled={disabled || derivedConsumption}
                      onChange={(event) => onChange(row.product_code, field.key, Number(event.target.value || 0))}
                    />
                  </Label>
                );
              })}
              <Label className="pr-inventory-note">
                <span>Ghi chú</span>
                <Input value={row.notes} disabled={disabled} onChange={(event) => onChange(row.product_code, "notes", event.target.value)} />
              </Label>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function EditorPanel({
  report,
  audit,
  amounts,
  quantities,
  channelNotes,
  inventoryRows,
  reportNotes,
  note,
  reason,
  idPrefix,
  canEdit,
  saving,
  detailLoading,
  onQuantityChange,
  onAmountChange,
  onChannelNotesChange,
  onInventoryChange,
  onReportNotesChange,
  onNoteChange,
  onReasonChange,
  onSaveDraft,
  onSaveReviewed,
}: {
  report: PointRevenueReport | null;
  audit: PointRevenueAuditEntry[];
  amounts: ChannelAmounts;
  quantities: ChannelQuantities;
  channelNotes: ChannelNotes;
  inventoryRows: PointReportInventoryRow[];
  reportNotes: string;
  note: string;
  reason: string;
  idPrefix: string;
  canEdit: boolean;
  saving: boolean;
  detailLoading: boolean;
  onQuantityChange: (channelCode: string, quantity: number) => void;
  onAmountChange: (channelCode: string, amount: number) => void;
  onChannelNotesChange: (channelCode: string, notes: string) => void;
  onInventoryChange: (productCode: string, field: keyof PointReportInventoryRow, value: number | string) => void;
  onReportNotesChange: (notes: string) => void;
  onNoteChange: (note: string) => void;
  onReasonChange: (reason: string) => void;
  onSaveDraft: () => void;
  onSaveReviewed: () => void;
}) {
  const adjustedChannels = useMemo(() => currentAmountsFor(report, amounts), [report, amounts]);
  const summary = useMemo(() => summarizePointRevenue(adjustedChannels), [adjustedChannels]);
  const issues = useMemo(() => detectPointRevenueIssues(report?.channels ?? []), [report]);

  if (!report) {
    return (
      <aside className="pr-editor pr-editor--empty" data-testid="point-revenue-editor" aria-live="polite">
        <ClipboardList className="pr-empty-icon" aria-hidden="true" />
        <h2>Chọn một báo cáo điểm bán</h2>
        <p>Workbench sẽ giữ nguồn nhân viên nhập riêng với số kế toán xác nhận trước khi lưu review.</p>
      </aside>
    );
  }

  return (
    <aside className="pr-editor" data-testid="point-revenue-editor" aria-live="polite">
      <header className="pr-editor-header">
        <div>
          <p className="pr-eyebrow">Biên bản đối soát</p>
          <h2>{report.location_name}</h2>
          <p>{formatDate(report.report_date)} · Nhân viên: {report.staff_name || "—"}</p>
        </div>
        <span className={statusClass(report.review_status)}>{statusLabel(report.review_status)}</span>
      </header>

      <section className="pr-editor-summary" aria-label="Tóm tắt số đang xác nhận">
        <div>
          <span>Nguồn nhân viên</span>
          <strong>{formatMoney(summary.source_total_vnd)}</strong>
        </div>
        <div>
          <span>Kế toán xác nhận</span>
          <strong>{formatMoney(summary.effective_total_vnd)}</strong>
        </div>
        <div>
          <span>Chênh lệch</span>
          <strong>{formatMoney(summary.correction_delta_vnd)}</strong>
        </div>
      </section>

      {issues.length > 0 && (
        <div className="pr-issue-box" role="status">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <span>{issues[0].message}</span>
        </div>
      )}

      <div className="pr-channel-list">
        {report.channels.map((channel) => (
          <ChannelEditor
            key={channel.channel_code}
            channel={channel}
            quantity={quantities[channel.channel_code] ?? channel.quantity}
            amount={amounts[channel.channel_code] ?? channel.effective_amount_vnd}
            notes={channelNotes[channel.channel_code] ?? ""}
            idPrefix={idPrefix}
            disabled={!canEdit || saving || detailLoading}
            onQuantityChange={onQuantityChange}
            onAmountChange={onAmountChange}
            onNotesChange={onChannelNotesChange}
          />
        ))}
      </div>

      <InventoryEditor rows={inventoryRows} disabled={!canEdit || saving || detailLoading} onChange={onInventoryChange} />

      <div className="pr-note-field">
        <Label htmlFor={`point-report-note-${idPrefix}`}>Ghi chú trên phiếu báo cáo</Label>
        <Textarea
          id={`point-report-note-${idPrefix}`}
          value={reportNotes}
          disabled={!canEdit || saving || detailLoading}
          onChange={(event) => onReportNotesChange(event.target.value)}
        />
      </div>

      <div className="pr-note-field">
        <Label htmlFor={`point-revenue-review-note-${idPrefix}`}>Ghi chú kiểm tra</Label>
        <Textarea
          id={`point-revenue-review-note-${idPrefix}`}
          value={note}
          disabled={!canEdit || saving}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder="Ví dụ: xác nhận theo sổ quỹ cuối ca."
        />
      </div>

      <div className="pr-note-field">
        <Label htmlFor={`point-report-edit-reason-${idPrefix}`}>Lý do chỉnh sửa</Label>
        <Input
          id={`point-report-edit-reason-${idPrefix}`}
          value={reason}
          disabled={!canEdit || saving}
          required
          maxLength={500}
          onChange={(event) => onReasonChange(event.target.value)}
          placeholder="Bắt buộc, ví dụ: sửa số tiền nhập thiếu 3 số 0."
        />
      </div>

      <div className="pr-audit-strip" aria-label="Lịch sử kiểm tra">
        <h3>Audit gần nhất</h3>
        {audit.length === 0 ? (
          <p>Chưa có lịch sử review.</p>
        ) : (
          audit.slice(0, 3).map((entry, index) => (
            <p key={`${entry.created_at ?? "audit"}-${index}`}>
              <span>{formatDateTime(entry.created_at)}</span> {entry.actor_name || "Hệ thống"} · {entry.action || entry.review_status || "kiểm tra"}
              {entry.note ? ` · ${entry.note}` : ""}
            </p>
          ))
        )}
      </div>

      <div className="pr-editor-actions">
        <Button type="button" variant="outline" onClick={onSaveDraft} disabled={!canEdit || saving || detailLoading || !reason.trim()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />} Lưu chỉnh sửa
        </Button>
        <Button type="button" onClick={onSaveReviewed} disabled={!canEdit || saving || detailLoading || !reason.trim()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="h-4 w-4" aria-hidden="true" />} Lưu & đánh dấu đã kiểm tra
        </Button>
      </div>
    </aside>
  );
}

export default function PointRevenueManagement() {
  const { canEditModule } = useAuth();
  const canEdit = canEditModule("finance_revenue");
  const queryClient = useQueryClient();
  const [startDate, setStartDate] = useState(daysAgoIso(7));
  const [endDate, setEndDate] = useState(todayIso());
  const [locationId, setLocationId] = useState("all");
  const [status, setStatus] = useState<ReviewFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileEditorOpen, setMobileEditorOpen] = useState(false);
  const [amounts, setAmounts] = useState<ChannelAmounts>({});
  const [quantities, setQuantities] = useState<ChannelQuantities>({});
  const [channelNotes, setChannelNotes] = useState<ChannelNotes>({});
  const [inventoryRows, setInventoryRows] = useState<PointReportInventoryRow[]>([]);
  const [reportNotes, setReportNotes] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");

  const { data: allReports = [], isLoading, isError, error } = usePointRevenueReviews(startDate, endDate, status);
  const reports = useMemo(
    () => locationId === "all" ? allReports : allReports.filter((report) => report.location_id === locationId),
    [allReports, locationId],
  );
  const selectedReport = reports.find((report) => report.report_id === selectedId) ?? reports[0] ?? null;
  const selectedReportId = selectedReport?.report_id ?? null;
  const selectedReviewNote = selectedReport?.review_note ?? "";
  const { data: audit = [] } = usePointRevenueAudit(selectedReportId);
  const { data: detail, isLoading: detailLoading } = usePointReportDetail(selectedReportId);

  useEffect(() => {
    if (selectedReportId && selectedReportId !== selectedId) setSelectedId(selectedReportId);
  }, [selectedReportId, selectedId]);

  useEffect(() => {
    setNote(selectedReviewNote);
    setReason("");
  }, [selectedReportId, selectedReviewNote]);

  useEffect(() => {
    if (!detail) return;
    setAmounts(Object.fromEntries(detail.channel_rows.map((channel) => [
      channel.channel_code,
      channel.channel_code.trim().toLowerCase() === "khach_le"
        ? channel.quantity * 12_000
        : channel.amount_vnd,
    ])));
    setQuantities(Object.fromEntries(detail.channel_rows.map((channel) => [channel.channel_code, channel.quantity])));
    setChannelNotes(Object.fromEntries(detail.channel_rows.map((channel) => [channel.channel_code, channel.notes])));
    setInventoryRows(recalculateInventory(detail.inventory_rows));
    setReportNotes(detail.report_notes);
  }, [detail]);

  const locations = useMemo(() => {
    const unique = new Map<string, string>();
    allReports.forEach((report) => unique.set(report.location_id, report.location_name));
    return Array.from(unique.entries()).map(([id, name]) => ({ id, name }));
  }, [allReports]);

  const rail = useMemo(() => {
    const allChannels = reports.flatMap((report) => report.channels);
    const summary = summarizePointRevenue(allChannels);
    return {
      reportCount: reports.length,
      pendingCount: reports.filter((report) => report.review_status !== "reviewed").length,
      reviewedCount: reports.filter((report) => report.review_status === "reviewed").length,
      amount: summary.effective_total_vnd,
      delta: summary.correction_delta_vnd,
    };
  }, [reports]);

  const saveMutation = useMutation({
    mutationFn: async ({ reviewStatus }: { reviewStatus: "in_review" | "reviewed" }) => {
      if (!selectedReport || !detail) throw new Error("Chưa tải đủ chi tiết báo cáo điểm bán.");
      if (!reason.trim()) throw new Error("Vui lòng nhập lý do chỉnh sửa.");
      const channelRows = detail.channel_rows.map((channel) => {
        const quantity = Math.max(0, quantities[channel.channel_code] ?? channel.quantity);
        return {
          channel_code: channel.channel_code,
          quantity,
          amount_vnd: channel.channel_code === "khach_le"
            ? Math.round(quantity * 12_000)
            : Math.max(0, amounts[channel.channel_code] ?? channel.amount_vnd),
          notes: channelNotes[channel.channel_code] ?? "",
        };
      });
      const { error } = await supabase.rpc("save_kiosk_point_report_correction" as never, {
        p_report_id: selectedReport.report_id,
        p_report_notes: reportNotes.trim() || null,
        p_inventory_rows: inventoryRows,
        p_channel_rows: channelRows,
        p_review_status: reviewStatus,
        p_review_note: note.trim() || null,
        p_reason: reason.trim(),
      } as never);
      if (error) throw error;
    },
    onSuccess: async (_data, variables) => {
      toast.success(variables.reviewStatus === "reviewed" ? "Đã sửa phiếu và đánh dấu đã kiểm tra." : "Đã lưu chỉnh sửa phiếu.");
      await queryClient.invalidateQueries({ queryKey: ["point-revenue-reviews"] });
      await queryClient.invalidateQueries({ queryKey: ["point-report-detail", selectedReport?.report_id] });
      await queryClient.invalidateQueries({ queryKey: ["point-revenue-audit", selectedReport?.report_id] });
      setReason("");
      setMobileEditorOpen(false);
    },
    onError: (saveError) => {
      toast.error(saveError instanceof Error ? saveError.message : "Không thể sửa báo cáo điểm bán.");
    },
  });

  const handleAmountChange = (channelCode: string, amount: number) => {
    setAmounts((current) => ({ ...current, [channelCode]: amount }));
  };

  const handleQuantityChange = (channelCode: string, quantity: number) => {
    const safeQuantity = Math.max(0, Number.isFinite(quantity) ? quantity : 0);
    setQuantities((current) => ({ ...current, [channelCode]: safeQuantity }));
    if (channelCode.trim().toLowerCase() === "khach_le") {
      setAmounts((current) => ({ ...current, [channelCode]: Math.round(safeQuantity * 12_000) }));
    }
  };

  const handleInventoryChange = (productCode: string, field: keyof PointReportInventoryRow, value: number | string) => {
    setInventoryRows((current) => recalculateInventory(current.map((row) => (
      row.product_code === productCode ? { ...row, [field]: value } : row
    ))));
  };

  const renderEditor = (idPrefix: string) => (
    <EditorPanel
      report={selectedReport}
      audit={audit}
      amounts={amounts}
      quantities={quantities}
      channelNotes={channelNotes}
      inventoryRows={inventoryRows}
      reportNotes={reportNotes}
      note={note}
      reason={reason}
      idPrefix={idPrefix}
      canEdit={canEdit}
      saving={saveMutation.isPending}
      detailLoading={detailLoading}
      onQuantityChange={handleQuantityChange}
      onAmountChange={handleAmountChange}
      onChannelNotesChange={(channelCode, notes) => setChannelNotes((current) => ({ ...current, [channelCode]: notes }))}
      onInventoryChange={handleInventoryChange}
      onReportNotesChange={setReportNotes}
      onNoteChange={setNote}
      onReasonChange={setReason}
      onSaveDraft={() => saveMutation.mutate({ reviewStatus: "in_review" })}
      onSaveReviewed={() => saveMutation.mutate({ reviewStatus: "reviewed" })}
    />
  );

  return (
    <main className="point-revenue-page" data-testid="point-revenue-page">
      <section className="pr-hero">
        <div>
          <p className="pr-eyebrow"><Store className="h-4 w-4" aria-hidden="true" /> Bàn làm việc kế toán</p>
          <h1>Doanh thu điểm bán</h1>
          <p>Nhân viên được cấp quyền có thể sửa toàn bộ phiếu. Mọi thay đổi đều lưu người sửa, lý do và dữ liệu trước/sau.</p>
        </div>
        <div className="pr-access-note" aria-live="polite">
          {canEdit ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : <AlertCircle className="h-4 w-4" aria-hidden="true" />}
          {canEdit ? "Có quyền kiểm tra và điều chỉnh" : "Chỉ xem — liên hệ quản trị để được cấp quyền sửa"}
        </div>
      </section>

      <section className="pr-metric-rail" aria-label="Tổng quan điểm bán">
        <article className="pr-rail-primary">
          <span>Tổng xác nhận trong bộ lọc</span>
          <strong>{formatMoney(rail.amount)}</strong>
          <small>{formatNumber(rail.reportCount)} báo cáo · chênh {formatMoney(rail.delta)}</small>
        </article>
        <article>
          <span>Chờ kiểm tra</span>
          <strong>{formatNumber(rail.pendingCount)}</strong>
        </article>
        <article>
          <span>Đã kiểm tra</span>
          <strong>{formatNumber(rail.reviewedCount)}</strong>
        </article>
      </section>

      <section className="pr-filters" aria-label="Bộ lọc báo cáo điểm bán">
        <label>
          <span>Từ ngày</span>
          <Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
        </label>
        <label>
          <span>Đến ngày</span>
          <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
        </label>
        <label>
          <span>Điểm bán</span>
          <Select value={locationId} onValueChange={setLocationId}>
            <SelectTrigger><SelectValue placeholder="Tất cả điểm bán" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả điểm bán</SelectItem>
              {locations.map((location) => <SelectItem key={location.id} value={location.id}>{location.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label>
          <span>Trạng thái</span>
          <Select value={status} onValueChange={(value) => setStatus(value as ReviewFilter)}>
            <SelectTrigger><SelectValue placeholder="Tất cả trạng thái" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả trạng thái</SelectItem>
              <SelectItem value="unreviewed">Chờ kiểm tra</SelectItem>
              <SelectItem value="in_review">Đang kiểm tra</SelectItem>
              <SelectItem value="reviewed">Đã kiểm tra</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </section>

      <section className="pr-workbench">
        <div className="pr-worklist" data-testid="point-revenue-worklist" aria-live="polite">
          <div className="pr-worklist-heading">
            <div>
              <p className="pr-eyebrow"><Search className="h-4 w-4" aria-hidden="true" /> Danh sách kiểm tra</p>
              <h2>Báo cáo kiosk cần kiểm tra</h2>
            </div>
            {isLoading && <Loader2 className="h-5 w-5 animate-spin" aria-label="Đang tải" />}
          </div>

          {isError && <div className="pr-error" role="alert">Không tải được báo cáo: {error instanceof Error ? error.message : "lỗi không xác định"}</div>}
          {!isLoading && reports.length === 0 && !isError && <div className="pr-empty">Không có báo cáo trong bộ lọc hiện tại.</div>}

          <div className="pr-table-wrap" role="region" aria-label="Bảng báo cáo điểm bán">
            <table className="pr-table">
              <thead>
                <tr>
                  <th>Ngày</th>
                  <th>Điểm bán</th>
                  <th>Nhân viên</th>
                  <th>Nguồn</th>
                  <th>Xác nhận</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => {
                  const summary = summarizePointRevenue(report.channels);
                  const selected = report.report_id === selectedReport?.report_id;
                  return (
                    <tr
                      key={report.report_id}
                      className={selected ? "is-selected" : undefined}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedId(report.report_id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedId(report.report_id);
                        }
                      }}
                    >
                      <td>{formatDate(report.report_date)}</td>
                      <td><strong>{report.location_name}</strong></td>
                      <td>{report.staff_name || "—"}</td>
                      <td>{formatMoney(summary.source_total_vnd)}</td>
                      <td>{formatMoney(summary.effective_total_vnd)}</td>
                      <td><span className={statusClass(report.review_status)}>{statusLabel(report.review_status)}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="pr-mobile-list">
            {reports.map((report) => {
              const summary = summarizePointRevenue(report.channels);
              return (
                <article key={report.report_id} className="pr-mobile-card" data-testid="point-revenue-mobile-card">
                  <div>
                    <Badge variant="outline"><CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />{formatDate(report.report_date)}</Badge>
                    <h3>{report.location_name}</h3>
                    <p>{report.staff_name || "—"} · {formatMoney(summary.effective_total_vnd)}</p>
                  </div>
                  <span className={statusClass(report.review_status)}>{statusLabel(report.review_status)}</span>
                  <Button type="button" variant="outline" onClick={() => { setSelectedId(report.report_id); setMobileEditorOpen(true); }}>
                    Mở kiểm tra
                  </Button>
                </article>
              );
            })}
          </div>
        </div>

        <div className="pr-desktop-editor">{renderEditor("desktop")}</div>
      </section>

      <Dialog open={mobileEditorOpen} onOpenChange={setMobileEditorOpen}>
        <DialogContent className="pr-mobile-dialog">
          <DialogHeader>
            <DialogTitle>Kiểm tra doanh thu điểm bán</DialogTitle>
            <DialogDescription>Sửa toàn bộ phiếu khi có quyền; mọi thay đổi đều được ghi audit.</DialogDescription>
          </DialogHeader>
          <Button className="pr-dialog-close" variant="ghost" size="icon" onClick={() => setMobileEditorOpen(false)} aria-label="Đóng">
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
          {renderEditor("mobile")}
        </DialogContent>
      </Dialog>
    </main>
  );
}
