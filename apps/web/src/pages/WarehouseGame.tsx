import { useEffect, useMemo, useState } from "react";
import { GamePicker } from "@/game/GamePicker";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useChangeStockItemUnit, useCrateReceiptLines, useItemReceiptLines, useRenameStockItem, useSetItemPastryQ7, useSetStockItemClass, useSetStockItemsClass, useWarehouseGameSnapshot, WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY, type StockItemClass } from "@/hooks/useWarehouseGame";
import { ReceiptNotes } from "@/game/ReceiptNotes";
import { useConfirmMaterialAlias, useCreateStockMaterialItem, useRunAliasBacklog } from "@/hooks/useMaterialAlias";
import { CrateYard, cleanCrateName, strongCandidate, type JevState } from "@/game/CrateYard";
import { unitConversionFor, type WarehouseGameItem, type WarehouseGameLocation, type WarehouseGamePendingRow, type WarehouseGameSnapshot } from "@/lib/warehouse-game";
import { defaultNewItemUnit, packFactorFor, unitFactor } from "@/components/material-alias/new-stock-item";
import { Yard, type Zone } from "@/game/Yard";
import { Warehouse, crateKey, layoutRows } from "@/game/Warehouse";
import { Shelf, entriesFor, type ShelfEntry } from "@/game/Shelf";
import { Sheet } from "@/game/Sheet";
import { Scene, usePortrait } from "@/game/Scene";
import { CLASS_META, ITEM_UNITS, asClass, fmtQty, newRequestId, normalizeName, type GameClass } from "@/game/meta";
import { STATION_META, STATION_ORDER, Workshop, type StationId } from "@/game/Workshop";
import { StationView } from "@/game/Stations";
import { Ceremony, MissionBoard, MissionHudButton, MissionSheet } from "@/game/Missions";
import { useMyMissions } from "@/hooks/useMissions";
import type { CompleteMissionResult } from "@/lib/missions";
import { useAuth } from "@/contexts/AuthContext";
import { useStockCatalogReview } from "@/hooks/useStockCatalog";
import { useMaterialAliasReview, useNewItemSuggestions } from "@/hooks/useMaterialAlias";
import { useStockRoutingReview } from "@/hooks/useStockRouting";
import { useQ7MaterialLinkReview } from "@/hooks/useQ7MaterialLinks";
import { GameLoading } from "@/game/Loading";
import { TransferSheet } from "@/game/TransferSlip";
import { DeliveryGate } from "@/game/DeliveryGate";
import { useDispatchGameQueue } from "@/hooks/useDispatchDelivery";
import { CountDone, CountLobby, CountSheet, CountSheetLoading, ReviewSheet, countErrorText, countProgress, dmy, type CountFilter } from "@/game/StockCount";
import { useCancelStockCount, useSaveStockCountLine, useStartStockCount, useStockCountReview, useSubmitStockCount } from "@/hooks/useStockCount";
import type { StockCountLine, StockCountLocation, StockCountSession } from "@/lib/stock-count";
import { useSuggestStockItemName } from "@/hooks/useSuggestStockItemName";
import { InvoiceScanner } from "@/game/InvoiceScanner";
import { RobotDesk, basketLineFor, loadBasket, saveBasket, type BasketLine } from "@/game/RobotDesk";
import { DiscontinueButton, ItemFactorBox, LinkQuest, QUEST_LABEL } from "@/game/LinkQuest";
import { useMaterialLinkReview } from "@/hooks/useMaterialLinkQuest";
import type { MaterialLinkLocation } from "@/lib/material-link-quest";
import "@/game/game.css";
import { Kho3D, canUse3D } from "@/game/three/Kho3D";
import { askGame } from "@/game/ConfirmDialog";

type View =
  | { kind: "yard" }
  | { kind: "robot" }
  | { kind: "quest"; location: MaterialLinkLocation }
  | { kind: "workshop" }
  | { kind: "missions" }
  | { kind: "station"; id: StationId }
  | { kind: "warehouse"; location: WarehouseGameLocation }
  | { kind: "crates"; location: WarehouseGameLocation }
  | { kind: "shelf"; location: WarehouseGameLocation; cls: GameClass }
  | { kind: "count" }
  | { kind: "count-sheet"; location: StockCountLocation };

type Panel =
  | { kind: "zone"; zone: Zone }
  | { kind: "deliver" }
  | { kind: "item"; location: WarehouseGameLocation; id: string }
  | { kind: "sku"; entry: ShelfEntry }
  | { kind: "crate"; location: WarehouseGameLocation; crate: WarehouseGamePendingRow }
  | { kind: "mission"; id: string }
  | { kind: "transfers"; location: WarehouseGameLocation; prefill?: string }
  | { kind: "count-review"; location: StockCountLocation }
  | null;

const LOCATION_LABEL: Record<WarehouseGameLocation, string> = { q7: "Kho Q7", tan_tao: "Kho Tân Tạo" };

const ZONE_ROUTES: Record<string, string> = {
  ledger: "/warehouse/stock-ledger",
  count: "/warehouse/stock-ledger",
  auto: "/warehouse/auto-purchase",
  clean: "/warehouse/catalog-cleanup",
};

/**
 * How a receipt's unit maps onto the stock unit (owner 12/10: "đơn vị ghi trên phiếu" was a guess).
 * pack: the receipt counts packs (PACK, gói, thùng…) → ask "1 PACK = ? g", prefilled from the name ("1KG").
 * auto: kg / g / l / ml lines convert by themselves. unknown: no receipt unit known → free label.
 */
type UnitPlan = { mode: "pack" | "auto" | "unknown"; unit: string | null; auto: number | null; prefill: number | null; units: Array<{ unit: string; line_count: number }> };
function unitPlanFor(crate: WarehouseGamePendingRow, stockUnit: string): UnitPlan {
  const units = (crate.raw_units ?? []).filter((row) => row.unit.trim());
  const ordered = units.length ? units : crate.raw_unit ? [{ unit: crate.raw_unit, line_count: crate.line_count }] : [];
  const pack = ordered.find((row) => unitFactor(row.unit, stockUnit) === null);
  const measure = ordered.find((row) => unitFactor(row.unit, stockUnit) !== null);
  const guess = packFactorFor(crate.raw_name, stockUnit)?.factor ?? null;
  if (pack) return { mode: "pack", unit: pack.unit.trim(), auto: null, prefill: guess, units: ordered };
  if (measure) return { mode: "auto", unit: measure.unit.trim(), auto: unitFactor(measure.unit, stockUnit), prefill: null, units: ordered };
  return { mode: "unknown", unit: null, auto: null, prefill: guess, units: ordered };
}

