import { useState } from "react";
import { GamePicker } from "@/game/GamePicker";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { MISSIONS_QUERY_KEY, useAssignMission, useCompleteMission, useMarkItemsDistinct, useMissionAssignments, useMissionStaff, useResolveUnknownUnit, useUnassignMission, useUpdateAliasFactor } from "@/hooks/useMissions";
import { useAliasReceiptLines, useItemReceiptLines, useRenameStockItem, useUnitVariantReceiptLines, useWarehouseGameSnapshot, WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "@/hooks/useWarehouseGame";
import { useAnswerCountUnitQuestion, useCountUnitQuestions } from "@/hooks/useCountUnitQuestions";
import { STOCK_CATALOG_REVIEW_QUERY_KEY } from "@/hooks/useStockCatalog";
import {
  assignmentsByParent, levelProgress, missionAssignErrorText, missionErrorMessage,
  type CompleteMissionResult, type MissionAssignment, type MissionStaffMember, type Mission, type MissionAliasDetail, type MissionCountQuestionsDetail, type MissionDuplicateDetail, type MissionLevel, type MissionMaterialLinksDetail, type MissionUnknownUnitDetail, type MyMissions,
} from "@/lib/missions";
import { STOCK_UNITS } from "@/lib/stock-units";
import { canSubmit, computeCountedQty, type StockCountUnitQuestion } from "@/lib/count-unit-questions";
import type { ReceiptLine } from "@/lib/receipt-lines";
import { ReceiptNotes } from "./ReceiptNotes";
import { Sheet } from "./Sheet";
import { GameLoading } from "./Loading";
import { Buddy } from "./Toon";
import { C, STROKE } from "./theme";
import { fmtQty, newRequestId } from "./meta";

/** Mirrors the public.mission_levels seed; the server decides the real level. */
export const LADDER: MissionLevel[] = [
  { level: 1, title: "Nhân viên mới", min_badges: 0 },
  { level: 2, title: "Nhân viên kho", min_badges: 3 },
  { level: 3, title: "Thủ kho", min_badges: 7 },
  { level: 4, title: "Thủ kho trưởng", min_badges: 12 },
  { level: 5, title: "Quản lý kho", min_badges: 20 },
];

const hatFor = (level: number): "none" | "cap" | "chef" => (level >= 3 ? "chef" : level === 2 ? "cap" : "none");

type Rule = "alias" | "duplicate" | "units" | "links" | "count" | "other";

function ruleOf(mission: Mission): Rule {
  const kind = mission.progress.detail[0]?.kind;
  if (kind === "count_questions" || mission.code.startsWith("wh-count-units")) return "count";
  if (kind === "alias_factor_fixed" || mission.code.includes("alias")) return "alias";
  if (kind === "duplicate_resolved" || mission.code.includes("duplicate")) return "duplicate";
  if (kind === "unknown_units_cleared" || mission.code.includes("unit")) return "units";
  if (kind === "material_links" || mission.code.includes("link")) return "links";
  return "other";
}

const RULE_ICON: Record<Rule, string> = { alias: "🏷️", duplicate: "🥐", units: "📏", links: "🧩", count: "⚖️", other: "📜" };

/** Steps shown on the card: the duplicate pair is one decision, the others count rows. */
export function missionSteps(mission: Mission): { done: number; total: number } {
  if (mission.status === "completed") {
    const total = ruleOf(mission) === "duplicate" ? 1 : Math.max(1, mission.progress.total);
    return { done: total, total };
  }
  if (ruleOf(mission) === "duplicate") return { done: mission.progress.done ? 1 : 0, total: 1 };
  const links = mission.progress.detail.find((row): row is MissionMaterialLinksDetail => row.kind === "material_links");
  if (links) return { done: links.linked, total: Math.max(links.linked + links.remaining, 1) };
  const counts = mission.progress.detail.find((row): row is MissionCountQuestionsDetail => row.kind === "count_questions");
  if (counts) return { done: counts.answered + counts.skipped, total: Math.max(counts.total, 1) };
  const total = Math.max(mission.progress.total, mission.progress.left, 1);
  return { done: Math.max(0, total - mission.progress.left), total };
}

export const readyToSubmit = (mission: Mission) => mission.status === "open" && mission.progress.done;

/** Honeycomb medal with a bee: the "Chăm chỉ" badge. `empty` draws a dashed slot. */
export function BeeBadge({ size = 44, empty = false }: { size?: number; empty?: boolean }) {
  const hex = "M0 -20 L17.3 -10 L17.3 10 L0 20 L-17.3 10 L-17.3 -10 Z";
  return (
    <svg viewBox="-24 -24 48 48" width={size} height={size} className="bee-badge" aria-hidden="true">
      {empty ? (
        <path d={hex} fill="none" stroke={C.ink} strokeOpacity=".35" strokeWidth={2.5} strokeDasharray="5 4" />
      ) : (
        <g>
          <path d={hex} transform="translate(2.5 3)" fill={C.shadow} />
          <path d={hex} fill={C.mustard} stroke={C.ink} strokeWidth={STROKE} strokeLinejoin="round" />
          <path d="M0 -14 L12 -7 L12 7 L0 14 L-12 7 L-12 -7 Z" fill={C.mustardLight} stroke={C.ink} strokeOpacity=".35" strokeWidth={1.5} />
          <ellipse cx={-4} cy={-6} rx={5} ry={3.6} fill={C.white} stroke={C.ink} strokeWidth={1.8} transform="rotate(-25 -4 -6)" />
          <ellipse cx={4} cy={-6} rx={5} ry={3.6} fill={C.white} stroke={C.ink} strokeWidth={1.8} transform="rotate(25 4 -6)" />
          <ellipse cx={0} cy={3} rx={7.5} ry={6} fill={C.mustard} stroke={C.ink} strokeWidth={2} />
          <path d="M-3 -2.4 v10.8 M2.6 -2.6 v11.2" stroke={C.ink} strokeWidth={2.2} />
          <circle cx={-8.6} cy={2} r={1.2} fill={C.ink} />
        </g>
      )}
    </svg>
  );
}

/** HUD notebook: open missions + level bar, replaces the old crate counter. */
export function MissionHudButton({ data, onOpen }: { data: MyMissions | undefined; onOpen: () => void }) {
  const open = data?.missions.filter((mission) => mission.status === "open") ?? [];
  const ready = open.some(readyToSubmit);
  const progress = levelProgress(data?.badges.total ?? 0, LADDER);
  const level = data?.level?.level ?? progress.current?.level ?? 1;
  return (
    <button type="button" className={`todo mission-hud${ready ? " is-ready" : ""}`} onClick={onOpen} aria-label={`Nhiệm vụ, ${open.length} nhiệm vụ đang mở`} data-bmq-mission-hud>
      <div className="todo-rings" aria-hidden="true"><i /><i /><i /><i /></div>
      <span className="hud-bee"><BeeBadge size={30} /></span>
      <div className="todo-body">
        <small>Nhiệm vụ<span className="hud-lv"> · Cấp {level}</span></small>
        <b data-bmq-mission-open>{data ? open.length : "…"}</b>
        <span className="todo-bar"><i style={{ width: `${progress.pct}%` }} /></span>
      </div>
      {ready ? <span className="hud-dot" aria-hidden="true">!</span> : null}
    </button>
  );
}

function RankCard({ data }: { data: MyMissions }) {
  const total = data.badges.total;
  const progress = levelProgress(total, LADDER);
  const level = data.level ?? progress.current ?? LADDER[0];
  const next = data.next_level ?? progress.next;
  const slots = next ? next.min_badges : Math.max(total, 1);
  const shown = Math.min(slots, 12);
  return (
    <section className="rank-card" aria-label="Thẻ nhân viên kho">
      <div className="rank-avatar">
        <svg viewBox="-34 -44 68 78" width="86" height="98" aria-hidden="true">
          <circle cx={0} cy={-4} r={30} fill={C.sageLight} stroke={C.ink} strokeWidth={STROKE} />
          <Buddy x={0} y={-6} mood="happy" hat={hatFor(level.level)} face={C.mustardLight} scale={1.15} />
        </svg>
        <span className="rank-level">Cấp {level.level}</span>
      </div>
      <div className="rank-main">
        <small>Thẻ nhân viên kho</small>
        <h3 data-bmq-mission-level>{level.title}</h3>
        <div className="rank-bees" aria-label={`${total} huy hiệu Chăm chỉ`}>
          {Array.from({ length: shown }).map((_, i) => <BeeBadge key={i} size={30} empty={i >= total} />)}
          {total > shown ? <b className="rank-more">+{total - shown}</b> : null}
        </div>
        <div className="rank-bar"><i style={{ width: `${progress.pct}%` }} /></div>
        <p className="rank-next">
          {next ? <>Còn <b>{Math.max(0, next.min_badges - total)}</b> huy hiệu nữa lên <b>{next.title}</b></> : "Đã đạt cấp cao nhất"}
        </p>
      </div>
      <ol className="ladder" aria-label="Các cấp">
        {LADDER.map((rung) => (
          <li key={rung.level} className={rung.level === level.level ? "is-now" : rung.level < level.level ? "is-past" : undefined}>
            <b>{rung.level}</b><span>{rung.title}</span><small>{rung.min_badges} 🐝</small>
          </li>
        ))}
      </ol>
    </section>
  );
}

function MissionCard({ mission, index, onOpen, crew, onAssign }: {
  mission: Mission; index: number; onOpen: () => void;
  /** Owner board (17/10): who else has this mission, and the "Giao" button. */
  crew?: MissionAssignment[]; onAssign?: () => void;
}) {
  const rule = ruleOf(mission);
  const steps = missionSteps(mission);
  const done = mission.status === "completed";
  const ready = readyToSubmit(mission);
  return (
    <li className="mission-slot" style={{ ["--tilt" as string]: `${index % 2 ? 1.2 : -1.4}deg` }}>
      <button
        type="button"
        className={`mission-note${done ? " is-done" : ""}${ready ? " is-ready" : ""}${onAssign ? " has-assign" : ""}`}
        style={{ animationDelay: `${index * 70}ms` }}
        onClick={onOpen}
        data-bmq-mission={mission.code}
      >
        <span className="pin" aria-hidden="true" />
        <span className="mission-icon" aria-hidden="true">{RULE_ICON[rule]}</span>
        <b className="mission-title">{mission.title}</b>
        {mission.description ? <span className="mission-desc">{mission.description}</span> : null}
        <span className="mission-progress">
          <span className="mission-bar"><i style={{ width: `${(steps.done / steps.total) * 100}%` }} /></span>
          <small>{rule === "duplicate" ? (steps.done ? "Đã chọn cách xử lý" : "Chờ anh chọn") : `${steps.done}/${steps.total} xong`}</small>
        </span>
        {crew?.length ? (
          <span className="mission-crew" data-bmq-mission-crew>
            <small>Đã giao:</small>
            {crew.map((copy) => (
              <span key={copy.missionId} className={`crew-chip${copy.status === "completed" ? " is-done" : ""}`}>{copy.status === "completed" ? "✓" : "👤"} {copy.assigneeName || "Nhân viên"}</span>
            ))}
          </span>
        ) : null}
        <span className="mission-foot">
          <span className="mission-reward"><BeeBadge size={24} /> {mission.badge?.name ?? "Chăm chỉ"}</span>
          {done ? null : <span className={`mission-go${ready ? " is-ready" : ""}`}>{ready ? "Nộp nhận 🐝" : "Làm"}</span>}
        </span>
        {done ? <span className="stamp" aria-label="Đã hoàn thành">XONG</span> : null}
      </button>
      {onAssign && !done ? (
        <button type="button" className="mission-assign" onClick={onAssign} aria-label={`Giao nhiệm vụ ${mission.title}`} data-bmq-mission-assign={mission.code}>👥 Giao</button>
      ) : null}
    </li>
  );
}

/** The mission board scene: rank card + cork board of notes. */
export function MissionBoard({ data, isLoading, error, onOpen, onAssign }: {
  data: MyMissions | undefined; isLoading: boolean; error: unknown; onOpen: (id: string) => void;
  /** Owner only: hand an open mission to a staff member. */
  onAssign?: (id: string) => void;
}) {
  const assignments = useMissionAssignments(Boolean(onAssign));
  const crewOf = assignmentsByParent(assignments.data ?? []);
  if (isLoading && !data) return <GameLoading lines={["Mở bảng nhiệm vụ", "Đếm huy hiệu", "Ghim thẻ việc"]} />;
  if (error && !data) return <div className="loading"><div className="err">{missionErrorMessage(error)}</div></div>;
  if (!data) return null;
  const open = data.missions.filter((mission) => mission.status === "open");
  const finished = data.missions.filter((mission) => mission.status === "completed");
  return (
    <div className="shelf-view mission-view" data-bmq-mission-board>
      <RankCard data={data} />
      <section className="cork" aria-label="Nhiệm vụ đang mở">
        <h2 className="cork-title"><span>📌</span> Nhiệm vụ đang mở · {open.length}</h2>
        {open.length ? (
          <ul className="mission-grid">{open.map((mission, i) => <MissionCard key={mission.id} mission={mission} index={i} onOpen={() => onOpen(mission.id)} crew={crewOf.get(mission.id)} onAssign={onAssign ? () => onAssign(mission.id) : undefined} />)}</ul>
        ) : (
          <p className="cork-empty">Không còn nhiệm vụ nào. Nghỉ tay một chút! ☕</p>
        )}
      </section>
      {finished.length ? (
        <section className="cork is-done" aria-label="Nhiệm vụ đã xong">
          <h2 className="cork-title"><span>🏅</span> Đã hoàn thành · {finished.length}</h2>
          <ul className="mission-grid">{finished.map((mission, i) => <MissionCard key={mission.id} mission={mission} index={i + 1} onOpen={() => onOpen(mission.id)} crew={crewOf.get(mission.id)} />)}</ul>
        </section>
      ) : null}
    </div>
  );
}

function CrewRow({ member, copy, busy, onGive, onTake }: {
  member: MissionStaffMember; copy: MissionAssignment | undefined; busy: boolean; onGive: () => void; onTake: () => void;
}) {
  const level = member.level ?? LADDER[0];
  return (
    <li className={`crew-row${copy ? " is-on" : ""}`} data-bmq-assign-row={member.name}>
      <svg viewBox="-24 -30 48 52" width="44" height="48" className="crew-face" aria-hidden="true">
        <circle cx={0} cy={-4} r={21} fill={copy ? C.sageLight : C.cream} stroke={C.ink} strokeWidth={2.5} />
        <Buddy x={0} y={-5} mood="happy" hat={hatFor(level.level)} face={C.mustardLight} scale={0.8} />
      </svg>
      <span className="crew-who">
        <b>{member.name}</b>
        <small>Cấp {level.level} · {level.title} · {copy?.status === "completed" ? "đã nộp việc này" : copy ? "đang làm việc này" : `${member.openMissions} việc đang mở`}</small>
      </span>
      {copy?.status === "completed" ? <span className="crew-done">✓ Đã nộp</span>
        : copy ? <button type="button" className="btn ghost" disabled={busy} onClick={onTake} data-bmq-unassign={member.userId}>Rút lại</button>
        : <button type="button" className="btn" disabled={busy} onClick={onGive} data-bmq-assign={member.userId}>Giao</button>}
    </li>
  );
}

/** Owner (17/10): hand an open mission to staff who may do warehouse work; progress is shared, each submits for their own 🐝. */
export function AssignSheet({ mission, onClose, onToast }: { mission: Mission; onClose: () => void; onToast: (text: string) => void }) {
  const staff = useMissionStaff(true);
  const assignments = useMissionAssignments(true);
  const assign = useAssignMission();
  const unassign = useUnassignMission();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const byUser = new Map((assignments.data ?? []).filter((copy) => copy.parentMissionId === mission.id).map((copy) => [copy.assigneeUserId, copy]));
  const settle = { onError: (err: unknown) => setError(missionAssignErrorText(err)), onSettled: () => setBusy(null) };
  const give = (member: MissionStaffMember) => {
    setBusy(member.userId); setError(null);
    assign.mutate({ missionId: mission.id, userId: member.userId }, { ...settle, onSuccess: (result) => onToast(`Đã giao “${mission.title}” cho ${result.assigneeName || member.name}`) });
  };
  const take = (member: MissionStaffMember, copy: MissionAssignment) => {
    setBusy(member.userId); setError(null);
    unassign.mutate({ missionId: copy.missionId }, { ...settle, onSuccess: () => onToast(`Đã rút “${mission.title}” khỏi ${member.name}`) });
  };
  return (
    <Sheet title="Giao nhiệm vụ" tag="👥 Giao việc" sub={mission.title} onClose={onClose}>
      <p className="hint">Người được giao thấy nhiệm vụ trên bảng của mình. Tiến độ tính chung: ai làm xong phần nào thì phần đó xong cho cả hai. Ai nộp thì người đó nhận 🐝.</p>
      {staff.isLoading || assignments.isLoading ? <p className="note">Đang tải danh sách nhân viên…</p>
        : staff.error ? <div className="err">{missionAssignErrorText(staff.error)}</div>
        : !staff.data?.length ? <p className="note" data-bmq-assign-empty>Chưa có nhân viên nào có quyền sửa kho để nhận nhiệm vụ.</p>
        : (
          <ul className="crew-list" data-bmq-assign-list>
            {staff.data.map((member) => {
              const copy = byUser.get(member.userId);
              return <CrewRow key={member.userId} member={member} copy={copy} busy={busy === member.userId} onGive={() => give(member)} onTake={() => copy && take(member, copy)} />;
            })}
          </ul>
        )}
      {error ? <div className="err" data-bmq-assign-error>{error}</div> : null}
    </Sheet>
  );
}

function useApplyMerge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ source, target }: { source: string; target: string }) => {
      const { error } = await supabase.rpc("apply_stock_item_merge", { p_source: source, p_target: target, p_factor: 1 });
      if (error) throw error;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [MISSIONS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [STOCK_CATALOG_REVIEW_QUERY_KEY] });
    },
  });
}

