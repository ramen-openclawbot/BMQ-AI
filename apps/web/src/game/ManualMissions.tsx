import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  useAddManualMissionAssignee, useCancelManualMission, useCreateManualMission, useManualMissionStaff,
  useManualMissionsOverview, useReviewManualMission, useSubmitManualMission,
} from "@/hooks/useManualMissions";
import {
  dueLabel, manualMissionErrorText, validateEvidenceDraft,
  type ManualBatch, type ManualBatchAssignee, type ManualEvidenceLevel, type ManualEvidenceSpec, type ManualLocation,
  type ManualPriority, type ManualReviewStatus, type ManualSubmission, type MyManualMission,
} from "@/lib/manual-missions";
import { Sheet } from "./Sheet";

/**
 * Thẻ nhiệm vụ tự giao (owner 17/10, GĐ1): the owner writes a card in the game, staff hand in evidence, the owner
 * approves (🐝 + stars) or sends it back. Every step lands in the warehouse Zalo group from the server outbox.
 */

export const isManualMissionCode = (code: string) => code.startsWith("manual-");

const PRIORITY: Record<ManualPriority, string> = { low: "Thấp", normal: "Bình thường", high: "Gấp" };
const PLACE: Record<ManualLocation, string> = { tan_tao: "Tân Tạo", q7: "Q7" };
const LEVELS: Array<[ManualEvidenceLevel, string]> = [["none", "Không"], ["optional", "Tuỳ ý"], ["required", "Bắt buộc"]];

/** One status word for a card, from the mission status and its latest hand-in. */
export function manualState(status: string, review: ManualReviewStatus | null): { label: string; tone: "done" | "wait" | "back" | "open" | "off" } {
  if (status === "completed") return { label: "✓ Xong", tone: "done" };
  if (status === "cancelled") return { label: "Đã rút", tone: "off" };
  if (review === "pending") return { label: "📨 Chờ duyệt", tone: "wait" };
  if (review === "returned") return { label: "↩️ Làm lại", tone: "back" };
  return { label: "Đang làm", tone: "open" };
}

/** "1.234" and "1.234,5" are Vietnamese thousands; "2.5" and "2,5" are decimals. */
export function parseVnNumber(text: string): number | null {
  const raw = text.trim().replace(/\s+/g, "");
  if (!raw) return null;
  let clean = raw;
  if (raw.includes(",")) clean = raw.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(raw)) clean = raw.replace(/\./g, "");
  const value = Number(clean);
  return Number.isFinite(value) ? value : null;
}

const isLate = (dueAt: string | null) => Boolean(dueAt) && new Date(dueAt!).getTime() < Date.now();

function requirementLines(spec: ManualEvidenceSpec): string[] {
  const lines: string[] = [];
  if (spec.photo === "required") lines.push("📷 Chụp ảnh (bắt buộc)");
  else if (spec.photo === "optional") lines.push("📷 Ảnh (nếu có)");
  if (spec.number) lines.push(`🔢 ${spec.number.label}${spec.number.unit ? ` (${spec.number.unit})` : ""}`);
  if (spec.note === "required") lines.push("✍️ Ghi chú (bắt buộc)");
  else if (spec.note === "optional") lines.push("✍️ Ghi chú (nếu cần)");
  spec.checklist.forEach((item) => lines.push(`☐ ${item}`));
  return lines;
}

// ---------------------------------------------------------------- photos

function useEvidenceUrls(paths: string[]) {
  return useQuery({
    queryKey: ["mission-evidence-urls", paths],
    enabled: paths.length > 0,
    staleTime: 30 * 60 * 1000,
    queryFn: () => Promise.all(paths.map(async (path) => {
      const { data } = await supabase.storage.from("mission-evidence").createSignedUrl(path, 3600);
      return data?.signedUrl ?? null;
    })),
  });
}