/** Count units (cái, gói, hộp…) are neither weight nor volume: the receipt and the shelf both count pieces. */
const isCountUnit = (unit: string) => unitFactor(unit, "g") === null && unitFactor(unit, "ml") === null;
const trimNumber = (value: number) => String(Math.round(value * 1e6) / 1e6);

/** Receipt counts pieces, the shelf counts packs (owner 12/10: "cái" on the receipt, "gói" on the shelf). */
/**
 * Owner 15/10 (IMG_5718): OCR read "cái" as "đệnh" / "định". A misread unit is the stock unit itself,
 * so it saves 1 = 1 like "Là một"; count lines all use the alias factor, so every misread line is covered.
 */
type CountChoice = "same" | "misread" | "stock_has" | "receipt_has";
function CountUnitQuestion({ receiptUnit, oddUnits, stockUnit, factorText, onFactor }: { receiptUnit: string; oddUnits: string[]; stockUnit: string; factorText: string; onFactor: (value: string) => void }) {
  const [choice, setChoice] = useState<CountChoice | null>(null);
  const [n, setN] = useState("");
  const pick = (next: CountChoice) => {
    setChoice(next);
    setN("");
    onFactor(next === "same" || next === "misread" ? "1" : "");
  };
  const misreadList = (oddUnits.length ? oddUnits : [receiptUnit]).map((unit) => `“${unit}”`).join(", ");
  const typeN = (value: string) => {
    setN(value);
    const parsed = Number(value.replace(",", "."));
    if (!(parsed > 0)) return onFactor("");
    onFactor(trimNumber(choice === "stock_has" ? 1 / parsed : parsed));
  };
  return (
    <div className="count-q" data-bmq-count-q>
      <p>Phiếu đếm bằng <b>{receiptUnit}</b>, kệ đếm bằng <b>{stockUnit}</b>. Hai đơn vị này liên quan thế nào?</p>
      <div className="count-choices" role="radiogroup" aria-label="Quan hệ đơn vị">
        <button type="button" role="radio" aria-checked={choice === "same"} className={choice === "same" ? "is-on" : undefined} onClick={() => pick("same")}>
          <b>Là một</b><small>1 {receiptUnit} = 1 {stockUnit}</small>
        </button>
        <button type="button" role="radio" aria-checked={choice === "misread"} className={choice === "misread" ? "is-on" : undefined} onClick={() => pick("misread")} data-bmq-count-misread>
          <b>Phiếu đọc sai chữ</b><small>{misreadList} chính là {stockUnit}</small>
        </button>
        <button type="button" role="radio" aria-checked={choice === "stock_has"} className={choice === "stock_has" ? "is-on" : undefined} onClick={() => pick("stock_has")}>
          <b>{stockUnit} gồm nhiều {receiptUnit}</b><small>vd 1 {stockUnit} = 10 {receiptUnit}</small>
        </button>
        <button type="button" role="radio" aria-checked={choice === "receipt_has"} className={choice === "receipt_has" ? "is-on" : undefined} onClick={() => pick("receipt_has")}>
          <b>{receiptUnit} gồm nhiều {stockUnit}</b><small>vd 1 {receiptUnit} = 12 {stockUnit}</small>
        </button>
      </div>
      {choice === "stock_has" || choice === "receipt_has" ? (
        <label className="conv unit-q-row">
          1 {choice === "stock_has" ? stockUnit : receiptUnit} =
          <input inputMode="decimal" value={n} onChange={(event) => typeN(event.target.value)} placeholder="?" aria-label="Số lượng" autoFocus />
          {choice === "stock_has" ? receiptUnit : stockUnit}
        </label>
      ) : null}
      {choice === "misread" ? <small className="unit-q-hint">Máy coi {misreadList} là {stockUnit}: phiếu ghi bao nhiêu thì nhập kho bấy nhiêu {stockUnit}.</small>
        : choice && factorText ? <small className="unit-q-hint">Máy sẽ tính: 1 {receiptUnit} = {fmtQty(Number(factorText))} {stockUnit}.</small> : null}
    </div>
  );
}

/** Receipt count units other than the stock unit itself ("cái ×2 · Cái ×1 · đệnh ×1 · định ×1" → đệnh, định). */
function oddCountUnits(plan: UnitPlan, stockUnit: string): string[] {
  const key = (unit: string) => unit.normalize("NFC").trim().toLowerCase();
  const seen = new Set<string>([key(stockUnit)]);
  return plan.units.flatMap((row) => {
    const k = key(row.unit);
    if (seen.has(k) || !isCountUnit(row.unit)) return [];
    seen.add(k);
    return [row.unit.trim()];
  });
}

