// Owner-only Generate Data panel: run a bounded batch of synthetic evaluation
// questions from supported BMQ business definitions and curated built-in example
// questions.
//
// Reuses the same owner-gated edge action and honest recovery contract as the
// other panels: a batch is durable (job row keyed by the batch key), the cost is
// bounded before any paid call, and an uncertain outcome is reconciled by reading
// the EXACT batch key back instead of resubmitting. The exact validated request is
// persisted with the key, so a retry after reload is the SAME run, never a batch
// with silently reset fields.
import { useEffect, useRef, useState } from "react";
import { DataAdminRequestError, invokeDataAdmin } from "@/lib/dataAssetsApi";
import {
  GENERATION_BUDGET_MAX,
  GENERATION_BUDGET_MIN,
  GENERATION_COUNT_MAX,
  GENERATION_COUNT_MIN,
  GENERATION_LANGUAGES,
  GENERATION_TOPICS,
  defaultGenerationStyleMix,
  formatDateTime,
  formatNumber,
  generationHistoryResponseSchema,
  generationRecoveryDecision,
  generationResponseSchema,
  generationStatusLabel,
  isDefinitiveGenerationDenial,
  parsePendingGeneration,
  serializePendingGeneration,
  type GenerationJob,
  type Language,
  type PendingGeneration,
  type PendingGenerationRequest,
} from "@/lib/dataAssets";
import { SectionCard } from "./shared";

function t(language: Language, vi: string, en: string): string {
  return language === "en" ? en : vi;
}

function money(value: unknown): string {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) ? `$${parsed.toFixed(4)}` : "—";
}

