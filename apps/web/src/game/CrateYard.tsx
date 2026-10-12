import type { WarehouseGameLocation, WarehouseGamePendingRow } from "@/lib/warehouse-game";
import { crateKey } from "./Warehouse";
import { C, STROKE } from "./theme";

export type JevState = "idle" | "working" | "done" | "error";

/** Jev, the sorting robot: plum body, screen face, antenna bulb. `working` scans and blinks. */
export function JevBot({ state, size = 120 }: { state: JevState; size?: number }) {
  const eye = state === "working" ? C.mustardLight : state === "error" ? C.coralLight : C.sageLight;
  return (
    <svg viewBox="-60 -70 120 140" width={size} height={size * (140 / 120)} className={`jev-bot is-${state}`} aria-hidden="true">
      <ellipse cx={4} cy={62} rx={40} ry={7} fill={C.shadow} />
      {/* antenna */}
      <line x1={0} y1={-42} x2={0} y2={-58} stroke={C.ink} strokeWidth={STROKE} strokeLinecap="round" />
      <circle className="jev-bulb" cx={0} cy={-61} r={7} fill={state === "working" ? C.mustard : state === "done" ? C.sage : C.coral} stroke={C.ink} strokeWidth={STROKE} />
      <g className="jev-body">
        {/* arms */}
        <g className="jev-arm-l"><path d="M-40 8 q-16 4 -18 22" fill="none" stroke={C.ink} strokeWidth={STROKE} strokeLinecap="round" /><circle cx={-58} cy={32} r={7} fill={C.plumLight} stroke={C.ink} strokeWidth={STROKE} /></g>
        <g className="jev-arm-r"><path d="M40 8 q16 4 18 22" fill="none" stroke={C.ink} strokeWidth={STROKE} strokeLinecap="round" /><circle cx={58} cy={32} r={7} fill={C.plumLight} stroke={C.ink} strokeWidth={STROKE} /></g>
        {/* head */}
        <rect x={-42} y={-44} width={84} height={64} rx={18} fill={C.plum} stroke={C.ink} strokeWidth={STROKE} />
        <rect x={-32} y={-34} width={64} height={44} rx={11} fill={C.ink} />
        {state === "working" ? (
          <>
            <rect className="jev-scan" x={-30} y={-32} width={60} height={4} rx={2} fill={C.mustardLight} opacity={0.8} />
            <rect x={-20} y={-18} width={12} height={8} rx={3} fill={eye} />
            <rect x={8} y={-18} width={12} height={8} rx={3} fill={eye} />
          </>
        ) : state === "done" ? (
          <>
            <path d="M-20 -12 q6 -9 12 0" fill="none" stroke={eye} strokeWidth={3.5} strokeLinecap="round" />
            <path d="M8 -12 q6 -9 12 0" fill="none" stroke={eye} strokeWidth={3.5} strokeLinecap="round" />
            <path d="M-8 0 q8 7 16 0" fill="none" stroke={eye} strokeWidth={3} strokeLinecap="round" />
          </>
        ) : (
          <>
            <circle className="jev-eye" cx={-14} cy={-14} r={6} fill={eye} />
            <circle className="jev-eye" cx={14} cy={-14} r={6} fill={eye} />
            <path d={state === "error" ? "M-8 4 q8 -6 16 0" : "M-7 1 h14"} fill="none" stroke={eye} strokeWidth={3} strokeLinecap="round" />
          </>
        )}
        {/* body */}
        <rect x={-30} y={20} width={60} height={36} rx={10} fill={C.plumLight} stroke={C.ink} strokeWidth={STROKE} />
        <text x={0} y={44} textAnchor="middle" className="t-jev">JEV</text>
      </g>
    </svg>
  );
}

const shortDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const [, m, d] = iso.slice(0, 10).split("-");
  return d && m ? `${d}/${m}` : iso;
};

/** Receipt name → a clean catalog name: no [tags], no "/ English", no "ngày 10" or trailing day number. */
export function cleanCrateName(raw: string): string {
  let name = raw.replace(/^\s*(\[[^\]]*\]\s*)+/, "").split("/")[0];
  name = name.replace(/\bng[aà]y\s*\d{1,2}\b/giu, " ").replace(/\s+\d{1,2}\s*$/u, "").replace(/\s+/g, " ").trim();
  if (!name) return raw.trim();
  if (name === name.toUpperCase() && /\p{L}/u.test(name)) name = name.toLowerCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** What the label sheet will offer first for a crate: the Jev pick, else the closest name. */
export function crateHint(crate: WarehouseGamePendingRow): { name: string; unit: string | null; tag: string; strong: boolean } | null {
  if (crate.jev_item_id && crate.jev_item_name) {
    const tag = crate.jev_source === "exact" ? "Trùng tên" : `Jev ${Math.round((crate.jev_probability ?? 0) * 100)}%`;
    return { name: crate.jev_item_name, unit: crate.jev_unit, tag, strong: true };
  }
  if (crate.top_candidate?.name) return { name: crate.top_candidate.name, unit: crate.top_candidate.unit ?? null, tag: "Gần nhất", strong: false };
  return null;
}