function UnitQuestion({ plan, stockUnit, label, onLabel, factorText, onFactor }: {
  plan: UnitPlan; stockUnit: string; label: string; onLabel: (value: string) => void; factorText: string; onFactor: (value: string) => void;
}) {
  const mixed = plan.units.length > 1;
  const countPair = plan.mode === "pack" && plan.unit !== null && isCountUnit(stockUnit) && isCountUnit(plan.unit);
  return (
    <div className={`unit-q is-${plan.mode}`} data-bmq-unit-q={plan.mode}>
      {plan.mode === "auto" ? (
        <p><b>Phiếu ghi “{plan.unit}”</b> → kho tự đổi: 1 {plan.unit} = {fmtQty(plan.auto ?? 1)} {stockUnit}. Không cần điền gì.</p>
      ) : countPair ? (
        <CountUnitQuestion key={`${plan.unit}-${stockUnit}`} receiptUnit={plan.unit ?? ""} oddUnits={oddCountUnits(plan, stockUnit)} stockUnit={stockUnit} factorText={factorText} onFactor={onFactor} />
      ) : plan.mode === "pack" ? (
        <>
          <p><b>Phiếu ghi “{plan.unit}”</b>, kho tính bằng <b>{stockUnit}</b>. Mỗi khi phiếu ghi {plan.unit}, máy nhân với số dưới đây:</p>
          <label className="conv unit-q-row">
            1 {plan.unit} =
            <input inputMode="decimal" value={factorText} onChange={(event) => onFactor(event.target.value)} placeholder="?" aria-label={`1 ${plan.unit} bằng bao nhiêu ${stockUnit}`} />
            {stockUnit}
          </label>
          {plan.prefill ? <small className="unit-q-hint">Máy đọc từ tên hàng: {fmtQty(plan.prefill)} {stockUnit}. Anh kiểm lại cho đúng.</small> : <small className="unit-q-hint">Ví dụ: 1 PACK phô mai 1 kg → 1000; 1 thùng 12 hộp × 1 l → 12000.</small>}
        </>
      ) : (
        <>
          <p>Chưa đọc được đơn vị trên phiếu. Ghi đơn vị nhà cung cấp dùng và quy đổi ra <b>{stockUnit}</b>:</p>
          <div className="unit-row">
            <label className="field">Đơn vị trên phiếu<input value={label} onChange={(event) => onLabel(event.target.value)} placeholder="PACK, gói, thùng…" /></label>
            <label className="field">1 {label.trim() || "đv"} = ? {stockUnit}<input inputMode="decimal" value={factorText} onChange={(event) => onFactor(event.target.value)} /></label>
          </div>
        </>
      )}
      {mixed ? <small className="unit-q-mixed">Các dòng phiếu ghi: {plan.units.map((row) => `${row.unit} ×${row.line_count}`).join(" · ")}. Dòng kg, g, l, ml luôn tự đổi.</small> : null}
    </div>
  );
}

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
    ["q7_pastry_only", "Kho Q7 chỉ nhận nguyên liệu bánh ngọt. Bật “Bánh ngọt (Q7)” cho món này, hoặc chọn “Không nhập kho”."],
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
  // Đặt hàng tự động (owner 14/10): the basket survives moving between scenes within the tab.
  const [basket, setBasketRaw] = useState<BasketLine[]>(loadBasket);
  const setBasket = (next: BasketLine[]) => { saveBasket(next); setBasketRaw(next); };
  const [panel, setPanel] = useState<Panel>(null);
  const [toast, setToast] = useState<string | null>(null);
  const setClasses = useSetStockItemsClass();
  const [leaving, setLeaving] = useState<string | null>(null);
  const runBacklog = useRunAliasBacklog();
  const [jev, setJev] = useState<{ location: WarehouseGameLocation; state: JevState; done: number; total: number; message?: string } | null>(null);
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const { isOwner, canEditModule, roles } = useAuth();
  const canClean = isOwner || canEditModule("q7_material_inventory") || canEditModule("kitchen_inventory");
  // Same gate as public.create_manual_stock_transfer (server re-checks).
  // Cổng giao hàng (owner 14/10): badge = open dispatches; a user without inventory view just sees no badge.
  const deliveryQueue = useDispatchGameQueue();
  const canTransfer = isOwner || roles.includes("warehouse") || canEditModule("inventory") || canEditModule("q7_material_inventory");
  // Same gates as public.create_robot_order_package (server re-checks): order = q7_material_inventory_can_edit; debt = create_payment_submission.
  const canRobotOrder = isOwner || canEditModule("q7_material_inventory") || canEditModule("kitchen_inventory");
  const canRobotDebt = isOwner || canEditModule("payment_requests");
  const catalogReview = useStockCatalogReview();
  const aliasReview = useMaterialAliasReview(7);
  const newQ7 = useNewItemSuggestions("q7");
  const newTt = useNewItemSuggestions("tan_tao");
  const routing = useStockRoutingReview();
  const q7Links = useQ7MaterialLinkReview(isOwner);
  // Gắn mã hàng quest (owner 15/10): Tân Tạo count for the workshop badge; Q7 comes from q7Links.
  const canLinkQuest = isOwner || canEditModule("material_master");
  const ttLinks = useMaterialLinkReview("tan_tao", canLinkQuest);
  const missions = useMyMissions();
  const [ceremony, setCeremony] = useState<{ result: CompleteMissionResult; title: string } | null>(null);
  // Kiểm kê (owner 12/10): one open count sheet per warehouse.
  const countQ7 = useStockCountReview("q7");
  const countTt = useStockCountReview("tan_tao");
  const countReviews = { q7: countQ7, tan_tao: countTt };
  const startCount = useStartStockCount();
  const saveLine = useSaveStockCountLine();
  const submitCount = useSubmitStockCount();
  const cancelCount = useCancelStockCount();
  const [countFilter, setCountFilter] = useState<CountFilter>("all");
  const [savingLines, setSavingLines] = useState<Set<string>>(new Set());
  const [countDone, setCountDone] = useState<{ location: StockCountLocation; session: StockCountSession } | null>(null);

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
  const totalCrates = crates.q7 + crates.tan_tao;

  const go = (next: View) => { setPanel(null); setQuery(""); setCountFilter("all"); setView(next); };
  const back = () => {
    if (view.kind === "shelf" || view.kind === "crates") go({ kind: "warehouse", location: view.location });
    else if (view.kind === "station" || view.kind === "quest") go({ kind: "workshop" });
    else if (view.kind === "count-sheet") go({ kind: "count" });
    else if (view.kind === "warehouse" || view.kind === "workshop" || view.kind === "missions" || view.kind === "count" || view.kind === "robot") go({ kind: "yard" });
  };

  const openCount = (location: StockCountLocation) =>
    startCount.mutate({ location }, {
      onSuccess: () => go({ kind: "count-sheet", location }),
      onError: (error) => setToast(countErrorText(error)),
    });
  const saveCountLine = (location: StockCountLocation, session: StockCountSession, line: StockCountLine, qty: number | null) => {
    setSavingLines((prev) => new Set(prev).add(line.id));
    saveLine.mutate({ location, sessionId: session.id, lineId: line.id, countedQty: qty }, {
      onError: (error) => setToast(countErrorText(error)),
      onSettled: () => setSavingLines((prev) => { const next = new Set(prev); next.delete(line.id); return next; }),
    });
  };
  const countSession = view.kind === "count-sheet" ? countReviews[view.location].data?.open_session ?? null : null;

  const pendingSuggestions = catalogReview.data?.pending_suggestions ?? [];
  const stations = STATION_ORDER.map((id) => {
    const count = id === "merge" ? pendingSuggestions.filter((row) => row.kind === "merge").length
      : id === "classify" ? pendingSuggestions.filter((row) => row.kind === "classify").length
      : id === "new" ? (newQ7.data ?? []).filter((g) => g.status === "pending").length + (newTt.data ?? []).filter((g) => g.status === "pending").length
      : id === "backlog" ? totalCrates
      : id === "aliases" ? (aliasReview.data?.aliases.length ?? 0)
      : id === "routing" ? (routing.data ? routing.data.supplier_pending.length + routing.data.material_pending.length : 0)
      : id === "links" ? (q7Links.data?.counts.total ?? 0) + (ttLinks.data?.counts.total ?? 0)
      : null;
    return { id, ...STATION_META[id], count: id === "aliases" ? null : count };
  });
  const workshopTodo = stations.reduce((sum, station) => sum + (station.id === "backlog" ? 0 : station.count ?? 0), 0);

  const inWarehouse = view.kind === "warehouse" || view.kind === "shelf" || view.kind === "crates";
  const current = inWarehouse ? snaps[view.location] : undefined;
  const currentQuery = inWarehouse ? (view.location === "q7" ? q7 : tt) : undefined;
  const title = view.kind === "yard" ? "Kho BMQ"
    : view.kind === "count" ? "Kiểm kê kho"
    : view.kind === "count-sheet" ? `Kiểm kê · ${LOCATION_LABEL[view.location]}`
    : view.kind === "workshop" ? "Danh mục hàng hóa"
    : view.kind === "robot" ? "🤖 Đặt hàng tự động"
    : view.kind === "quest" ? "🧩 Gắn mã hàng"
    : view.kind === "missions" ? "Nhiệm vụ"
    : view.kind === "station" ? `${STATION_META[view.id].icon} ${STATION_META[view.id].label}`
    : view.kind === "warehouse" ? LOCATION_LABEL[view.location]
    : view.kind === "crates" ? "Khu phân loại"
    : `${CLASS_META[view.cls].icon} ${CLASS_META[view.cls].label}`;
  const subtitle = view.kind === "yard" ? "Bấm vào kho để vào"
    : view.kind === "count" ? "Chọn kho để đếm"
    : view.kind === "count-sheet" ? (countSession ? `Phiếu ${dmy(countSession.count_date)} · đã đếm ${countProgress(countSession).done}/${countProgress(countSession).total}` : "Chưa có phiếu đang mở")
    : view.kind === "workshop" ? (workshopTodo ? `${workshopTodo} việc đang chờ` : "Mọi bàn đã gọn")
    : view.kind === "robot" ? (basket.length ? `${basket.length} món trong giỏ` : "PO mới + trả đơn cũ")
    : view.kind === "quest" ? QUEST_LABEL[view.location]
    : view.kind === "station" ? "Danh mục hàng hóa"
    : view.kind === "missions" ? (missions.data?.level ? `Cấp ${missions.data.level.level} · ${missions.data.level.title} · ${missions.data.badges.total} 🐝` : "Làm xong nhận huy hiệu")
    : view.kind === "crates" ? `${LOCATION_LABEL[view.location]} · hàng chưa dán nhãn`
    : view.kind === "shelf" ? LOCATION_LABEL[view.location]
    : current?.cutover_date ? `Sổ từ ${current.cutover_date.split("-").reverse().join("/")}` : "Sổ chưa bắt đầu";

  const afterAssign = (crate: WarehouseGamePendingRow, label: string) => {
    setPanel(null);
    setLeaving(crateKey(crate));
    window.setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] }).then(() => setLeaving(null));
      setToast(`“${crate.raw_name}” → ${label} · ${crate.line_count} dòng`);
    }, 650);
  };

  const runJev = (location: WarehouseGameLocation) => {
    setJev({ location, state: "working", done: 0, total: 0 });
    runBacklog.mutate(
      { location, onProgress: (done: number, total: number) => setJev({ location, state: "working", done, total }) },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
          setJev((prev) => ({ location, state: "done", done: prev?.done ?? 0, total: prev?.total ?? 0 }));
        },
        onError: (error) => setJev((prev) => ({ location, state: "error", done: prev?.done ?? 0, total: prev?.total ?? 0, message: String((error as { message?: string })?.message ?? error).slice(0, 220) })),
      },
    );
  };

  const use3D = canUse3D();
  const yardProps = {
    counts,
    crates,
    badges: { deliver: deliveryQueue.data?.length ?? 0 },
    onEnter: (location: WarehouseGameLocation) => go({ kind: "warehouse", location }),
    onZone: (zone: Zone) => (zone.id === "deliver" ? setPanel({ kind: "deliver" }) : zone.id === "clean" ? go({ kind: "workshop" }) : zone.id === "count" ? go({ kind: "count" }) : zone.id === "auto" ? go({ kind: "robot" }) : setPanel({ kind: "zone", zone })),
  };

  return (
    <div className={`kg is-full${portrait ? " is-portrait" : ""}`} data-bmq-warehouse-game>
      <header className="hud">
        <button type="button" className="round-btn" onClick={back} disabled={view.kind === "yard"} aria-label="Quay lại">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <div className="title-pill"><b>{title}</b><small>{subtitle}</small></div>
        <MissionHudButton data={missions.data} onOpen={() => go({ kind: "missions" })} />
        <button type="button" className="round-btn exit-btn" onClick={() => navigate("/")} aria-label="Thoát về Tổng quan" title="Thoát về Tổng quan">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </header>

      <main className="stage">
        {view.kind === "yard" ? (
          q7.isLoading && tt.isLoading ? <GameLoading /> : (
            <Scene id={`yard-${portrait}`} fill={portrait || use3D} scroll={portrait && !use3D}>
              {use3D ? (
                <Kho3D kind="yard" {...yardProps} flat={<Yard portrait={portrait} {...yardProps} />} />
              ) : (
                <Yard portrait={portrait} {...yardProps} />
              )}
            </Scene>
          )
        ) : null}

        {view.kind === "workshop" ? (
          <Scene id={`workshop-${portrait}`} scroll>
            <Workshop portrait={portrait} stations={stations} onStation={(id) => (id === "links" ? go({ kind: "quest", location: "q7" }) : go({ kind: "station", id }))} />
          </Scene>
        ) : null}

        {view.kind === "quest" ? (
          <Scene id={`quest-${view.location}`} scroll>
            <div className="lq-wrap">
              <div className="loc-switch lq-loc" role="tablist" aria-label="Kho">
                {(["q7", "tan_tao"] as MaterialLinkLocation[]).map((location) => (
                  <button key={location} type="button" role="tab" aria-selected={view.location === location} className={view.location === location ? "is-on" : undefined} onClick={() => go({ kind: "quest", location })} data-bmq-quest-loc={location}>
                    {QUEST_LABEL[location]}
                  </button>
                ))}
              </div>
            <LinkQuest
              key={view.location}
              location={view.location}
              canEdit={canLinkQuest}
              mission={missions.data?.missions.find((entry) => entry.progress.detail.some((row) => row.kind === "material_links" && row.location === view.location))}
              onToast={setToast}
              onCompleted={(result, done) => setCeremony({ result, title: done.title })}
            />
            </div>
          </Scene>
        ) : null}

        {view.kind === "robot" ? (
          <Scene id="robot" scroll>
            <RobotDesk
              items={[...(tt.data?.items ?? []), ...(q7.data?.items ?? []).filter((item) => !(tt.data?.items ?? []).some((other) => other.id === item.id))]}
              basket={basket}
              setBasket={setBasket}
              canOrder={canRobotOrder}
              canDebt={canRobotDebt}
              onToast={setToast}
            />
          </Scene>
        ) : null}

        {view.kind === "missions" ? (
          <Scene id="missions" scroll>
            <MissionBoard data={missions.data} isLoading={missions.isLoading} error={missions.error} onOpen={(id) => setPanel({ kind: "mission", id })} />
          </Scene>
        ) : null}

        {view.kind === "station" ? (
          <Scene id={`station-${view.id}`} scroll>
            <StationView id={view.id} canEdit={canClean} />
          </Scene>
        ) : null}

        {view.kind === "count" ? (
          <Scene id="count" scroll>
            <CountLobby
              reviews={countReviews}
              starting={startCount.isPending ? (startCount.variables?.location ?? null) : null}
              onEnter={(location) => go({ kind: "count-sheet", location })}
              onStart={openCount}
            />
          </Scene>
        ) : null}

        {view.kind === "count-sheet" ? (
          countReviews[view.location].isLoading && !countReviews[view.location].data ? <CountSheetLoading />
          : countReviews[view.location].error && !countReviews[view.location].data ? <div className="loading"><div className="err">{countErrorText(countReviews[view.location].error)}</div></div>
          : countSession ? (
            <Scene id={`count-${view.location}-${countSession.id}`} scroll>
              <CountSheet
                location={view.location}
                session={countSession}
                canEdit={Boolean(countReviews[view.location].data?.can_edit)}
                started={Boolean(countReviews[view.location].data?.cutover_date)}
                savingIds={savingLines}
                query={query}
                onQuery={setQuery}
                filter={countFilter}
                onFilter={setCountFilter}
                onSave={(line, qty) => saveCountLine(view.location, countSession, line, qty)}
                onReview={() => { submitCount.reset(); setPanel({ kind: "count-review", location: view.location }); }}
                cancelling={cancelCount.isPending}
                onCancel={async () => {
                  if (!(await askGame({ title: "Hủy phiếu kiểm kê này?", message: "Số đã đếm sẽ bỏ, tồn kho không đổi.", ok: "Hủy phiếu", cancel: "Đếm tiếp", tone: "danger" }))) return;
                  cancelCount.mutate({ location: view.location, sessionId: countSession.id }, { onSuccess: () => { setToast("Đã hủy phiếu kiểm kê"); go({ kind: "count" }); }, onError: (error) => setToast(countErrorText(error)) });
                }}
              />
            </Scene>
          ) : (
            <Scene id={`count-${view.location}-none`} scroll>
              <CountLobby
                reviews={countReviews}
                starting={startCount.isPending ? (startCount.variables?.location ?? null) : null}
                onEnter={(location) => go({ kind: "count-sheet", location })}
                onStart={openCount}
              />
            </Scene>
          )
        ) : null}

        {inWarehouse && currentQuery?.isError ? (
          <div className="loading"><div className="err">{errorText(currentQuery.error)}</div></div>
        ) : null}
        {inWarehouse && !current && currentQuery?.isLoading ? <GameLoading /> : null}

        {view.kind === "warehouse" && current ? (
          <Scene id={`wh-${view.location}-${portrait}`} scroll={!use3D} fill={use3D}>
            {(() => {
              const location = view.location;
              const whProps = {
                location,
                rows: layoutRows(current),
                crates: current.pending,
                canAssign: current.can_edit,
                onShelf: (cls: GameClass) => go({ kind: "shelf", location, cls }),
                onYard: () => go({ kind: "crates", location }),
                transfers: current.transfers.length,
                onTransfers: () => setPanel({ kind: "transfers", location }),
              };
              const flat = <Warehouse portrait={portrait} {...whProps} />;
              return use3D ? <Kho3D kind="warehouse" {...whProps} flat={flat} /> : flat;
            })()}
          </Scene>
        ) : null}

        {view.kind === "crates" && current ? (
          <Scene id={`crates-${view.location}`} scroll>
            <CrateYard
              location={view.location}
              crates={current.pending}
              canAssign={current.can_edit}
              pastryIds={new Set((snaps.tan_tao?.items ?? current.items).filter((item) => item.pastry_q7).map((item) => item.id))}
              jev={jev?.location === view.location ? jev.state : "idle"}
              progress={jev?.location === view.location ? { done: jev.done, total: jev.total } : null}
              error={jev?.location === view.location && jev.state === "error" ? jev.message ?? null : null}
              leavingKey={leaving}
              onRunJev={() => runJev(view.location)}
              onOpen={(crate) => setPanel({ kind: "crate", location: view.location, crate })}
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
              bulk={canClean ? {
                busy: setClasses.isPending,
                onApply: async (ids, target) => {
                  try {
                    await setClasses.mutateAsync({ itemIds: ids, itemClass: target });
                    setToast(`Đã xếp ${ids.length} món vào ${CLASS_META[target].label}`);
                    return true;
                  } catch (error) {
                    setToast(errorText(error));
                    return false;
                  }
                },
              } : undefined}
            />
          </Scene>
        ) : null}

        {panel?.kind === "zone" ? (
          <Sheet title={`${panel.zone.icon} ${panel.zone.label}`} tag="Sắp có" sub="Bản game của khu này làm ở bước sau." onClose={() => setPanel(null)}>
            <p className="note">{panel.zone.blurb}</p>
            <div className="row">
              <button type="button" className="btn" onClick={() => navigate(ZONE_ROUTES[panel.zone.id] ?? "/warehouse/stock-ledger")}>Mở trang {panel.zone.label}</button>
              <button type="button" className="btn ghost" onClick={() => setPanel(null)}>Ở lại</button>
            </div>
          </Sheet>
        ) : null}

        {panel?.kind === "deliver" ? (
          <DeliveryGate onDone={(message) => { setPanel(null); setToast(message); }} onClose={() => setPanel(null)} />
        ) : null}

        {panel?.kind === "transfers" ? (
          <TransferSheet
            key={panel.prefill ?? "list"}
            items={tt.data?.items ?? []}
            ttStarted={Boolean(tt.data?.cutover_date)}
            q7Started={Boolean(q7.data?.cutover_date)}
            canTransfer={canTransfer}
            prefillId={panel.prefill ?? null}
            onDone={(message) => setToast(message)}
            onClose={() => setPanel(null)}
          />
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
              onTransfer={panel.location === "tan_tao" && canTransfer && item.on_hand > 0 ? () => setPanel({ kind: "transfers", location: "tan_tao", prefill: item.id }) : undefined}
              onFactorToast={canLinkQuest ? setToast : undefined}
              onRobot={canRobotOrder ? () => { if (!basket.some((line) => line.item_id === item.id)) setBasket([...basket, basketLineFor(item)]); setToast(`🤖 Đã cho robot: ${item.name}`); go({ kind: "robot" }); } : undefined}
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
            autoPick
            onAssigned={(_cls, label) => afterAssign(panel.crate, label)}
            onClose={() => setPanel(null)}
          />
        ) : null}

        {panel?.kind === "mission" ? (() => {
          const mission = missions.data?.missions.find((entry) => entry.id === panel.id);
          return mission ? (
            <MissionSheet
              key={mission.id}
              mission={mission}
              onClose={() => setPanel(null)}
              onToast={setToast}
              onCompleted={(result, done) => { setPanel(null); setCeremony({ result, title: done.title }); }}
              onOpenQuest={(location) => go({ kind: "quest", location })}
            />
          ) : null;
        })() : null}

        {panel?.kind === "count-review" && countSession ? (
          <ReviewSheet
            location={panel.location}
            session={countSession}
            submitting={submitCount.isPending}
            error={submitCount.error}
            onSubmit={() => submitCount.mutate({ location: panel.location, sessionId: countSession.id }, { onSuccess: (session) => { setPanel(null); setCountDone({ location: panel.location, session }); } })}
            onClose={() => setPanel(null)}
          />
        ) : null}

        {countDone ? <CountDone location={countDone.location} session={countDone.session} onClose={() => { setCountDone(null); go({ kind: "count" }); }} /> : null}

        {ceremony ? <Ceremony result={ceremony.result} title={ceremony.title} onClose={() => setCeremony(null)} /> : null}

        {toast ? <div className="toast" role="status">{toast}</div> : null}
      </main>
    </div>
  );
}

