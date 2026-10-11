import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useChangeStockItemUnit, useRenameStockItem, useWarehouseGameSnapshot, WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "@/hooks/useWarehouseGame";
import { useConfirmMaterialAlias, useCreateStockMaterialItem } from "@/hooks/useMaterialAlias";
import { unitConversionFor, type WarehouseGameItem, type WarehouseGameLocation, type WarehouseGamePendingRow, type WarehouseGameSnapshot } from "@/lib/warehouse-game";
import { packFactorFor } from "@/components/material-alias/new-stock-item";
import { Yard, type Zone } from "@/game/Yard";
import { Warehouse, crateKey, layoutRows } from "@/game/Warehouse";
import { Shelf, entriesFor, type ShelfEntry } from "@/game/Shelf";
import { Sheet } from "@/game/Sheet";
import { Scene, usePortrait } from "@/game/Scene";
import { CLASS_META, ITEM_UNITS, asClass, fmtQty, newRequestId, normalizeName, type GameClass } from "@/game/meta";
import { STATION_META, STATION_ORDER, Workshop, type StationId } from "@/game/Workshop";
import { StationView } from "@/game/Stations";
import { useAuth } from "@/contexts/AuthContext";
import { useStockCatalogReview } from "@/hooks/useStockCatalog";
import { useMaterialAliasReview, useNewItemSuggestions } from "@/hooks/useMaterialAlias";
import { useStockRoutingReview } from "@/hooks/useStockRouting";
import "@/game/game.css";

type View =
  | { kind: "yard" }
  | { kind: "workshop" }
  | { kind: "station"; id: StationId }
  | { kind: "warehouse"; location: WarehouseGameLocation }
  | { kind: "shelf"; location: WarehouseGameLocation; cls: GameClass };

type Panel =
  | { kind: "zone"; zone: Zone }
  | { kind: "item"; location: WarehouseGameLocation; id: string }
  | { kind: "sku"; entry: ShelfEntry }
  | { kind: "crate"; location: WarehouseGameLocation; crate: WarehouseGamePendingRow }
  | null;

const LOCATION_LABEL: Record<WarehouseGameLocation, string> = { q7: "Kho Q7", tan_tao: "Kho Tân Tạo" };

const ZONE_ROUTES: Record<string, string> = {
  ledger: "/warehouse/stock-ledger",
  count: "/warehouse/stock-ledger",
  auto: "/warehouse/auto-purchase",
  clean: "/warehouse/catalog-cleanup",
};

function errorText(error: unknown): string {
  const message = String((error as { message?: string })?.message ?? error);
  const known: Array<[string, string]> = [
    ["item_name_duplicate", "Tên này đã có ở một mặt hàng khác."],
    ["invalid_name", "Tên phải dài 2–120 ký tự."],
    ["rename_forbidden", "Chỉ chủ hoặc người sửa kho Q7 được đổi tên."],
    ["unit_forbidden", "Chỉ chủ hoặc người sửa kho Q7 được đổi đơn vị."],
    ["unit_not_allowed", "Đơn vị không có trong bảng chuẩn."],
    ["unit_unchanged", "Đơn vị mới giống đơn vị cũ (kho lưu g / ml)."],
    ["invalid_factor", "Cần hệ số quy đổi lớn hơn 0."],
    ["create_item_forbidden", "Chỉ chủ hoặc người sửa kho Q7 được tạo mặt hàng."],
    ["non_stock_requires_admin", "Chỉ chủ hoặc người sửa kho Q7 được đánh dấu không nhập kho."],
    ["insufficient_privilege", "Tài khoản chưa có quyền với kho này."],
  ];
  return known.find(([code]) => message.includes(code))?.[1] ?? message;
}

function useGameFonts() {
  useEffect(() => {
    const id = "kg-fonts";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Nunito:wght@600;700;800;900&display=swap";
    document.head.appendChild(link);
  }, []);
}

