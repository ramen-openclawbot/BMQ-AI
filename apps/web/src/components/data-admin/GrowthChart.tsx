// Real daily dataset chart: reconstructed stock or per-day inflow for
// raw/curated/gold, with a 7/30/90 day selector and the source contribution
// counts. Values come only from the daily timeseries RPC (creation + audited
// transition events); there are no synthetic curves.
import { useCallback, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { invokeDataAdmin } from "@/lib/dataAssetsApi";
import {
  TIMESERIES_DAYS,
  chartPoints,
  contributionRows,
  overallContributionLabel,
  timeseriesResponseSchema,
  type ChartMode,
  type Language,
  type TimeseriesDayCount,
} from "@/lib/dataAssets";
import { EmptyBlock, ErrorBlock, LoadingBlock, SectionCard, toLocalNumber, useAsync } from "./shared";

function t(language: Language, vi: string, en: string): string {
  return language === "en" ? en : vi;
}

const COLORS: Record<string, string> = { raw: "#5f7268", curated: "#3b4374", gold: "#a9680f" };

export function GrowthChart({ language }: { language: Language }) {
  const [days, setDays] = useState<TimeseriesDayCount>(30);
  const [mode, setMode] = useState<ChartMode>("stock");

  const load = useCallback(
    () => invokeDataAdmin({ action: "timeseries", days }, timeseriesResponseSchema, language),
    [days, language],
  );
  const { data, loading, error, reload } = useAsync(load, [load]);

  const series = data?.timeseries;
  const points = series ? chartPoints(series, mode) : [];
  const contributions = contributionRows(
    series?.sourceContributions ?? { operational_chat: 0, contributor: 0, synthetic: 0, total: 0 },
    language,
  );

  return (
    <SectionCard
      title={t(language, "Dòng dữ liệu theo ngày", "Daily dataset series")}
      hint={t(
        language,
        "Tồn kho mỗi ngày được dựng lại từ thời điểm tạo tài sản và các sự kiện chuyển giai đoạn có kiểm toán. Chế độ “Mới” đếm số vào mỗi ngày, không làm mượt số liệu.",
        "Each day's stock is reconstructed from asset creation plus audited stage-change events. “New” counts that day's inflow; nothing is smoothed.",
      )}
      actions={
        <div className="da-actions">
          <div className="da-toggle" role="group" aria-label={t(language, "Khoảng thời gian", "Date range")}>
            {TIMESERIES_DAYS.map((value) => (
              <button key={value} type="button" className="da-toggle-btn" aria-pressed={days === value} onClick={() => setDays(value)}>
                {value} {t(language, "ngày", "days")}
              </button>
            ))}
          </div>
          <div className="da-toggle" role="group" aria-label={t(language, "Chế độ xem", "View mode")}>
            <button type="button" className="da-toggle-btn" aria-pressed={mode === "stock"} onClick={() => setMode("stock")}>
              {t(language, "Tồn kho", "Stock")}
            </button>
            <button type="button" className="da-toggle-btn" aria-pressed={mode === "new"} onClick={() => setMode("new")}>
              {t(language, "Mới", "New")}
            </button>
          </div>
          <button type="button" className="da-btn" onClick={() => void reload()} disabled={loading}>{t(language, "Tải lại", "Refresh")}</button>
        </div>
      }
    >
      {loading && <LoadingBlock label={t(language, "Đang dựng biểu đồ…", "Loading chart…")} />}
      {!loading && error && <ErrorBlock message={error} onRetry={() => void reload()} retryLabel={t(language, "Thử lại", "Retry")} />}
      {!loading && !error && !series && <EmptyBlock label={t(language, "Chưa có chuỗi dữ liệu.", "No series yet.")} />}
      {!loading && !error && series && (
        <>
          <div className="da-chart" style={{ width: "100%", height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="var(--da-line)" strokeDasharray="3 3" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(value: string) => value.slice(5)} minTickGap={16} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={40} />
                <Tooltip />
                <Legend />
                <Line type="stepAfter" dataKey="raw" name={t(language, "Raw", "Raw")} stroke={COLORS.raw} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="stepAfter" dataKey="curated" name={t(language, "Curated", "Curated")} stroke={COLORS.curated} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="stepAfter" dataKey="gold" name={t(language, "Gold", "Gold")} stroke={COLORS.gold} strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="da-meta" style={{ marginTop: 8 }} data-da-chart-mode={mode} data-da-chart-days={days}>
            {overallContributionLabel(series.sourceContributions.total, language)}
            {series.from && series.to ? ` · ${t(language, "từ", "from")} ${series.from} ${t(language, "đến", "to")} ${series.to}` : ""}
          </p>
          <div className="da-scope" style={{ marginTop: 10 }}>
            {contributions.map((row) => (
              <span key={row.key} className="da-chip" data-da-contribution={row.key}>
                {row.label}: {toLocalNumber(row.count)}
              </span>
            ))}
          </div>
        </>
      )}
    </SectionCard>
  );
}