function ItemNotes({ itemId }: { itemId: string }) {
  const lines = useItemReceiptLines(itemId, true);
  return <ReceiptNotes title="Phiếu nhập gần đây" lines={lines.data} loading={lines.isLoading} error={lines.error} />;
}

/** "Bánh ngọt (Q7)": flagged items move on to Q7 by themselves after landing at Tân Tạo. */
function PastrySwitch({ item, canEdit }: { item: WarehouseGameItem; canEdit: boolean }) {
  const setFlag = useSetItemPastryQ7();
  const [value, setValue] = useState(item.pastry_q7);
  const flip = () => {
    const next = !value;
    setValue(next);
    setFlag.mutate({ itemId: item.id, value: next }, { onError: () => setValue(!next) });
  };
  return (
    <div className={`pastry-switch${value ? " is-on" : ""}`} data-bmq-item-pastry>
      <span><b>🧁 Bánh ngọt (Q7)</b><small>{value ? "Nhập ở Tân Tạo xong tự chuyển sang Q7" : "Chỉ ở Tân Tạo, Q7 không nhận"}</small></span>
      {canEdit ? (
        <button type="button" role="switch" aria-checked={value} aria-label="Bánh ngọt (Q7)" className="kg-switch" disabled={setFlag.isPending} onClick={flip}><i /></button>
      ) : null}
      {setFlag.error ? <div className="err">{errorText(setFlag.error)}</div> : null}
    </div>
  );
}