export default function WarehouseGame() {
  useGameFonts();
  const portrait = usePortrait();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const q7 = useWarehouseGameSnapshot("q7");
  const tt = useWarehouseGameSnapshot("tan_tao");
  const snaps: Record<WarehouseGameLocation, WarehouseGameSnapshot | undefined> = { q7: q7.data, tan_tao: tt.data };
  const [view, setView] = useState<View>({ kind: "yard" });
  const [panel, setPanel] = useState<Panel>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [flying, setFlying] = useState<{ key: string; to: GameClass } | null>(null);
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const { isOwner, canEditModule } = useAuth();
  const canClean = isOwner || canEditModule("q7_material_inventory") || canEditModule("kitchen_inventory");
  const catalogReview = useStockCatalogReview();
  const aliasReview = useMaterialAliasReview(7);
  const newQ7 = useNewItemSuggestions("q7");
  const newTt = useNewItemSuggestions("tan_tao");
  const routing = useStockRoutingReview();

  // Full screen: the game owns the page while it is open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const crates = { q7: q7.data?.pending.length ?? 0, tan_tao: tt.data?.pending.length ?? 0 };
  const counts = { q7: q7.data?.items.length ?? 0, tan_tao: (tt.data?.items.length ?? 0) + (tt.data?.skus.length ?? 0) };
  const [startCrates, setStartCrates] = useState<number | null>(null);
  const totalCrates = crates.q7 + crates.tan_tao;
  useEffect(() => {
    if (startCrates === null && q7.data && tt.data) setStartCrates(totalCrates);
  }, [q7.data, tt.data, startCrates, totalCrates]);
  const done = Math.max(0, (startCrates ?? totalCrates) - totalCrates);

  const go = (next: View) => { setPanel(null); setQuery(""); setView(next); };
  const back = () => {
    if (view.kind === "shelf") go({ kind: "warehouse", location: view.location });
    else if (view.kind === "station") go({ kind: "workshop" });
    else if (view.kind === "warehouse" || view.kind === "workshop") go({ kind: "yard" });
  };

  const pendingSuggestions = catalogReview.data?.pending_suggestions ?? [];
  const stations = STATION_ORDER.map((id) => {
    const count = id === "merge" ? pendingSuggestions.filter((row) => row.kind === "merge").length
      : id === "classify" ? pendingSuggestions.filter((row) => row.kind === "classify").length
      : id === "new" ? (newQ7.data ?? []).filter((g) => g.status === "pending").length + (newTt.data ?? []).filter((g) => g.status === "pending").length
      : id === "backlog" ? totalCrates
      : id === "aliases" ? (aliasReview.data?.aliases.length ?? 0)
      : id === "routing" ? (routing.data ? routing.data.supplier_pending.length + routing.data.material_pending.length : 0)
      : null;
    return { id, ...STATION_META[id], count: id === "aliases" ? null : count };
  });
  const workshopTodo = stations.reduce((sum, station) => sum + (station.id === "backlog" ? 0 : station.count ?? 0), 0);

  const inWarehouse = view.kind === "warehouse" || view.kind === "shelf";
  const current = inWarehouse ? snaps[view.location] : undefined;
  const currentQuery = inWarehouse ? (view.location === "q7" ? q7 : tt) : undefined;
  const title = view.kind === "yard" ? "Phố kho BMQ"
    : view.kind === "workshop" ? "Xưởng dọn danh mục"
    : view.kind === "station" ? `${STATION_META[view.id].icon} ${STATION_META[view.id].label}`
    : view.kind === "warehouse" ? LOCATION_LABEL[view.location]
    : `${CLASS_META[view.cls].icon} ${CLASS_META[view.cls].label}`;
  const subtitle = view.kind === "yard" ? "Bấm vào kho để vào"
    : view.kind === "workshop" ? (workshopTodo ? `${workshopTodo} việc đang chờ` : "Mọi bàn đã gọn")
    : view.kind === "station" ? "Xưởng dọn danh mục"
    : view.kind === "shelf" ? LOCATION_LABEL[view.location]
    : current?.cutover_date ? `Sổ từ ${current.cutover_date.split("-").reverse().join("/")}` : "Sổ chưa bắt đầu";

  const afterAssign = (location: WarehouseGameLocation, crate: WarehouseGamePendingRow, cls: GameClass, label: string) => {
    setPanel(null);
    setFlying({ key: crateKey(crate), to: cls });
    window.setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] }).then(() => setFlying(null));
      setToast(`“${crate.raw_name}” → ${label} · ${crate.line_count} dòng`);
    }, 800);
    void location;
  };

  return (
    <div className={`kg is-full${portrait ? " is-portrait" : ""}`} data-bmq-warehouse-game>
      <header className="hud">
        <button type="button" className="round-btn" onClick={back} disabled={view.kind === "yard"} aria-label="Quay lại">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <div className="title-pill"><b>{title}</b><small>{subtitle}</small></div>
        <div className="todo" aria-label="Thùng chờ dán nhãn">
          <div className="todo-rings" aria-hidden="true"><i /><i /><i /><i /></div>
          <span className="todo-star" aria-hidden="true">★</span>
          <div className="todo-body">
            <small>Thùng chờ</small>
            <b data-bmq-game-pending>{totalCrates}</b>
            <span className="todo-bar"><i style={{ width: `${startCrates ? (done / Math.max(1, startCrates)) * 100 : 0}%` }} /></span>
          </div>
        </div>
        <button type="button" className="round-btn exit-btn" onClick={() => navigate("/")} aria-label="Thoát về Tổng quan" title="Thoát về Tổng quan">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </header>

      <main className="stage">
        {view.kind === "yard" ? (
          q7.isLoading && tt.isLoading ? <div className="loading">Đang mở cửa kho…</div> : (
            <Scene id={`yard-${portrait}`} fill={portrait}>
              <Yard
                portrait={portrait}
                counts={counts}
                crates={crates}
                onEnter={(location) => go({ kind: "warehouse", location })}
                onZone={(zone) => (zone.id === "clean" ? go({ kind: "workshop" }) : setPanel({ kind: "zone", zone }))}
              />
            </Scene>
          )
        ) : null}

        {view.kind === "workshop" ? (
          <Scene id={`workshop-${portrait}`} scroll>
            <Workshop portrait={portrait} stations={stations} onStation={(id) => go({ kind: "station", id })} />
          </Scene>
        ) : null}

        {view.kind === "station" ? (
          <Scene id={`station-${view.id}`} scroll>
            <StationView id={view.id} canEdit={canClean} />
          </Scene>
        ) : null}

        {inWarehouse && currentQuery?.isError ? (
          <div className="loading"><div className="err">{errorText(currentQuery.error)}</div></div>
        ) : null}
        {inWarehouse && !current && currentQuery?.isLoading ? <div className="loading">Đang mở cửa kho…</div> : null}

        {view.kind === "warehouse" && current ? (
          <Scene id={`wh-${view.location}-${portrait}`} scroll>
            <Warehouse
              portrait={portrait}
              location={view.location}
              rows={layoutRows(current)}
              crates={current.pending}
              flying={flying}
              canAssign={current.can_edit}
              onShelf={(cls) => go({ kind: "shelf", location: view.location, cls })}
              onCrate={(crate) => setPanel({ kind: "crate", location: view.location, crate })}
            />
          </Scene>
        ) : null}

        {view.kind === "shelf" && current ? (
          <Scene id={`shelf-${view.location}-${view.cls}`} scroll>
            <Shelf
              cls={view.cls}
              entries={entriesFor(view.cls, current)}
              started={Boolean(current.cutover_date)}
              query={query}
              onQuery={setQuery}
              selectedId={panel?.kind === "item" ? panel.id : null}
              justSaved={justSaved}
              onPick={(entry) => (entry.isSku ? setPanel({ kind: "sku", entry }) : setPanel({ kind: "item", location: view.location, id: entry.id }))}
            />
          </Scene>
        ) : null}

        {panel?.kind === "zone" ? (
          <Sheet title={`${panel.zone.icon} ${panel.zone.label}`} tag="Khu chức năng" sub="Bản game của khu này làm ở bước sau." onClose={() => setPanel(null)}>
            <p className="note">{panel.zone.blurb}</p>
            <div className="row">
              <button type="button" className="btn" onClick={() => navigate(ZONE_ROUTES[panel.zone.id] ?? "/warehouse/stock-ledger")}>Mở trang {panel.zone.label}</button>
              <button type="button" className="btn ghost" onClick={() => setPanel(null)}>Ở lại</button>
            </div>
          </Sheet>
        ) : null}

        {panel?.kind === "sku" ? (
          <Sheet title={panel.entry.name} tag="🥖 Thành phẩm SKU" sub={`Mã ${panel.entry.code}`} onClose={() => setPanel(null)}>
            <div className="stats">
              <div><small>Đơn vị</small><b>{panel.entry.unit}</b></div>
              <div><small>Tồn</small><b>{fmtQty(panel.entry.qty)}</b></div>
              <div><small>Nguồn</small><b>SKU</b></div>
            </div>
            <p className="note">Thành phẩm quản lý theo mã SKU; đổi tên ở Material Master.</p>
          </Sheet>
        ) : null}

        {panel?.kind === "item" && current ? (() => {
          const item = current.items.find((entry) => entry.id === panel.id);
          return item ? (
            <ItemSheet
              key={item.id}
              item={item}
              others={current.items}
              canEdit={current.can_edit}
              started={Boolean(current.cutover_date)}
              onDone={(id, message) => { setJustSaved(id); window.setTimeout(() => setJustSaved(null), 2600); setToast(message); setPanel(null); }}
              onClose={() => setPanel(null)}
            />
          ) : null;
        })() : null}

        {panel?.kind === "crate" && current ? (
          <CrateSheet
            key={crateKey(panel.crate)}
            location={panel.location}
            crate={panel.crate}
            snapshot={current}
            onAssigned={(cls, label) => afterAssign(panel.location, panel.crate, cls, label)}
            onClose={() => setPanel(null)}
          />
        ) : null}

        {toast ? <div className="toast" role="status">{toast}</div> : null}
      </main>
    </div>
  );
}