/** Delivery notes behind the alias: the owner checks the photo before typing a factor (16/10). */
function AliasNotes({ aliasId }: { aliasId: string }) {
  const lines = useAliasReceiptLines(aliasId, true);
  return <ReceiptNotes title="Phiếu giao hàng" lines={lines.data} loading={lines.isLoading} error={lines.error} />;
}

function AliasRow({ row, onSaved }: { row: MissionAliasDetail; onSaved: (text: string) => void }) {
  const update = useUpdateAliasFactor();
  const [text, setText] = useState("");
  const [requestId] = useState(newRequestId);
  const value = Number(text.replace(",", "."));
  const ok = Number.isFinite(value) && value > 0 && value !== row.factor;
  return (
    <li className={`task-row${row.fixed ? " is-fixed" : ""}`} data-bmq-mission-alias>
      <div className="task-head">
        <b>“{row.name ?? "tên gọi khác đã xoá"}”</b>
        <small>→ {row.item_name ?? "—"}{row.item_unit ? ` · kho tính ${row.item_unit}` : ""}</small>
      </div>
      <div className="task-now">Đang tính: 1 đơn vị trên phiếu = <b>{row.factor === null ? "—" : fmtQty(row.factor)} {row.item_unit ?? row.unit ?? ""}</b></div>
      {row.fixed ? <span className="task-ok">✓ Đã sửa</span> : (
        <>
          <AliasNotes aliasId={row.id} />
          <label className="conv">
            1 đơn vị trên phiếu =
            <input inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} placeholder="?" aria-label={`Hệ số mới cho ${row.name ?? ""}`} />
            {row.item_unit ?? row.unit ?? ""}
            <button type="button" className="btn" disabled={!ok || update.isPending} onClick={() => update.mutate({ aliasId: row.id, factor: value, requestId }, { onSuccess: () => onSaved(`Đã sửa hệ số “${row.name}” = ${fmtQty(value)} ${row.item_unit ?? ""}`) })}>
              {update.isPending ? "Đang lưu…" : "Lưu"}
            </button>
          </label>
          {update.error ? <div className="err">{missionErrorMessage(update.error)}</div> : null}
        </>
      )}
    </li>
  );
}

