// Dataset overview: real inventory counts, the daily event-derived chart and the
// reviewed/unknown split. Capture status is shown honestly (enabled vs off).
import { useCallback } from "react";
import { invokeDataAdmin } from "@/lib/dataAssetsApi";
import {
  contributionRows,
  overviewResponseSchema,
  reviewedRate,
  type DataAdminOverview,
  type Language,
} from "@/lib/dataAssets";
import { GrowthChart } from "./GrowthChart";
import { EmptyBlock, ErrorBlock, LoadingBlock, SectionCard, StageBadge, toLocalNumber, useAsync } from "./shared";

function t(language: Language, vi: string, en: string): string {
  return language === "en" ? en : vi;
}

function Stat({ label, value, delta }: { label: React.ReactNode; value: string; delta?: string }) {
  return (
    <div className="da-stat">
      <span className="da-stat-value">{value}</span>
      <span className="da-stat-label">{label}</span>
      {delta && <span className="da-stat-delta">{delta}</span>}
    </div>
  );
}

export function OverviewPanel({ language }: { language: Language }) {
  const load = useCallback(
    () => invokeDataAdmin({ action: "overview" }, overviewResponseSchema, language),
    [language],
  );
  const { data, loading, error, reload } = useAsync(load, [load]);

  if (loading) return <LoadingBlock label={t(language, "Đang đọc số liệu bộ dữ liệu…", "Loading dataset metrics…")} />;
  if (error) return <ErrorBlock message={error} onRetry={() => void reload()} retryLabel={t(language, "Thử lại", "Retry")} />;
  if (!data) return <EmptyBlock label={t(language, "Chưa có số liệu.", "No metrics yet.")} />;

  const overview: DataAdminOverview = data.overview;
  const captureEnabled = data.capture.enabled;
  const rate = reviewedRate(overview);
  const unknown = overview.unknown;
  const contributions = contributionRows(overview.sourceContributions, language);

  return (
    <div data-da-panel="overview">
      <SectionCard
        title={t(language, "Tồn kho bộ dữ liệu hiện tại", "Current dataset inventory")}
        hint={t(
          language,
          "Raw / Curated / Gold là ba giai đoạn của CÙNG một tài sản dữ liệu, không phải ba tài sản độc lập. Tổng chỉ tính một lần.",
          "Raw / Curated / Gold are stages of the SAME asset, not three independent assets. The total counts each asset once.",
        )}
        actions={<button type="button" className="da-btn" onClick={() => void reload()}>{t(language, "Tải lại", "Refresh")}</button>}
      >
        <div className="da-grid">
          <Stat
            label={t(language, "Tổng tài sản dữ liệu", "Total assets")}
            value={toLocalNumber(overview.assets.total)}
            delta={`+${toLocalNumber(overview.createdToday)} ${t(language, "tạo hôm nay", "created today")}`}
          />
          <Stat label={<>{t(language, "Giai đoạn", "Stage")}: <StageBadge stage="raw" language={language} /></>} value={toLocalNumber(overview.assets.raw)} />
          <Stat label={<>{t(language, "Giai đoạn", "Stage")}: <StageBadge stage="curated" language={language} /></>} value={toLocalNumber(overview.assets.curated)} />
          <Stat label={<>{t(language, "Giai đoạn", "Stage")}: <StageBadge stage="gold" language={language} /></>} value={toLocalNumber(overview.assets.gold)} />
        </div>
        <div className="da-scope" style={{ marginTop: 12 }}>
          {contributions.map((row) => (
            <span key={row.key} className="da-chip" data-da-contribution={row.key}>
              {row.label}: {toLocalNumber(row.count)}
            </span>
          ))}
        </div>
        <p className="da-notice" style={{ marginTop: 8 }}>{overview.scopeNote}</p>
      </SectionCard>

      <GrowthChart language={language} />

      <SectionCard
        title={t(language, "Đã duyệt và chưa xác định", "Review and response outcomes")}
        hint={t(
          language,
          "Mẫu số là toàn bộ tài sản hiện có. Câu trả lời chưa xác định (abstain) và lỗi được tách riêng khỏi lượt trả lời thành công.",
          "The denominator is the full asset inventory. Abstained and failed answers are kept separate from successful answers.",
        )}
      >
        <div
          className={`da-alert ${captureEnabled ? "da-alert--ok" : "da-alert--error"}`}
          role="status"
          data-da-capture={captureEnabled ? "enabled" : "disabled"}
          style={{ marginBottom: 12 }}
        >
          {captureEnabled
            ? t(language, "Thu thập tự động từ chat phân tích: đang bật.", "Automatic analytics-chat capture is enabled.")
            : t(
                language,
                "Thu thập tự động từ chat phân tích đang TẮT (VNAGENT_CAPTURE_ENABLED). Số liệu bên dưới chỉ phản ánh dữ liệu đã có, không phải hệ thống đang chạy.",
                "Automatic analytics-chat capture is OFF (VNAGENT_CAPTURE_ENABLED). The numbers below reflect stored data only, not a live capture pipeline.",
              )}
        </div>
        <div className="da-grid">
          <Stat label={t(language, "Tỉ lệ đã xác minh", "Verified rate")} value={rate === null ? "—" : `${rate}%`} delta={`${toLocalNumber(overview.reviewed.verified)}/${toLocalNumber(overview.reviewed.denominator)}`} />
          <Stat label={t(language, "Chờ duyệt", "Pending review")} value={toLocalNumber(overview.reviewed.pending)} />
          <Stat label={t(language, "Chưa đánh giá", "Not evaluated")} value={toLocalNumber(overview.reviewed.notEvaluated)} />
          <Stat label={t(language, "Từ chối", "Rejected")} value={toLocalNumber(overview.reviewed.rejected)} />
          <Stat label={t(language, "Chưa xác định (abstain)", "Abstained")} value={toLocalNumber(unknown.abstainedToday)} delta={`${toLocalNumber(unknown.abstainedTotal)} ${t(language, "tổng", "total")}`} />
          <Stat label={t(language, "Lượt trả lời lỗi", "Failed responses")} value={toLocalNumber(unknown.errorsToday)} delta={`${toLocalNumber(unknown.errorsTotal)} ${t(language, "tổng", "total")}`} />
          <Stat label={t(language, "Chat thu thập (7 ngày)", "Collected (7 days)")} value={toLocalNumber(overview.collected.last7d)} delta={`${toLocalNumber(overview.collected.total)} ${t(language, "tổng", "total")}`} />
        </div>
      </SectionCard>
    </div>
  );
}