function ItemSheet({ item, others, canEdit, started, onDone, onClose }: {
  item: WarehouseGameItem; others: WarehouseGameItem[]; canEdit: boolean; started: boolean;
  onDone: (id: string, message: string) => void; onClose: () => void;
}) {
  const rename = useRenameStockItem();
  const changeUnit = useChangeStockItemUnit();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [unit, setUnit] = useState(item.unit);
  const [factorText, setFactorText] = useState("");
  const [requestId] = useState(newRequestId);
  const [unitRequestId] = useState(newRequestId);
  const meta = CLASS_META[asClass(item.item_class)];
  const trimmed = name.trim();
  const duplicate = others.find((other) => other.id !== item.id && normalizeName(other.name) === normalizeName(trimmed));
  const nameChanged = trimmed !== item.name;
  const unitChanged = unit !== item.unit;
  const autoFactor = unitChanged ? unitConversionFor(item.unit, unit) : null;
  const factor = autoFactor ?? Number(factorText.replace(",", "."));
  const factorOk = !unitChanged || (Number.isFinite(factor) && factor > 0);
  const busy = rename.isPending || changeUnit.isPending;
  const canSave = (nameChanged || unitChanged) && trimmed.length >= 2 && !duplicate && factorOk && !busy;
  const error = rename.error ?? changeUnit.error;

  const save = async () => {
    try {
      let id = item.id;
      const parts: string[] = [];
      if (nameChanged) {
        await rename.mutateAsync({ itemId: item.id, newName: trimmed, requestId });
        parts.push(`tên “${trimmed}”`);
      }
      if (unitChanged) {
        const result = await changeUnit.mutateAsync({ itemId: item.id, newUnit: unit, factor: autoFactor ? null : factor, requestId: unitRequestId });
        id = result.item_id;
        parts.push(`đơn vị ${result.old_unit} → ${result.new_unit}${result.merge_id ? " (đã chuyển sổ, hoàn tác được)" : ""}`);
      }
      onDone(id, `Đã lưu ${parts.join(" · ")}`);
    } catch {
      /* the error box shows the message */
    }
  };

  return (
    <Sheet title={item.name} tag={`${meta.icon} ${meta.label}`} sub={`Mã ${item.code}`} onClose={onClose}>
      {!editing ? (
        <>
          <div className="stats">
            <div><small>Đơn vị kho</small><b>{item.unit}</b></div>
            <div><small>Tồn</small><b>{started ? fmtQty(item.on_hand) : "—"}</b></div>
            <div><small>Bí danh</small><b>{item.aliases.length}</b></div>
          </div>
          <div className="checklist">
            <small>Cách ghi trên phiếu nhập</small>
            {item.aliases.length
              ? item.aliases.map((alias) => (
                <label key={`${alias.normalized_name}-${alias.supplier_name ?? ""}`}>
                  <input type="checkbox" checked={alias.status === "auto"} readOnly /> {alias.normalized_name}{alias.supplier_name ? ` · ${alias.supplier_name}` : ""}{alias.line_class === "non_stock" ? " · không nhập kho" : ""}
                </label>
              ))
              : <p className="note">Chưa học tên nào. Dán nhãn thùng ở khu chờ để dạy máy.</p>}
          </div>
          <div className="row">
            {canEdit ? <button type="button" className="btn" onClick={() => setEditing(true)}>✎ Đổi tên / đơn vị</button> : <span className="kg-locked">Chỉ chủ hoặc người sửa kho Q7 được sửa</span>}
            <button type="button" className="btn ghost" onClick={onClose}>Đóng</button>
          </div>
        </>
      ) : (
        <>
          <label className="field">
            Tên chính thức
            <input value={name} onChange={(event) => setName(event.target.value)} autoFocus maxLength={120} />
          </label>
          <label className="field">
            Đơn vị kho
            <select value={unit} onChange={(event) => setUnit(event.target.value)}>
              {[...new Set([item.unit, ...ITEM_UNITS])].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          {unitChanged && autoFactor === null ? (
            <label className="conv">
              1 {item.unit} =
              <input inputMode="decimal" value={factorText} onChange={(event) => setFactorText(event.target.value)} placeholder="?" aria-label="Hệ số quy đổi" />
              {unit}
            </label>
          ) : null}
          {duplicate ? <div className="warn">Trùng với “{duplicate.name}”. Đổi tên khác hoặc gộp hai mặt hàng ở Dọn danh mục.</div> : null}
          {unitChanged ? <div className="warn">Đổi đơn vị sẽ quy đổi tồn, hệ số bí danh và giá chuẩn{autoFactor ? ` (1 ${item.unit} = ${fmtQty(autoFactor)} ${unit})` : ""}. Mặt hàng đã có sổ được chuyển sang bản mới, hoàn tác được.</div> : null}
          {error ? <div className="err">{errorText(error)}</div> : null}
          <div className="row">
            <button type="button" className="btn" disabled={!canSave} onClick={() => void save()}>{busy ? "Đang lưu…" : "Lưu"}</button>
            <button type="button" className="btn ghost" onClick={() => { setEditing(false); setName(item.name); setUnit(item.unit); setFactorText(""); }}>Huỷ</button>
          </div>
        </>
      )}
    </Sheet>
  );
}

interface Target { kind: "item" | "sku"; id: string; name: string; unit: string; cls: GameClass }

function CrateSheet({ location, crate, snapshot, onAssigned, onClose }: {
  location: WarehouseGameLocation; crate: WarehouseGamePendingRow; snapshot: WarehouseGameSnapshot;
  onAssigned: (cls: GameClass, label: string) => void; onClose: () => void;
}) {
  const confirm = useConfirmMaterialAlias();
  const create = useCreateStockMaterialItem();
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(crate.raw_name.replace(/^\s*(\[[^\]]*\]\s*)+/, "").split("/")[0].trim());
  const [newUnit, setNewUnit] = useState("g");
  const [packLabel, setPackLabel] = useState("");
  const [factorText, setFactorText] = useState("1");
  const [requestId] = useState(newRequestId);

  const toItem = (item: WarehouseGameItem): Target => ({ kind: "item", id: item.id, name: item.name, unit: item.unit, cls: asClass(item.item_class) });
  const suggested = useMemo<Target | null>(() => {
    const id = crate.jev_item_id ?? crate.top_candidate?.item_id ?? crate.top_candidate?.sku_id ?? null;
    if (!id) return null;
    const isSku = crate.jev_item_id ? crate.jev_is_sku : !crate.top_candidate?.item_id;
    if (isSku) {
      const sku = snapshot.skus.find((entry) => entry.id === id);
      return sku ? { kind: "sku", id: sku.id, name: sku.product_name, unit: sku.unit, cls: "finished_goods" } : null;
    }
    const item = snapshot.items.find((entry) => entry.id === id);
    return item ? toItem(item) : null;
  }, [crate, snapshot]);
  const q = normalizeName(query);
  const matches = snapshot.items
    .filter((item) => item.id !== suggested?.id)
    .filter((item) => (q ? normalizeName(item.name).includes(q) : true))
    .slice(0, 8);

  const pick = (next: Target) => {
    const pack = packFactorFor(crate.raw_name, next.unit);
    setPackLabel(pack?.label ?? next.unit);
    setFactorText(String(pack?.factor ?? 1));
    setTarget(next);
  };

  const factor = Number(factorText.replace(",", "."));
  const busy = confirm.isPending || create.isPending;
  const error = confirm.error ?? create.error;

  const send = (dest: Target | null, lineClass: "stock" | "non_stock") =>
    confirm.mutate(
      {
        supplierId: crate.supplier_id,
        location,
        rawName: crate.raw_name,
        rawUnit: null,
        kitchenInventoryItemId: dest?.kind === "item" ? dest.id : null,
        tanTaoSkuId: dest?.kind === "sku" ? dest.id : null,
        enteredUnitLabel: lineClass === "stock" ? packLabel.trim() || dest?.unit || null : null,
        conversionFactor: lineClass === "stock" ? factor : 1,
        jevItemId: crate.jev_item_id,
        jevProbability: crate.jev_probability,
        sourceTable: "warehouse_game",
        sourceId: null,
        lineClass,
      },
      { onSuccess: () => onAssigned(dest?.cls ?? "non_stock", dest ? dest.name : "không nhập kho") },
    );

  const createAndSend = () =>
    create.mutate(
      { name: newName.trim(), unit: newUnit, location, requestId },
      { onSuccess: (result) => send({ kind: "item", id: result.item_id, name: newName.trim(), unit: newUnit, cls: "unclassified" }, "stock") },
    );

  return (
    <Sheet title={`“${crate.raw_name}”`} tag="📦 Thùng chưa dán nhãn" sub={`${crate.line_count} dòng phiếu · ${crate.supplier_name ?? "chưa rõ NCC"}`} onClose={onClose}>
      {creating ? (
        <>
          <label className="field">Tên mặt hàng mới<input value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={120} /></label>
          <label className="field">Đơn vị kho
            <select value={newUnit} onChange={(event) => setNewUnit(event.target.value)}>
              {ITEM_UNITS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          {error ? <div className="err">{errorText(error)}</div> : null}
          <div className="row">
            <button type="button" className="btn" disabled={busy || newName.trim().length < 2} onClick={createAndSend}>{busy ? "Đang tạo…" : "Tạo và xếp vào kệ"}</button>
            <button type="button" className="btn ghost" onClick={() => setCreating(false)}>Quay lại</button>
          </div>
        </>
      ) : target ? (
        <>
          <button type="button" className="pick is-top" onClick={() => setTarget(null)}>
            <span className="pick-star">★</span>
            <span><b>{target.name}</b><small>{target.kind === "sku" ? "Thành phẩm SKU" : CLASS_META[target.cls].label} · {target.unit} · bấm để đổi</small></span>
          </button>
          <div className="unit-row">
            <label className="field">Đơn vị trên phiếu<input value={packLabel} onChange={(event) => setPackLabel(event.target.value)} placeholder="bao 25kg" /></label>
            <label className="field">1 {packLabel.trim() || "đv"} = ? {target.unit}<input inputMode="decimal" value={factorText} onChange={(event) => setFactorText(event.target.value)} /></label>
          </div>
          <p className="note" style={{ fontSize: 13 }}>Dòng ghi kg, g, l, ml tự đổi theo đơn vị; hệ số chỉ dùng khi phiếu ghi bao, thùng, gói…</p>
          {error ? <div className="err">{errorText(error)}</div> : null}
          <div className="row">
            <button type="button" className="btn" disabled={busy || !(factor > 0)} onClick={() => send(target, "stock")}>{busy ? "Đang xếp…" : "Xếp vào kệ"}</button>
            <button type="button" className="btn ghost" onClick={() => setTarget(null)}>Chọn lại</button>
          </div>
        </>
      ) : (
        <>
          {suggested ? (
            <button type="button" className="pick is-top" onClick={() => pick(suggested)}>
              <span className="pick-star">★</span>
              <span><b>{suggested.name}</b><small>{crate.jev_source === "exact" ? "Trùng tên" : crate.jev_item_id ? `Jev ${Math.round((crate.jev_probability ?? 0) * 100)}%` : "Gần nhất"} · {suggested.kind === "sku" ? "Thành phẩm SKU" : CLASS_META[suggested.cls].label} · {suggested.unit}</small></span>
              <span className="pick-go">Chọn</span>
            </button>
          ) : <p className="note">Jev chưa chắc mặt hàng nào. Tìm bên dưới hoặc tạo mới.</p>}
          <label className="field">Chọn mặt hàng khác<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="gõ tên để tìm…" /></label>
          <div className="picks">
            {matches.map((item) => (
              <button key={item.id} type="button" className="pick" onClick={() => pick(toItem(item))}>
                <span><b>{item.name}</b><small>{CLASS_META[asClass(item.item_class)].label} · {item.unit}</small></span>
              </button>
            ))}
          </div>
          {error ? <div className="err">{errorText(error)}</div> : null}
          <div className="row">
            <button type="button" className="btn ghost" onClick={() => setCreating(true)}>＋ Mặt hàng mới</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => send(null, "non_stock")}>Không nhập kho</button>
            <button type="button" className="btn ghost" onClick={onClose}>Để sau</button>
          </div>
        </>
      )}
    </Sheet>
  );
}