function DuplicateTool({ items, done, onSaved }: { items: MissionDuplicateDetail[]; done: boolean; onSaved: (text: string) => void }) {
  const distinct = useMarkItemsDistinct();
  const rename = useRenameStockItem();
  const merge = useApplyMerge();
  const [mode, setMode] = useState<"pick" | "rename" | "merge">("pick");
  const [which, setWhich] = useState(1);
  const [name, setName] = useState(items[1]?.name ?? "");
  const [requestIds] = useState(() => ({ distinct: newRequestId(), rename: newRequestId() }));
  const [a, b] = items;
  const sameUnit = Boolean(a?.unit && b?.unit && a.unit === b.unit);
  const error = distinct.error ?? rename.error ?? merge.error;
  const busy = distinct.isPending || rename.isPending || merge.isPending;
  if (!a || !b) return <p className="note">Không đọc được cặp mặt hàng.</p>;
  if (done) return <p className="task-ok big">✓ Đã xử lý xong cặp này. Bấm “Nộp nhiệm vụ” bên dưới.</p>;
  return (
    <>
      <div className="dup-pair">
        {items.map((item, i) => (
          <div key={item.id} className={`dup-item${mode !== "pick" && which === i ? " is-picked" : ""}`}>
            <small>{item.code ?? "—"}</small>
            <b>{item.name ?? "—"}</b>
            <span>{item.unit ?? "—"} · {item.alias_count} tên gọi khác{item.active ? "" : " · đã ngưng"}</span>
          </div>
        ))}
      </div>
      {mode === "pick" ? (
        <div className="dup-choices">
          <button type="button" className="btn" disabled={busy} data-bmq-dup="distinct" onClick={() => distinct.mutate({ itemA: a.id, itemB: b.id, requestId: requestIds.distinct }, { onSuccess: () => onSaved("Đã ghi: hai mặt hàng khác nhau, giữ cả hai") })}>
            Giữ cả hai · 2 món khác nhau
          </button>
          <button type="button" className="btn ghost" disabled={busy} data-bmq-dup="rename" onClick={() => { setMode("rename"); setWhich(1); setName(b.name ?? ""); }}>✎ Đổi tên một món</button>
          {sameUnit ? <button type="button" className="btn ghost" disabled={busy} data-bmq-dup="merge" onClick={() => { setMode("merge"); setWhich(0); }}>🔗 Gộp làm một</button> : null}
        </div>
      ) : mode === "rename" ? (
        <>
          <div className="seg" role="radiogroup" aria-label="Món cần đổi tên">
            {items.map((item, i) => <button key={item.id} type="button" role="radio" aria-checked={which === i} className={which === i ? "is-on" : undefined} onClick={() => { setWhich(i); setName(item.name ?? ""); }}>{item.code ?? `Món ${i + 1}`}</button>)}
          </div>
          <label className="field">Tên mới<input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoFocus /></label>
          <div className="row">
            <button type="button" className="btn" disabled={busy || name.trim().length < 2 || name.trim() === items[which].name} onClick={() => rename.mutate({ itemId: items[which].id, newName: name.trim(), requestId: requestIds.rename }, { onSuccess: () => onSaved(`Đã đổi tên thành “${name.trim()}”`) })}>
              {rename.isPending ? "Đang lưu…" : "Lưu tên"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setMode("pick")}>Quay lại</button>
          </div>
        </>
      ) : (
        <>
          <p className="note">Giữ lại món nào? Món kia gộp vào, tên gọi khác và lịch sử chuyển theo (hoàn tác được ở Gộp tên trùng).</p>
          <div className="seg" role="radiogroup" aria-label="Món giữ lại">
            {items.map((item, i) => <button key={item.id} type="button" role="radio" aria-checked={which === i} className={which === i ? "is-on" : undefined} onClick={() => setWhich(i)}>Giữ {item.code ?? `món ${i + 1}`}</button>)}
          </div>
          <div className="row">
            <button type="button" className="btn" disabled={busy} onClick={() => merge.mutate({ source: items[1 - which].id, target: items[which].id }, { onSuccess: () => onSaved(`Đã gộp vào “${items[which].name}”`) })}>
              {merge.isPending ? "Đang gộp…" : `Gộp vào “${items[which].name}”`}
            </button>
            <button type="button" className="btn ghost" onClick={() => setMode("pick")}>Quay lại</button>
          </div>
        </>
      )}
      {error ? <div className="err">{missionErrorMessage(error)}</div> : null}
    </>
  );
}

