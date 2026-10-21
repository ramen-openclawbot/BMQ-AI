import type { WarehouseGameLocation, WarehouseGamePendingRow } from "@/lib/warehouse-game";
import { crateKey } from "./Warehouse";

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

/**
 * A name-match candidate worth showing. One shared word ("bánh", "nhãn") gives a 0.63 token score that ties
 * across many items (owner 12/10: "Nhãn Bánh Pháp" → "Chất làm mềm bánh"), so token-only matches need ≥ 0.75.
 */
export function strongCandidate(crate: WarehouseGamePendingRow) {
  const c = crate.top_candidate;
  if (!c?.name) return null;
  const tokenOnly = (c.reason ?? "").includes("token");
  return tokenOnly && Number(c.score ?? 0) < 0.75 ? null : c;
}

/** What the label sheet will offer first for a crate: the closest name already in this warehouse. */
function crateHint(crate: WarehouseGamePendingRow): { name: string; unit: string | null; itemId: string | null } | null {
  const near = strongCandidate(crate);
  return near ? { name: near.name, unit: near.unit ?? null, itemId: near.item_id ?? null } : null;
}

function CrateCard({ crate, index, leaving, pastryIds, onOpen }: { crate: WarehouseGamePendingRow; index: number; leaving: boolean; pastryIds: Set<string>; onOpen: () => void }) {
  const hint = crateHint(crate);
  const toQ7 = Boolean(hint?.itemId && pastryIds.has(hint.itemId));
  return (
    <li>
      <button
        type="button"
        className={`crate-card${leaving ? " is-leaving" : ""}`}
        style={{ animationDelay: `${Math.min(index, 16) * 35}ms` }}
        onClick={onOpen}
        data-bmq-crate={crate.normalized_name}
      >
        <span className="crate-tape" aria-hidden="true" />
        <span className="crate-face" aria-hidden="true">{hint ? "•ᴗ•" : "•︵•"}</span>
        <b className="crate-name">{crate.raw_name}</b>
        <span className="crate-meta">{crate.supplier_name ?? "Chưa rõ NCC"} · {crate.line_count} dòng · {shortDate(crate.last_receipt_date)}</span>
        {hint ? (
          <span className="crate-hint">
            <small>Gần nhất</small>
            <span>{hint.name}{hint.unit ? ` · ${hint.unit}` : ""}</span>
            {toQ7 ? <em className="crate-q7">🧁 tự chuyển Q7</em> : null}
          </span>
        ) : <span className="crate-hint is-none"><small>Chưa có trong kho</small><span>Tạo mới “{cleanCrateName(crate.raw_name)}”</span></span>}
        <span className={`crate-go${hint ? "" : " is-new"}`}>{hint ? "Dán nhãn ›" : "＋ Tạo mới ›"}</span>
      </button>
    </li>
  );
}

/** The crate yard of one warehouse: the player labels each crate, starting from the closest name. */
export function CrateYard({ location, crates, canAssign, pastryIds, leavingKey, onOpen }: {
  location: WarehouseGameLocation; crates: WarehouseGamePendingRow[]; canAssign: boolean; pastryIds: Set<string>;
  leavingKey: string | null; onOpen: (crate: WarehouseGamePendingRow) => void;
}) {
  const near = crates.filter((crate) => crateHint(crate));
  const fresh = crates.filter((crate) => !crateHint(crate));
  const say = !canAssign ? "Chỉ chủ hoặc người sửa kho được dán nhãn."
    : crates.length === 0 ? "Bãi sạch trơn! Không còn thùng nào ✓"
    : `${crates.length} món chưa dán nhãn${near.length ? `, ${near.length} món có tên gần giống trong kho` : ""}. Bấm từng thùng để dán nhãn!`;
  return (
    <div className="shelf-view crate-yard" data-bmq-crate-yard={location}>
      <section className="yard-head">
        <p className="yard-say">{say}</p>
        <p className="yard-rule">{location === "tan_tao" ? "Mọi phiếu nhập về Tân Tạo; món để ở Q7 tự chuyển sang Q7. " : "Q7 chỉ nhận món để ở Q7. "}Chỉ hiện tên có nhập trong 60 ngày.</p>
      </section>

      {canAssign && near.length ? (
        <section className="yard-lot">
          <h2 className="cork-title"><span>📦</span> Chưa rõ · {near.length}</h2>
          <ul className="crate-grid">{near.map((crate, i) => <CrateCard key={crateKey(crate)} crate={crate} index={i} leaving={leavingKey === crateKey(crate)} pastryIds={pastryIds} onOpen={() => onOpen(crate)} />)}</ul>
        </section>
      ) : null}
      {canAssign && fresh.length ? (
        <section className="yard-lot is-new" data-bmq-crate-lot="new">
          <h2 className="cork-title"><span>✨</span> Chưa có trong kho · tạo mới · {fresh.length}</h2>
          <ul className="crate-grid">{fresh.map((crate, i) => <CrateCard key={crateKey(crate)} crate={crate} index={i} leaving={leavingKey === crateKey(crate)} pastryIds={pastryIds} onOpen={() => onOpen(crate)} />)}</ul>
        </section>
      ) : null}
    </div>
  );
}
