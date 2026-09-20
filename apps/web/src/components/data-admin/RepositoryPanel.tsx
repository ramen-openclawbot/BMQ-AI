// Dataset repository: filtered browse + read-only detail for owner review,
// including the ORIGINAL question/answer/provenance next to the reviewed
// semantics, and a single-case .md export.
import { useCallback, useState } from "react";
import { invokeDataAdmin } from "@/lib/dataAssetsApi";
import {
  ASSET_STAGES,
  EMPTY_ASSET_FILTERS,
  SOURCE_KINDS,
  assetsResponseSchema,
  designationLabel,
  evaluationLabel,
  exportFileName,
  exportResponseSchema,
  formatDateTime,
  sourceKindLabel,
  type AssetFilters,
  type DataAsset,
  type Language,
} from "@/lib/dataAssets";
import { EmptyBlock, ErrorBlock, LoadingBlock, SectionCard, StageBadge, downloadMarkdown, toLocalNumber, useAsync } from "./shared";

function t(language: Language, vi: string, en: string): string {
  return language === "en" ? en : vi;
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <p className="da-meta">
      <strong>{label}:</strong>{" "}
      <code>{value === null || value === undefined ? "—" : JSON.stringify(value)}</code>
    </p>
  );
}

export function RepositoryPanel({ language }: { language: Language }) {
  const [draft, setDraft] = useState<AssetFilters>({ ...EMPTY_ASSET_FILTERS });
  const [applied, setApplied] = useState<AssetFilters>({ ...EMPTY_ASSET_FILTERS });
  const [selected, setSelected] = useState<DataAsset | null>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [exportError, setExportError] = useState("");

  const load = useCallback(
    () => invokeDataAdmin({
      action: "assets",
      stage: applied.stage || null,
      source_kind: applied.sourceKind || null,
      evaluation_status: applied.evaluationStatus || null,
      search: applied.search || null,
      limit: applied.limit,
      offset: applied.offset,
    }, assetsResponseSchema, language),
    [applied, language],
  );
  const { data, loading, error, reload } = useAsync(load, [load]);

  const rows = data?.assets ?? [];
  const total = data?.total ?? rows.length;
  const pageStart = applied.offset + 1;
  const pageEnd = applied.offset + rows.length;

  async function exportOne(asset: DataAsset) {
    setExportingId(asset.id);
    setExportError("");
    try {
      const result = await invokeDataAdmin({ action: "export", asset_ids: [asset.id], limit: 1 }, exportResponseSchema, language);
      downloadMarkdown(result.markdown, exportFileName(new Date()));
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : t(language, "Không xuất được tài sản này.", "Could not export this asset."));
    } finally {
      setExportingId(null);
    }
  }

  return (
    <div data-da-panel="repository">
      <SectionCard
        title={t(language, "Kho tài sản dữ liệu", "Dataset repository")}
        hint={t(
          language,
          "Bộ lọc chạy trên máy chủ theo quyền owner. Tài sản vẫn giữ nguyên giai đoạn; đây chỉ là lớp xem.",
          "Filters run server-side under the owner role. This view is read-only and never changes an asset's stage.",
        )}
      >
        <form
          className="da-form"
          onSubmit={(event) => {
            event.preventDefault();
            setSelected(null);
            setApplied({ ...draft, offset: 0 });
          }}
        >
          <div className="da-form-row">
            <label className="da-field">
              {t(language, "Giai đoạn", "Stage")}
              <select className="da-select" value={draft.stage} onChange={(event) => setDraft({ ...draft, stage: event.target.value as AssetFilters["stage"] })}>
                <option value="">{t(language, "Tất cả", "All")}</option>
                {ASSET_STAGES.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
              </select>
            </label>
            <label className="da-field">
              {t(language, "Nguồn", "Source")}
              <select className="da-select" value={draft.sourceKind} onChange={(event) => setDraft({ ...draft, sourceKind: event.target.value as AssetFilters["sourceKind"] })}>
                <option value="">{t(language, "Tất cả", "All")}</option>
                {SOURCE_KINDS.map((kind) => <option key={kind} value={kind}>{sourceKindLabel(kind, language)}</option>)}
              </select>
            </label>
            <label className="da-field">
              {t(language, "Trạng thái đánh giá", "Evaluation status")}
              <select className="da-select" value={draft.evaluationStatus} onChange={(event) => setDraft({ ...draft, evaluationStatus: event.target.value })}>
                <option value="">{t(language, "Tất cả", "All")}</option>
                <option value="not_evaluated">{evaluationLabel("not_evaluated", language)}</option>
                <option value="pending_review">{evaluationLabel("pending_review", language)}</option>
                <option value="verified">{evaluationLabel("verified", language)}</option>
                <option value="rejected">{evaluationLabel("rejected", language)}</option>
              </select>
            </label>
            <label className="da-field">
              {t(language, "Tìm theo câu hỏi", "Search questions")}
              <input className="da-input" maxLength={200} value={draft.search} onChange={(event) => setDraft({ ...draft, search: event.target.value })} placeholder={t(language, "Ví dụ: doanh thu", "e.g. revenue")} />
            </label>
          </div>
          <div className="da-actions">
            <button type="submit" className="da-btn da-btn--primary">{t(language, "Áp dụng bộ lọc", "Apply filters")}</button>
            <button type="button" className="da-btn da-btn--ghost" onClick={() => { const empty = { ...EMPTY_ASSET_FILTERS }; setDraft(empty); setApplied(empty); setSelected(null); }}>
              {t(language, "Xóa bộ lọc", "Clear filters")}
            </button>
            <span className="da-scope">
              <span className="da-chip">stage={applied.stage || "all"}</span>
              <span className="da-chip">source={applied.sourceKind || "all"}</span>
              <span className="da-chip">status={applied.evaluationStatus || "all"}</span>
            </span>
          </div>
        </form>
        {exportError && <div className="da-alert da-alert--error" role="alert" style={{ marginTop: 12 }}>{exportError}</div>}
      </SectionCard>

      <SectionCard
        title={t(language, "Kết quả", "Results")}
        hint={data ? t(language, `Hiển thị ${pageStart}–${pageEnd} trên ${toLocalNumber(total)} tài sản`, `Showing ${pageStart}–${pageEnd} of ${toLocalNumber(total)} assets`) : undefined}
        actions={<button type="button" className="da-btn" onClick={() => void reload()} disabled={loading}>{t(language, "Tải lại", "Refresh")}</button>}
      >
        {loading && <LoadingBlock label={t(language, "Đang tải kho dữ liệu…", "Loading repository…")} />}
        {!loading && error && <ErrorBlock message={error} onRetry={() => void reload()} retryLabel={t(language, "Thử lại", "Retry")} />}
        {!loading && !error && rows.length === 0 && <EmptyBlock label={t(language, "Không có tài sản dữ liệu khớp bộ lọc.", "No dataset assets match the filters.")} />}
        {!loading && !error && rows.length > 0 && (
          <div className="da-tablewrap">
            <table className="da-table">
              <caption>{t(language, "Danh sách tài sản dữ liệu (chọn một dòng để xem chi tiết)", "Dataset assets (select a row for detail)")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t(language, "Giai đoạn", "Stage")}</th>
                  <th scope="col">{t(language, "Câu hỏi cuối cùng", "Final question")}</th>
                  <th scope="col">{t(language, "Nguồn", "Source")}</th>
                  <th scope="col">{t(language, "Đánh giá", "Evaluation")}</th>
                  <th scope="col">{t(language, "Phiên bản", "Version")}</th>
                  <th scope="col">{t(language, "Cập nhật", "Updated")}</th>
                  <th scope="col">{t(language, "Xuất", "Export")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((asset) => (
                  <tr key={asset.id} data-selected={selected?.id === asset.id ? "true" : "false"}>
                    <td><StageBadge stage={asset.dataset_stage} language={language} /></td>
                    <td>
                      <button type="button" className="da-btn da-btn--ghost" style={{ padding: 0, minHeight: "auto", textAlign: "left", fontWeight: 500 }} onClick={() => setSelected(asset)} aria-expanded={selected?.id === asset.id}>
                        <span className="da-question">{asset.question}</span>
                      </button>
                    </td>
                    <td>{sourceKindLabel(asset.source_kind, language)}<br /><span className="da-meta">{designationLabel(asset.source_designation, language)}</span></td>
                    <td>{evaluationLabel(asset.evaluation_status, language)}</td>
                    <td>v{asset.version}</td>
                    <td>{formatDateTime(asset.updated_at, language)}</td>
                    <td>
                      <button type="button" className="da-btn da-btn--ghost" disabled={exportingId === asset.id} onClick={() => void exportOne(asset)} data-da-export-asset={asset.id}>
                        {exportingId === asset.id ? t(language, "Đang xuất…", "Exporting…") : t(language, "Xuất .md", "Export .md")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && !error && rows.length > 0 && (
          <div className="da-actions" style={{ marginTop: 12 }}>
            <button type="button" className="da-btn" disabled={applied.offset === 0} onClick={() => setApplied({ ...applied, offset: Math.max(0, applied.offset - applied.limit) })}>
              {t(language, "Trang trước", "Previous")}
            </button>
            <button type="button" className="da-btn" disabled={pageEnd >= total} onClick={() => setApplied({ ...applied, offset: applied.offset + applied.limit })}>
              {t(language, "Trang sau", "Next")}
            </button>
          </div>
        )}
      </SectionCard>

      {selected && (
        <SectionCard
          title={t(language, "Chi tiết tài sản", "Asset detail")}
          actions={
            <div className="da-actions">
              <button type="button" className="da-btn da-btn--primary" disabled={exportingId === selected.id} onClick={() => void exportOne(selected)}>
                {t(language, "Xuất tài sản này (.md)", "Export this asset (.md)")}
              </button>
              <button type="button" className="da-btn da-btn--ghost" onClick={() => setSelected(null)}>{t(language, "Đóng", "Close")}</button>
            </div>
          }
        >
          <div className="da-item">
            <div className="da-item-head">
              <StageBadge stage={selected.dataset_stage} language={language} />
              <span className="da-badge da-badge--muted">{evaluationLabel(selected.evaluation_status, language)}</span>
              <span className="da-badge da-badge--muted">v{selected.version}</span>
              <span className="da-badge da-badge--muted">{sourceKindLabel(selected.source_kind, language)}</span>
            </div>
            <p className="da-meta"><strong>{t(language, "Câu hỏi gốc", "Original question")}:</strong> {selected.question}</p>
            <p className="da-meta"><strong>{t(language, "Câu trả lời gốc (chỉ để tham chiếu)", "Original answer (reference only)")}:</strong> {selected.source_answer ?? t(language, "không có", "none")}</p>
            <JsonBlock label={t(language, "Bộ lọc đã thực thi", "Executed filters")} value={selected.provenance?.executedFilters ?? selected.expected_filters} />
            <JsonBlock label={t(language, "Ý định mong đợi", "Expected intent")} value={selected.expected_intent} />
            <JsonBlock label={t(language, "Nguồn gốc / snapshot", "Provenance / snapshot")} value={selected.provenance} />
            <p className="da-meta"><strong>{t(language, "Ảnh chụp", "Snapshot")}:</strong> {formatDateTime(selected.snapshot_at, language)} · <strong>{t(language, "Hiệu lực xuất", "Export effective at")}:</strong> {formatDateTime(selected.effective_at, language)}</p>
            {selected.dataset_stage === "gold" && (
              <>
                <hr className="da-hr" />
                <p className="da-meta"><strong>{t(language, "Ngữ nghĩa đã duyệt Gold", "Gold-reviewed semantics")}</strong></p>
                <JsonBlock label={t(language, "Ý định đã xác minh", "Verified intent")} value={selected.verified_intent} />
                <JsonBlock label={t(language, "Điều kiện đã xác minh", "Verified conditions")} value={selected.verified_conditions} />
                <JsonBlock label={t(language, "Bằng chứng", "Evidence")} value={selected.evidence} />
              </>
            )}
            <p className="da-meta"><strong>{t(language, "Người duyệt", "Reviewer")}:</strong> {selected.reviewer_id ?? t(language, "chưa có", "none")} · <strong>{t(language, "Cập nhật", "Updated")}:</strong> {formatDateTime(selected.updated_at, language)}</p>
          </div>
        </SectionCard>
      )}
    </div>
  );
}
