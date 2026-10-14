import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { MISSIONS_QUERY_KEY, useCompleteMission, useMarkItemsDistinct, useResolveUnknownUnit, useUpdateAliasFactor } from "@/hooks/useMissions";
import { useRenameStockItem, WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "@/hooks/useWarehouseGame";
import { STOCK_CATALOG_REVIEW_QUERY_KEY } from "@/hooks/useStockCatalog";
import {
  levelProgress, missionErrorMessage,
  type CompleteMissionResult, type Mission, type MissionAliasDetail, type MissionDuplicateDetail, type MissionLevel, type MissionMaterialLinksDetail, type MissionUnknownUnitDetail, type MyMissions,
} from "@/lib/missions";
import { STOCK_UNITS } from "@/lib/stock-units";
import { Sheet } from "./Sheet";
import { GameLoading } from "./Loading";
import { Buddy } from "./Toon";
import { C, STROKE } from "./theme";
import { fmtQty, newRequestId } from "./meta";

/** Mirrors the public.mission_levels seed; the server decides the real level. */
export const LADDER: MissionLevel[] = [
  { level: 1, title: "Tập sự", min_badges: 0 },
  { level: 2, title: "Thợ kho", min_badges: 3 },
  { level: 3, title: "Thợ lành nghề", min_badges: 7 },
  { level: 4, title: "Thợ cả", min_badges: 12 },
  { level: 5, title: "Quản kho", min_badges: 20 },
];

const hatFor = (level: number): "none" | "cap" | "chef" => (level >= 3 ? "chef" : level === 2 ? "cap" : "none");

type Rule = "alias" | "duplicate" | "units" | "links" | "other";

function ruleOf(mission: Mission): Rule {
  const kind = mission.progress.detail[0]?.kind;
  if (kind === "alias_factor_fixed" || mission.code.includes("alias")) return "alias";
  if (kind === "duplicate_resolved" || mission.code.includes("duplicate")) return "duplicate";
  if (kind === "unknown_units_cleared" || mission.code.includes("unit")) return "units";
  if (kind === "material_links" || mission.code.includes("link")) return "links";
  return "other";
}

const RULE_ICON: Record<Rule, string> = { alias: "🏷️", duplicate: "🥐", units: "📏", links: "🧩", other: "📜" };

/** Steps shown on the card: the duplicate pair is one decision, the others count rows. */
export function missionSteps(mission: Mission): { done: number; total: number } {
  if (mission.status === "completed") {
    const total = ruleOf(mission) === "duplicate" ? 1 : Math.max(1, mission.progress.total);
    return { done: total, total };
  }
  if (ruleOf(mission) === "duplicate") return { done: mission.progress.done ? 1 : 0, total: 1 };
  const links = mission.progress.detail.find((row): row is MissionMaterialLinksDetail => row.kind === "material_links");
  if (links) return { done: links.linked, total: Math.max(links.linked + links.remaining, 1) };
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
    <button type="button" className={`todo mission-hud${ready ? " is-ready" : ""}`} onClick={onOpen} aria-label={`Bảng nhiệm vụ, ${open.length} nhiệm vụ đang mở`} data-bmq-mission-hud>
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
    <section className="rank-card" aria-label="Thẻ thợ">
      <div className="rank-avatar">
        <svg viewBox="-34 -44 68 78" width="86" height="98" aria-hidden="true">
          <circle cx={0} cy={-4} r={30} fill={C.sageLight} stroke={C.ink} strokeWidth={STROKE} />
          <Buddy x={0} y={-6} mood="happy" hat={hatFor(level.level)} face={C.mustardLight} scale={1.15} />
        </svg>
        <span className="rank-level">Cấp {level.level}</span>
      </div>
      <div className="rank-main">
        <small>Thẻ thợ kho</small>
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

function MissionCard({ mission, index, onOpen }: { mission: Mission; index: number; onOpen: () => void }) {
  const rule = ruleOf(mission);
  const steps = missionSteps(mission);
  const done = mission.status === "completed";
  const ready = readyToSubmit(mission);
  return (
    <li>
      <button
        type="button"
        className={`mission-note${done ? " is-done" : ""}${ready ? " is-ready" : ""}`}
        style={{ ["--tilt" as string]: `${index % 2 ? 1.2 : -1.4}deg`, animationDelay: `${index * 70}ms` }}
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
        <span className="mission-foot">
          <span className="mission-reward"><BeeBadge size={24} /> {mission.badge?.name ?? "Chăm chỉ"}</span>
          {done ? null : <span className={`mission-go${ready ? " is-ready" : ""}`}>{ready ? "Nộp nhận 🐝" : "Làm"}</span>}
        </span>
        {done ? <span className="stamp" aria-label="Đã hoàn thành">XONG</span> : null}
      </button>
    </li>
  );
}

/** The mission board scene: rank card + cork board of notes. */
export function MissionBoard({ data, isLoading, error, onOpen }: {
  data: MyMissions | undefined; isLoading: boolean; error: unknown; onOpen: (id: string) => void;
}) {
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
          <ul className="mission-grid">{open.map((mission, i) => <MissionCard key={mission.id} mission={mission} index={i} onOpen={() => onOpen(mission.id)} />)}</ul>
        ) : (
          <p className="cork-empty">Không còn nhiệm vụ nào. Nghỉ tay một chút! ☕</p>
        )}
      </section>
      {finished.length ? (
        <section className="cork is-done" aria-label="Nhiệm vụ đã xong">
          <h2 className="cork-title"><span>🏅</span> Đã hoàn thành · {finished.length}</h2>
          <ul className="mission-grid">{finished.map((mission, i) => <MissionCard key={mission.id} mission={mission} index={i + 1} onOpen={() => onOpen(mission.id)} />)}</ul>
        </section>
      ) : null}
    </div>
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

function AliasRow({ row, onSaved }: { row: MissionAliasDetail; onSaved: (text: string) => void }) {
  const update = useUpdateAliasFactor();
  const [text, setText] = useState("");
  const [requestId] = useState(newRequestId);
  const value = Number(text.replace(",", "."));
  const ok = Number.isFinite(value) && value > 0 && value !== row.factor;
  return (
    <li className={`task-row${row.fixed ? " is-fixed" : ""}`} data-bmq-mission-alias>
      <div className="task-head">
        <b>“{row.name ?? "bí danh đã xoá"}”</b>
        <small>→ {row.item_name ?? "—"}{row.item_unit ? ` · kho tính ${row.item_unit}` : ""}</small>
      </div>
      <div className="task-now">Đang tính: 1 đơn vị trên phiếu = <b>{row.factor === null ? "—" : fmtQty(row.factor)} {row.item_unit ?? row.unit ?? ""}</b></div>
      {row.fixed ? <span className="task-ok">✓ Đã sửa</span> : (
        <>
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
            <span>{item.unit ?? "—"} · {item.alias_count} bí danh{item.active ? "" : " · đã ngưng"}</span>
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
          <p className="note">Giữ lại món nào? Món kia gộp vào, bí danh và lịch sử chuyển theo (hoàn tác được ở Bàn gộp).</p>
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
      <div className="unit-actions">
        <select value={code} onChange={(event) => setCode(event.target.value)} aria-label={`Quy ${variant} về đơn vị chuẩn`}>
          <option value="">Quy về đơn vị…</option>
          {UNIT_CHOICES.map((unit) => <option key={unit.code} value={unit.code}>{unit.label}</option>)}
        </select>
        <button type="button" className="btn" disabled={!code || resolve.isPending} onClick={() => resolve.mutate({ variant, action: "map", code, requestId }, { onSuccess: () => onSaved(`“${variant}” → ${code}`) })}>Gán</button>
        <button type="button" className="btn ghost" disabled={resolve.isPending} onClick={() => resolve.mutate({ variant, action: "not_stock", requestId }, { onSuccess: () => onSaved(`“${variant}” không phải hàng kho`) })}>Không phải hàng kho</button>
      </div>
      {resolve.error ? <div className="err">{missionErrorMessage(resolve.error)}</div> : null}
    </li>
  );
}

/** One mission opened up: the tool to finish it, then "Nộp nhiệm vụ". */
export function MissionSheet({ mission, onClose, onToast, onCompleted, onOpenQuest }: {
  mission: Mission; onClose: () => void; onToast: (text: string) => void; onCompleted: (result: CompleteMissionResult, mission: Mission) => void;
  /** Gắn mã chuẩn missions are played in the card deck, not inside the sheet. */
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
