// Bounded Markdown export with a server-side scope and permission check.
import { useState } from "react";
import { invokeDataAdmin } from "@/lib/dataAssetsApi";
import {
  ASSET_STAGES,
  EMPTY_EXPORT_FILTERS,
  EVALUATION_STATUSES,
  SOURCE_KINDS,
  evaluationLabel,
  exportFileName,
  exportResponseSchema,
  sourceKindLabel,
  type DataAdminExport,
  type ExportFilters,
  type Language,
} from "@/lib/dataAssets";
import { SectionCard, downloadMarkdown } from "./shared";

function t(language: Language, vi: string, en: string): string {
  return language === "en" ? en : vi;
}

export function ExportPanel({ language }: { language: Language }) {
  const [filters, setFilters] = useState<ExportFilters>({ ...EMPTY_EXPORT_FILTERS });
  const [result, setResult] = useState<DataAdminExport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function preview(event?: React.FormEvent) {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const data = await invokeDataAdmin({
        action: "export",
        stage: filters.stage || null,
        source_kind: filters.sourceKind || null,
        evaluation_status: filters.evaluationStatus || null,
        from: filters.from || null,
        to: filters.to || null,
        asset_ids: filters.assetIds,
        limit: filters.limit,
      }, exportResponseSchema, language);
      setResult(data);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : t(language, "Không tạo được bản xuất.", "Could not build the export."));
    } finally {
      setBusy(false);
    }
  }

  const bodyPreview = result?.markdown
    ? (result.markdown.length > 100_000 ? `${result.markdown.slice(0, 100_000)}\n… (preview truncated)` : result.markdown)
    : "";

  return (
    <div data-da-panel="export">
      <SectionCard
        title={t(language, "Xuất Markdown", "Markdown export")}
        hint={t(
          language,
          "Bản xuất áp dụng mọi bộ lọc (kể cả ngày) trước khi giới hạn dòng, nên số dòng và trạng thái cắt luôn khớp nhau. Nội dung gồm câu hỏi/câu trả lời gốc, bộ lọc đã thực thi, ngữ nghĩa đã duyệt Gold và bằng chứng.",
          "The export applies every filter (including dates) before the row limit, so the row count and truncation always match. It includes the original question/answer, executed filters, Gold-reviewed semantics and evidence.",
        )}
      >
        <form className="da-form" onSubmit={(event) => void preview(event)}>
          <div className="da-form-row">
            <label className="da-field">
              {t(language, "Giai đoạn", "Stage")}
              <select className="da-select" value={filters.stage} onChange={(event) => setFilters({ ...filters, stage: event.target.value as ExportFilters["stage"] })}>
                <option value="">{t(language, "Tất cả", "All")}</option>
                {ASSET_STAGES.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
              </select>
            </label>
            <label className="da-field">
              {t(language, "Nguồn", "Source")}
              <select className="da-select" value={filters.sourceKind} onChange={(event) => setFilters({ ...filters, sourceKind: event.target.value as ExportFilters["sourceKind"] })}>
                <option value="">{t(language, "Tất cả", "All")}</option>
                {SOURCE_KINDS.map((kind) => <option key={kind} value={kind}>{sourceKindLabel(kind, language)}</option>)}
              </select>
            </label>
            <label className="da-field">
              {t(language, "Trạng thái đánh giá", "Evaluation status")}
              <select className="da-select" value={filters.evaluationStatus} onChange={(event) => setFilters({ ...filters, evaluationStatus: event.target.value })}>
                <option value="">{t(language, "Tất cả", "All")}</option>
                {EVALUATION_STATUSES.map((status) => <option key={status} value={status}>{evaluationLabel(status, language)}</option>)}
              </select>
            </label>
            <label className="da-field">
              {t(language, "Từ ngày / snapshot", "From date / snapshot")}
              <input className="da-input" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
            </label>
            <label className="da-field">
              {t(language, "Đến ngày / snapshot", "To date / snapshot")}
              <input className="da-input" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
            </label>
            <label className="da-field">
              {t(language, "Giới hạn dòng (1–200)", "Row limit (1–200)")}
              <input className="da-input" type="number" min={1} max={200} value={filters.limit} onChange={(event) => setFilters({ ...filters, limit: Math.max(1, Math.min(200, Number(event.target.value) || 1)) })} />
            </label>
          </div>
          <div className="da-actions">
            <button type="submit" className="da-btn da-btn--primary" disabled={busy}>{busy ? t(language, "Đang tạo…", "Building…") : t(language, "Xem trước", "Preview")}</button>
            <button type="button" className="da-btn" disabled={!result} onClick={() => result && downloadMarkdown(result.markdown, exportFileName(new Date()))}>{t(language, "Tải .md", "Download .md")}</button>
            <button type="button" className="da-btn da-btn--ghost" onClick={() => { setFilters({ ...EMPTY_EXPORT_FILTERS }); setResult(null); setError(""); }}>{t(language, "Xóa bộ lọc", "Clear filters")}</button>
          </div>
          <p className="da-scope">
            <span className="da-chip">stage={filters.stage || "all"}</span>
            <span className="da-chip">source={filters.sourceKind || "all"}</span>
            <span className="da-chip">status={filters.evaluationStatus || "all"}</span>
            <span className="da-chip">from={filters.from || "unbounded"}</span>
            <span className="da-chip">to={filters.to || "unbounded"}</span>
            <span className="da-chip">asset_ids={filters.assetIds ? filters.assetIds.length : "all"}</span>
            <span className="da-chip">limit={filters.limit}</span>
          </p>
        </form>

        {error && <div className="da-alert da-alert--error" role="alert" style={{ marginTop: 12 }}>{error}</div>}
        {result && (
          <>
            <p className="da-notice" style={{ marginTop: 12 }} role="status">
              {t(language, `Đã tạo ${result.count}/${result.total} dòng`, `Built ${result.count} of ${result.total} rows`)}{result.truncated ? t(language, " (đã cắt theo giới hạn)", " (truncated to the limit)") : ""}.
            </p>
            <pre className="da-preview" aria-label={t(language, "Xem trước Markdown", "Markdown preview")}>{bodyPreview}</pre>
          </>
        )}
      </SectionCard>
    </div>
  );
}
