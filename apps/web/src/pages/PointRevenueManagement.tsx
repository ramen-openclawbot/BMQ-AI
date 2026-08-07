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
  parsePointRevenueRows,
  PointRevenueChannel,
  PointRevenueReport,
  PointRevenueReviewStatus,
  summarizePointRevenue,
} from "@/lib/point-revenue";
import "./point-revenue-management.css";

type ReviewFilter = "all" | PointRevenueReviewStatus;
type ChannelAmounts = Record<string, number>;

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

function ChannelEditor({
  channel,
  amount,
  idPrefix,
  disabled,
  onChange,
}: {
  channel: PointRevenueChannel;
  amount: number;
  idPrefix: string;
  disabled: boolean;
  onChange: (channelCode: string, amount: number) => void;
}) {
  const delta = amount - channel.source_amount_vnd;

  return (
    <div className="pr-channel-row">
      <div className="pr-channel-main">
        <span className="pr-channel-code" aria-hidden="true">{channelMark(channel.channel_code)}</span>
        <div>
          <p className="pr-channel-name">{channel.channel_name || channel.channel_code}</p>
          <p className="pr-channel-qty">Số lượng: {formatNumber(channel.quantity)}</p>
        </div>
      </div>
      <div className="pr-channel-fields">
        <div className="pr-field-block">
          <Label>Số nhân viên nhập</Label>
          <output className="pr-readonly-amount">{formatMoney(channel.source_amount_vnd)}</output>
        </div>
        <div className="pr-field-block">
          <Label htmlFor={`point-revenue-${idPrefix}-${channel.channel_code}`}>Số kế toán xác nhận</Label>
          <Input
            id={`point-revenue-${idPrefix}-${channel.channel_code}`}
            inputMode="numeric"
            className="pr-amount-input"
            value={formatNumber(amount)}
            disabled={disabled}
            onChange={(event) => onChange(channel.channel_code, parseMoneyInput(event.target.value))}
          />
        </div>
        <output className={delta === 0 ? "pr-delta" : "pr-delta pr-delta--changed"}>
          {delta === 0 ? "Khớp" : `${delta > 0 ? "+" : ""}${formatMoney(delta)}`}
        </output>
      </div>
    </div>
  );
}

function EditorPanel({
  report,
  audit,
  amounts,
  note,
  idPrefix,
  canEdit,
  saving,
  onAmountChange,
  onNoteChange,
  onSaveDraft,
  onSaveReviewed,
}: {
  report: PointRevenueReport | null;
  audit: PointRevenueAuditEntry[];
  amounts: ChannelAmounts;
  note: string;
  idPrefix: string;
  canEdit: boolean;
  saving: boolean;
  onAmountChange: (channelCode: string, amount: number) => void;
  onNoteChange: (note: string) => void;
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
            amount={amounts[channel.channel_code] ?? channel.effective_amount_vnd}
            idPrefix={idPrefix}
            disabled={!canEdit || saving}
            onChange={onAmountChange}
          />
        ))}
      </div>

      <div className="pr-note-field">
        <Label htmlFor={`point-revenue-review-note-${idPrefix}`}>Ghi chú kiểm tra</Label>
        <Textarea
          id={`point-revenue-review-note-${idPrefix}`}
          value={note}
          disabled={!canEdit || saving}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder="Ví dụ: xác nhận theo sổ quỹ cuối ca, giữ nguyên nguồn POS."
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
        <Button type="button" variant="outline" onClick={onSaveDraft} disabled={!canEdit || saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />} Lưu nháp kiểm tra
        </Button>
        <Button type="button" onClick={onSaveReviewed} disabled={!canEdit || saving}>
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
  const [note, setNote] = useState("");

  const { data: allReports = [], isLoading, isError, error } = usePointRevenueReviews(startDate, endDate, status);
  const reports = useMemo(
    () => locationId === "all" ? allReports : allReports.filter((report) => report.location_id === locationId),
    [allReports, locationId],
  );
  const selectedReport = reports.find((report) => report.report_id === selectedId) ?? reports[0] ?? null;
  const selectedReportId = selectedReport?.report_id ?? null;
  const selectedReviewNote = selectedReport?.review_note ?? "";
  const { data: audit = [] } = usePointRevenueAudit(selectedReportId);

  useEffect(() => {
    if (selectedReportId && selectedReportId !== selectedId) setSelectedId(selectedReportId);
  }, [selectedReportId, selectedId]);

  useEffect(() => {
    setAmounts(toAmountMap(selectedReport));
    setNote(selectedReviewNote);
  }, [selectedReport, selectedReviewNote]);

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
      if (!selectedReport) throw new Error("Chưa chọn báo cáo điểm bán.");
      const completeAmounts = Object.fromEntries(
        currentAmountsFor(selectedReport, amounts).map((channel) => [channel.channel_code, channel.effective_amount_vnd]),
      );
      const { error } = await supabase.rpc("save_kiosk_point_revenue_review" as never, {
        p_report_id: selectedReport.report_id,
        p_channel_amounts: completeAmounts,
        p_review_status: reviewStatus,
        p_note: note.trim() || null,
      } as never);
      if (error) throw error;
    },
    onSuccess: async (_data, variables) => {
      toast.success(variables.reviewStatus === "reviewed" ? "Đã lưu và đánh dấu đã kiểm tra." : "Đã lưu nháp kiểm tra.");
      await queryClient.invalidateQueries({ queryKey: ["point-revenue-reviews"] });
      await queryClient.invalidateQueries({ queryKey: ["point-revenue-audit", selectedReport?.report_id] });
      setMobileEditorOpen(false);
    },
    onError: (saveError) => {
      toast.error(saveError instanceof Error ? saveError.message : "Không thể lưu review doanh thu điểm bán.");
    },
  });

  const handleAmountChange = (channelCode: string, amount: number) => {
    setAmounts((current) => ({ ...current, [channelCode]: amount }));
  };

  const renderEditor = (idPrefix: string) => (
    <EditorPanel
      report={selectedReport}
      audit={audit}
      amounts={amounts}
      note={note}
      idPrefix={idPrefix}
      canEdit={canEdit}
      saving={saveMutation.isPending}
      onAmountChange={handleAmountChange}
      onNoteChange={setNote}
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
          <p>Đối soát số nhân viên nhập với số kế toán xác nhận. Báo cáo gốc luôn được giữ nguyên và mọi điều chỉnh đều có lịch sử.</p>
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
            <DialogDescription>Giữ nguyên số nguồn và chỉ lưu số kế toán xác nhận.</DialogDescription>
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
