import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  Eye,
  Loader2,
  PencilLine,
  Save,
  Store,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import {
  parsePointReportDetail,
  parsePointRevenueRows,
  PointReportInventoryRow,
  PointRevenueChannel,
  PointRevenueReport,
  summarizePointRevenue,
} from "@/lib/point-revenue";
import "./point-revenue-management.css";

type ChannelAmounts = Record<string, number>;
type ChannelQuantities = Record<string, number>;
type ChannelNotes = Record<string, string>;

type RankedPointReport = {
  report: PointRevenueReport;
  totalQuantity: number;
  totalRevenue: number;
  rank: number;
  share: number;
};

const dateInVietnam = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

const todayIso = () => dateInVietnam();

const shiftIsoDate = (value: string, days: number) => {
  const parsed = new Date(`${value}T12:00:00+07:00`);
  parsed.setDate(parsed.getDate() + days);
  return dateInVietnam(parsed);
};

const moneyFormatter = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
const inventoryNumberFormatter = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 });

function formatMoney(value: number) {
  return moneyFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatNumber(value: number) {
  return numberFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatInventoryQuantity(value: number) {
  return inventoryNumberFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00+07:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("vi-VN", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
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

function parseMoneyInput(value: string) {
  const normalized = value.replace(/[^0-9]/g, "");
  const parsed = Number(normalized || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recalculateInventory(rows: PointReportInventoryRow[]) {
  const breadstickSold = Math.max(
    0,
    rows.find((row) => row.product_code === "banh_mi_que")?.sold_quantity ?? 0,
  );
  return rows.map((row) => {
    const consumed = row.consumption_is_manual
      ? Math.max(0, row.consumed_quantity)
      : Math.round(breadstickSold * row.breadstick_consumption_ratio * 1000) / 1000;
    const closing =
      row.opening_quantity +
      row.received_quantity -
      row.shortage_quantity +
      row.transfer_quantity -
      row.waste_quantity -
      row.returns_quantity -
      row.sold_quantity -
      consumed;
    return { ...row, consumed_quantity: consumed, closing_quantity: closing };
  });
}

function currentAmountsFor(report: PointRevenueReport | null, edits: ChannelAmounts) {
  return (report?.channels ?? []).map((channel) => ({
    ...channel,
    effective_amount_vnd: edits[channel.channel_code] ?? channel.effective_amount_vnd,
    corrected:
      (edits[channel.channel_code] ?? channel.effective_amount_vnd) !== channel.source_amount_vnd,
  }));
}

function usePointRevenueReports(reportDate: string) {
  return useQuery({
    queryKey: ["point-revenue-reports", reportDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_kiosk_point_revenue_reviews" as never, {
        p_start_date: reportDate,
        p_end_date: reportDate,
        p_location_id: null,
        p_review_status: null,
      } as never);

      if (error) throw error;
      return parsePointRevenueRows((data ?? []) as unknown[]);
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
  const isRetail = channel.channel_code.trim().toLowerCase() === "khach_le";

  return (
    <div className="pr-channel-row" data-testid="point-report-channel-editor">
      <div className="pr-channel-main">
        <span className="pr-channel-code" aria-hidden="true">
          {channelMark(channel.channel_code)}
        </span>
        <div>
          <p className="pr-channel-name">{channel.channel_name || channel.channel_code}</p>
          {isRetail && <p className="pr-channel-help">Tự tính 12.000đ × số lượng</p>}
        </div>
      </div>
      <div className="pr-channel-fields">
        <div className="pr-field-block">
          <Label htmlFor={`point-quantity-${idPrefix}-${channel.channel_code}`}>Số bánh</Label>
          <Input
            id={`point-quantity-${idPrefix}-${channel.channel_code}`}
            inputMode="decimal"
            className="pr-quantity-input"
            value={quantity}
            disabled={disabled}
            onChange={(event) =>
              onQuantityChange(channel.channel_code, Number(event.target.value || 0))
            }
          />
        </div>
        <div className="pr-field-block">
          <Label htmlFor={`point-revenue-${idPrefix}-${channel.channel_code}`}>Doanh thu</Label>
          <Input
            id={`point-revenue-${idPrefix}-${channel.channel_code}`}
            inputMode="numeric"
            className="pr-amount-input"
            value={formatNumber(amount)}
            disabled={disabled || isRetail}
            onChange={(event) =>
              onAmountChange(channel.channel_code, parseMoneyInput(event.target.value))
            }
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
  onChange: (
    productCode: string,
    field: keyof PointReportInventoryRow,
    value: number | string,
  ) => void;
}) {
  if (rows.length === 0) return null;

  return (
    <section className="pr-full-report-section" data-testid="point-report-inventory-editor">
      <div className="pr-section-heading">
        <div>
          <h3>Kho và số bánh</h3>
          <p>Tồn cuối được tính lại khi số liệu thay đổi.</p>
        </div>
      </div>
      <div className="pr-inventory-list">
        {rows.map((row) => (
          <article className="pr-inventory-card" key={row.product_code}>
            <header>
              <strong>{row.product_name}</strong>
              <span>Tồn cuối {formatInventoryQuantity(row.closing_quantity)}</span>
            </header>
            <div className="pr-inventory-grid">
              {INVENTORY_FIELDS.map((field) => {
                const derivedConsumption =
                  field.key === "consumed_quantity" && !row.consumption_is_manual;
                return (
                  <Label key={field.key}>
                    <span>{field.label}</span>
                    <Input
                      type="number"
                      step="0.001"
                      value={String(row[field.key] ?? 0)}
                      disabled={disabled || derivedConsumption}
                      onChange={(event) =>
                        onChange(row.product_code, field.key, Number(event.target.value || 0))
                      }
                    />
                  </Label>
                );
              })}
              <Label className="pr-inventory-note">
                <span>Ghi chú</span>
                <Input
                  value={row.notes}
                  disabled={disabled}
                  onChange={(event) => onChange(row.product_code, "notes", event.target.value)}
                />
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
  amounts,
  quantities,
  channelNotes,
  inventoryRows,
  reportNotes,
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
  onReasonChange,
  onSave,
}: {
  report: PointRevenueReport | null;
  amounts: ChannelAmounts;
  quantities: ChannelQuantities;
  channelNotes: ChannelNotes;
  inventoryRows: PointReportInventoryRow[];
  reportNotes: string;
  reason: string;
  idPrefix: string;
  canEdit: boolean;
  saving: boolean;
  detailLoading: boolean;
  onQuantityChange: (channelCode: string, quantity: number) => void;
  onAmountChange: (channelCode: string, amount: number) => void;
  onChannelNotesChange: (channelCode: string, notes: string) => void;
  onInventoryChange: (
    productCode: string,
    field: keyof PointReportInventoryRow,
    value: number | string,
  ) => void;
  onReportNotesChange: (notes: string) => void;
  onReasonChange: (reason: string) => void;
  onSave: () => void;
}) {
  const adjustedChannels = useMemo(() => currentAmountsFor(report, amounts), [report, amounts]);
  const summary = useMemo(() => summarizePointRevenue(adjustedChannels), [adjustedChannels]);

  if (!report) {
    return (
      <aside className="pr-editor pr-editor--empty" data-testid="point-revenue-editor">
        <Store className="pr-empty-icon" aria-hidden="true" />
        <h2>Chưa có báo cáo để mở</h2>
        <p>Chọn ngày khác khi điểm bán chưa gửi số liệu.</p>
      </aside>
    );
  }

  return (
    <aside className="pr-editor" data-testid="point-revenue-editor" aria-live="polite">
      <header className="pr-editor-header">
        <div>
          <p className="pr-editor-kicker">Báo cáo chi tiết</p>
          <h2>{report.location_name}</h2>
          <p>{formatDate(report.report_date)} · {report.staff_name || "Chưa có tên nhân viên"}</p>
        </div>
        <span className="pr-editor-mode">
          {canEdit ? <PencilLine aria-hidden="true" /> : <Eye aria-hidden="true" />}
          {canEdit ? "Được chỉnh sửa" : "Chỉ xem"}
        </span>
      </header>

      <section className="pr-editor-summary" aria-label="Tóm tắt báo cáo">
        <div>
          <span>Tổng bánh</span>
          <strong>{formatNumber(summary.total_quantity)}</strong>
        </div>
        <div>
          <span>Tổng doanh thu</span>
          <strong>{formatMoney(summary.effective_total_vnd)}</strong>
        </div>
        <div>
          <span>Kênh bán</span>
          <strong>{formatNumber(report.channels.length)}</strong>
        </div>
      </section>

      {detailLoading ? (
        <div className="pr-detail-loading">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          Đang tải báo cáo…
        </div>
      ) : (
        <>
          <div className="pr-channel-list">
            {report.channels.map((channel) => (
              <ChannelEditor
                key={channel.channel_code}
                channel={channel}
                quantity={quantities[channel.channel_code] ?? channel.quantity}
                amount={amounts[channel.channel_code] ?? channel.effective_amount_vnd}
                notes={channelNotes[channel.channel_code] ?? ""}
                idPrefix={idPrefix}
                disabled={!canEdit || saving}
                onQuantityChange={onQuantityChange}
                onAmountChange={onAmountChange}
                onNotesChange={onChannelNotesChange}
              />
            ))}
          </div>

          <InventoryEditor
            rows={inventoryRows}
            disabled={!canEdit || saving}
            onChange={onInventoryChange}
          />

          <div className="pr-note-field">
            <Label htmlFor={`point-report-note-${idPrefix}`}>Ghi chú báo cáo</Label>
            <Textarea
              id={`point-report-note-${idPrefix}`}
              value={reportNotes}
              disabled={!canEdit || saving}
              onChange={(event) => onReportNotesChange(event.target.value)}
            />
          </div>

          {canEdit && (
            <div className="pr-note-field">
              <Label htmlFor={`point-report-edit-reason-${idPrefix}`}>Lý do chỉnh sửa</Label>
              <Input
                id={`point-report-edit-reason-${idPrefix}`}
                value={reason}
                disabled={saving}
                required
                maxLength={500}
                aria-required="true"
                onChange={(event) => onReasonChange(event.target.value)}
                placeholder="Ví dụ: cập nhật số bánh bán thực tế cuối ca"
              />
              <p className="pr-field-help">Lý do được lưu cùng người sửa và dữ liệu trước/sau.</p>
            </div>
          )}

          {canEdit && (
            <div className="pr-editor-actions">
              <Button
                type="button"
                onClick={onSave}
                disabled={saving || !reason.trim()}
                aria-disabled={saving || !reason.trim()}
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="h-4 w-4" aria-hidden="true" />
                )}
                {saving ? "Đang lưu…" : "Lưu thay đổi"}
              </Button>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

export default function PointRevenueManagement() {
  const { canEditModule } = useAuth();
  const canEdit = canEditModule("finance_revenue");
  const queryClient = useQueryClient();
  const [reportDate, setReportDate] = useState(todayIso());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileEditorOpen, setMobileEditorOpen] = useState(false);
  const [amounts, setAmounts] = useState<ChannelAmounts>({});
  const [quantities, setQuantities] = useState<ChannelQuantities>({});
  const [channelNotes, setChannelNotes] = useState<ChannelNotes>({});
  const [inventoryRows, setInventoryRows] = useState<PointReportInventoryRow[]>([]);
  const [reportNotes, setReportNotes] = useState("");
  const [reason, setReason] = useState("");

  const {
    data: reports = [],
    isLoading,
    isError,
    error,
  } = usePointRevenueReports(reportDate);

  const rankedReports = useMemo<RankedPointReport[]>(() => {
    const rows = reports
      .map((report) => {
        const summary = summarizePointRevenue(report.channels);
        return {
          report,
          totalQuantity: summary.total_quantity,
          totalRevenue: summary.effective_total_vnd,
        };
      })
      .sort((a, b) => b.totalQuantity - a.totalQuantity || b.totalRevenue - a.totalRevenue);
    const maxQuantity = Math.max(...rows.map((row) => row.totalQuantity), 0);
    return rows.map((row, index) => ({
      ...row,
      rank: index + 1,
      share: maxQuantity > 0 ? (row.totalQuantity / maxQuantity) * 100 : 0,
    }));
  }, [reports]);

  const selectedReport =
    reports.find((report) => report.report_id === selectedId) ?? rankedReports[0]?.report ?? null;
  const selectedReportId = selectedReport?.report_id ?? null;
  const { data: detail, isLoading: detailLoading } = usePointReportDetail(selectedReportId);

  useEffect(() => {
    if (selectedReportId && selectedReportId !== selectedId) setSelectedId(selectedReportId);
  }, [selectedReportId, selectedId]);

  useEffect(() => {
    setSelectedId(null);
    setMobileEditorOpen(false);
  }, [reportDate]);

  useEffect(() => {
    setReason("");
  }, [selectedReportId]);

  useEffect(() => {
    if (!detail) return;
    setAmounts(
      Object.fromEntries(
        detail.channel_rows.map((channel) => [
          channel.channel_code,
          channel.channel_code.trim().toLowerCase() === "khach_le"
            ? channel.quantity * 12_000
            : channel.amount_vnd,
        ]),
      ),
    );
    setQuantities(
      Object.fromEntries(
        detail.channel_rows.map((channel) => [channel.channel_code, channel.quantity]),
      ),
    );
    setChannelNotes(
      Object.fromEntries(
        detail.channel_rows.map((channel) => [channel.channel_code, channel.notes]),
      ),
    );
    const breadstickSoldQuantity = detail.channel_rows.reduce((sum, channel) => sum + channel.quantity, 0);
    const inventoryWithDerivedSales = detail.inventory_rows.map((row) => (
      row.product_code === "banh_mi_que"
        ? { ...row, sold_quantity: breadstickSoldQuantity }
        : row
    ));
    setInventoryRows(recalculateInventory(inventoryWithDerivedSales));
    setReportNotes(detail.report_notes);
  }, [detail]);

  const dailySummary = useMemo(() => {
    const totalQuantity = rankedReports.reduce((sum, row) => sum + row.totalQuantity, 0);
    const totalRevenue = rankedReports.reduce((sum, row) => sum + row.totalRevenue, 0);
    const highest = rankedReports[0] ?? null;
    const lowest = rankedReports.length > 1 ? rankedReports[rankedReports.length - 1] : null;
    return {
      totalQuantity,
      totalRevenue,
      pointCount: rankedReports.length,
      averageQuantity: rankedReports.length > 0 ? totalQuantity / rankedReports.length : 0,
      highest,
      lowest,
    };
  }, [rankedReports]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!selectedReport || !detail) throw new Error("Chưa tải đủ chi tiết báo cáo điểm bán.");
      if (!reason.trim()) throw new Error("Vui lòng nhập lý do chỉnh sửa.");
      const channelRows = detail.channel_rows.map((channel) => {
        const quantity = Math.max(0, quantities[channel.channel_code] ?? channel.quantity);
        return {
          channel_code: channel.channel_code,
          quantity,
          amount_vnd:
            channel.channel_code === "khach_le"
              ? Math.round(quantity * 12_000)
              : Math.max(0, amounts[channel.channel_code] ?? channel.amount_vnd),
          notes: channelNotes[channel.channel_code] ?? "",
        };
      });
      const { error: saveError } = await supabase.rpc(
        "save_kiosk_point_report_correction" as never,
        {
          p_report_id: selectedReport.report_id,
          p_report_notes: reportNotes.trim() || null,
          p_inventory_rows: inventoryRows,
          p_channel_rows: channelRows,
          p_review_status:
            selectedReport.review_status === "reviewed" ? "reviewed" : "in_review",
          p_review_note: selectedReport.review_note || null,
          p_reason: reason.trim(),
        } as never,
      );
      if (saveError) throw saveError;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["point-revenue-reports"] });
      await queryClient.invalidateQueries({
        queryKey: ["point-report-detail", selectedReport?.report_id],
      });
      setReason("");
      setMobileEditorOpen(false);
      toast.success("Đã lưu thay đổi báo cáo.", { icon: <Check className="h-4 w-4" /> });
    },
    onError: (saveError) => {
      toast.error(
        saveError instanceof Error
          ? saveError.message
          : "Không thể lưu báo cáo điểm bán. Xem lại dữ liệu rồi thử lần nữa.",
      );
    },
  });

  const handleAmountChange = (channelCode: string, amount: number) => {
    setAmounts((current) => ({ ...current, [channelCode]: amount }));
  };

  const handleQuantityChange = (channelCode: string, quantity: number) => {
    const safeQuantity = Math.max(0, Number.isFinite(quantity) ? quantity : 0);
    setQuantities((current) => ({ ...current, [channelCode]: safeQuantity }));
    if (channelCode.trim().toLowerCase() === "khach_le") {
      setAmounts((current) => ({
        ...current,
        [channelCode]: Math.round(safeQuantity * 12_000),
      }));
    }
  };

  const handleInventoryChange = (
    productCode: string,
    field: keyof PointReportInventoryRow,
    value: number | string,
  ) => {
    setInventoryRows((current) =>
      recalculateInventory(
        current.map((row) => (row.product_code === productCode ? { ...row, [field]: value } : row)),
      ),
    );
  };

  const openReport = (reportId: string, mobile = false) => {
    setSelectedId(reportId);
    if (mobile) setMobileEditorOpen(true);
  };

  const renderEditor = (idPrefix: string) => (
    <EditorPanel
      report={selectedReport}
      amounts={amounts}
      quantities={quantities}
      channelNotes={channelNotes}
      inventoryRows={inventoryRows}
      reportNotes={reportNotes}
      reason={reason}
      idPrefix={idPrefix}
      canEdit={canEdit}
      saving={saveMutation.isPending}
      detailLoading={detailLoading}
      onQuantityChange={handleQuantityChange}
      onAmountChange={handleAmountChange}
      onChannelNotesChange={(channelCode, notes) =>
        setChannelNotes((current) => ({ ...current, [channelCode]: notes }))
      }
      onInventoryChange={handleInventoryChange}
      onReportNotesChange={setReportNotes}
      onReasonChange={setReason}
      onSave={() => saveMutation.mutate()}
    />
  );

  return (
    <main
      className="point-revenue-page"
      data-testid="point-revenue-page"
      data-point-revenue-version="daily-ranking-v1"
    >
      <header className="pr-page-header">
        <div className="pr-title-line">
          <Store className="h-5 w-5" aria-hidden="true" />
          <h1>Doanh thu điểm bán</h1>
        </div>
      </header>

      <section className="pr-date-control" aria-label="Chọn ngày báo cáo">
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setReportDate((current) => shiftIsoDate(current, -1))}
          aria-label="Xem ngày trước"
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <label>
          <span>Ngày báo cáo</span>
          <Input
            type="date"
            value={reportDate}
            max={todayIso()}
            onChange={(event) => setReportDate(event.target.value || todayIso())}
          />
        </label>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setReportDate((current) => shiftIsoDate(current, 1))}
          disabled={reportDate >= todayIso()}
          aria-label="Xem ngày sau"
        >
          <ArrowRight aria-hidden="true" />
        </Button>
      </section>

      <section className="pr-stat-led" aria-label="Tổng quan doanh thu trong ngày">
        <article className="pr-lead-stat">
          <div className="pr-lead-number" aria-live="polite">
            {isLoading ? "—" : formatNumber(dailySummary.totalQuantity)}
          </div>
          <div className="pr-lead-copy">
            <h2>bánh bán ra trong ngày</h2>
            <p>
              {formatDate(reportDate)} · {formatNumber(dailySummary.pointCount)} điểm bán đã gửi báo cáo
            </p>
          </div>
        </article>

        <div className="pr-supporting-stats">
          <article>
            <span>Tổng doanh thu</span>
            <strong>{isLoading ? "—" : formatMoney(dailySummary.totalRevenue)}</strong>
          </article>
          <article>
            <span>Trung bình mỗi điểm</span>
            <strong>{isLoading ? "—" : `${formatNumber(dailySummary.averageQuantity)} bánh`}</strong>
          </article>
          <article>
            <span>Bán nhiều nhất</span>
            <strong>{dailySummary.highest?.report.location_name || "—"}</strong>
            <small>
              {dailySummary.highest ? `${formatNumber(dailySummary.highest.totalQuantity)} bánh` : "Chưa có dữ liệu"}
            </small>
          </article>
          <article>
            <span>Bán ít nhất</span>
            <strong>{dailySummary.lowest?.report.location_name || "—"}</strong>
            <small>
              {dailySummary.lowest ? `${formatNumber(dailySummary.lowest.totalQuantity)} bánh` : "Chưa đủ dữ liệu so sánh"}
            </small>
          </article>
        </div>
      </section>

      <section className="pr-ranking-section" aria-labelledby="point-ranking-title">
        <div className="pr-ranking-heading">
          <div>
            <h2 id="point-ranking-title">Xếp hạng điểm bán</h2>
            <p>Danh sách được sắp theo tổng số bánh bán ra, từ cao xuống thấp.</p>
          </div>
          {isLoading && <Loader2 className="h-5 w-5 animate-spin" aria-label="Đang tải" />}
        </div>

        {isError && (
          <div className="pr-error" role="alert">
            Không tải được báo cáo. {error instanceof Error ? error.message : "Vui lòng thử lại."}
          </div>
        )}

        {!isLoading && rankedReports.length === 0 && !isError && (
          <div className="pr-empty">
            <CalendarDays aria-hidden="true" />
            <div>
              <strong>Chưa có báo cáo trong ngày này.</strong>
              <span>Chọn một ngày khác để xem dữ liệu điểm bán.</span>
            </div>
          </div>
        )}

        <div className="pr-ranking-list" aria-live="polite">
          {rankedReports.map((row, index) => {
            const isHighest = index === 0 && rankedReports.length > 1;
            const isLowest = index === rankedReports.length - 1 && rankedReports.length > 1;
            const selected = row.report.report_id === selectedReportId;
            return (
              <article
                key={row.report.report_id}
                className={`pr-ranking-row${selected ? " is-selected" : ""}`}
              >
                <button
                  type="button"
                  className="pr-ranking-main"
                  onClick={() => openReport(row.report.report_id)}
                  aria-label={`Mở báo cáo ${row.report.location_name}`}
                >
                  <span className="pr-rank">{String(row.rank).padStart(2, "0")}</span>
                  <span className="pr-point-copy">
                    <span className="pr-point-title-line">
                      <strong>{row.report.location_name}</strong>
                      {isHighest && <span className="pr-rank-note">Bán nhiều nhất</span>}
                      {isLowest && <span className="pr-rank-note pr-rank-note--low">Bán ít nhất</span>}
                    </span>
                    <span className="pr-volume-track" aria-hidden="true">
                      <span style={{ transform: `scaleX(${row.share / 100})` }} />
                    </span>
                    <span className="pr-point-meta">
                      {row.report.staff_name || "Chưa có tên nhân viên"}
                    </span>
                  </span>
                  <span className="pr-point-quantity">
                    <strong>{formatNumber(row.totalQuantity)}</strong>
                    <span>bánh</span>
                  </span>
                  <span className="pr-point-revenue">{formatMoney(row.totalRevenue)}</span>
                </button>
                <Button
                  type="button"
                  variant="outline"
                  className="pr-open-report"
                  onClick={() => openReport(row.report.report_id, true)}
                >
                  {canEdit ? <PencilLine aria-hidden="true" /> : <Eye aria-hidden="true" />}
                  {canEdit ? "Mở & sửa" : "Xem báo cáo"}
                </Button>
              </article>
            );
          })}
        </div>
      </section>

      <section className="pr-desktop-editor" aria-label="Báo cáo điểm bán được chọn">
        {renderEditor("desktop")}
      </section>

      <Dialog open={mobileEditorOpen} onOpenChange={setMobileEditorOpen}>
        <DialogContent className="pr-mobile-dialog">
          <DialogHeader>
            <DialogTitle>Báo cáo điểm bán</DialogTitle>
            <DialogDescription>
              {canEdit
                ? "Xem và chỉnh sửa số liệu khi tài khoản được cấp quyền."
                : "Tài khoản hiện chỉ có quyền xem báo cáo."}
            </DialogDescription>
          </DialogHeader>
          <Button
            className="pr-dialog-close"
            variant="ghost"
            size="icon"
            onClick={() => setMobileEditorOpen(false)}
            aria-label="Đóng"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
          {renderEditor("mobile")}
        </DialogContent>
      </Dialog>
    </main>
  );
}
