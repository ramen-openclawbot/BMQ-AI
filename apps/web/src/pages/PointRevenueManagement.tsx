import { useLanguage } from "@/contexts/LanguageContext";
import { pointRevenue } from "@/i18n/pointRevenue";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  Eye,
  Loader2,
  PencilLine,
  Save,
  Star,
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
import { kioskRetailCustomerUnitPriceVnd } from "@/lib/kiosk-report-inventory";
import {
  createPointReportEditDraft,
  getBreadClosingQuantity,
  parsePointReportDetail,
  parsePointRevenueRows,
  PointReportInventoryRow,
  PointRevenueChannel,
  PointRevenueReport,
  recalculatePointInventory,
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

function formatVnd(value: number) {
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

function isSpecificCorrectionReason(value: string) {
  const trimmed = value.trim().replace(/\s+/g, " ");
  const genericReasons = new Set([
    "đã kiểm",
    "đã kiểm tra",
    "da kiem",
    "da kiem tra",
    "chỉnh sửa",
    "update data",
    "checked data",
  ]);
  return trimmed.length >= 10 && !genericReasons.has(trimmed.toLocaleLowerCase("vi-VN"));
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

async function fetchPointReportDetail(reportId: string) {
  const { data, error } = await supabase.rpc("get_kiosk_point_report_detail" as never, {
    p_report_id: reportId,
  } as never);
  if (error) throw error;
  return parsePointReportDetail(data);
}

function usePointReportDetail(reportId: string | null) {
  return useQuery({
    queryKey: ["point-report-detail", reportId],
    enabled: Boolean(reportId),
    queryFn: () => fetchPointReportDetail(reportId as string),
  });
}

function ChannelEditor({
  channel,
  quantity,
  amount,
  notes,
  idPrefix,
  retailUnitPriceLabel,
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
  retailUnitPriceLabel: string;
  disabled: boolean;
  onQuantityChange: (channelCode: string, quantity: number) => void;
  onAmountChange: (channelCode: string, amount: number) => void;
  onNotesChange: (channelCode: string, notes: string) => void;
}) {
  const { language } = useLanguage();
  const copy = pointRevenue[language];
  const isRetail = channel.channel_code.trim().toLowerCase() === "khach_le";
  const isHotline = channel.channel_code.trim().toLowerCase() === "hotline";

  return (
    <div className="pr-channel-row" data-testid="point-report-channel-editor">
      <div className="pr-channel-main">
        <span className="pr-channel-code" aria-hidden="true">
          {channelMark(channel.channel_code)}
        </span>
        <div>
          <p className="pr-channel-name">{channel.channel_name || channel.channel_code}</p>
          {isRetail && <p className="pr-channel-help">{copy.autoCalculated} {retailUnitPriceLabel}{copy.priceQuantity}</p>}
          {isHotline && <p className="pr-channel-help">{copy.hotlineHint}</p>}
        </div>
      </div>
      <div className="pr-channel-fields">
        <div className="pr-field-block">
          <Label htmlFor={`point-quantity-${idPrefix}-${channel.channel_code}`}>{copy.breadCount}</Label>
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
          <Label htmlFor={`point-revenue-${idPrefix}-${channel.channel_code}`}>{isHotline ? copy.actualReceipts : copy.revenue}</Label>
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
          <Label htmlFor={`point-channel-note-${idPrefix}-${channel.channel_code}`}>{copy.notes}</Label>
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
  const { language } = useLanguage();
  const copy = pointRevenue[language];
  const INVENTORY_FIELDS: Array<{ key: keyof PointReportInventoryRow; label: string }> = [
  { key: "opening_quantity", label: copy.opening },
  { key: "received_quantity", label: copy.received },
  { key: "shortage_quantity", label: copy.shortage },
  { key: "transfer_quantity", label: copy.transfer },
  { key: "waste_quantity", label: copy.waste },
  { key: "returns_quantity", label: copy.returns },
  { key: "sold_quantity", label: copy.sold },
  { key: "consumed_quantity", label: copy.consumed },
];

  if (rows.length === 0) return null;

  return (
    <section className="pr-full-report-section" data-testid="point-report-inventory-editor">
      <div className="pr-section-heading">
        <div>
          <h3>{copy.inventoryTitle}</h3>
          <p>{copy.inventoryHint}</p>
        </div>
      </div>
      <div className="pr-inventory-list">
        {rows.map((row) => (
          <article className="pr-inventory-card" key={row.product_code}>
            <header>
              <strong>{row.product_name}</strong>
              <span>{copy.closing} {formatInventoryQuantity(row.closing_quantity)}</span>
            </header>
            <div className="pr-inventory-grid">
              {INVENTORY_FIELDS.map((field) => {
                const derivedConsumption =
                  field.key === "consumed_quantity" && !row.consumption_is_manual;
                const derivedBreadSold =
                  field.key === "sold_quantity" && row.product_code === "banh_mi_que";
                return (
                  <Label key={field.key}>
                    <span>{field.label}</span>
                    <Input
                      type="number"
                      step="0.001"
                      value={String(row[field.key] ?? 0)}
                      disabled={disabled || derivedConsumption || derivedBreadSold}
                      title={derivedBreadSold ? copy.breadDerived : undefined}
                      onChange={(event) =>
                        onChange(row.product_code, field.key, Number(event.target.value || 0))
                      }
                    />
                    {derivedBreadSold && <small>{copy.breadDerived}</small>}
                  </Label>
                );
              })}
              <Label className="pr-inventory-note">
                <span>{copy.notes}</span>
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
  retailUnitPriceLabel,
  canEdit,
  saving,
  detailLoading,
  onQuantityChange,
  onAmountChange,
  onChannelNotesChange,
  onInventoryChange,
  onReportNotesChange,
  onReasonChange,
  onCancel,
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
  retailUnitPriceLabel: string;
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
  onCancel?: () => void;
  onSave: () => void;
}) {
  const { language } = useLanguage();
  const copy = pointRevenue[language];
  const adjustedChannels = useMemo(() => currentAmountsFor(report, amounts), [report, amounts]);
  const summary = useMemo(() => summarizePointRevenue(adjustedChannels), [adjustedChannels]);

  if (!report) {
    return (
      <aside className="pr-editor pr-editor--empty" data-testid="point-revenue-editor">
        <Store className="pr-empty-icon" aria-hidden="true" />
        <h2>{copy.noReport}</h2>
        <p>{copy.noReportHint}</p>
      </aside>
    );
  }

  return (
    <aside className="pr-editor" data-testid="point-revenue-editor" aria-live="polite">
      <header className="pr-editor-header">
        <div>
          <p className="pr-editor-kicker">{copy.detailTitle}</p>
          <h2>{report.location_name}</h2>
          <p>{formatDate(report.report_date)} · {report.staff_name || copy.unnamedStaff}</p>
        </div>
        <span className="pr-editor-mode">
          {canEdit ? <PencilLine aria-hidden="true" /> : <Eye aria-hidden="true" />}
          {canEdit ? copy.editable : copy.readonly}
        </span>
      </header>

      <section className="pr-editor-summary" aria-label={copy.summary}>
        <div>
          <span>{copy.totalBread}</span>
          <strong>{formatNumber(summary.total_quantity)}</strong>
        </div>
        <div>
          <span>{copy.totalRevenue}</span>
          <strong>{formatMoney(summary.effective_total_vnd)}</strong>
        </div>
        <div>
          <span>{copy.channels}</span>
          <strong>{formatNumber(report.channels.length)}</strong>
        </div>
      </section>

      {detailLoading ? (
        <div className="pr-detail-loading">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          {copy.loadingReport} </div>
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
                retailUnitPriceLabel={retailUnitPriceLabel}
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
            <Label htmlFor={`point-report-note-${idPrefix}`}>{copy.reportNotes}</Label>
            <Textarea
              id={`point-report-note-${idPrefix}`}
              value={reportNotes}
              disabled={!canEdit || saving}
              onChange={(event) => onReportNotesChange(event.target.value)}
            />
          </div>

          {canEdit && (
            <div className="pr-note-field">
              <Label htmlFor={`point-report-edit-reason-${idPrefix}`}>{copy.editReason}</Label>
              <Input
                id={`point-report-edit-reason-${idPrefix}`}
                value={reason}
                disabled={saving}
                required
                maxLength={500}
                aria-required="true"
                onChange={(event) => onReasonChange(event.target.value)}
                placeholder={copy.reasonPlaceholder}
              />
              <p className="pr-field-help">{copy.reasonHint}</p>
            </div>
          )}

          {canEdit && (
            <div className="pr-editor-actions">
              {onCancel && (
                <Button
                  type="button"
                  variant="outline"
                  className="pr-editor-cancel"
                  onClick={onCancel}
                  disabled={saving}
                >
                  {copy.cancel} </Button>
              )}
              <Button
                type="button"
                onClick={onSave}
                disabled={saving || !isSpecificCorrectionReason(reason)}
                aria-disabled={saving || !isSpecificCorrectionReason(reason)}
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Save className="h-4 w-4" aria-hidden="true" />
                )}
                {saving ? copy.saving : copy.save}
              </Button>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

export default function PointRevenueManagement() {
  const { language } = useLanguage();
  const copy = pointRevenue[language];
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

  const pointDetailQueries = useQueries({
    queries: rankedReports.map(({ report }) => ({
      queryKey: ["point-report-detail", report.report_id],
      queryFn: () => fetchPointReportDetail(report.report_id),
      staleTime: 30_000,
    })),
  });
  const breadClosingByReportId = useMemo(
    () => new Map(
      rankedReports.map((row, index) => [
        row.report.report_id,
        getBreadClosingQuantity(pointDetailQueries[index]?.data),
      ]),
    ),
    [pointDetailQueries, rankedReports],
  );
  const inventoryOverviewLoading = pointDetailQueries.some((query) => query.isLoading);
  const inventoryOverviewIncomplete = pointDetailQueries.some(
    (query) => query.isError || !query.data || getBreadClosingQuantity(query.data) === null,
  );
  const totalBreadClosing = Array.from(breadClosingByReportId.values()).reduce<number>(
    (sum, quantity) => sum + (quantity ?? 0),
    0,
  );

  const selectedReport =
    reports.find((report) => report.report_id === selectedId) ?? rankedReports[0]?.report ?? null;
  const selectedRetailUnitPriceVnd = selectedReport
    ? kioskRetailCustomerUnitPriceVnd(selectedReport.report_date)
    : kioskRetailCustomerUnitPriceVnd(reportDate);
  const selectedRetailUnitPriceLabel = selectedReport
    ? formatVnd(kioskRetailCustomerUnitPriceVnd(selectedReport.report_date))
    : formatVnd(kioskRetailCustomerUnitPriceVnd(reportDate));
  const selectedReportId = selectedReport?.report_id ?? null;
  const { data: detail, isLoading: detailLoading } = usePointReportDetail(selectedReportId);
  const breadstickSoldQuantity = Object.values(quantities).reduce((sum, value) => sum + Math.max(0, value), 0);

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
    if (!detail || !selectedReport) return;
    const draft = createPointReportEditDraft(
      detail,
      kioskRetailCustomerUnitPriceVnd(selectedReport.report_date),
    );
    setAmounts(draft.amounts);
    setQuantities(draft.quantities);
    setChannelNotes(draft.channelNotes);
    setInventoryRows(draft.inventoryRows);
    setReportNotes(draft.reportNotes);
  }, [detail, selectedReport]);

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
      if (!selectedReport || !detail) throw new Error(copy.incompleteReport);
      if (!isSpecificCorrectionReason(reason)) {
        throw new Error(copy.specificReason);
      }
      const channelRows = detail.channel_rows.map((channel) => {
        const quantity = Math.max(0, quantities[channel.channel_code] ?? channel.quantity);
        return {
          channel_code: channel.channel_code,
          quantity,
          amount_vnd:
            channel.channel_code === "khach_le"
              ? Math.round(quantity * selectedRetailUnitPriceVnd)
              : Math.max(0, amounts[channel.channel_code] ?? channel.amount_vnd),
          notes: channelNotes[channel.channel_code] ?? "",
        };
      });
      const { error: saveError } = await supabase.rpc(
        "save_kiosk_point_report_correction" as never,
        {
          p_report_id: selectedReport.report_id,
          p_report_notes: reportNotes.trim() || null,
          p_inventory_rows: inventoryRows.map((row) => (
            row.product_code === "banh_mi_que" ? { ...row, sold_quantity: breadstickSoldQuantity } : row
          )),
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
      toast.success(copy.saved, { icon: <Check className="h-4 w-4" /> });
    },
    onError: (saveError) => {
      toast.error(
        saveError instanceof Error
          ? saveError.message
          : copy.saveFailed,
      );
    },
  });

  const handleAmountChange = (channelCode: string, amount: number) => {
    setAmounts((current) => ({ ...current, [channelCode]: amount }));
  };

  const handleQuantityChange = (channelCode: string, quantity: number) => {
    const safeQuantity = Math.max(0, Number.isFinite(quantity) ? quantity : 0);
    setQuantities((current) => {
      const next = { ...current, [channelCode]: safeQuantity };
      const nextBreadstickSoldQuantity = Object.values(next).reduce((sum, value) => sum + Math.max(0, value), 0);
      setInventoryRows((rows) => recalculatePointInventory(rows.map((row) => (
        row.product_code === "banh_mi_que" ? { ...row, sold_quantity: nextBreadstickSoldQuantity } : row
      ))));
      return next;
    });
    if (channelCode.trim().toLowerCase() === "khach_le") {
      setAmounts((current) => ({
        ...current,
        [channelCode]: Math.round(safeQuantity * selectedRetailUnitPriceVnd),
      }));
    }
  };

  const handleInventoryChange = (
    productCode: string,
    field: keyof PointReportInventoryRow,
    value: number | string,
  ) => {
    setInventoryRows((current) =>
      recalculatePointInventory(
        current.map((row) => (row.product_code === productCode ? { ...row, [field]: value } : row)),
      ),
    );
  };

  const closeMobileEditor = () => {
    if (detail && selectedReport) {
      const draft = createPointReportEditDraft(
        detail,
        kioskRetailCustomerUnitPriceVnd(selectedReport.report_date),
      );
      setAmounts(draft.amounts);
      setQuantities(draft.quantities);
      setChannelNotes(draft.channelNotes);
      setInventoryRows(draft.inventoryRows);
      setReportNotes(draft.reportNotes);
    }
    setReason("");
    setMobileEditorOpen(false);
  };

  const openReport = (reportId: string, mobile = false) => {
    setSelectedId(reportId);
    if (mobile) setMobileEditorOpen(true);
  };

  const renderEditor = (idPrefix: string, onCancel?: () => void) => (
    <EditorPanel
      report={selectedReport}
      amounts={amounts}
      quantities={quantities}
      channelNotes={channelNotes}
      inventoryRows={inventoryRows}
      reportNotes={reportNotes}
      reason={reason}
      idPrefix={idPrefix}
      retailUnitPriceLabel={selectedRetailUnitPriceLabel}
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
      onCancel={onCancel}
      onSave={() => saveMutation.mutate()}
    />
  );

  return (
    <main
      className="point-revenue-page"
      data-testid="point-revenue-page"
      data-staff-i18n="b-revenue-v1"
      data-point-revenue-version="mobile-ranking-edit-v2"
    >
      <header className="pr-page-header">
        <div className="pr-title-line">
          <Store className="h-5 w-5" aria-hidden="true" />
          <h1>{copy.title}</h1>
        </div>
      </header>

      <section className="pr-date-control" aria-label={copy.chooseDate}>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setReportDate((current) => shiftIsoDate(current, -1))}
          aria-label={copy.previousDay}
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <label>
          <span>{copy.reportDate}</span>
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
          aria-label={copy.nextDay}
        >
          <ArrowRight aria-hidden="true" />
        </Button>
      </section>

      <section className="pr-stat-led" aria-label={copy.dailyOverview}>
        <article className="pr-lead-stat">
          <div className="pr-lead-number" aria-live="polite">
            {isLoading ? "—" : formatNumber(dailySummary.totalQuantity)}
          </div>
          <div className="pr-lead-copy">
            <h2>{copy.breadSoldToday}</h2>
            <p>
              {formatDate(reportDate)} · {formatNumber(dailySummary.pointCount)} {copy.submittedLocations} </p>
          </div>
        </article>

        <div className="pr-supporting-stats">
          <article>
            <span>{copy.totalRevenue}</span>
            <strong>{isLoading ? "—" : formatMoney(dailySummary.totalRevenue)}</strong>
          </article>
          <article>
            <span>{copy.average}</span>
            <strong>{isLoading ? "—" : `${formatNumber(dailySummary.averageQuantity)} ${copy.bread}`}</strong>
          </article>
          <article>
            <span>{copy.highest}</span>
            <strong>{dailySummary.highest?.report.location_name || "—"}</strong>
            <small>
              {dailySummary.highest ? `${formatNumber(dailySummary.highest.totalQuantity)} ${copy.bread}` : copy.noData}
            </small>
          </article>
          <article>
            <span>{copy.lowest}</span>
            <strong>{dailySummary.lowest?.report.location_name || "—"}</strong>
            <small>
              {dailySummary.lowest ? `${formatNumber(dailySummary.lowest.totalQuantity)} ${copy.bread}` : copy.notEnoughComparison}
            </small>
          </article>
        </div>
      </section>

      <section className="pr-ranking-section" aria-labelledby="point-ranking-title">
        <div className="pr-ranking-heading">
          <div>
            <h2 id="point-ranking-title">{copy.ranking}</h2>
            <p>{copy.rankingHint}</p>
          </div>
          {isLoading && <Loader2 className="h-5 w-5 animate-spin" aria-label={copy.loading} />}
        </div>

        {isError && (
          <div className="pr-error" role="alert">
            {copy.loadFailed} {error instanceof Error ? error.message : copy.retry}
          </div>
        )}

        {!isLoading && rankedReports.length === 0 && !isError && (
          <div className="pr-empty">
            <CalendarDays aria-hidden="true" />
            <div>
              <strong>{copy.emptyDay}</strong>
              <span>{copy.emptyDayHint}</span>
            </div>
          </div>
        )}

        <div className="pr-ranking-list" aria-live="polite">
          {rankedReports.map((row, index) => {
            const isHighest = index === 0 && rankedReports.length > 1;
            const isLowest = index === rankedReports.length - 1 && rankedReports.length > 1;
            const selected = row.report.report_id === selectedReportId;
            const breadClosing = breadClosingByReportId.get(row.report.report_id);
            return (
              <article
                key={row.report.report_id}
                className={`pr-ranking-row${selected ? " is-selected" : ""}`}
              >
                <button
                  type="button"
                  className="pr-ranking-main"
                  onClick={() => openReport(row.report.report_id)}
                  aria-label={`${copy.viewReport}: ${row.report.location_name}`}
                >
                  <span className={`pr-rank${isHighest ? " pr-rank--highest" : ""}`}>
                    {isHighest ? <Star aria-label={copy.bestToday} /> : String(row.rank).padStart(2, "0")}
                  </span>
                  <span className="pr-point-copy">
                    <span className="pr-point-title-line">
                      <strong>{row.report.location_name}</strong>
                      {isHighest && <span className="pr-rank-note">{copy.bestToday}</span>}
                      {isLowest && <span className="pr-rank-note pr-rank-note--low">{copy.lowest}</span>}
                    </span>
                    <span className="pr-volume-track" aria-hidden="true">
                      <span style={{ transform: `scaleX(${row.share / 100})` }} />
                    </span>
                    <span className="pr-point-meta">
                      {row.report.staff_name || copy.unnamedStaff}
                      {breadClosing !== null && breadClosing !== undefined && (
                        <span className="pr-point-stock"> {copy.closingInline} {formatInventoryQuantity(breadClosing)} {copy.bread}</span>
                      )}
                    </span>
                    {row.report.report_notes && (
                      <span className="pr-shift-note">
                        <strong>{copy.shiftNotes}</strong> {row.report.report_notes}
                      </span>
                    )}
                  </span>
                  <span className="pr-point-quantity">
                    <strong>{formatNumber(row.totalQuantity)}</strong>
                    <span>{copy.bread}</span>
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
                  {canEdit ? copy.openEdit : copy.viewReport}
                </Button>
              </article>
            );
          })}
        </div>

        {rankedReports.length > 0 && (
          <section className="pr-inventory-overview" aria-labelledby="point-inventory-title">
            <header>
              <div>
                <h3 id="point-inventory-title">{copy.currentStock}</h3>
                <p>{copy.currentStockHint}</p>
              </div>
              <strong>
                {inventoryOverviewLoading
                  ? copy.loadingEllipsis
                  : inventoryOverviewIncomplete
                    ? copy.insufficientData
                    : `${formatInventoryQuantity(totalBreadClosing)} ${copy.bread}`}
              </strong>
            </header>
            <div className="pr-inventory-overview-grid">
              {rankedReports.map((row, index) => {
                const closing = breadClosingByReportId.get(row.report.report_id);
                const detailQuery = pointDetailQueries[index];
                return (
                  <article key={row.report.report_id}>
                    <span>{row.report.location_name}</span>
                    <strong>{closing === null || closing === undefined ? "—" : formatInventoryQuantity(closing)}</strong>
                    <small>{detailQuery?.isError ? copy.unableLoad : copy.closingBread}</small>
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </section>

      <section className="pr-desktop-editor" aria-label={copy.selectedReport}>
        {renderEditor("desktop")}
      </section>

      <Dialog
        open={mobileEditorOpen}
        onOpenChange={(open) => {
          if (!open) closeMobileEditor();
        }}
      >
        <DialogContent className="pr-mobile-dialog">
          <DialogHeader>
            <DialogTitle>{copy.locationReport}</DialogTitle>
            <DialogDescription>
              {canEdit
                ? copy.editableHint
                : copy.readonlyHint}
            </DialogDescription>
          </DialogHeader>
          <Button
            className="pr-dialog-close"
            variant="ghost"
            size="icon"
            onClick={closeMobileEditor}
            aria-label={copy.close}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
          {renderEditor("mobile", closeMobileEditor)}
        </DialogContent>
      </Dialog>
    </main>
  );
}