const UNIT_CHOICES = STOCK_UNITS.filter((unit) => unit.code === unit.baseCode || unit.kind !== "count");

/** Delivery notes written with this unit: the owner reads the photo before mapping it (16/10). */
function UnitNotes({ variant }: { variant: string }) {
  const lines = useUnitVariantReceiptLines(variant, true);
  return <ReceiptNotes title="Phiếu giao hàng" lines={lines.data} loading={lines.isLoading} error={lines.error} />;
}

function UnitRow({ variant, rows, onSaved }: { variant: string; rows: MissionUnknownUnitDetail[]; onSaved: (text: string) => void }) {
  const resolve = useResolveUnknownUnit();
  const [code, setCode] = useState("");
  const [requestId] = useState(newRequestId);
  const lines = rows.reduce((sum, row) => sum + row.line_count, 0);
  const example = rows[0]?.example_name ?? "";
  return (
    <li className="task-row" data-bmq-mission-unit={variant}>
      <div className="task-head">
        <b className="unit-chip">{rows[0]?.unit ?? variant}</b>
        <small>{lines} dòng phiếu · ví dụ “{example}”</small>
      </div>
      <UnitNotes variant={variant} />
      <div className="unit-actions">
        <GamePicker value={code} onChange={setCode} placeholder="Quy về đơn vị…" title={`Quy “${variant}” về đơn vị`} ariaLabel={`Quy ${variant} về đơn vị chuẩn`} options={UNIT_CHOICES.map((unit) => ({ value: unit.code, label: unit.label }))} />
        <button type="button" className="btn" disabled={!code || resolve.isPending} onClick={() => resolve.mutate({ variant, action: "map", code, requestId }, { onSuccess: () => onSaved(`“${variant}” → ${code}`) })}>Gán</button>
        <button type="button" className="btn ghost" disabled={resolve.isPending} onClick={() => resolve.mutate({ variant, action: "not_stock", requestId }, { onSuccess: () => onSaved(`“${variant}” không phải hàng kho`) })}>Không phải hàng kho</button>
      </div>
      {resolve.error ? <div className="err">{missionErrorMessage(resolve.error)}</div> : null}
    </li>
  );
}

