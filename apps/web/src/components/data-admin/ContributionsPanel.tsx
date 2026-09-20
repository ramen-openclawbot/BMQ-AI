// Manual question contributions. Paste/submit is fully supported: no paid LLM
// generation is required, and the source is explicitly designated.
import { useState } from "react";
import { DataAdminRequestError, invokeDataAdmin } from "@/lib/dataAssetsApi";
import {
  MAX_FILTER_ROWS,
  SOURCE_DESIGNATIONS,
  SOURCE_KINDS,
  assetsResponseSchema,
  contributionResponseSchema,
  designationLabel,
  parseFilterRows,
  sourceKindLabel,
  type Language,
  type SourceDesignation,
  type SourceKind,
} from "@/lib/dataAssets";
import { SectionCard } from "./shared";

function t(language: Language, vi: string, en: string): string {
  return language === "en" ? en : vi;
}

interface FilterRow { key: string; value: string }

const MAX_FILTERS = MAX_FILTER_ROWS;

export function ContributionsPanel({ language }: { language: Language }) {
  const [question, setQuestion] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("contributor");
  const [designation, setDesignation] = useState<SourceDesignation>("manual");
  const [intent, setIntent] = useState("");
  const [filters, setFilters] = useState<FilterRow[]>([{ key: "", value: "" }]);
  const [provenance, setProvenance] = useState("");
  const [snapshotAt, setSnapshotAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  // When a submit outcome is unknown, retry stays locked until the durable state
  // has been read back (the dedupe key then prevents a duplicate contribution).
  const [uncertain, setUncertain] = useState<string | null>(null);

  async function reconcile() {
    if (!uncertain || busy) return;
    setBusy(true);
    try {
      const result = await invokeDataAdmin({ action: "assets", search: uncertain, limit: 5, offset: 0 }, assetsResponseSchema, language);
      const found = result.assets.some((asset) => asset.question === uncertain);
      setUncertain(null);
      setStatus({
        tone: "ok",
        text: found
          ? t(language, "Đã đọc lại: câu hỏi này đã có trong bộ dữ liệu, không tạo thêm bản ghi.", "Reconciled: this question already exists in the dataset; no extra record was created.")
          : t(language, "Đã đọc lại: chưa thấy bản ghi nào, anh có thể gửi lại an toàn.", "Reconciled: no matching record was found, so it is safe to submit again."),
      });
    } catch (caught) {
      setStatus({ tone: "error", text: caught instanceof Error ? caught.message : t(language, "Chưa đọc lại được trạng thái.", "Could not read the current state.") });
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || uncertain) return;
    setStatus(null);
    const trimmed = question.trim();
    if (!trimmed) { setStatus({ tone: "error", text: t(language, "Vui lòng nhập câu hỏi.", "Enter a question.") }); return; }
    let expectedFilters: Record<string, string>;
    try {
      expectedFilters = parseFilterRows(filters);
    } catch {
      setStatus({ tone: "error", text: t(language, `Bộ lọc chưa hợp lệ (tối đa ${MAX_FILTERS} khóa, mỗi dòng đủ khóa và giá trị).`, `Invalid filters (max ${MAX_FILTERS} keys; each row needs both key and value).`) });
      return;
    }
    setBusy(true);
    try {
      const result = await invokeDataAdmin({
        action: "contribute",
        question: trimmed,
        source_kind: sourceKind,
        source_designation: designation,
        expected_intent: intent.trim() ? { intent: intent.trim() } : {},
        expected_filters: expectedFilters,
        provenance: provenance.trim() ? { note: provenance.trim() } : {},
        ...(snapshotAt ? { snapshot_at: new Date(snapshotAt).toISOString() } : {}),
      }, contributionResponseSchema, language);
      setStatus({
        tone: "ok",
        text: result.duplicate
          ? t(language, "Câu hỏi này đã tồn tại trong bộ dữ liệu; không tạo bản trùng.", "This question already exists in the dataset; no duplicate was created.")
          : t(language, "Đã thêm vào giai đoạn Raw để chờ duyệt.", "Added to Raw and waiting for review."),
      });
      if (result.status === "created") {
        setQuestion(""); setIntent(""); setFilters([{ key: "", value: "" }]); setProvenance(""); setSnapshotAt("");
      }
      setUncertain(null);
    } catch (caught) {
      if (caught instanceof DataAdminRequestError && caught.uncertain) {
        setUncertain(trimmed);
        setStatus({
          tone: "error",
          text: t(
            language,
            "Chưa rõ kết quả gửi (mạng/máy chủ). Cần đọc lại trạng thái bên dưới trước khi gửi lại để tránh tạo trùng.",
            "The submit outcome is unknown (network/server). Read the current state below before retrying to avoid a duplicate.",
          ),
        });
      } else {
        setStatus({ tone: "error", text: caught instanceof Error ? caught.message : t(language, "Không gửi được đóng góp.", "Could not submit the contribution.") });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-da-panel="contributions">
      <SectionCard
        title={t(language, "Đóng góp câu hỏi", "Question contributions")}
        hint={t(
          language,
          "Dán và gửi câu hỏi cùng ý định/bộ lọc mong đợi. Không cần tạo bằng LLM trả phí; nếu có dùng LLM, hãy đánh dấu đúng nguồn. Bộ dữ liệu này không dùng để huấn luyện model.",
          "Paste and submit a question with its expected intent/filters. No paid LLM generation is required; if an LLM was used, mark the source honestly. This dataset is not used to train a model.",
        )}
      >
        <form className="da-form" onSubmit={submit}>
          <label className="da-field">
            {t(language, "Câu hỏi (giữ nguyên ngữ nghĩa cuối cùng)", "Question (final semantics preserved)")}
            <textarea className="da-textarea" maxLength={4000} required value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={t(language, "Ví dụ: Doanh thu có kiểm soát hôm nay là bao nhiêu?", "e.g. What is controlled revenue today?")} />
          </label>
          <div className="da-form-row">
            <label className="da-field">
              {t(language, "Loại nguồn", "Source kind")}
              <select className="da-select" value={sourceKind} onChange={(event) => setSourceKind(event.target.value as SourceKind)}>
                {SOURCE_KINDS.filter((kind) => kind !== "operational_chat").map((kind) => <option key={kind} value={kind}>{sourceKindLabel(kind, language)}</option>)}
              </select>
            </label>
            <label className="da-field">
              {t(language, "Nguồn tạo", "Source designation")}
              <select className="da-select" value={designation} onChange={(event) => setDesignation(event.target.value as SourceDesignation)}>
                {SOURCE_DESIGNATIONS.map((value) => <option key={value} value={value}>{designationLabel(value, language)}</option>)}
              </select>
            </label>
            <label className="da-field">
              {t(language, "Ý định mong đợi", "Expected intent")}
              <input className="da-input" maxLength={2000} value={intent} onChange={(event) => setIntent(event.target.value)} placeholder={t(language, "Ví dụ: tra cứu doanh thu theo ngày", "e.g. look up daily revenue")} />
            </label>
            <label className="da-field">
              {t(language, "Mốc snapshot (không bắt buộc)", "Snapshot time (optional)")}
              <input className="da-input" type="datetime-local" value={snapshotAt} onChange={(event) => setSnapshotAt(event.target.value)} />
            </label>
          </div>

          <fieldset style={{ border: "1px solid var(--da-line)", borderRadius: "var(--da-radius-sm)", padding: 12 }}>
            <legend className="da-meta">{t(language, `Bộ lọc mong đợi (tối đa ${MAX_FILTERS})`, `Expected filters (max ${MAX_FILTERS})`)}</legend>
            <div className="da-list">
              {filters.map((row, index) => (
                <div className="da-form-row" key={index}>
                  <label className="da-field">
                    {t(language, "Khóa", "Key")}
                    <input className="da-input" maxLength={60} value={row.key} onChange={(event) => setFilters(filters.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value } : item))} />
                  </label>
                  <label className="da-field">
                    {t(language, "Giá trị", "Value")}
                    <input className="da-input" maxLength={200} value={row.value} onChange={(event) => setFilters(filters.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} />
                  </label>
                  <div className="da-actions" style={{ alignItems: "flex-end" }}>
                    <button type="button" className="da-btn da-btn--ghost" onClick={() => setFilters(filters.length === 1 ? [{ key: "", value: "" }] : filters.filter((_, itemIndex) => itemIndex !== index))}>
                      {t(language, "Xóa dòng", "Remove")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button type="button" className="da-btn" style={{ marginTop: 10 }} disabled={filters.length >= MAX_FILTERS} onClick={() => setFilters([...filters, { key: "", value: "" }])}>
              {t(language, "Thêm bộ lọc", "Add filter")}
            </button>
          </fieldset>

          <label className="da-field">
            {t(language, "Ghi chú nguồn gốc (không bắt buộc)", "Provenance note (optional)")}
            <input className="da-input" maxLength={2000} value={provenance} onChange={(event) => setProvenance(event.target.value)} placeholder={t(language, "Ví dụ: chị Thủy cung cấp ngày 20/09", "e.g. provided by owner on 20 Sep")} />
          </label>

          {status && <div className={`da-alert ${status.tone === "ok" ? "da-alert--ok" : "da-alert--error"}`} role={status.tone === "ok" ? "status" : "alert"}>{status.text}</div>}

          <div className="da-actions">
            <button type="submit" className="da-btn da-btn--primary" disabled={busy || uncertain !== null}>{busy ? t(language, "Đang gửi…", "Submitting…") : t(language, "Gửi vào Raw", "Submit to Raw")}</button>
            {uncertain && (
              <button type="button" className="da-btn" disabled={busy} onClick={() => void reconcile()} data-da-reconcile="contribution">
                {t(language, "Đọc lại trạng thái", "Read current state")}
              </button>
            )}
            <span className="da-notice">{t(language, "Bản ghi trùng theo câu hỏi + loại nguồn + phạm vi mong đợi sẽ được trả về bản đã có, không tạo thêm.", "A duplicate by question + source kind + expected scope returns the existing record instead of creating another.")}</span>
          </div>
        </form>
      </SectionCard>
    </div>
  );
}