const PICK_CLASSES: StockItemClass[] = ["raw_material", "packaging_supply", "finished_goods", "non_stock"];

/** "Nhóm": pick the item's shelf group by hand; "Chưa có nhóm" items had no way out before (16/10). */
function ClassPicker({ item, canEdit }: { item: WarehouseGameItem; canEdit: boolean }) {
  const setClass = useSetStockItemClass();
  const [value, setValue] = useState(asClass(item.item_class));
  const pick = (next: StockItemClass) => {
    if (next === value || setClass.isPending) return;
    const before = value;
    setValue(next);
    setClass.mutate({ itemId: item.id, itemClass: next }, { onError: () => setValue(before) });
  };
  return (
    <div className="class-pick" data-bmq-item-class={value}>
      <span><b>Nhóm</b><small>{value === "unclassified" ? "Chưa có nhóm — chọn một nhóm bên dưới" : setClass.isSuccess ? `Đã chuyển sang ${CLASS_META[value].label}` : CLASS_META[value].label}</small></span>
      {canEdit ? (
        <div className="class-pick-row" role="radiogroup" aria-label="Nhóm mặt hàng">
          {PICK_CLASSES.map((cls) => (
            <button key={cls} type="button" role="radio" aria-checked={value === cls} className={`class-chip${value === cls ? " is-on" : ""}`} style={{ ["--chip" as string]: CLASS_META[cls].tint }} disabled={setClass.isPending} onClick={() => pick(cls)} data-bmq-class-option={cls}>
              <i aria-hidden="true">{CLASS_META[cls].icon}</i>{CLASS_META[cls].label}
            </button>
          ))}
        </div>
      ) : null}
      {setClass.error ? <div className="err">{errorText(setClass.error)}</div> : null}
    </div>
  );
}