const LOCATION_LABEL = { q7: "Kho Q7", tan_tao: "Kho Tân Tạo" } as const;

/** The owner's 16/10 stock file, rendered per kho and stored next to the delivery notes (bucket invoices). */
const COUNT_FILE_IMAGES: Record<string, Record<"q7" | "tan_tao", string>> = {
  "2026-10-16": { q7: "stock-count-files/ton-thuc-te-2026-10-16-q7.png", tan_tao: "stock-count-files/ton-thuc-te-2026-10-16-tan_tao.png" },
};

const sameUnit = (a: string | null, b: string) => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Evidence beside every conversion (owner rule 17/10): the file line itself, then the item's delivery
 * notes — receipts written in the file's unit (e.g. "cây") first.
 */
function CountEvidence({ row, itemId }: { row: StockCountUnitQuestion; itemId: string | null }) {
  const lines = useItemReceiptLines(itemId, Boolean(itemId));
  const image = COUNT_FILE_IMAGES[row.batch]?.[row.location] ?? null;
  const file: ReceiptLine = {
    goods_receipt_id: `file-${row.id}`, goods_receipt_item_id: `file-${row.id}`, receipt_number: "File tồn 16/10", receipt_date: row.batch,
    status: "file", supplier_name: null, raw_name: row.file_label, quantity: row.file_qty, unit: row.file_unit, unit_price: null, line_total: null,
    image_path: image, photo_paths: [],
  };
  const receipts = [...(lines.data ?? [])].sort((a, b) => Number(sameUnit(b.unit, row.file_unit)) - Number(sameUnit(a.unit, row.file_unit)));
  return <ReceiptNotes title="Đối soát: file + phiếu giao hàng" pinned={[file]} lines={itemId ? receipts : []} loading={Boolean(itemId) && lines.isLoading} error={lines.error} />;
}