/** Durable batch key; the server produces one when the client cannot. */
function newIdempotencyKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `gen-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }
}

function ResultsList({ job, language }: { job: GenerationJob; language: Language }) {
  const summary = (job.result_summary ?? {}) as Record<string, unknown>;
  const created = Number(summary.created ?? 0);
  const duplicate = Number(summary.duplicate ?? 0);
  return (
    <div className="da-form-row" data-da-generation-results={job.status}>
      <div className="da-field"><span className="da-meta">{t(language, "Trạng thái job", "Job status")}</span><strong>{generationStatusLabel(job.status, language)}</strong></div>
      <div className="da-field"><span className="da-meta">{t(language, "Đã lưu mới", "Created")}</span><strong>{formatNumber(created, language)}</strong></div>
      <div className="da-field"><span className="da-meta">{t(language, "Trùng (bỏ qua)", "Duplicates skipped")}</span><strong>{formatNumber(duplicate, language)}</strong></div>
      <div className="da-field"><span className="da-meta">{t(language, "Chi phí tối đa", "Worst-case cost")}</span><strong>{money(job.worst_case_cost_usd)}</strong></div>
      <div className="da-field"><span className="da-meta">{t(language, "Chi phí thực tế", "Actual cost")}</span><strong>{money(job.actual_cost_usd)}</strong></div>
    </div>
  );
}

type RecoveryState = "unknown" | "running" | "absent" | "terminal" | "abandoned";

export function GeneratePanel({ language, ownerId }: { language: Language; ownerId: string }) {
  const [topic, setTopic] = useState<string>("mixed");
  const [count, setCount] = useState(20);
  const [targetLanguage, setTargetLanguage] = useState<"vi" | "en">("vi");
  const [budget, setBudget] = useState("1.00");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  // The uncertain run keeps its exact key AND request; a blind retry is locked
  // until the durable job for that key has been read back.
  const [pending, setPending] = useState<PendingGeneration | null>(null);
  const [recovery, setRecovery] = useState<RecoveryState>("unknown");
  const [history, setHistory] = useState<GenerationJob[]>([]);

  const mountedRef = useRef(true);
  const controllersRef = useRef<Set<AbortController>>(new Set());
  // Owner-scoped, so switching accounts can never inherit another owner's pending batch.
  const storageKey = `vnagent-generate-pending:${ownerId}`;

  const mix = defaultGenerationStyleMix(count);
  const budgetNumber = Number(budget);

  function readPending(): PendingGeneration | null {
    try {
      return parsePendingGeneration(window.localStorage.getItem(storageKey));
    } catch {
      return null;
    }
  }

  function writePending(value: PendingGeneration | null) {
    try {
      if (value) window.localStorage.setItem(storageKey, serializePendingGeneration(value));
      else window.localStorage.removeItem(storageKey);
    } catch {
      // Persistence is best effort; the lock still holds for this session.
    }
  }

  function track() {
    const controller = new AbortController();
    controllersRef.current.add(controller);
    return controller;
  }

  function release(controller: AbortController) {
    controllersRef.current.delete(controller);
  }

  function clearPending() {
    setPending(null);
    setRecovery("unknown");
    writePending(null);
  }

  function restoreForm(request: PendingGenerationRequest) {
    setTopic(request.topic);
    setCount(request.count);
    setTargetLanguage(request.target_language);
    setBudget(String(request.budget_usd));
  }

  async function loadHistory() {
    const controller = track();
    try {
      const result = await invokeDataAdmin({ action: "generate_status" }, generationHistoryResponseSchema, language, controller.signal);
      if (!mountedRef.current) return;
      setHistory(result.jobs ?? (result.job ? [result.job] : []));
    } catch {
      // The history read is a convenience; the form still works without it.
    } finally {
      release(controller);
    }
  }

  // Read the EXACT batch key back. The lock is only released by a terminal state or
  // a server-verified expired lease; a running or absent job keeps it.
  async function reconcileKey(run: PendingGeneration) {
    const controller = track();
    setBusy(true);
    try {
      const result = await invokeDataAdmin({ action: "generate_status", idempotency_key: run.key }, generationHistoryResponseSchema, language, controller.signal);
      if (!mountedRef.current) return;
      const found = result.job ?? null;
      const decision = generationRecoveryDecision({ jobStatus: found?.status, abandoned: result.abandoned === true, absent: !found });
      if (!found) {
        setRecovery("absent");
        setStatus({
          tone: "error",
          text: t(
            language,
            "Chưa tìm thấy lô nào cho đúng lượt chạy này. Chưa chạy lô mới; anh đọc lại, hoặc chạy lại an toàn đúng lượt cũ nếu đã có đủ thông tin.",
            "No batch was found for this exact run yet. No new batch was started; read again, or safely retry the same run if it is available.",
          ),
        });
      } else if (result.abandoned === true) {
        setJob(found);
        setRecovery("abandoned");
        clearPending();
        setStatus({
          tone: "error",
          text: t(
            language,
            "Lượt chạy trước đã hết hạn thuê và được hệ thống xác nhận là bỏ dở; không có lần gọi model trả phí nào được lặp lại. Anh có thể chạy lô mới.",
            "The previous run's lease expired and the server confirms it is abandoned; no paid call was repeated. You can start a new batch.",
          ),
        });
      } else if (decision === "keep" && found.status === "running") {
        setJob(found);
        setRecovery("running");
        setPending(run);
        setStatus({
          tone: "ok",
          text: t(language, "Lô này vẫn đang chạy. Anh đọc lại trạng thái trước khi chạy lô mới.", "This batch is still running. Read the state again before starting a new batch."),
        });
      } else {
        setJob(found);
        setRecovery("terminal");
        clearPending();
        setStatus({
          tone: found.status === "completed" ? "ok" : "error",
          text: t(
            language,
            `Đã đọc lại: lô kết thúc ở trạng thái ${generationStatusLabel(found.status, language)}${found.error_code ? ` (${found.error_code})` : ""}.`,
            `Reconciled: the batch finished as ${generationStatusLabel(found.status, language)}${found.error_code ? ` (${found.error_code})` : ""}.`,
          ),
        });
      }
      void loadHistory();
    } catch (caught) {
      if (!mountedRef.current) return;
      setRecovery("unknown");
      setPending(run);
      setStatus({ tone: "error", text: caught instanceof Error ? caught.message : t(language, "Chưa đọc lại được trạng thái lô.", "Could not read the batch state.") });
    } finally {
      release(controller);
      if (mountedRef.current) setBusy(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    const stored = readPending();
    if (stored) {
      setPending(stored);
      // Restore the EXACT request of the pending run so the visible form and a
      // safe retry describe the same batch, even after a reload. Reconcile (which
      // refreshes the history itself) is the ONLY request, so the owner's
      // single-flight guard is not tripped by two concurrent admin calls.
      if (stored.request) restoreForm(stored.request);
      void reconcileKey(stored);
    } else {
      void loadHistory();
    }
    return () => {
      // Account switch / unmount: cancel in-flight reads and ignore their responses.
      mountedRef.current = false;
      for (const controller of controllersRef.current) controller.abort();
      controllersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId]);

  async function submit(event: React.FormEvent | null, exact?: PendingGeneration) {
    if (event) event.preventDefault();
    if (busy) return;
    if (!exact && pending) return;
    setStatus(null);
    const run: PendingGeneration = exact ?? {
      key: newIdempotencyKey(),
      request: { topic, count, target_language: targetLanguage, budget_usd: budgetNumber },
    };
    const request = run.request;
    if (!request) return;
    if (!Number.isInteger(request.count) || request.count < GENERATION_COUNT_MIN || request.count > GENERATION_COUNT_MAX) {
      setStatus({ tone: "error", text: t(language, `Số câu phải từ ${GENERATION_COUNT_MIN} đến ${GENERATION_COUNT_MAX}.`, `The count must be between ${GENERATION_COUNT_MIN} and ${GENERATION_COUNT_MAX}.`) });
      return;
    }
    if (!Number.isFinite(request.budget_usd) || request.budget_usd < GENERATION_BUDGET_MIN || request.budget_usd > GENERATION_BUDGET_MAX) {
      setStatus({ tone: "error", text: t(language, `Ngân sách phải từ $${GENERATION_BUDGET_MIN} đến $${GENERATION_BUDGET_MAX}.`, `The budget must be between $${GENERATION_BUDGET_MIN} and $${GENERATION_BUDGET_MAX}.`) });
      return;
    }
    const controller = track();
    setBusy(true);
    // Persist BEFORE dispatch so a reload during the paid call recovers the same key AND request.
    writePending(run);
    setPending(run);
    try {
      const result = await invokeDataAdmin({
        action: "generate",
        topic: request.topic,
        count: request.count,
        target_language: request.target_language,
        budget_usd: request.budget_usd,
        idempotency_key: run.key,
      }, generationResponseSchema, language, controller.signal);
      if (!mountedRef.current) return;
      setJob(result.job);
      setQuestions((result.assets ?? []).map((asset) => asset.question));
      if (result.status === "ok" || result.status === "failed" || result.status === "budget_exceeded" || result.status === "abandoned") {
        clearPending();
      } else {
        setRecovery(result.status === "in_progress" ? "running" : "unknown");
      }
      if (result.status === "ok") {
        setStatus({ tone: "ok", text: t(language, `Đã tạo ${formatNumber(result.results.created, language)} câu vào Raw (synthetic / LLM-generated) để chờ duyệt.`, `Created ${formatNumber(result.results.created, language)} Raw synthetic / LLM-generated questions for review.`) });
      } else if (result.status === "failed" || result.status === "budget_exceeded") {
        setStatus({ tone: "error", text: t(language, `Lô kết thúc ở trạng thái ${generationStatusLabel(result.job.status, language)}; không có câu nào được lưu.`, `The batch finished as ${generationStatusLabel(result.job.status, language)}; nothing was stored.`) });
      } else {
        setStatus({ tone: "error", text: t(language, "Lô đang chạy hoặc đã được đọc lại từ job bền vững.", "The batch is running or was read back from the durable job.") });
      }
      void loadHistory();
    } catch (caught) {
      if (!mountedRef.current) return;
      const definitive = caught instanceof DataAdminRequestError && isDefinitiveGenerationDenial(caught.code, caught.uncertain);
      if (definitive) {
        // Definitive pre-dispatch denial: no durable batch exists for this key.
        clearPending();
        setStatus({ tone: "error", text: caught.message });
      } else {
        // Uncertain OR possibly post-dispatch store failure: keep the durable pending record.
        setPending(run);
        writePending(run);
        setRecovery("unknown");
        setStatus({
          tone: "error",
          text: t(
            language,
            "Chưa rõ kết quả lô (mạng/máy chủ). Cần đọc lại trạng thái lô trước khi chạy lại để tránh gọi model trả phí lần hai.",
            "The batch outcome is unknown (network/server). Read the batch state before retrying so the paid model is not called twice.",
          ),
        });
      }
    } finally {
      release(controller);
      if (mountedRef.current) setBusy(false);
    }
  }

  const locked = busy || pending !== null;

  return (
    <div data-da-panel="generate">
      <SectionCard
        title={t(language, "Tạo câu hỏi tổng hợp", "Generate data")}
        hint={t(
          language,
          "Chạy một lô 20–50 câu hỏi tổng hợp từ định nghĩa nghiệp vụ BMQ được hỗ trợ và câu hỏi ví dụ có sẵn trong nguồn đã duyệt. Mọi câu vào Raw với nguồn synthetic / do LLM tạo; chủ doanh nghiệp vẫn duyệt Curated/Gold như cũ. Không dùng để huấn luyện model và không tự tạo nhãn đúng.",
          "Run a 20–50 question synthetic batch from supported BMQ business definitions and built-in example questions shipped in reviewed source. Every question lands in Raw as synthetic / LLM-generated; the owner still reviews Curated/Gold as before. This is not used to train a model and never self-labels truth.",
        )}
      >
        <form className="da-form" onSubmit={(event) => void submit(event)} data-da-generation-form="owner">
          <div className="da-form-row">
            <label className="da-field">
              {t(language, "Chủ đề", "Topic")}
              <select className="da-select" value={topic} onChange={(event) => setTopic(event.target.value)} data-da-generation-topic>
                {GENERATION_TOPICS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
            </label>
            <label className="da-field">
              {t(language, "Số câu (20–50)", "Count (20–50)")}
              <input className="da-input" type="number" min={GENERATION_COUNT_MIN} max={GENERATION_COUNT_MAX} step={1} value={count} onChange={(event) => setCount(Number(event.target.value))} data-da-generation-count />
            </label>
            <label className="da-field">
              {t(language, "Ngôn ngữ câu hỏi", "Question language")}
              <select className="da-select" value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value as "vi" | "en")} data-da-generation-language>
                {GENERATION_LANGUAGES.map((value) => <option key={value} value={value}>{value === "vi" ? t(language, "Tiếng Việt", "Vietnamese") : t(language, "Tiếng Anh", "English")}</option>)}
              </select>
            </label>
            <label className="da-field">
              {t(language, "Ngân sách tối đa (USD)", "Hard budget (USD)")}
              <input className="da-input" type="number" min={GENERATION_BUDGET_MIN} max={GENERATION_BUDGET_MAX} step="0.01" value={budget} onChange={(event) => setBudget(event.target.value)} data-da-generation-budget />
            </label>
          </div>

          <p className="da-notice" data-da-generation-mix>
            {t(
              language,
              `Tỷ lệ mặc định: biến thể ${mix.variant} · lỗi gõ ${mix.typo} · mơ hồ ${mix.ambiguous} · ngoài phạm vi ${mix.out_of_scope}. Nếu giá model chưa cấu hình hoặc ngân sách thấp hơn chi phí tối đa, hệ thống từ chối trước khi gọi model.`,
              `Default split: variant ${mix.variant} · typo ${mix.typo} · ambiguous ${mix.ambiguous} · out-of-scope ${mix.out_of_scope}. If the model price is unconfigured or the budget is below the worst-case cost, the batch is refused before any model call.`,
            )}
          </p>

          {status && <div className={`da-alert ${status.tone === "ok" ? "da-alert--ok" : "da-alert--error"}`} role={status.tone === "ok" ? "status" : "alert"}>{status.text}</div>}

          <div className="da-actions">
            <button type="submit" className="da-btn da-btn--primary" disabled={locked} data-da-generation-run>
              {busy ? t(language, "Đang chạy lô…", "Running batch…") : t(language, "Chạy lô", "Run batch")}
            </button>
            {pending && (
              <button type="button" className="da-btn" disabled={busy} onClick={() => void reconcileKey(pending)} data-da-generation-reconcile>
                {t(language, "Đọc lại trạng thái lô", "Read batch state")}
              </button>
            )}
            {pending?.request && recovery === "absent" && (
              <button type="button" className="da-btn" disabled={busy} onClick={() => void submit(null, pending)} data-da-generation-safe-retry>
                {t(language, "Chạy lại an toàn đúng lượt cũ", "Safely retry this run")}
              </button>
            )}
            <span className="da-notice">{t(language, "Lần chạy trùng được nhận diện tự động nên model không bị gọi hai lần.", "Repeated runs are recognised automatically, so the model is never called twice.")}</span>
          </div>
        </form>

        {job && (
          <div className="da-card" style={{ marginTop: 12 }}>
            <ResultsList job={job} language={language} />
            {questions.length > 0 && (
              <details>
                <summary>{t(language, `Câu hỏi đã tạo (${questions.length})`, `Generated questions (${questions.length})`)}</summary>
                <ul className="da-list">
                  {questions.map((question, index) => <li key={index}>{question}</li>)}
                </ul>
              </details>
            )}
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <h3 className="da-card-title">{t(language, "Lô gần đây", "Recent runs")}</h3>
          {history.length === 0
            ? <p className="da-notice">{t(language, "Chưa có lô nào.", "No runs yet.")}</p>
            : (
              <div className="da-table-wrap">
                <table className="da-table">
                  <thead><tr>
                    <th>{t(language, "Thời điểm", "Started")}</th>
                    <th>{t(language, "Trạng thái", "Status")}</th>
                    <th>{t(language, "Số câu", "Count")}</th>
                    <th>{t(language, "Đã lưu", "Created")}</th>
                    <th>{t(language, "Mô hình", "Model")}</th>
                  </tr></thead>
                  <tbody>
                    {history.map((entry) => {
                      const request = (entry.request ?? {}) as Record<string, unknown>;
                      const summary = (entry.result_summary ?? {}) as Record<string, unknown>;
                      return (
                        <tr key={entry.id}>
                          <td>{formatDateTime(entry.created_at, language)}</td>
                          <td>{generationStatusLabel(entry.status, language)}</td>
                          <td>{formatNumber(Number(request.count ?? 0), language)}</td>
                          <td>{formatNumber(Number(summary.created ?? 0), language)}</td>
                          <td>{entry.model ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </SectionCard>
    </div>
  );
}
