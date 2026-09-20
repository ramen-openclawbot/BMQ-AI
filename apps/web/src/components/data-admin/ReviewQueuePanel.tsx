// Review queue: the only place where an owner promotes an asset one stage and,
// for Gold, supplies verified intent/conditions/evidence with optimistic version.
//
// The queue pages over ONE reviewable stage at a time using the server stage
// filter and the honest server total. It never fetches "latest N of all stages"
// and hides Gold on the client, which would make older pending assets unreachable.
import { useCallback, useState } from "react";
import { DataAdminRequestError, invokeDataAdmin } from "@/lib/dataAssetsApi";
import {
  REVIEW_PAGE_SIZE,
  REVIEWABLE_STAGES,
  assetsResponseSchema,
  reviewPageRange,
  reviewQueueQuery,
  stageLabel,
  transitionResponseSchema,
  evaluationLabel,
  formatDateTime,
  parseConditions,
  parseEvidenceLines,
  sourceKindLabel,
  type DataAsset,
  type Language,
  type ReviewableStage,
} from "@/lib/dataAssets";
import { EmptyBlock, ErrorBlock, LoadingBlock, SectionCard, StageBadge, useAsync } from "./shared";

function t(language: Language, vi: string, en: string): string {
  return language === "en" ? en : vi;
}

interface GoldDraft {
  intent: string;
  conditions: string;
  evidence: string;
}

const EMPTY_GOLD: GoldDraft = { intent: "", conditions: "", evidence: "" };

