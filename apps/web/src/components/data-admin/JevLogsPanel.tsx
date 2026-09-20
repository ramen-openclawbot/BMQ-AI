// Bounded Jev telemetry using the real JevTelemetry fields. No question text,
// prompt or credential is shown; unknown numbers render as "—", never 0.
import { useCallback } from "react";
import { invokeDataAdmin } from "@/lib/dataAssetsApi";
import { formatDateTime, jevResponseSchema, type JevEvent, type Language } from "@/lib/dataAssets";
import { EmptyBlock, ErrorBlock, LoadingBlock, SectionCard, toLocalNumber, useAsync } from "./shared";

function t(language: Language, vi: string, en: string): string {
  return language === "en" ? en : vi;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function probability(value: unknown): string {
  const parsed = number(value);
  if (parsed === null) return "—";
  return `${Math.round(parsed * 100)}%`;
}

function usageCell(event: JevEvent, language: Language): string {
  const input = number(event.token_counts?.input);
  const output = number(event.token_counts?.output);
  if (input === null && output === null) return t(language, "không rõ", "unknown");
  return `${input === null ? "—" : toLocalNumber(input)} / ${output === null ? "—" : toLocalNumber(output)}`;
}

function timingCell(event: JevEvent): string {
  const total = number(event.stage_timings?.totalMs);
  return total === null ? "—" : `${Math.round(total)} ms`;
}

function countsCell(event: JevEvent): string {
  const reads = number(event.counts?.warehouseReads);
  const calls = number(event.counts?.plannerCalls);
  if (reads === null && calls === null) return "—";
  return `${reads === null ? "—" : toLocalNumber(reads)} / ${calls === null ? "—" : toLocalNumber(calls)}`;
}

export function JevLogsPanel({ language }: { language: Language }) {
  const load = useCallback(() => invokeDataAdmin({ action: "jev", limit: 50 }, jevResponseSchema, language), [language]);
  const { data, loading, error, reload } = useAsync(load, [load]);
  const events = data?.events ?? [];

  return (
    <div data-da-panel="jev">
      <SectionCard
        title={t(language, "Nhật ký Jev", "Jev logs")}
        hint={t(
          language,
          "Chỉ lưu chỉ số/kỳ/hỗ trợ đã chọn kèm xác suất, phiên bản prompt & registry, chi phí, usage, thời gian và số lượt đọc. Không lưu câu hỏi, prompt hay khóa bí mật.",
          "Only the selected metric/period/support with probabilities, prompt & registry versions, cost, usage, timings and counts are stored. No question, prompt or secret key is kept.",
        )}
        actions={<button type="button" className="da-btn" onClick={() => void reload()} disabled={loading}>{t(language, "Tải lại", "Refresh")}</button>}
      >
        {loading && <LoadingBlock label={t(language, "Đang tải nhật ký Jev…", "Loading Jev logs…")} />}
        {!loading && error && <ErrorBlock message={error} onRetry={() => void reload()} retryLabel={t(language, "Thử lại", "Retry")} />}
        {!loading && !error && events.length === 0 && <EmptyBlock label={t(language, "Chưa có sự kiện Jev nào.", "No Jev events yet.")} />}
        {!loading && !error && events.length > 0 && (
          <div className="da-tablewrap">
            <table className="da-table">
              <caption>{t(language, "50 sự kiện Jev gần nhất", "Latest 50 Jev events")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t(language, "Thời gian", "Time")}</th>
                  <th scope="col">Request ID</th>
                  <th scope="col">{t(language, "Phiên bản", "Versions")}</th>
                  <th scope="col">{t(language, "Chỉ số", "Metric")}</th>
                  <th scope="col">{t(language, "Xác suất (chỉ số/kỳ/hỗ trợ)", "Probabilities (metric/period/support)")}</th>
                  <th scope="col">{t(language, "Tokens (vào / ra)", "Tokens (in / out)")}</th>
                  <th scope="col">{t(language, "Chi phí", "Cost")}</th>
                  <th scope="col">{t(language, "Thời gian", "Timings")}</th>
                  <th scope="col">{t(language, "Lượt đọc/lượt gọi", "Reads/calls")}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td>{formatDateTime(event.created_at, language)}</td>
                    <td><code>{event.request_id}</code></td>
                    <td>
                      {event.prompt_version ?? "—"} / {event.registry_version ?? "—"}
                      <br />
                      <span className="da-meta">{event.attempted ? t(language, "đã thử", "attempted") : t(language, "chưa thử", "not attempted")} · {event.decided ? t(language, "đã quyết", "decided") : t(language, "chưa quyết", "undecided")}</span>
                    </td>
                    <td>{event.metric ?? "—"}<br /><span className="da-meta">{event.period ?? "—"} · {event.support ?? "—"}</span></td>
                    <td>{probability(event.metric_probability)} / {probability(event.period_probability)} / {probability(event.support_probability)}</td>
                    <td>{usageCell(event, language)}</td>
                    <td>{number(event.cost) === null ? "—" : `$${number(event.cost)!.toFixed(4)}`}</td>
                    <td>{timingCell(event)}</td>
                    <td>{countsCell(event)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