function ItemSheet({ item, others, canEdit, started, onTransfer, onRobot, onFactorToast, onDone, onClose }: {
  item: WarehouseGameItem; others: WarehouseGameItem[]; canEdit: boolean; started: boolean; onTransfer?: () => void; onRobot?: () => void; onFactorToast?: (text: string) => void;
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
            <div><small>Tên gọi khác</small><b>{item.aliases.length}</b></div>
          </div>
          <ClassPicker key={item.id} item={item} canEdit={canEdit} />
          <PastrySwitch item={item} canEdit={canEdit} />
          {onTransfer ? <button type="button" className="btn slip-new" onClick={onTransfer} data-bmq-item-transfer>🚚 Chuyển sang Q7</button> : null}
          {onRobot ? <button type="button" className="btn ghost slip-new" onClick={onRobot} data-bmq-item-robot>🤖 Đặt hàng món này</button> : null}
          {onFactorToast ? <ItemFactorBox itemId={item.id} onToast={onFactorToast} /> : null}
          {onFactorToast && canEdit ? <DiscontinueButton itemId={item.id} name={item.name} onDone={onClose} onToast={onFactorToast} /> : null}
          {canEdit ? <ItemNotes itemId={item.id} /> : null}
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
            <GamePicker value={unit} onChange={setUnit} title="Đơn vị kho" ariaLabel="Đơn vị kho" options={[...new Set([item.unit, ...ITEM_UNITS])].map((value) => ({ value, label: value }))} />
          </label>
          {unitChanged && autoFactor === null ? (
            <label className="conv">
              1 {item.unit} =
              <input inputMode="decimal" value={factorText} onChange={(event) => setFactorText(event.target.value)} placeholder="?" aria-label="Hệ số quy đổi" />
              {unit}
            </label>
          ) : null}
          {duplicate ? <div className="warn">Trùng với “{duplicate.name}”. Đổi tên khác hoặc gộp hai mặt hàng ở Dọn danh mục.</div> : null}
          {unitChanged ? <div className="warn">Đổi đơn vị sẽ quy đổi tồn, hệ số tên gọi khác và giá chuẩn{autoFactor ? ` (1 ${item.unit} = ${fmtQty(autoFactor)} ${unit})` : ""}. Mặt hàng đã có sổ được chuyển sang bản mới, hoàn tác được.</div> : null}
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

function CrateSheet({ location, crate, snapshot, autoPick = false, onAssigned, onClose }: {
  location: WarehouseGameLocation; crate: WarehouseGamePendingRow; snapshot: WarehouseGameSnapshot; autoPick?: boolean;
  onAssigned: (cls: GameClass, label: string) => void; onClose: () => void;
}) {
  const confirm = useConfirmMaterialAlias();
  const create = useCreateStockMaterialItem();
  const notes = useCrateReceiptLines(location, crate.supplier_id, crate.normalized_name, true);
  const setPastry = useSetItemPastryQ7();
  // Q7 only stocks pastry items, so a new item made from a Q7 crate starts flagged.
  const [asPastry, setAsPastry] = useState(location === "q7");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(() => cleanCrateName(crate.raw_name));
  const [newUnit, setNewUnit] = useState(() => defaultNewItemUnit(crate.raw_name, crate.raw_unit));
  const [packLabel, setPackLabel] = useState("");
  const [factorText, setFactorText] = useState("1");
  const [requestId] = useState(newRequestId);
  // Owner 14/10: the new item takes the full name printed on the invoice photo, not the short name typed on the PO.
  const suggestName = useSuggestStockItemName();
  const [nameEdited, setNameEdited] = useState(false);
  const [nameSource, setNameSource] = useState<"receipt" | "invoice">("receipt");

  const startCreate = () => {
    setCreating(true);
    preparePlan(newUnit);
    if (nameSource === "invoice" || suggestName.isPending) return;
    suggestName.mutate({ location, supplier_id: crate.supplier_id, normalized_name: crate.normalized_name }, {
      onSuccess: (suggestion) => {
        if (!suggestion) return;
        setNameSource("invoice");
        setNameEdited((edited) => {
          if (!edited) setNewName(cleanCrateName(suggestion.full_name));
          return edited;
        });
        const unit = suggestion.unit && ITEM_UNITS.includes(suggestion.unit) ? suggestion.unit : null;
        if (unit) { setNewUnit(unit); preparePlan(unit); }
      },
    });
  };

  const toItem = (item: WarehouseGameItem): Target => ({ kind: "item", id: item.id, name: item.name, unit: item.unit, cls: asClass(item.item_class) });
  const suggested = useMemo<Target | null>(() => {
    const near = strongCandidate(crate);
    const id = crate.jev_item_id ?? near?.item_id ?? near?.sku_id ?? null;
    if (!id) return null;
    const isSku = crate.jev_item_id ? crate.jev_is_sku : !near?.item_id;
    if (isSku) {
      const sku = snapshot.skus.find((entry) => entry.id === id);
      return sku ? { kind: "sku", id: sku.id, name: sku.product_name, unit: sku.unit, cls: "finished_goods" } : null;
    }
    const item = snapshot.items.find((entry) => entry.id === id);
    return item ? toItem(item) : null;
  }, [crate, snapshot]);
  const q = normalizeName(query);
  // Only search results: an unfiltered A→Z list looked like a suggestion (owner 12/10, "tỏi ngày 10").
  const matches = q
    ? snapshot.items.filter((item) => item.id !== suggested?.id && normalizeName(item.name).includes(q)).slice(0, 8)
    : [];

  const preparePlan = (stockUnit: string) => {
    const plan = unitPlanFor(crate, stockUnit);
    // No unit on the receipt lines at all: assume they count in the stock unit (1 = 1), editable.
    setPackLabel(plan.unit ?? (plan.mode === "unknown" ? stockUnit : ""));
    setFactorText(plan.mode === "auto" ? "1" : plan.prefill ? String(plan.prefill) : plan.mode === "unknown" ? "1" : "");
  };
  const pick = (next: Target) => {
    preparePlan(next.unit);
    setTarget(next);
  };
  // Open on the hint: Jev's pick (or the closest name) is already on the label.
  useEffect(() => {
    if (autoPick && suggested) pick(suggested);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const factor = Number(factorText.replace(",", "."));
  const stockUnit = creating ? newUnit : target?.unit ?? "g";
  const plan = unitPlanFor(crate, stockUnit);
  const unitOk = plan.mode === "auto" || (Number.isFinite(factor) && factor > 0 && (plan.mode === "pack" || packLabel.trim().length > 0));
  const busy = confirm.isPending || create.isPending || setPastry.isPending;
  const error = confirm.error ?? create.error ?? setPastry.error;

  const send = (dest: Target | null, lineClass: "stock" | "non_stock") =>
    confirm.mutate(
      {
        supplierId: crate.supplier_id,
        location,
        rawName: crate.raw_name,
        rawUnit: crate.raw_unit ?? null,
        kitchenInventoryItemId: dest?.kind === "item" ? dest.id : null,
        tanTaoSkuId: dest?.kind === "sku" ? dest.id : null,
        enteredUnitLabel: lineClass === "stock" ? (plan.mode === "unknown" ? packLabel.trim() : plan.unit) || dest?.unit || null : null,
        conversionFactor: lineClass === "stock" && plan.mode !== "auto" ? factor : 1,
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
      {
        onSuccess: async (result) => {
          if (asPastry) await setPastry.mutateAsync({ itemId: result.item_id, value: true });
          send({ kind: "item", id: result.item_id, name: newName.trim(), unit: newUnit, cls: "unclassified" }, "stock");
        },
      },
    );

  return (
    <Sheet title={`“${crate.raw_name}”`} tag="📦 Hàng chưa dán nhãn" sub={`${crate.line_count} dòng phiếu · ${crate.supplier_name ?? "chưa rõ NCC"}`} onClose={onClose}>
      <ReceiptNotes title="Phiếu giao hàng" lines={notes.data} loading={notes.isLoading} error={notes.error} />
      {creating ? (
        <>
          <label className="field">Tên mặt hàng mới<input value={newName} onChange={(event) => { setNewName(event.target.value); setNameEdited(true); }} maxLength={120} data-bmq-new-name className={nameSource === "invoice" ? "is-popped" : undefined} key={nameSource} /></label>
          {suggestName.isPending ? <div data-bmq-name-hint="busy"><InvoiceScanner lines={notes.data} /></div>
            : nameSource === "invoice" ? <p className="name-hint is-ok" data-bmq-name-hint="invoice">📄 Tên đầy đủ lấy từ ảnh hóa đơn. Anh kiểm lại trước khi tạo.</p>
            : suggestName.isError ? <p className="name-hint" data-bmq-name-hint="error">Chưa đọc được ảnh hóa đơn: {String((suggestName.error as Error)?.message ?? "").slice(0, 140)}. Tên đang lấy từ phiếu.</p>
            : suggestName.isSuccess ? <p className="name-hint" data-bmq-name-hint="none">Không tìm thấy dòng khớp trên ảnh hóa đơn; tên đang lấy từ phiếu.</p>
            : null}
          <label className="field">Đơn vị kho
            <GamePicker value={newUnit} onChange={(value) => { setNewUnit(value); preparePlan(value); }} title="Đơn vị kho" ariaLabel="Đơn vị kho" options={ITEM_UNITS.map((value) => ({ value, label: value }))} />
          </label>
          <UnitQuestion plan={plan} stockUnit={newUnit} label={packLabel} onLabel={setPackLabel} factorText={factorText} onFactor={setFactorText} />
          <div className={`pastry-switch${asPastry ? " is-on" : ""}`} data-bmq-new-pastry>
            <span>
              <b>🧁 Bánh ngọt (Q7)</b>
              <small>{location === "q7" ? (asPastry ? "Kho Q7 chỉ nhận nguyên liệu bánh ngọt" : "Tắt thì Kho Q7 không nhận món này") : asPastry ? "Nhập ở Tân Tạo xong tự chuyển sang Q7" : "Chỉ ở Tân Tạo"}</small>
            </span>
            <button type="button" role="switch" aria-checked={asPastry} aria-label="Bánh ngọt (Q7)" className="kg-switch" onClick={() => setAsPastry((v) => !v)}><i /></button>
          </div>
          {error ? <div className="err">{errorText(error)}</div> : null}
          <div className="row">
            <button type="button" className="btn" disabled={busy || newName.trim().length < 2 || !unitOk || (location === "q7" && !asPastry)} onClick={createAndSend}>{busy ? "Đang tạo…" : "Tạo và xếp vào kệ"}</button>
            <button type="button" className="btn ghost" onClick={() => setCreating(false)}>Quay lại</button>
          </div>
        </>
      ) : target ? (
        <>
          <div className="pick is-top is-chosen" data-bmq-picked>
            <span className="pick-star">★</span>
            <span><b>{target.name}</b><small>{target.kind === "sku" ? "Thành phẩm SKU" : CLASS_META[target.cls].label} · {target.unit}</small></span>
            <button type="button" className="pick-clear" onClick={() => setTarget(null)} aria-label={`Bỏ chọn ${target.name}`} data-bmq-unpick>✕ Bỏ chọn</button>
          </div>
          <UnitQuestion plan={plan} stockUnit={target.unit} label={packLabel} onLabel={setPackLabel} factorText={factorText} onFactor={setFactorText} />
          {target.kind === "item" && location === "tan_tao" ? (() => {
            const picked = snapshot.items.find((item) => item.id === target.id);
            return picked ? <PastrySwitch key={picked.id} item={picked} canEdit /> : null;
          })() : null}
          {error ? <div className="err">{errorText(error)}</div> : null}
          <div className="row">
            <button type="button" className="btn" disabled={busy || !unitOk} onClick={() => send(target, "stock")}>{busy ? "Đang xếp…" : "Xếp vào kệ"}</button>
            <button type="button" className="btn ghost" onClick={() => setTarget(null)}>Chọn lại</button>
          </div>
        </>
      ) : (
        <>
          {suggested ? (
            <button type="button" className="pick is-top" onClick={() => pick(suggested)}>
              <span className="pick-star">★</span>
              <span><b>{suggested.name}</b><small>{crate.jev_source === "exact" ? "Trùng tên" : crate.jev_item_id ? `Bé Mì ${Math.round((crate.jev_probability ?? 0) * 100)}%` : "Gần nhất"} · {suggested.kind === "sku" ? "Thành phẩm SKU" : CLASS_META[suggested.cls].label} · {suggested.unit}</small></span>
              <span className="pick-go">Chọn</span>
            </button>
          ) : (
            <div className="no-hint" data-bmq-crate-nohint>
              <p className="note">Kho chưa có mặt hàng giống tên này, nên Bé Mì chưa có gì để gợi ý.</p>
              <button type="button" className="btn" onClick={startCreate}>＋ Tạo mặt hàng “{cleanCrateName(crate.raw_name)}”</button>
            </div>
          )}
          <label className="field">{suggested ? "Hoặc tìm mặt hàng khác" : "Hoặc tìm trong kho"}<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="gõ tên để tìm…" /></label>
          <div className="picks">
            {matches.map((item) => (
              <button key={item.id} type="button" className="pick" onClick={() => pick(toItem(item))}>
                <span><b>{item.name}</b><small>{CLASS_META[asClass(item.item_class)].label} · {item.unit}</small></span>
              </button>
            ))}
          </div>
          {error ? <div className="err">{errorText(error)}</div> : null}
          {q && matches.length === 0 ? <p className="note" style={{ fontSize: 13 }}>Không có mặt hàng nào khớp “{query}”.</p> : null}
          <div className="row">
            {suggested ? <button type="button" className="btn ghost" onClick={startCreate}>＋ Mặt hàng mới</button> : null}
            <button type="button" className="btn ghost" disabled={busy} onClick={() => send(null, "non_stock")}>Không nhập kho</button>
            <button type="button" className="btn ghost" onClick={onClose}>Để sau</button>
          </div>
        </>
      )}
    </Sheet>
  );
}