/**
 * One line of the 16/10 stock file whose unit is unclear (owner 17/10): pick the kho item, answer
 * "1 {file unit} = ? {kho unit}", and the server records file qty × factor as the 16/10 count.
 */
function CountQuestionRow({ row, onSaved }: { row: StockCountUnitQuestion; onSaved: (text: string) => void }) {
  const answer = useAnswerCountUnitQuestion();
  const snapshot = useWarehouseGameSnapshot(row.location);
  const [itemId, setItemId] = useState(row.suggested_item_id ?? "");
  const [newName, setNewName] = useState(row.suggested_item ? "" : row.file_label);
  const [newUnit, setNewUnit] = useState(row.file_unit === "kg" ? "g" : row.file_unit);
  const [factorText, setFactorText] = useState(row.suggested_factor != null ? String(row.suggested_factor) : "");
  const creating = itemId === "__new__" || (!itemId && !row.suggested_item);
  const items = snapshot.data?.items ?? [];
  const chosen = creating ? null : items.find((item) => item.id === itemId) ?? (row.suggested_item?.id === itemId ? row.suggested_item : null);
  const khoUnit = creating ? (STOCK_UNITS.find((unit) => unit.code === newUnit)?.code ?? newUnit) : chosen?.unit ?? "";
  const factor = Number(factorText.replace(/\s/g, "").replace(",", "."));
  const input = creating
    ? { newItemName: newName.trim(), newItemUnit: newUnit, factor }
    : { itemId: itemId || null, factor };
  const ready = canSubmit(row, input) && !answer.isPending;
  const counted = Number.isFinite(factor) && factor > 0 ? computeCountedQty(row.file_qty, factor) : null;
  const options = [
    ...(row.suggested_item && !items.some((item) => item.id === row.suggested_item!.id) ? [{ value: row.suggested_item.id, label: `${row.suggested_item.name} · ${row.suggested_item.unit}` }] : []),
    ...items.map((item) => ({ value: item.id, label: `${item.name} · ${item.unit}` })),
    { value: "__new__", label: "＋ Tạo món mới" },
  ];
  const send = (skip: boolean) => answer.mutate(
    skip ? { questionId: row.id, skip: true } : { questionId: row.id, ...input, note: `Tồn 16/10: ${row.file_label} ${fmtQty(row.file_qty)} ${row.file_unit} × ${fmtQty(factor)}` },
    { onSuccess: (saved) => onSaved(skip ? `Bỏ qua “${row.file_label}”` : `Đã ghi ${fmtQty(saved.counted_qty ?? 0)} ${saved.chosen_item?.unit ?? khoUnit} · ${saved.chosen_item?.name ?? row.file_label}`) },
  );

  if (row.status !== "open") {
    return (
      <li className="task-row is-fixed cq-row" data-bmq-count-question={row.file_label} data-status={row.status}>
        <div className="task-head"><b>{row.file_label}</b><small>{LOCATION_LABEL[row.location]} · file: {fmtQty(row.file_qty)} {row.file_unit}</small></div>
        <CountEvidence row={row} itemId={row.item_id ?? row.suggested_item_id} />
        <span className="task-ok">{row.status === "skipped" ? "Đã bỏ qua" : `✓ Đã ghi ${fmtQty(row.counted_qty ?? 0)} ${row.chosen_item?.unit ?? ""} · ${row.chosen_item?.name ?? ""}`}</span>
      </li>
    );
  }
  return (
    <li className="task-row cq-row" data-bmq-count-question={row.file_label} data-status="open">
      <div className="task-head">
        <b>{row.file_label}</b>
        <small>{LOCATION_LABEL[row.location]} · trong file 16/10</small>
      </div>
      <div className="cq-file"><span>File ghi</span><b>{fmtQty(row.file_qty)} {row.file_unit}</b></div>
      <div className="cq-item">
        <GamePicker value={creating ? "__new__" : itemId} onChange={setItemId} placeholder="Chọn món trong kho…" title={`Món kho cho “${row.file_label}”`} ariaLabel={`Món kho cho ${row.file_label}`} options={options} dataAttrs={{ "data-bmq-count-item": row.file_label }} />
      </div>
      <CountEvidence row={row} itemId={creating ? null : itemId || null} />
      {creating ? (
        <div className="cq-new">
          <label className="field">Tên món mới<input value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={120} /></label>
          <label className="field">Kho tính theo<GamePicker value={newUnit} onChange={setNewUnit} title="Đơn vị kho" ariaLabel="Đơn vị kho của món mới" options={UNIT_CHOICES.map((unit) => ({ value: unit.code, label: unit.label }))} /></label>
        </div>
      ) : null}
      <label className="conv">
        1 {row.file_unit} =
        <input inputMode="decimal" value={factorText} onChange={(event) => setFactorText(event.target.value)} placeholder="?" aria-label={`Quy đổi 1 ${row.file_unit} ${row.file_label}`} data-bmq-count-factor />
        {khoUnit || "…"}
      </label>
      {counted !== null && khoUnit ? <div className="task-now cq-preview">Sẽ ghi tồn 16/10: <b>{fmtQty(counted)} {khoUnit}</b></div> : null}
      <div className="row cq-actions">
        <button type="button" className="btn" disabled={!ready} onClick={() => send(false)} data-bmq-count-save>{answer.isPending ? "Đang ghi…" : "Ghi tồn"}</button>
        <button type="button" className="btn ghost" disabled={answer.isPending} onClick={() => send(true)} data-bmq-count-skip>Bỏ qua</button>
      </div>
      {answer.error ? <div className="err">{missionErrorMessage(answer.error)}</div> : null}
    </li>
  );
}