function CrateCard({ crate, index, leaving, onOpen }: { crate: WarehouseGamePendingRow; index: number; leaving: boolean; onOpen: () => void }) {
  const hint = crateHint(crate);
  return (
    <li>
      <button
        type="button"
        className={`crate-card${hint?.strong ? " has-jev" : ""}${leaving ? " is-leaving" : ""}`}
        style={{ animationDelay: `${Math.min(index, 16) * 35}ms` }}
        onClick={onOpen}
        data-bmq-crate={crate.normalized_name}
      >
        <span className="crate-tape" aria-hidden="true" />
        <span className="crate-face" aria-hidden="true">{hint?.strong ? "•ᴗ•" : "•︵•"}</span>
        <b className="crate-name">{crate.raw_name}</b>
        <span className="crate-meta">{crate.supplier_name ?? "Chưa rõ NCC"} · {crate.line_count} dòng · {shortDate(crate.last_receipt_date)}</span>
        {hint ? (
          <span className={`crate-hint${hint.strong ? " is-jev" : ""}`}>
            <small>{hint.tag}</small>
            <span>{hint.name}{hint.unit ? ` · ${hint.unit}` : ""}</span>
          </span>
        ) : <span className="crate-hint is-none"><small>Chưa có trong kho</small><span>Tạo mới “{cleanCrateName(crate.raw_name)}”</span></span>}
        <span className={`crate-go${hint ? "" : " is-new"}`}>{hint ? "Dán nhãn ›" : "＋ Tạo mới ›"}</span>
      </button>
    </li>
  );
}

/** The crate yard of one warehouse: Jev sorts first, then the player labels with the hint. */
export function CrateYard({ location, crates, canAssign, jev, progress, leavingKey, onRunJev, onOpen }: {
  location: WarehouseGameLocation; crates: WarehouseGamePendingRow[]; canAssign: boolean;
  jev: JevState; progress: { done: number; total: number } | null; leavingKey: string | null;
  onRunJev: () => void; onOpen: (crate: WarehouseGamePendingRow) => void;
}) {
  const withHint = crates.filter((crate) => crateHint(crate)?.strong);
  const near = crates.filter((crate) => { const hint = crateHint(crate); return hint && !hint.strong; });
  const fresh = crates.filter((crate) => !crateHint(crate));
  const label = location === "q7" ? "Kho Q7" : "Kho Tân Tạo";
  const say = !canAssign ? "Chỉ chủ hoặc người sửa kho được dán nhãn."
    : jev === "working" ? `Jev đang phân loại…${progress && progress.total ? ` ${progress.done}/${progress.total}` : ""}`
    : jev === "error" ? "Jev chưa chạy được. Thử lại sau nhé."
    : crates.length === 0 ? "Bãi sạch trơn! Không còn thùng nào ✓"
    : withHint.length === crates.length ? `Đã gợi ý cả ${crates.length} thùng. Bấm từng thùng để dán nhãn!`
    : jev === "done" ? `Xong! Gợi ý được ${withHint.length}/${crates.length} thùng. Thùng còn lại anh chọn tay nha.`
    : `${crates.length} thùng chờ, ${withHint.length} đã có gợi ý. Bấm nút để Jev phân loại giúp!`;
  return (
    <div className="shelf-view crate-yard" data-bmq-crate-yard={location}>
      <section className="jev-stage" data-bmq-jev={jev}>
        <div className="jev-figure"><JevBot state={jev} size={112} /></div>
        <div className="jev-talk">
          <div className="jev-bubble"><small>Jev · {label}</small><p>{say}</p></div>
          {progress && jev === "working" ? <div className="jev-progress"><i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 8}%` }} /></div> : null}
          {canAssign && crates.length > 0 ? (
            <button type="button" className="btn jev-run" disabled={jev === "working"} onClick={onRunJev} data-bmq-jev-run>
              {jev === "working" ? "Jev đang làm…" : withHint.length === crates.length ? "🤖 Cho Jev xem lại" : "🤖 Jev phân loại"}
            </button>
          ) : null}
          <p className="yard-rule">Chỉ hiện tên có nhập trong 60 ngày; tên lâu không nhập tự bỏ qua.</p>
        </div>
      </section>

      {canAssign && withHint.length ? (
        <section className="yard-lot is-jev">
          <h2 className="cork-title"><span>★</span> Jev đã gợi ý · {withHint.length}</h2>
          <ul className="crate-grid">{withHint.map((crate, i) => <CrateCard key={crateKey(crate)} crate={crate} index={i} leaving={leavingKey === crateKey(crate)} onOpen={() => onOpen(crate)} />)}</ul>
        </section>
      ) : null}
      {canAssign && near.length ? (
        <section className="yard-lot">
          <h2 className="cork-title"><span>📦</span> Chưa rõ · {near.length}</h2>
          <ul className="crate-grid">{near.map((crate, i) => <CrateCard key={crateKey(crate)} crate={crate} index={i} leaving={leavingKey === crateKey(crate)} onOpen={() => onOpen(crate)} />)}</ul>
        </section>
      ) : null}
      {canAssign && fresh.length ? (
        <section className="yard-lot is-new" data-bmq-crate-lot="new">
          <h2 className="cork-title"><span>✨</span> Chưa có trong kho · tạo mới · {fresh.length}</h2>
          <ul className="crate-grid">{fresh.map((crate, i) => <CrateCard key={crateKey(crate)} crate={crate} index={i} leaving={leavingKey === crateKey(crate)} onOpen={() => onOpen(crate)} />)}</ul>
        </section>
      ) : null}
    </div>
  );
}