/** Thumbnails of handed-in photos; tap one to see it full screen. */
export function EvidencePhotos({ paths }: { paths: string[] }) {
  const urls = useEvidenceUrls(paths);
  const [open, setOpen] = useState<number | null>(null);
  if (!paths.length) return null;
  const list = urls.data ?? [];
  return (
    <>
      <ul className="mm-photos" data-bmq-mm-photos={paths.length}>
        {paths.map((path, i) => (
          <li key={path}>
            <button type="button" disabled={!list[i]} onClick={() => setOpen(i)} aria-label={`Xem ảnh ${i + 1}`}>
              {list[i] ? <img src={list[i]!} alt="" loading="lazy" /> : <span>{urls.isLoading ? "…" : "Không mở được"}</span>}
            </button>
          </li>
        ))}
      </ul>
      {open !== null && list[open] ? (
        <div className="mm-viewer" role="dialog" aria-label={`Ảnh ${open + 1}`} onClick={(e) => { if (e.target === e.currentTarget) setOpen(null); }} data-bmq-mm-viewer>
          <img src={list[open]!} alt="" />
          <div className="mm-viewer-bar">
            {paths.length > 1 ? <button type="button" onClick={() => setOpen((open - 1 + paths.length) % paths.length)} aria-label="Ảnh trước">‹</button> : null}
            <span>{open + 1}/{paths.length}</span>
            {paths.length > 1 ? <button type="button" onClick={() => setOpen((open + 1) % paths.length)} aria-label="Ảnh sau">›</button> : null}
            <button type="button" onClick={() => setOpen(null)} aria-label="Đóng ảnh">✕</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** What one hand-in contains: photos, the number, the note and the ticked list. */
function SubmissionView({ submission, spec }: { submission: ManualSubmission; spec: ManualEvidenceSpec }) {
  return (
    <div className="mm-evidence" data-bmq-mm-evidence>
      <EvidencePhotos paths={submission.photoPaths} />
      {spec.number && submission.numberValue !== null ? (
        <p className="mm-number"><small>{spec.number.label}</small><b>{submission.numberValue.toLocaleString("vi-VN")}{spec.number.unit ? ` ${spec.number.unit}` : ""}</b></p>
      ) : null}
      {submission.note ? <p className="mm-note">“{submission.note}”</p> : null}
      {spec.checklist.length ? (
        <ul className="mm-ticks">{spec.checklist.map((item, i) => <li key={item}>{submission.checklist[i] ? "✅" : "⬜️"} {item}</li>)}</ul>
      ) : null}
      <small className="mm-when">Nộp lúc {new Date(submission.createdAt).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}</small>
    </div>
  );
}

// ---------------------------------------------------------------- owner: create

function Seg<T extends string>({ label, value, options, onChange, name }: {
  label: string; value: T; options: Array<[T, string]>; onChange: (next: T) => void; name: string;
}) {
  return (
    <div className="mm-field">
      <span className="mm-label">{label}</span>
      <div className="mm-seg" role="radiogroup" aria-label={label}>
        {options.map(([key, text]) => (
          <button key={key} type="button" role="radio" aria-checked={value === key} className={value === key ? "is-on" : undefined} onClick={() => onChange(key)} data-bmq-mm-seg={`${name}:${key}`}>{text}</button>
        ))}
      </div>
    </div>
  );
}

const vnDate = (offsetDays: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() + offsetDays * 86400000));
type DuePreset = "none" | "today" | "tomorrow" | "custom";

function dueIso(preset: DuePreset, date: string, time: string): string | null {
  if (preset === "none") return null;
  const day = preset === "today" ? vnDate(0) : preset === "tomorrow" ? vnDate(1) : date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
  return new Date(`${day}T${time}:00+07:00`).toISOString();
}

/** Owner writes a new card: what, who, by when, and what proof to hand in. */
export function CreateMissionSheet({ onClose, onToast }: { onClose: () => void; onToast: (text: string) => void }) {
  const staff = useManualMissionStaff(true);
  const create = useCreateManualMission();
  const [requestId] = useState(() => crypto.randomUUID());
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [people, setPeople] = useState<Set<string>>(new Set());
  const [preset, setPreset] = useState<DuePreset>("tomorrow");
  const [date, setDate] = useState(vnDate(2));
  const [time, setTime] = useState("17:00");
  const [priority, setPriority] = useState<ManualPriority>("normal");
  const [place, setPlace] = useState<"none" | ManualLocation>("none");
  const [photo, setPhoto] = useState<ManualEvidenceLevel>("required");
  const [note, setNote] = useState<ManualEvidenceLevel>("optional");
  const [numberOn, setNumberOn] = useState(false);
  const [numberLabel, setNumberLabel] = useState("");
  const [numberUnit, setNumberUnit] = useState("");
  const [checklist, setChecklist] = useState<string[]>([]);
  const [newItem, setNewItem] = useState("");
  const [error, setError] = useState<string | null>(null);

  const due = dueIso(preset, date, time);
  const problems = [
    title.trim().length < 3 ? "Tiêu đề cần ít nhất 3 ký tự" : null,
    people.size === 0 ? "Chọn ít nhất 1 người nhận" : null,
    preset !== "none" && !due ? "Chọn ngày giờ hạn" : null,
    preset !== "none" && due && new Date(due).getTime() < Date.now() - 3600_000 ? "Hạn đã qua" : null,
    numberOn && !numberLabel.trim() ? "Đặt tên cho số liệu (vd: Số thùng đếm được)" : null,
  ].filter((text): text is string => Boolean(text));

  const toggle = (id: string) => setPeople((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const addItem = () => {
    const text = newItem.trim();
    if (!text || checklist.length >= 10) return;
    setChecklist([...checklist, text.slice(0, 80)]);
    setNewItem("");
  };
  const submit = () => {
    if (problems.length || create.isPending) return;
    setError(null);
    create.mutate({
      title: title.trim(),
      description: description.trim() || null,
      assigneeIds: [...people],
      dueAt: due,
      priority,
      location: place === "none" ? null : place,
      evidence: { photo, note, number: numberOn ? { label: numberLabel.trim(), unit: numberUnit.trim() } : null, checklist },
      requestId,
    }, {
      onSuccess: (result) => { onToast(`Đã giao “${title.trim()}” cho ${result.missions.length} người · đã báo nhóm Zalo Kho`); onClose(); },
      onError: (err) => setError(manualMissionErrorText(err)),
    });
  };

  return (
    <Sheet title="Giao việc mới" tag="📋 Thẻ nhiệm vụ" sub="Nhân viên nhận thẻ trên bảng nhiệm vụ, nhóm Zalo Kho được báo ngay." onClose={onClose}>
      <div className="mm-form" data-bmq-mm-create>
        <label className="field">Việc cần làm
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="vd: Kiểm kê bơ ở Q7" data-bmq-mm-title />
        </label>
        <label className="field">Mô tả
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} placeholder="Làm gì, ở đâu, lưu ý gì…" data-bmq-mm-desc />
        </label>
        <div className="mm-field">
          <span className="mm-label">Giao cho {people.size ? `· ${people.size} người` : ""}</span>
          {staff.isLoading ? <p className="note">Đang tải nhân viên…</p>
            : staff.error ? <div className="err">{manualMissionErrorText(staff.error)}</div>
            : (
              <div className="mm-people" data-bmq-mm-people>
                {(staff.data ?? []).map((member) => (
                  <button key={member.userId} type="button" aria-pressed={people.has(member.userId)} className={people.has(member.userId) ? "is-on" : undefined} onClick={() => toggle(member.userId)} data-bmq-mm-person={member.name}>
                    <b>{people.has(member.userId) ? "✓ " : ""}{member.name}</b>
                    <small>{member.level ? `Cấp ${member.level.level}` : "Cấp 1"} · {member.openMissions} việc</small>
                  </button>
                ))}
              </div>
            )}
        </div>
        <Seg label="Hạn chót" name="due" value={preset} onChange={(next) => setPreset(next as DuePreset)} options={[["today", "Hôm nay"], ["tomorrow", "Ngày mai"], ["custom", "Chọn ngày"], ["none", "Không hạn"]]} />
        {preset !== "none" ? (
          <div className="mm-due">
            {preset === "custom" ? <label className="field">Ngày<input type="date" value={date} min={vnDate(0)} onChange={(e) => setDate(e.target.value)} data-bmq-mm-date /></label> : null}
            <label className="field">Giờ<input type="time" value={time} onChange={(e) => setTime(e.target.value)} data-bmq-mm-time /></label>
            {due ? <small className="mm-due-text">{dueLabel(due)}</small> : null}
          </div>
        ) : null}
        <Seg label="Mức ưu tiên" name="priority" value={priority} onChange={(next) => setPriority(next as ManualPriority)} options={[["low", "Thấp"], ["normal", "Bình thường"], ["high", "Gấp"]]} />
        <Seg label="Ở kho" name="place" value={place} onChange={(next) => setPlace(next as "none" | ManualLocation)} options={[["none", "Không ghi"], ["tan_tao", "Tân Tạo"], ["q7", "Q7"]]} />
        <fieldset className="mm-proof">
          <legend>Bằng chứng khi nộp</legend>
          <Seg label="📷 Ảnh" name="photo" value={photo} onChange={(next) => setPhoto(next as ManualEvidenceLevel)} options={LEVELS} />
          <Seg label="✍️ Ghi chú" name="note" value={note} onChange={(next) => setNote(next as ManualEvidenceLevel)} options={LEVELS} />
          <div className="mm-field">
            <label className="mm-check"><input type="checkbox" checked={numberOn} onChange={(e) => setNumberOn(e.target.checked)} data-bmq-mm-number-on /> 🔢 Nhập một số liệu</label>
            {numberOn ? (
              <div className="mm-number-spec">
                <label className="field">Tên số liệu<input value={numberLabel} maxLength={40} onChange={(e) => setNumberLabel(e.target.value)} placeholder="vd: Số thùng đếm được" data-bmq-mm-number-label /></label>
                <label className="field">Đơn vị<input value={numberUnit} maxLength={12} onChange={(e) => setNumberUnit(e.target.value)} placeholder="thùng" data-bmq-mm-number-unit /></label>
              </div>
            ) : null}
          </div>
          <div className="mm-field">
            <span className="mm-label">☑️ Việc phải tích đủ {checklist.length ? `· ${checklist.length}` : "(không bắt buộc)"}</span>
            {checklist.length ? (
              <ul className="mm-list">{checklist.map((item, i) => (
                <li key={`${item}-${i}`}><span>{item}</span><button type="button" onClick={() => setChecklist(checklist.filter((_, j) => j !== i))} aria-label={`Bỏ ${item}`}>✕</button></li>
              ))}</ul>
            ) : null}
            {checklist.length < 10 ? (
              <div className="mm-add">
                <input value={newItem} maxLength={80} onChange={(e) => setNewItem(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }} placeholder="vd: Dán nhãn ngày" aria-label="Thêm việc phải tích" data-bmq-mm-check-input />
                <button type="button" className="btn ghost" onClick={addItem} disabled={!newItem.trim()} data-bmq-mm-check-add>＋ Thêm</button>
              </div>
            ) : null}
          </div>
        </fieldset>
        {problems.length && (title || people.size) ? <ul className="mm-problems">{problems.map((text) => <li key={text}>{text}</li>)}</ul> : null}
        {error ? <div className="err" data-bmq-mm-error>{error}</div> : null}
        <div className="submit-bar">
          <button type="button" className={`btn submit${problems.length ? "" : " is-ready"}`} disabled={problems.length > 0 || create.isPending} onClick={submit} data-bmq-mm-send>
            {create.isPending ? "Đang giao…" : `📌 Giao việc${people.size ? ` cho ${people.size} người` : ""}`}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- owner: board + review

/** "Việc anh đã giao": every card the owner handed out, with who is waiting for a review. */
export function ManualBoardSection({ onCreate, onOpenBatch }: { onCreate: () => void; onOpenBatch: (batchId: string) => void }) {
  const overview = useManualMissionsOverview(true);
  const batches = overview.data ?? [];
  const waiting = batches.reduce((n, batch) => n + batch.assignees.filter((a) => a.status === "open" && a.reviewState === "pending").length, 0);
  return (
    <section className="cork mm-cork" aria-label="Việc anh đã giao" data-bmq-mm-board>
      <div className="mm-cork-head">
        <h2 className="cork-title"><span>📋</span> Việc đã giao · {batches.length}{waiting ? <em className="mm-wait-count">{waiting} chờ duyệt</em> : null}</h2>
        <button type="button" className="btn mm-new" onClick={onCreate} data-bmq-manual-create>＋ Giao việc mới</button>
      </div>
      {overview.error ? <div className="err">{manualMissionErrorText(overview.error)}</div>
        : overview.isLoading ? <p className="cork-empty">Đang tải…</p>
        : !batches.length ? <p className="cork-empty">Chưa giao việc nào. Bấm “＋ Giao việc mới” để giao việc phát sinh cho nhân viên.</p>
        : (
          <ul className="mm-batches">
            {batches.map((batch, i) => {
              const live = batch.assignees.filter((a) => a.status !== "cancelled");
              const pending = live.filter((a) => a.status === "open" && a.reviewState === "pending").length;
              const done = live.filter((a) => a.status === "completed").length;
              const late = isLate(batch.dueAt) && live.some((a) => a.status === "open");
              return (
                <li key={batch.batchId} style={{ ["--tilt" as string]: `${i % 2 ? 0.8 : -0.9}deg` }}>
                  <button type="button" className={`mm-batch${pending ? " is-pending" : ""}${done === live.length && live.length ? " is-done" : ""}`} onClick={() => onOpenBatch(batch.batchId)} data-bmq-mm-batch={batch.title}>
                    <span className="mm-batch-top">
                      {batch.priority === "high" ? <em className="mm-pri">Gấp</em> : null}
                      {batch.dueAt ? <em className={`mm-due-chip${late ? " is-late" : ""}`}>{dueLabel(batch.dueAt)}</em> : null}
                      {batch.location ? <em className="mm-place">{PLACE[batch.location]}</em> : null}
                    </span>
                    <b className="mm-batch-title">{batch.title}</b>
                    <span className="mm-crew">
                      {live.map((a) => {
                        const state = manualState(a.status, a.reviewState);
                        return <span key={a.missionId} className={`mm-state is-${state.tone}`}>{a.name} · {state.label}</span>;
                      })}
                    </span>
                    <small className="mm-batch-sum">{done}/{live.length} xong{pending ? ` · ${pending} chờ duyệt` : ""}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}

function Stars({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  return (
    <div className="mm-stars" role="radiogroup" aria-label="Chấm sao">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} sao`} className={n <= value ? "is-on" : undefined} onClick={() => onChange(n)} data-bmq-mm-star={n}>★</button>
      ))}
    </div>
  );
}

function ReviewRow({ batch, assignee, onToast }: { batch: ManualBatch; assignee: ManualBatchAssignee; onToast: (text: string) => void }) {
  const review = useReviewManualMission();
  const cancel = useCancelManualMission();
  const [stars, setStars] = useState(5);
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = manualState(assignee.status, assignee.reviewState);
  const sub = assignee.lastSubmission;
  const decide = (approve: boolean) => {
    if (!sub) return;
    setError(null);
    review.mutate({ submissionId: sub.id, approve, rating: approve ? stars : null, note: approve ? null : reason.trim() }, {
      onSuccess: () => onToast(approve ? `Đã duyệt ${assignee.name} · ${stars}★ · +🐝` : `Đã trả lại cho ${assignee.name}`),
      onError: (err) => setError(manualMissionErrorText(err)),
    });
  };
  return (
    <li className={`mm-assignee is-${state.tone}`} data-bmq-mm-assignee={assignee.name}>
      <div className="mm-assignee-head">
        <b>{assignee.name}</b>
        <span className={`mm-state is-${state.tone}`}>{state.label}{assignee.status === "completed" && sub?.rating ? ` · ${sub.rating}★` : ""}</span>
      </div>
      {sub && (assignee.reviewState === "pending" || assignee.status === "completed") ? <SubmissionView submission={sub} spec={batch.evidence} /> : null}
      {assignee.reviewState === "returned" && sub?.reviewNote && assignee.status === "open" ? <p className="mm-returned">↩️ Đã trả lại: {sub.reviewNote}</p> : null}
      {assignee.status === "open" && assignee.reviewState === "pending" && sub ? (
        returning ? (
          <div className="mm-return">
            <label className="field">Lý do trả lại<textarea value={reason} maxLength={500} rows={2} onChange={(e) => setReason(e.target.value)} placeholder="vd: Ảnh mờ, chụp lại kệ số 3" data-bmq-mm-reason /></label>
            <div className="row">
              <button type="button" className="btn" disabled={!reason.trim() || review.isPending} onClick={() => decide(false)} data-bmq-mm-return-send>Gửi trả lại</button>
              <button type="button" className="btn ghost" onClick={() => setReturning(false)}>Thôi</button>
            </div>
          </div>
        ) : (
          <div className="mm-decide">
            <Stars value={stars} onChange={setStars} />
            <div className="row">
              <button type="button" className="btn mm-approve" disabled={review.isPending} onClick={() => decide(true)} data-bmq-mm-approve={assignee.name}>✅ Duyệt · +🐝</button>
              <button type="button" className="btn ghost" disabled={review.isPending} onClick={() => setReturning(true)} data-bmq-mm-return={assignee.name}>↩️ Trả lại</button>
            </div>
          </div>
        )
      ) : null}
      {assignee.status === "open" && assignee.reviewState !== "pending" ? (
        confirmCancel ? (
          <div className="row mm-cancel">
            <span>Rút việc của {assignee.name}?</span>
            <button type="button" className="btn ghost" disabled={cancel.isPending} onClick={() => cancel.mutate({ missionId: assignee.missionId }, { onSuccess: () => onToast(`Đã rút việc của ${assignee.name}`), onError: (err) => setError(manualMissionErrorText(err)) })} data-bmq-mm-cancel-yes>Rút</button>
            <button type="button" className="btn ghost" onClick={() => setConfirmCancel(false)}>Giữ</button>
          </div>
        ) : <button type="button" className="mm-link" onClick={() => setConfirmCancel(true)} data-bmq-mm-cancel={assignee.name}>Rút việc này</button>
      ) : null}
      {error ? <div className="err" data-bmq-mm-error>{error}</div> : null}
    </li>
  );
}

/** One handed-out card: everyone on it, their proof, and the review buttons. */
export function BatchSheet({ batchId, onClose, onToast }: { batchId: string; onClose: () => void; onToast: (text: string) => void }) {
  const overview = useManualMissionsOverview(true);
  const staff = useManualMissionStaff(true);
  const add = useAddManualMissionAssignee();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const batch = overview.data?.find((entry) => entry.batchId === batchId);
  if (!batch) return overview.isLoading ? <Sheet title="Việc đã giao" onClose={onClose}><p className="note">Đang tải…</p></Sheet> : null;
  const live = batch.assignees.filter((a) => a.status !== "cancelled");
  const onCard = new Set(live.map((a) => a.userId));
  const others = (staff.data ?? []).filter((member) => !onCard.has(member.userId));
  const reqs = requirementLines(batch.evidence);
  return (
    <Sheet title={batch.title} tag="📋 Việc đã giao" sub={[batch.dueAt ? dueLabel(batch.dueAt) : "Không hạn", PRIORITY[batch.priority], batch.location ? PLACE[batch.location] : null].filter(Boolean).join(" · ")} onClose={onClose}>
      <div data-bmq-mm-batch-sheet>
        {batch.description ? <p className="note">{batch.description}</p> : null}
        {reqs.length ? <ul className="mm-req">{reqs.map((line) => <li key={line}>{line}</li>)}</ul> : null}
        <ul className="mm-assignees">{live.map((assignee) => <ReviewRow key={assignee.missionId} batch={batch} assignee={assignee} onToast={onToast} />)}</ul>
        {adding ? (
          <div className="mm-people" data-bmq-mm-add-list>
            {others.length ? others.map((member) => (
              <button key={member.userId} type="button" disabled={add.isPending} onClick={() => add.mutate({ batchId, userId: member.userId }, { onSuccess: () => { setAdding(false); onToast(`Đã giao thêm cho ${member.name}`); }, onError: (err) => setError(manualMissionErrorText(err)) })} data-bmq-mm-add-person={member.name}>
                <b>＋ {member.name}</b><small>{member.openMissions} việc đang mở</small>
              </button>
            )) : <p className="note">Mọi nhân viên đã có trong việc này.</p>}
          </div>
        ) : <button type="button" className="btn ghost mm-add-person" onClick={() => setAdding(true)} data-bmq-mm-add>＋ Giao thêm người</button>}
        {error ? <div className="err">{error}</div> : null}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- staff: hand in

/** Staff side of a card: what to hand in, the form, then "chờ duyệt" until the owner decides. */
export function ManualSubmitTool({ manual, missionId, onToast }: { manual: MyManualMission | undefined; missionId: string; onToast: (text: string) => void }) {
  const submit = useSubmitManualMission();
  const [files, setFiles] = useState<File[]>([]);
  const [numberText, setNumberText] = useState("");
  const [note, setNote] = useState("");
  const [ticks, setTicks] = useState<boolean[]>([]);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews]);
  useEffect(() => { if (manual) setTicks(manual.evidence.checklist.map(() => false)); }, [manual?.missionId, manual?.evidence.checklist.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!manual) return <p className="note">Đang tải thẻ việc…</p>;
  const spec = manual.evidence;
  const sub = manual.lastSubmission;
  const reqs = requirementLines(spec);
  const head = (
    <div className="mm-meta" data-bmq-mm-meta>
      {manual.createdByName ? <span>👤 {manual.createdByName} giao</span> : null}
      {manual.dueAt ? <span className={isLate(manual.dueAt) ? "is-late" : undefined}>⏰ {dueLabel(manual.dueAt)}</span> : null}
      {manual.priority === "high" ? <span className="is-late">Gấp</span> : null}
      {manual.location ? <span>📍 {PLACE[manual.location]}</span> : null}
    </div>
  );
  if (manual.reviewState === "pending" && sub) {
    return (
      <>
        {head}
        <p className="mm-waiting" data-bmq-mm-waiting>📨 Đã nộp — chờ duyệt. Có kết quả sẽ báo trong nhóm Zalo Kho.</p>
        <SubmissionView submission={sub} spec={spec} />
      </>
    );
  }
  const number = parseVnNumber(numberText);
  const problems = validateEvidenceDraft(spec, { photoPaths: files.map((file) => file.name), note, number: spec.number ? number : null, checklist: spec.checklist.length ? ticks : [] });
  const send = () => {
    if (problems.length || submit.isPending) return;
    setError(null);
    submit.mutate({ missionId, files, note: note.trim() || null, numberValue: spec.number ? number : null, checklist: spec.checklist.length ? ticks : [] }, {
      onSuccess: () => { setFiles([]); setNote(""); setNumberText(""); onToast("Đã nộp — chờ duyệt"); },
      onError: (err) => setError(manualMissionErrorText(err)),
    });
  };
  return (
    <>
      {head}
      {manual.reviewState === "returned" && sub?.reviewNote ? <p className="mm-returned" data-bmq-mm-returned>↩️ Bị trả lại: {sub.reviewNote}</p> : null}
      {reqs.length ? <ul className="mm-req">{reqs.map((line) => <li key={line}>{line}</li>)}</ul> : null}
      <div className="mm-form" data-bmq-mm-submit-form>
        {spec.photo !== "none" ? (
          <div className="mm-field">
            <span className="mm-label">📷 Ảnh {spec.photo === "required" ? "(bắt buộc)" : "(nếu có)"} · {files.length}/8</span>
            <ul className="mm-photos">
              {previews.map((url, i) => (
                <li key={url}><img src={url} alt="" /><button type="button" className="mm-x" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Bỏ ảnh ${i + 1}`}>✕</button></li>
              ))}
              {files.length < 8 ? <li><button type="button" className="mm-shot" onClick={() => picker.current?.click()} data-bmq-mm-add-photo>📷<small>Thêm ảnh</small></button></li> : null}
            </ul>
            <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(e) => { const picked = [...(e.target.files ?? [])]; setFiles([...files, ...picked].slice(0, 8)); e.target.value = ""; }} data-bmq-mm-file />
          </div>
        ) : null}
        {spec.number ? (
          <label className="field">{spec.number.label}{spec.number.unit ? ` (${spec.number.unit})` : ""}
            <input inputMode="decimal" value={numberText} onChange={(e) => setNumberText(e.target.value)} placeholder="0" data-bmq-mm-number />
          </label>
        ) : null}
        {spec.note !== "none" ? (
          <label className="field">Ghi chú {spec.note === "required" ? "(bắt buộc)" : "(nếu cần)"}
            <textarea value={note} maxLength={1000} rows={3} onChange={(e) => setNote(e.target.value)} placeholder="Đã làm gì, còn vướng gì…" data-bmq-mm-note />
          </label>
        ) : null}
        {spec.checklist.length ? (
          <ul className="mm-ticks is-form">
            {spec.checklist.map((item, i) => (
              <li key={`${item}-${i}`}><label><input type="checkbox" checked={Boolean(ticks[i])} onChange={(e) => setTicks(ticks.map((value, j) => (j === i ? e.target.checked : value)))} data-bmq-mm-tick={i} /> {item}</label></li>
            ))}
          </ul>
        ) : null}
        {problems.length ? <ul className="mm-problems">{problems.map((text) => <li key={text}>{text}</li>)}</ul> : null}
        {error ? <div className="err" data-bmq-mm-error>{error}</div> : null}
        <div className="submit-bar">
          <button type="button" className={`btn submit${problems.length ? "" : " is-ready"}`} disabled={problems.length > 0 || submit.isPending} onClick={send} data-bmq-mm-submit>
            {submit.isPending ? (files.length ? "Đang tải ảnh…" : "Đang nộp…") : "📨 Nộp cho anh duyệt"}
          </button>
        </div>
      </div>
    </>
  );
}