function CountQuestionsTool({ detail, onSaved }: { detail: MissionCountQuestionsDetail | undefined; onSaved: (text: string) => void }) {
  const questions = useCountUnitQuestions(detail?.batch ?? "2026-10-16");
  if (questions.isLoading) return <p className="note">Đang tải câu hỏi…</p>;
  if (questions.error) return <div className="err">{missionErrorMessage(questions.error)}</div>;
  const rows = questions.data ?? [];
  return (
    <>
      <p className="hint">Mỗi dòng: chọn đúng món trong kho, rồi gõ 1 đơn vị trong file bằng bao nhiêu đơn vị kho. Hệ thống tự nhân và ghi tồn ngày 16/10. Dòng không cần theo dõi thì bấm “Bỏ qua”.</p>
      <ul className="task-list" data-bmq-count-questions>{rows.map((row) => <CountQuestionRow key={row.id} row={row} onSaved={onSaved} />)}</ul>
    </>
  );
}

/** One mission opened up: the tool to finish it, then "Nộp nhiệm vụ". */
export function MissionSheet({ mission, onClose, onToast, onCompleted, onOpenQuest }: {
  mission: Mission; onClose: () => void; onToast: (text: string) => void; onCompleted: (result: CompleteMissionResult, mission: Mission) => void;
  /** Gắn mã hàng missions are played in the card deck, not inside the sheet. */
  onOpenQuest?: (location: "q7" | "tan_tao") => void;
}) {
  const complete = useCompleteMission();
  const [requestId] = useState(newRequestId);
  const rule = ruleOf(mission);
  const done = mission.status === "completed";
  const detail = mission.progress.detail;
  const aliases = detail.filter((row): row is MissionAliasDetail => row.kind === "alias_factor_fixed");
  const items = detail.filter((row): row is MissionDuplicateDetail => row.kind === "duplicate_resolved");
  const units = detail.filter((row): row is MissionUnknownUnitDetail => row.kind === "unknown_units_cleared");
  const grouped = units.reduce<Map<string, MissionUnknownUnitDetail[]>>((map, row) => {
    const key = row.unit.trim().toLowerCase();
    map.set(key, [...(map.get(key) ?? []), row]);
    return map;
  }, new Map());
  const steps = missionSteps(mission);

  return (
    <Sheet title={mission.title} tag={`${RULE_ICON[rule]} Nhiệm vụ`} sub={`Thưởng: 🐝 ${mission.badge?.name ?? "Chăm chỉ"} · ${rule === "duplicate" ? (steps.done ? "đã chọn" : "1 quyết định") : `${steps.done}/${steps.total} xong`}`} onClose={onClose}>
      {mission.description ? <p className="note">{mission.description}</p> : null}
      {done ? (
        <div className="done-box"><BeeBadge size={54} /><span><b>Đã hoàn thành</b><small>{mission.completed_at ? new Date(mission.completed_at).toLocaleString("vi-VN") : ""}</small></span></div>
      ) : (
        <>
          {rule === "alias" ? (
            <>
              <p className="hint">Gõ số đúng cho 1 đơn vị ghi trên phiếu. Ví dụ khối phô mai 1kg → 1000; combo 3 thùng × 12 hộp × 1 l → 36000.</p>
              <ul className="task-list">{aliases.map((row) => <AliasRow key={row.id} row={row} onSaved={onToast} />)}</ul>
            </>
          ) : null}
          {rule === "duplicate" ? <DuplicateTool items={items} done={mission.progress.done} onSaved={onToast} /> : null}
          {rule === "links" ? (() => {
            const links = detail.find((row): row is MissionMaterialLinksDetail => row.kind === "material_links");
            const location = links?.location === "tan_tao" ? "tan_tao" : "q7";
            return (
              <div className="lq-mission" data-bmq-mission-links>
                <div className="stats">
                  <div><small>Còn lại</small><b>{links?.remaining ?? "—"}</b></div>
                  <div><small>Đã gắn</small><b>{links?.linked ?? "—"}</b></div>
                  <div><small>Trùng tên</small><b>{links?.exact ?? "—"}</b></div>
                </div>
                {onOpenQuest ? <button type="button" className="btn slip-new" onClick={() => onOpenQuest(location)} data-bmq-mission-open-quest>🧩 Mở bộ bài {location === "q7" ? "Kho Q7" : "Kho Tân Tạo"}</button> : null}
              </div>
            );
          })() : null}
          {rule === "count" ? <CountQuestionsTool detail={detail.find((row): row is MissionCountQuestionsDetail => row.kind === "count_questions")} onSaved={onToast} /> : null}
          {rule === "units" ? (
            grouped.size ? (
              <>
                <p className="hint">Mỗi cách viết: quy về đơn vị chuẩn (vd PACK → gói), hoặc chọn “Không phải hàng kho” cho phí dịch vụ (lần, tháng). Phiếu cũ giữ nguyên.</p>
                <ul className="task-list">{[...grouped.entries()].map(([variant, rows]) => <UnitRow key={variant} variant={variant} rows={rows} onSaved={onToast} />)}</ul>
              </>
            ) : <p className="task-ok big">✓ Không còn đơn vị lạ nào.</p>
          ) : null}
          {complete.error ? <div className="err">{missionErrorMessage(complete.error)}</div> : null}
          <div className="submit-bar">
            <button
              type="button"
              className={`btn submit${mission.progress.done ? " is-ready" : ""}`}
              disabled={!mission.progress.done || complete.isPending}
              data-bmq-mission-submit
              onClick={() => complete.mutate({ missionId: mission.id, requestId }, { onSuccess: (result) => onCompleted(result, mission) })}
            >
              {complete.isPending ? "Đang chấm…" : mission.progress.done ? "Nộp nhiệm vụ · nhận 🐝" : rule === "duplicate" ? "Chọn cách xử lý trước" : `Còn ${mission.progress.left} việc`}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

const CONFETTI = Array.from({ length: 18 }, (_, i) => ({
  left: `${(i * 37) % 100}%`,
  delay: `${(i % 6) * 0.12}s`,
  color: [C.coral, C.mustard, C.sage, C.plum, C.coralLight][i % 5],
  rot: `${(i * 47) % 360}deg`,
}));

/** Badge stamp, then the level-up banner when the badge crossed a threshold. */
export function Ceremony({ result, title, onClose }: { result: CompleteMissionResult; title: string; onClose: () => void }) {
  const [stage, setStage] = useState<"badge" | "level">("badge");
  const levelUp = result.leveled_up && result.level_after;
  const next = () => (stage === "badge" && levelUp ? setStage("level") : onClose());
  return (
    <div className="ceremony" role="dialog" aria-label={stage === "badge" ? "Nhận huy hiệu" : "Lên cấp"} data-bmq-ceremony={stage}>
      <div className="confetti" aria-hidden="true">{CONFETTI.map((c, i) => <i key={`${stage}-${i}`} style={{ left: c.left, animationDelay: c.delay, background: c.color, ["--rot" as string]: c.rot }} />)}</div>
      {stage === "badge" ? (
        <div className="ceremony-card" key="badge">
          <small>Nhiệm vụ hoàn thành</small>
          <h2>{title}</h2>
          <div className="stamp-drop"><BeeBadge size={132} /></div>
          <p>+1 huy hiệu <b>{result.badge?.name ?? "Chăm chỉ"}</b> · tổng {result.badges_total}</p>
          <button type="button" className="btn" onClick={next} autoFocus>{levelUp ? "Tiếp ›" : "Tuyệt!"}</button>
        </div>
      ) : (
        <div className="ceremony-card is-level" key="level">
          <span className="ribbon">LÊN CẤP!</span>
          <svg viewBox="-40 -50 80 86" width="150" height="160" aria-hidden="true" className="level-buddy">
            <circle cx={0} cy={-4} r={36} fill={C.mustardLight} stroke={C.ink} strokeWidth={STROKE} />
            <Buddy x={0} y={-6} mood="wow" hat={hatFor(result.level_after?.level ?? 2)} face={C.white} scale={1.35} />
          </svg>
          <h2>Cấp {result.level_after?.level} · {result.level_after?.title}</h2>
          <p>{result.level_before ? `Từ ${result.level_before.title} lên ${result.level_after?.title}.` : ""} Giữ phong độ nhé!</p>
          <button type="button" className="btn" onClick={onClose} autoFocus>Nhận danh hiệu</button>
        </div>
      )}
    </div>
  );
}
