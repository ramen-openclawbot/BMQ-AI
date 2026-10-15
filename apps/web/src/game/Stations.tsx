import { useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLinkKitchenItemsToCanonical, useRevertStockItemMerge, useRunStockCatalogJev, useStockCatalogReview } from "@/hooks/useStockCatalog";
import { useRunAliasBacklog, type MaterialAliasLocation } from "@/hooks/useMaterialAlias";
import { ClassifyRow, LearnedAliasesCard, MergeRow, errorText } from "@/pages/StockCatalogCleanup";
import { AliasBacklogReview } from "@/components/material-alias/AliasBacklogReview";
import { NewItemSuggestions } from "@/components/material-alias/NewItemSuggestions";
import { StockRoutingCards } from "@/components/stock-routing/StockRoutingCards";
import { useSetItemPastryQ7, useWarehouseGameSnapshot } from "@/hooks/useWarehouseGame";
import { CLASS_META, asClass, normalizeName } from "./meta";
import { STATION_META, type StationId } from "./Workshop";
import { LinkStation } from "./LinkStation";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-stock-ledger.css";
import "@/styles/bmq-material-alias.css";

const shortDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}` : iso;
};

function LocationSwitch({ value, onChange }: { value: MaterialAliasLocation; onChange: (v: MaterialAliasLocation) => void }) {
  return (
    <div className="loc-switch" role="tablist" aria-label="Kho">
      {([["q7", "Kho Q7"], ["tan_tao", "Kho Tân Tạo"]] as const).map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={value === id} className={value === id ? "is-on" : undefined} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="d3-wh-card">
      <div className="d3-wh-card-h"><h2>{title}</h2>{sub ? <p>{sub}</p> : null}</div>
      {children}
    </section>
  );
}

function MergeStation({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const query = useStockCatalogReview();
  const revert = useRevertStockItemMerge();
  const merges = (query.data?.pending_suggestions ?? []).filter((row) => row.kind === "merge");
  const history = query.data?.recent_merges ?? [];
  return (
    <>
      <Section title={`Cặp chờ gộp · ${merges.length}`} sub="Mặt hàng được giữ là bên đang dùng nhiều hơn. Tồn và lịch sử bên kia chuyển sang theo hệ số.">
        {query.isLoading ? <div className="d3-wh-empty">Đang tải…</div> : merges.length === 0 ? <div className="d3-wh-empty">Không có cặp nào chờ gộp. Bấm “Quét cặp trùng” ở Bé Mì rà soát.</div> : (
          <ul className="d3-sc-list">{merges.map((row) => <MergeRow key={row.id} row={row} canEdit={canEdit} />)}</ul>
        )}
      </Section>
      <Section title={`Lịch sử gộp · ${history.length}`}>
        {history.length === 0 ? <div className="d3-wh-empty">Chưa gộp mặt hàng nào.</div> : (
          <ul className="d3-sc-list">
            {history.map((merge) => (
              <li key={merge.merge_id} className={`d3-sc-row is-history${merge.status === "reverted" ? " is-reverted" : ""}`}>
                <div className="d3-sc-side">
                  <strong>{merge.source_name} → {merge.target_name}</strong>
                  <span>hệ số {merge.factor} · {shortDate(merge.applied_at)}{merge.status === "reverted" ? ` · đã hoàn tác ${shortDate(merge.reverted_at)}` : ""}</span>
                </div>
                {canEdit && merge.can_revert ? (
                  <button type="button" className="kg-mini" disabled={revert.isPending} onClick={() => revert.mutate({ mergeId: merge.merge_id }, { onSuccess: () => toast({ title: "Đã hoàn tác", description: `${merge.source_name} hoạt động trở lại.` }), onError: (error) => toast({ title: "Chưa hoàn tác được", description: errorText(error), variant: "destructive" }) })}>
                    <RotateCcw className="h-3.5 w-3.5" /> Hoàn tác
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function ClassifyStation({ canEdit }: { canEdit: boolean }) {
  const query = useStockCatalogReview();
  const rows = (query.data?.pending_suggestions ?? []).filter((row) => row.kind === "classify");
  const counts = query.data?.item_class_counts ?? {};
  return (
    <Section title={`Chờ phân loại · ${rows.length}`} sub={`${counts.unclassified ?? 0} mặt hàng chưa có nhóm. Nguyên liệu, bao bì/vật tư, thành phẩm hay không tồn kho.`}>
      {query.isLoading ? <div className="d3-wh-empty">Đang tải…</div> : rows.length === 0 ? <div className="d3-wh-empty">Không có mặt hàng chờ phân loại. Bấm “Phân loại mặt hàng” ở Bé Mì rà soát.</div> : (
        <ul className="d3-sc-list">{rows.map((row) => <ClassifyRow key={row.id} row={row} canEdit={canEdit} />)}</ul>
      )}
    </Section>
  );
}

function JevStation({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const query = useStockCatalogReview();
  const run = useRunStockCatalogJev();
  const link = useLinkKitchenItemsToCanonical();
  const backlog = useRunAliasBacklog();
  const usage = query.data?.jev_usage;
  const left = usage ? Math.max(0, usage.call_limit - usage.calls) : null;
  const scan = (mode: "dedupe" | "classify") =>
    run.mutate({ mode }, {
      onSuccess: (s) => toast({ title: mode === "dedupe" ? "Bé Mì đã quét cặp trùng" : "Bé Mì đã phân loại", description: `${s.suggestions} đề xuất mới, ${s.skipped_existing} đã có, ${s.failed} lỗi, ${s.calls} lượt gọi${s.stopped ? " · dừng vì hết hạn mức" : ""}.` }),
      onError: (error) => toast({ title: "Bé Mì chưa quét được", description: errorText(error), variant: "destructive" }),
    });
  const scanBacklog = (location: MaterialAliasLocation) =>
    backlog.mutate({ location }, {
      onSuccess: () => toast({ title: `Bé Mì đã dò tên tồn đọng ${location === "q7" ? "Q7" : "Tân Tạo"}` }),
      onError: (error) => toast({ title: "Bé Mì chưa dò được", description: errorText(error), variant: "destructive" }),
    });
  return (
    <>
      <div className="jev-meter">
        <div><small>Lượt Bé Mì hôm nay</small><b>{usage ? `${usage.calls}/${usage.call_limit}` : "…"}</b></div>
        <div><small>Còn lại</small><b>{left ?? "…"}</b></div>
        <div><small>Chi phí</small><b>{usage ? `${usage.cost.toFixed(4)} $` : "…"}</b></div>
      </div>
      {!canEdit ? <p className="note">Chỉ chủ hoặc người sửa kho được chạy máy Bé Mì.</p> : (
        <div className="jev-buttons">
          <button type="button" className="btn" disabled={run.isPending || left === 0} onClick={() => scan("dedupe")}>🔗 Quét cặp trùng</button>
          <button type="button" className="btn" disabled={run.isPending || left === 0} onClick={() => scan("classify")}>🏷️ Phân loại mặt hàng</button>
          <button type="button" className="btn ghost" disabled={backlog.isPending} onClick={() => scanBacklog("q7")}>📦 Dò tên tồn đọng Q7</button>
          <button type="button" className="btn ghost" disabled={backlog.isPending} onClick={() => scanBacklog("tan_tao")}>📦 Dò tên tồn đọng Tân Tạo</button>
          <button
            type="button"
            className="btn ghost"
            disabled={link.isPending}
            onClick={() => link.mutate(undefined, {
              onSuccess: (data) => toast({ title: "Đã rà mã hàng", description: `${Number((data as { linkable_count?: number })?.linkable_count ?? 0)} mặt hàng gắn được mã hàng. Việc gắn thật làm ở Material Master.` }),
              onError: (error) => toast({ title: "Chưa rà được", description: errorText(error), variant: "destructive" }),
            })}
          >
            🧭 Rà mã hàng
          </button>
        </div>
      )}
      {run.isPending || backlog.isPending ? <p className="note">Bé Mì đang làm việc… có thể mất vài phút.</p> : null}
    </>
  );
}

/** Owner rule 12/10: every receipt lands at Tân Tạo; flagged pastry items move on to Q7 by themselves. */
function PastryStation({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const snapshot = useWarehouseGameSnapshot("tan_tao");
  const setFlag = useSetItemPastryQ7();
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const q = normalizeName(query);
  const items = (snapshot.data?.items ?? [])
    .filter((item) => asClass(item.item_class) !== "non_stock")
    .filter((item) => (q ? normalizeName(item.name).includes(q) : true));
  const on = items.filter((item) => item.pastry_q7);
  const off = items.filter((item) => !item.pastry_q7);
  const toggle = (id: string, name: string, value: boolean) => {
    setBusyId(id);
    setFlag.mutate({ itemId: id, value }, {
      onSuccess: () => toast({ title: value ? "Đã đánh dấu bánh ngọt" : "Đã bỏ dấu bánh ngọt", description: value ? `${name} sẽ tự chuyển sang Q7 khi nhập.` : `${name} chỉ ở Tân Tạo.` }),
      onError: (error) => toast({ title: "Chưa lưu được", description: errorText(error), variant: "destructive" }),
      onSettled: () => setBusyId(null),
    });
  };
  const row = (item: (typeof items)[number]) => (
    <li key={item.id} className={`pastry-row${item.pastry_q7 ? " is-on" : ""}`}>
      <span className="pastry-name"><b>{item.name}</b><small>{CLASS_META[asClass(item.item_class)].label} · {item.unit}</small></span>
      {canEdit ? (
        <button type="button" role="switch" aria-checked={item.pastry_q7} aria-label={`Bánh ngọt: ${item.name}`} className="kg-switch" disabled={busyId === item.id} onClick={() => toggle(item.id, item.name, !item.pastry_q7)} data-bmq-pastry-toggle={item.id}>
          <i />
        </button>
      ) : <span className="kg-locked">{item.pastry_q7 ? "Q7" : "Tân Tạo"}</span>}
    </li>
  );
  return (
    <>
      <div className="flow-note">
        <span>🏭 Nhập hết vào <b>Tân Tạo</b></span><span className="flow-arrow">→</span><span>🧁 Món bánh ngọt tự <b>chuyển Q7</b></span>
      </div>
      <label className="field">Tìm mặt hàng<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="gõ tên…" /></label>
      {snapshot.isLoading ? <div className="d3-wh-empty">Đang tải…</div> : (
        <>
          <Section title={`Tự chuyển sang Q7 · ${on.length}`} sub="Khi ghi sổ phiếu nhập, máy lập phiếu chuyển Tân Tạo → Q7 và trừ hết ở Tân Tạo.">
            {on.length ? <ul className="pastry-list">{on.map(row)}</ul> : <div className="d3-wh-empty">Chưa có món nào.</div>}
          </Section>
          <Section title={`Chỉ ở Tân Tạo · ${off.length}`} sub="Q7 không nhận các món này (ví dụ Patê, rau củ, vật tư chung).">
            {off.length ? <ul className="pastry-list">{off.map(row)}</ul> : <div className="d3-wh-empty">Không có món nào.</div>}
          </Section>
        </>
      )}
    </>
  );
}

/** One workshop table opened up. */
export function StationView({ id, canEdit }: { id: StationId; canEdit: boolean }) {
  const meta = STATION_META[id];
  const [location, setLocation] = useState<MaterialAliasLocation>("q7");
  return (
    <div className="shelf-view station-view">
      <div className="shelf-head">
        <div className="plaque" style={{ ["--tint" as string]: meta.tint }}>
          <span className="plaque-icon">{meta.icon}</span>
          <span><b>{meta.label}</b><small>{meta.hint}</small></span>
        </div>
        {id === "backlog" || id === "new" ? <LocationSwitch value={location} onChange={setLocation} /> : null}
      </div>
      <div className="station-body d3-wh" data-bmq-station={id}>
        {id === "merge" ? <MergeStation canEdit={canEdit} /> : null}
        {id === "classify" ? <ClassifyStation canEdit={canEdit} /> : null}
        {id === "pastry" ? <PastryStation canEdit={canEdit} /> : null}
        {id === "links" ? <LinkStation canEdit={canEdit} /> : null}
        {id === "jev" ? <JevStation canEdit={canEdit} /> : null}
        {id === "aliases" ? <LearnedAliasesCard canEdit={canEdit} /> : null}
        {id === "backlog" ? <AliasBacklogReview key={`b-${location}`} canEdit={canEdit} location={location} /> : null}
        {id === "new" ? <NewItemSuggestions key={`n-${location}`} canEdit={canEdit} location={location} /> : null}
        {id === "routing" ? <StockRoutingCards canEdit={canEdit} /> : null}
      </div>
    </div>
  );
}