export function ReviewQueuePanel({ language }: { language: Language }) {
  const [stage, setStage] = useState<ReviewableStage>("curated");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [gold, setGold] = useState<GoldDraft>(EMPTY_GOLD);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(
    () => invokeDataAdmin(reviewQueueQuery(stage, offset), assetsResponseSchema, language),
    [language, stage, offset],
  );
  const { data, loading, error, reload } = useAsync(load, [load]);

  const queue = data?.assets ?? [];
  const total = data?.total ?? null;
  const selected = queue.find((asset) => asset.id === selectedId) ?? null;
  const hasPrev = offset > 0;
  const hasNext = total !== null && offset + queue.length < total;

  function resetDraft() {
    setSelectedId(null);
    setGold(EMPTY_GOLD);
    setReason("");
    setStatus(null);
  }

  function selectStage(next: ReviewableStage) {
    setStage(next);
    setOffset(0);
    resetDraft();
  }

  function goToPage(nextOffset: number) {
    setOffset(Math.max(0, nextOffset));
    resetDraft();
  }

  async function transition(asset: DataAsset, toStage: "raw" | "curated" | "gold", verified?: unknown, demotionReason?: string) {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      await invokeDataAdmin({
        action: "transition",
        asset_id: asset.id,
        expected_version: asset.version,
        to_stage: toStage,
        ...(demotionReason ? { reason: demotionReason } : {}),
        ...(verified ? { verified } : {}),
      }, transitionResponseSchema, language);
      resetDraft();
      setStatus({ tone: "ok", text: t(language, `Đã chuyển sang ${toStage} (v${asset.version + 1}).`, `Moved to ${toStage} (v${asset.version + 1}).`) });
      // If the page is now empty, step back a page; otherwise reload in place.
      if (queue.length <= 1 && offset > 0) {
        setOffset(Math.max(0, offset - REVIEW_PAGE_SIZE));
      } else {
        await reload();
      }
    } catch (caught) {
      // An uncertain failure (network/5xx) may already have applied, so read the
      // durable state back before the user can retry; the version guard then
      // makes any resent action safe instead of double-applying.
      const uncertain = caught instanceof DataAdminRequestError && caught.uncertain;
      setStatus({
        tone: "error",
        text: uncertain
          ? t(language, "Chưa rõ kết quả (mạng/máy chủ). Đang đọc lại trạng thái trước khi cho thao tác lại.", "The outcome is unknown (network/server). Re-reading the current state before retry.")
          : caught instanceof Error ? caught.message : t(language, "Thao tác thất bại.", "Action failed."),
      });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function submitGold(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const intent = gold.intent.trim();
    const conditions = parseConditions(gold.conditions);
    const evidence = parseEvidenceLines(gold.evidence);
    if (!intent) { setStatus({ tone: "error", text: t(language, "Gold cần ý định đã xác minh.", "Gold requires a verified intent.") }); return; }
    if (conditions === undefined || conditions === null) { setStatus({ tone: "error", text: t(language, "Điều kiện phải là JSON hợp lệ và không rỗng.", "Conditions must be valid, non-empty JSON.") }); return; }
    if (evidence.length === 0) { setStatus({ tone: "error", text: t(language, "Gold cần ít nhất một bằng chứng.", "Gold requires at least one piece of evidence.") }); return; }
    await transition(selected, "gold", { intent, conditions, evidence });
  }

  return (
    <div data-da-panel="review">
      <SectionCard
        title={t(language, "Hàng chờ duyệt", "Review queue")}
        hint={t(
          language,
          "Chỉ chuyển một bước: raw → curated → gold. Gold bắt buộc có ý định, điều kiện và bằng chứng đã xác minh; người duyệt là phiên owner hiện tại. Hàng chờ lọc theo giai đoạn ở máy chủ nên mọi tài sản chờ duyệt đều tới được, kể cả khi có hơn một trang.",
          "One step only: raw → curated → gold. Gold requires verified intent, conditions and evidence; the reviewer is the current owner session. The queue filters by stage on the server so every pending asset stays reachable, even beyond one page.",
        )}
        actions={<button type="button" className="da-btn" onClick={() => void reload()} disabled={loading}>{t(language, "Tải lại", "Refresh")}</button>}
      >
        {status && <div className={`da-alert ${status.tone === "ok" ? "da-alert--ok" : "da-alert--error"}`} role={status.tone === "ok" ? "status" : "alert"} style={{ marginBottom: 12 }}>{status.text}</div>}

        <div className="da-form-row" style={{ alignItems: "flex-end" }}>
          <label className="da-field">
            {t(language, "Giai đoạn cần duyệt", "Review stage")}
            <select className="da-select" value={stage} onChange={(event) => selectStage(event.target.value as ReviewableStage)} disabled={loading || busy}>
              {REVIEWABLE_STAGES.map((option) => <option key={option} value={option}>{stageLabel(option, language)}</option>)}
            </select>
          </label>
          <div className="da-actions" style={{ gap: 8 }}>
            <button type="button" className="da-btn" disabled={!hasPrev || loading || busy} onClick={() => goToPage(offset - REVIEW_PAGE_SIZE)}>
              {t(language, "← Trang trước", "← Previous")}
            </button>
            <span className="da-badge da-badge--muted" role="status" data-da-review-range>{reviewPageRange(offset, queue.length, total)}</span>
            <button type="button" className="da-btn" disabled={!hasNext || loading || busy} onClick={() => goToPage(offset + REVIEW_PAGE_SIZE)}>
              {t(language, "Trang sau →", "Next →")}
            </button>
          </div>
        </div>

        {loading && <LoadingBlock label={t(language, "Đang tải hàng chờ…", "Loading review queue…")} />}
        {!loading && error && <ErrorBlock message={error} onRetry={() => void reload()} retryLabel={t(language, "Thử lại", "Retry")} />}
        {!loading && !error && queue.length === 0 && (
          <EmptyBlock label={offset > 0
            ? t(language, "Trang này trống. Quay lại trang trước.", "This page is empty. Go back to the previous page.")
            : t(language, "Không có tài sản nào đang chờ duyệt ở giai đoạn này.", "No assets are awaiting review in this stage.")} />
        )}
        {!loading && !error && queue.length === 0 && offset > 0 && (
          <div className="da-actions" style={{ marginTop: 8 }}>
            <button type="button" className="da-btn" onClick={() => goToPage(offset - REVIEW_PAGE_SIZE)}>{t(language, "← Trang trước", "← Previous")}</button>
          </div>
        )}
        {!loading && !error && queue.length > 0 && (
          <div className="da-list">
            {queue.map((asset) => (
              <div className="da-item" key={asset.id}>
                <div className="da-item-head">
                  <StageBadge stage={asset.dataset_stage} language={language} />
                  <span className="da-badge da-badge--muted">{evaluationLabel(asset.evaluation_status, language)}</span>
                  <span className="da-badge da-badge--muted">v{asset.version}</span>
                  <span className="da-badge da-badge--muted">{sourceKindLabel(asset.source_kind, language)}</span>
                </div>
                <p className="da-question" style={{ fontWeight: 600, marginBottom: 6 }}>{asset.question}</p>
                <p className="da-meta"><strong>{t(language, "Câu trả lời gốc (chỉ để tham chiếu)", "Original answer (reference only)")}:</strong> {asset.source_answer ?? t(language, "không có", "none")}</p>
                <p className="da-meta"><strong>{t(language, "Bộ lọc đã thực thi", "Executed filters")}:</strong> <code>{JSON.stringify(asset.provenance?.executedFilters ?? asset.expected_filters)}</code></p>
                <p className="da-meta"><strong>{t(language, "Ý định mong đợi", "Expected intent")}:</strong> <code>{JSON.stringify(asset.expected_intent)}</code></p>
                <p className="da-meta">{t(language, "Cập nhật", "Updated")}: {formatDateTime(asset.updated_at, language)}</p>
                <div className="da-actions" style={{ marginTop: 10 }}>
                  {asset.dataset_stage === "raw" && (
                    <button type="button" className="da-btn da-btn--primary" disabled={busy} onClick={() => void transition(asset, "curated")}>
                      {t(language, "Chuyển sang Curated", "Promote to Curated")}
                    </button>
                  )}
                  {asset.dataset_stage === "curated" && (
                    <button type="button" className="da-btn da-btn--gold" disabled={busy} onClick={() => { setSelectedId(asset.id); setGold(EMPTY_GOLD); setReason(""); setStatus(null); }}>
                      {t(language, "Xác minh Gold", "Verify Gold")}
                    </button>
                  )}
                  {asset.dataset_stage === "curated" && (
                    <>
                      <input className="da-input" style={{ maxWidth: 280 }} placeholder={t(language, "Lý do hạ giai đoạn", "Demotion reason")} value={reason} onChange={(event) => setReason(event.target.value)} />
                      <button type="button" className="da-btn" disabled={busy || !reason.trim()} onClick={() => void transition(asset, "raw", undefined, reason.trim())}>
                        {t(language, "Hạ về Raw", "Demote to Raw")}
                      </button>
                    </>
                  )}
                </div>

                {selectedId === asset.id && (
                  <form className="da-form" style={{ marginTop: 14 }} onSubmit={submitGold}>
                    <label className="da-field">
                      {t(language, "Ý định đã xác minh (bắt buộc)", "Verified intent (required)")}
                      <input className="da-input" maxLength={2000} value={gold.intent} onChange={(event) => setGold({ ...gold, intent: event.target.value })} />
                    </label>
                    <label className="da-field">
                      {t(language, "Điều kiện đã xác minh — JSON (bắt buộc)", "Verified conditions — JSON (required)")}
                      <textarea className="da-textarea" value={gold.conditions} onChange={(event) => setGold({ ...gold, conditions: event.target.value })} placeholder='{"period":"today","metric":"controlled_revenue"}' />
                    </label>
                    <label className="da-field">
                      {t(language, "Bằng chứng — mỗi dòng một mục (bắt buộc)", "Evidence — one item per line (required)")}
                      <textarea className="da-textarea" value={gold.evidence} onChange={(event) => setGold({ ...gold, evidence: event.target.value })} placeholder={t(language, "snapshot:snap-1 · source:bmq-analytics", "snapshot:snap-1 · source:bmq-analytics")} />
                    </label>
                    <div className="da-actions">
                      <button type="submit" className="da-btn da-btn--gold" disabled={busy}>{busy ? t(language, "Đang lưu…", "Saving…") : t(language, "Xác minh và chuyển Gold", "Verify and move to Gold")}</button>
                      <button type="button" className="da-btn da-btn--ghost" onClick={() => { setSelectedId(null); setGold(EMPTY_GOLD); setStatus(null); }}>{t(language, "Hủy", "Cancel")}</button>
                    </div>
                    <p className="da-notice">{t(language, "Tài sản phải còn ở phiên bản v" + asset.version + "; nếu nơi khác đã đổi, thao tác sẽ báo xung đột và tải lại.", `The asset must still be v${asset.version}; if it changed elsewhere the action reports a conflict and reloads.`)}</p>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
