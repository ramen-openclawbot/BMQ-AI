import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import {
  OFFICE_PENDING_PAYMENT_REQUESTS_QUERY_KEY, useOfficeOrderSnapshot, usePendingPaymentRequests, type OfficeOrderLocation,
} from "@/hooks/useOfficeOrder";
import { useCreateRobotOrderPackage, useRunDebtReview, useSupplierDebtCandidates, useSupplierDebtPickPattern } from "@/hooks/useRobotOrder";
import { useApprovePaymentRequest, useRejectPaymentRequest } from "@/hooks/usePaymentRequests";
import { useSuppliers } from "@/hooks/useSuppliers";
import { useWarehouseGameSnapshot } from "@/hooks/useWarehouseGame";
import {
  buildShelves, daysLabel, FILL_LABEL, searchItems, startQty, stockFill, suggestFromLast, type FillLevel, type GroupCode, type PredictedOfficeOrderItem, type StockFill,
} from "@/lib/office-order";
import {
  MAX_DEBT_PICKS, packageDebtNumbers, packageSummary, rankDebtRows, robotOrderErrorCode, robotOrderErrorText, sumDebtPicks, toggleDebtPick,
  type DebtPick, type RobotOrderPackageResult, type SupplierDebtRow,
} from "@/lib/robot-order";
import { resolveImageUrl } from "@/lib/storage-url";
import { GamePicker } from "@/game/GamePicker";
import { newRequestId } from "@/game/meta";
import { usePageZoomGuard } from "@/game/zoomGuard";
import { loadBasket, saveBasket, type BasketLine } from "@/game/basket";
import { FLY, Room, type RoomData, type RoomItem } from "@/game/office/Room";
import { OfficeDocDetail, type DocKey } from "@/game/office/OfficeDocDetail";
import { fmtDate, fmtMillion, fmtMoney, fmtNum } from "@/game/office/format";
import "@/game/office/office.css";

/**
 * Đặt hàng tự động — the warehouse you play in (owner 16/10: "đang yêu cầu làm giao diện game kho", approved
 * for the real app the same day). The 3D room is the screen: shelves, the PR desk and the Sushi machine are the
 * things you touch; the notebook (side board on desktop, bottom sheet on phones) shows what you touched. Every
 * document row carries its photo count and the detail puts the photos first, so a PR can be reconciled against
 * its invoice / delivery note without leaving the room.
 * Business flow retained from the earlier room: products → supplier's old unpaid PR/PO picked to pay with the
 * order, one robot package per supplier (create_robot_order_package), PRs approved / rejected through finance.
 */
type Item = PredictedOfficeOrderItem;
type Line = { item: Item; qty: number; price: number | null; supplierId: string | null; supplierName: string | null };
type Spot = { kind: "low" } | { kind: "desk" } | { kind: "shelf"; code: GroupCode };
type Hover = { label: string; sub: string; x: number; y: number };

const SHELF_HEX: Record<GroupCode, string> = {
  flour: "#e8a23a", dairy_fat: "#7fb3d5", eggs: "#f6d79a", sugar_additives: "#cfc8f3", meat_filling: "#d9667a",
  cheese: "#f2c14e", vegetables: "#6f9e8b", packaging: "#d7a768", supplies: "#9aa7c7", other: "#b9b3a3",
};
const WAREHOUSES: Record<OfficeOrderLocation, { label: string; short: string; emoji: string }> = {
  tan_tao: { label: "Kho Tân Tạo", short: "Tân Tạo", emoji: "🏭" },
  q7: { label: "Kho Q7", short: "Kho Q7", emoji: "🧁" },
};
const NO_SUP = "__none__";
const REDUCED = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const IDLE_START = -20; // the machine is already built when you walk in; the build plays only when you open it
const isPhone = () => window.innerWidth < 900;
const lineUnit = (item: Item) => item.last_unit ?? item.unit ?? "";
/** Stock quantities read naturally: 12.343.750 g → 12.343,75 kg, 2.500 ml → 2,5 l. */
const qtyText = (n: number, unit: string | null | undefined) => {
  const u = (unit ?? "").trim().toLowerCase();
  const r = (v: number) => fmtNum(Math.round(v * 100) / 100);
  if ((u === "g" || u === "gr") && Math.abs(n) >= 1000) return `${r(n / 1000)} kg`;
  if (u === "ml" && Math.abs(n) >= 1000) return `${r(n / 1000)} l`;
  return `${r(n)} ${unit ?? ""}`.trim();
};
const num = (text: string) => { const v = Number(String(text).replace(/\s/g, "").replace(",", ".")); return Number.isFinite(v) ? v : NaN; };
const toBasketLine = (l: Line): BasketLine => ({ key: l.item.id, item_id: l.item.id, name: l.item.name, unit: lineUnit(l.item), qty: String(l.qty), supplier_id: l.supplierId, price: l.price === null ? "" : String(l.price) });
const startKho = (): OfficeOrderLocation => (new URLSearchParams(window.location.search).get("kho") === "q7" ? "q7" : "tan_tao");
const FROM_KHO = new URLSearchParams(window.location.search).get("from") === "kho";
// Entered from inside a warehouse (its machine or a shelf), the room already knows where it is: no warehouse switch (owner 17/10).
const KHO_FIXED = ["tan_tao", "q7"].includes(new URLSearchParams(window.location.search).get("kho") ?? "");

/** Robot packages sent recently (RLS: any signed-in user may read), newest first. */
function useRecentPackages() {
  return useQuery({
    queryKey: ["robot-order-packages"],
    queryFn: async () => {
      const { data, error } = await (supabase as unknown as { from: (t: string) => { select: (c: string) => { order: (c: string, o: { ascending: boolean }) => { limit: (n: number) => Promise<{ data: unknown; error: unknown }> } } } })
        .from("robot_order_packages").select("id, supplier_id, result, created_at").order("created_at", { ascending: false }).limit(6);
      if (error) throw error;
      return (data ?? []) as { id: string; supplier_id: string; result: RobotOrderPackageResult | null; created_at: string }[];
    },
  });
}

const markLabel = (row: SupplierDebtRow) => {
  if (row.mark === "settled_outside") return row.mark_source === "learned" ? "đã chi ngoài hệ thống (học)" : row.mark_source === "manual" ? "đã chi ngoài hệ thống" : `Sushi: có thể đã chi${row.probability != null ? ` ${Math.round(row.probability * 100)}%` : ""}`;
  if (row.mark === "real_debt") return row.mark_source === "jev" ? `Sushi: nợ thật${row.probability != null ? ` ${Math.round(row.probability * 100)}%` : ""}` : "nợ thật";
  if (row.mark === "unsure") return "Sushi: chưa rõ";
  return null;
};
const suggestText = (item: Item) => {
  const s = suggestFromLast(item);
  return s ? `${fmtNum(s.qty)} ${s.unit ?? item.unit ?? ""}`.trim() : null;
};

/** "📷 n" on a document row: the row's photos (header, attachments, goods receipt) are one tap away. */
function PhotoBadge({ count, title }: { count: number | null | undefined; title?: string }) {
  if (!count) return <span className="ph-badge is-none" title="Chưa có ảnh chứng từ" data-office-photo-count="0">không ảnh</span>;
  return <span className="ph-badge" title={title ?? `${count} ảnh chứng từ`} data-office-photo-count={count}>📷 {count}</span>;
}

/** The first photo of a document, signed on the client; falls back to the badge when it cannot be read. */
function PhotoThumb({ path, bucket, count }: { path: string | null | undefined; bucket: string; count: number }) {
  const url = useQuery({
    queryKey: ["office-thumb", bucket, path ?? null],
    enabled: Boolean(path),
    staleTime: 30 * 60 * 1000,
    queryFn: () => resolveImageUrl(path!, { preferredBucket: bucket }),
  });
  return (
    <span className={`pr-thumb${url.data ? " has-img" : ""}`} aria-hidden data-office-thumb={path ? "1" : "0"}>
      {url.data ? <img src={url.data} alt="" loading="lazy" /> : <span className="pr-thumb-ph">{count ? "📷" : "📄"}</span>}
      {count > 1 ? <b>{count}</b> : null}
    </span>
  );
}

/** One product on the shelf close-up: a jar whose contents show how much is left (owner 17/10). */
function Jar({ fill, color, icon }: { fill: StockFill; color: string; icon: string }) {
  const inner = 58; // px of usable height inside the jar
  const h = fill.ratio == null ? 0 : Math.max(fill.level === "empty" ? 0 : 6, Math.round(fill.ratio * inner));
  return (
    <svg viewBox="0 0 80 96" className={`jar is-${fill.level}`} aria-hidden>
      <rect x="22" y="4" width="36" height="12" rx="4" className="jar-lid" />
      <path d="M14 20 h52 a6 6 0 0 1 6 6 v58 a8 8 0 0 1 -8 8 h-48 a8 8 0 0 1 -8 -8 v-58 a6 6 0 0 1 6 -6 z" className="jar-glass" />
      {h > 0 ? <rect x="12" y={86 - h} width="56" height={h} rx="5" fill={color} className="jar-stuff" /> : null}
      {h > 0 ? <rect x="12" y={86 - h} width="56" height="5" rx="2.5" fill="#fff" opacity=".35" /> : null}
      <path d="M14 20 h52 a6 6 0 0 1 6 6 v58 a8 8 0 0 1 -8 8 h-48 a8 8 0 0 1 -8 -8 v-58 a6 6 0 0 1 6 -6 z" className="jar-edge" />
      <rect x="22" y="40" width="36" height="22" rx="5" className="jar-label" />
      <text x="40" y="56" textAnchor="middle" className="jar-icon">{fill.level === "unknown" ? "?" : icon}</text>
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Old unpaid documents of one supplier (farthest first), with picks for the robot package. Same rules as the old
// robot desk: rows before the learned cutover fold away, rows already paid outside are faded, the last pick
// pattern is shown, and Sushi (the finance reviewer) can review the list. Each row shows its photo count.
function DebtPicker({ supplierId, picks, onToggle, onView, compact = false }: {
  supplierId: string | null; picks: DebtPick[]; onToggle: (pick: DebtPick) => void; onView: (key: DocKey) => void; compact?: boolean;
}) {
  const debt = useSupplierDebtCandidates(supplierId);
  const pattern = useSupplierDebtPickPattern(compact ? null : supplierId);
  const review = useRunDebtReview();
  const [showOld, setShowOld] = useState(false);
  const [showAll, setShowAll] = useState(false);
  if (!supplierId) return <p className="debt-none">Chưa rõ NCC: chọn NCC để xem phiếu cũ.</p>;
  if (debt.isLoading) return <p className="debt-none is-wait">Đang tải phiếu cũ chưa chi…</p>;
  if (debt.isError) return <p className="debt-none err">Không tải được phiếu cũ: {robotOrderErrorText(robotOrderErrorCode(debt.error))}</p>;
  const ranked = rankDebtRows(debt.data?.rows ?? []);
  const live = ranked.filter((r) => !r.collapsed);
  const folded = ranked.filter((r) => r.collapsed);
  if (!ranked.length) return <p className="debt-none">✓ NCC này không còn phiếu cũ chưa chi</p>;
  const limit = compact ? 3 : showAll ? live.length : 8;
  const total = live.reduce((s, r) => s + (r.remaining ?? 0), 0);
  const picked = sumDebtPicks(ranked, picks);
  const stats = debt.data?.stats;
  const cutover = debt.data?.cutover;
  const learned = pattern.data?.packages ? pattern.data : null;
  const full = picks.length >= MAX_DEBT_PICKS;
  const row = (r: SupplierDebtRow) => {
    const on = picks.some((p) => p.id === r.id);
    const mark = markLabel(r);
    return (
      <li key={r.id} className={r.mark === "settled_outside" ? "is-faded" : undefined}>
        <label className="pick">
          <input type="checkbox" checked={on} disabled={full && !on} onChange={() => onToggle({ kind: r.kind, id: r.id })} />
          <span className={`kind kind-${r.kind}`}>{r.kind.toUpperCase()}</span>
          <span className="num">{r.number ?? r.id.slice(0, 8)} <PhotoBadge count={r.photo_count} /></span>
          <span className="age">{fmtDate(r.doc_date)}{r.age_days !== null && r.age_days !== undefined ? ` · ${r.age_days} ngày` : ""}{r.has_receipt ? " · đã nhận hàng" : ""}{r.last_submission_number ? ` · đã trình ${r.last_submission_number}` : ""}{mark ? ` · ${mark}` : ""}</span>
          <b>{fmtMoney(r.remaining ?? r.amount ?? 0)}</b>
        </label>
        <button type="button" className="view" onClick={() => onView({ kind: r.kind, id: r.id })} aria-label={`Xem chi tiết ${r.number ?? ""}${r.photo_count ? ` và ${r.photo_count} ảnh` : ""}`} data-view={r.number ?? r.id}>{r.photo_count ? "Xem + ảnh" : "Xem"}</button>
      </li>
    );
  };
  return (
    <div className="debt" data-office-debt={supplierId}>
      <div className="debt-head">
        <b>Phiếu cũ chưa chi · {live.length}</b>
        <small>{fmtMillion(total)}{stats?.median_lag_days != null ? ` · thường trả sau ~${Math.round(stats.median_lag_days)} ngày` : ""}</small>
      </div>
      {!compact ? (
        <small className="debt-meta">
          {cutover ? `Mốc đã học: từ ${cutover.number ?? ""} (${fmtDate(cutover.start_date)})` : "Chưa có mốc · lần chọn đầu tiên sẽ dạy hệ thống"}
          {stats?.paid_90d ? ` · 90 ngày chi ${stats.paid_90d} lần` : ""}
          {learned ? <span data-office-learned> · Lần trước chọn {learned.last_picked_count} phiếu{learned.packages > 1 && learned.median_picked_count != null ? `, thường ${fmtNum(learned.median_picked_count)} phiếu` : ""}</span> : null}
        </small>
      ) : null}
      {live.length ? <ul>{live.slice(0, limit).map(row)}</ul> : <p className="debt-none">Không còn phiếu nào chưa chi sau mốc.</p>}
      {live.length > limit ? (compact ? <small className="more">+{live.length - limit} phiếu mới hơn · xem đủ ở Máy</small> : <button type="button" className="fold" onClick={() => setShowAll(true)}>Xem thêm {live.length - limit} phiếu</button>) : null}
      {!compact && folded.length ? <button type="button" className="fold" onClick={() => setShowOld((v) => !v)} data-office-fold>{showOld ? "Ẩn" : "Xem"} {folded.length} phiếu trước mốc đã học</button> : null}
      {!compact && showOld ? <ul>{folded.map(row)}</ul> : null}
      <small className="sum">{picks.length ? `Chi kèm ${picks.length} phiếu · ${fmtMoney(picked)}${full ? ` (tối đa ${MAX_DEBT_PICKS})` : ""}` : "Chưa chọn phiếu cũ: chỉ đặt đơn mới"}</small>
      {!compact ? (
        <div className="debt-jev">
          <button type="button" className="fold" disabled={review.isPending} onClick={() => review.mutate(supplierId)} data-office-jev>{review.isPending ? "Sushi đang rà…" : "🤖 Sushi rà phiếu cũ"}</button>
          {review.data ? <small>Sushi xem {review.data.evaluated}, đánh dấu {review.data.marked}{review.data.stopped === "quota" ? " · hết hạn mức hôm nay" : ""}</small> : null}
          {review.error ? <small className="err">Sushi chưa chạy được</small> : null}
        </div>
      ) : null}
    </div>
  );
}

// Approve / reject one PR through the existing finance flow (the server owns every permission check).
function ApproveBar({ prId, onDone }: { prId: string; onDone: (text: string, ok: boolean | null) => void }) {
  const { canEditModule } = useAuth();
  const approve = useApprovePaymentRequest();
  const reject = useRejectPaymentRequest();
  const [method, setMethod] = useState<"bank_transfer" | "cash">("bank_transfer");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  if (!canEditModule("payment_requests")) return <p className="state">Chỉ người có quyền Đề nghị chi mới duyệt được.</p>;
  const busy = approve.isPending || reject.isPending;
  const fail = (error: unknown) => onDone(`Không xong: ${String((error as Error)?.message ?? error).slice(0, 160)}`, null);
  return (
    <div className="doc-actions" data-office-approve>
      {rejecting ? (
        <>
          <input className="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lý do từ chối…" aria-label="Lý do từ chối" maxLength={300} autoFocus />
          <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => reject.mutate({ id: prId, reason: reason.trim() }, { onSuccess: () => onDone("Đã từ chối PR", false), onError: fail })}>Gửi từ chối</button>
          <button type="button" className="quiet" onClick={() => setRejecting(false)}>Huỷ</button>
        </>
      ) : (
        <>
          <span className="method" role="radiogroup" aria-label="Cách chi">
            {(["bank_transfer", "cash"] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={method === m} className={method === m ? "is-on" : undefined} onClick={() => setMethod(m)}>{m === "cash" ? "Tiền mặt" : "Chuyển khoản"}</button>
            ))}
          </span>
          <button type="button" className="primary" disabled={busy} onClick={() => approve.mutate({ id: prId, paymentMethod: method }, { onSuccess: () => onDone("Đã duyệt PR", true), onError: fail })}>{approve.isPending ? "Đang duyệt…" : "✓ Duyệt chi"}</button>
          <button type="button" disabled={busy} onClick={() => setRejecting(true)}>Từ chối</button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
export default function WarehouseOffice() {
  usePageZoomGuard();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<Room | null>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const machineHot = useRef(false);
  const builtFor = useRef<string | null>(null);
  const requestIds = useRef(new Map<string, string>());
  // Shared session basket with the Kho 2D/3D shelves ("🤖 Đặt hàng món này"); lines of the other warehouse wait here.
  const parked = useRef<BasketLine[]>([]);
  const imported = useRef<string | null>(null);
  const [wh, setWh] = useState<OfficeOrderLocation>(startKho);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState("");
  const [spot, setSpot] = useState<Spot>({ kind: "low" });
  const [open, setOpen] = useState<string | null>(null);
  const [basket, setBasket] = useState<Line[]>([]);
  const [picks, setPicks] = useState<Record<string, DebtPick[]>>({});
  const [docStack, setDocStack] = useState<DocKey[]>([]);
  const [prOpen, setPrOpen] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(true);
  // Phones (owner 17/10 IMG_5809): drag the notebook up to see the catalog bigger, down to give the room back.
  // Three stops: closed (strip only) · half · full; a plain tap on the handle toggles half ⇄ full.
  const [sheetFull, setSheetFull] = useState(false);
  const sheetDrag = useRef<{ y0: number; h0: number; moved: boolean } | null>(null);
  const [dragH, setDragH] = useState<number | null>(null);
  // The full sheet stops just under the HUD (one row at 390px, two rows on the narrowest phones).
  const hudRef = useRef<HTMLElement>(null);
  const [hudBottom, setHudBottom] = useState(64);
  useEffect(() => {
    const el = hudRef.current;
    if (!el) return;
    const fit = () => setHudBottom(Math.round(el.getBoundingClientRect().bottom));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("resize", fit);
    return () => { ro.disconnect(); window.removeEventListener("resize", fit); };
  }, []);
  const [modal, setModal] = useState<"machine" | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [decided, setDecided] = useState(0);
  // Shelf close-up (owner 17/10: "ấn vào kệ nên phóng to ra"): the shelf fills the screen, products sit on planks.
  const [zoom, setZoom] = useState<GroupCode | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const snapshot = useOfficeOrderSnapshot(wh);
  // Real on-hand from the stock ledger (same item ids, kitchen_inventory_items). Before a warehouse's first count
  // (no cutover) or when the reader is not allowed, the boxes fall back to the purchase-cycle forecast.
  const ledger = useWarehouseGameSnapshot(wh);
  const ledgerStarted = Boolean(ledger.data && ledger.data.location === wh && ledger.data.cutover_date);
  const onHand = useMemo(() => new Map((ledger.data?.location === wh ? ledger.data.items : []).map((i) => [i.id, i.on_hand])), [ledger.data, wh]);
  const pending = usePendingPaymentRequests();
  const recent = useRecentPackages();
  const suppliers = useSuppliers();
  const create = useCreateRobotOrderPackage();
  const snap = snapshot.data?.location === wh ? snapshot.data : null;

  const shelves = useMemo(() => (snap ? buildShelves(snap.items, snap.as_of) : []), [snap]);
  const items = useMemo(() => shelves.flatMap((s) => s.items), [shelves]);
  const low = useMemo(() => items.filter((i) => i.low).sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99)), [items]);
  const results = useMemo(() => (query ? (searchItems(items, query, snap?.as_of) as Item[]) : []), [items, query, snap]);
  const supplierOptions = useMemo(() => (suppliers.data ?? []).map((s) => ({ value: s.id, label: s.name })).sort((a, b) => a.label.localeCompare(b.label, "vi")), [suppliers.data]);
  const waiting = pending.data?.length ?? 0;

  // ---- scene lifecycle: one room, live idle (breathing, blinking bulbs); the build plays only when the machine opens
  useEffect(() => {
    const room = new Room(canvasRef.current!, overlayRef.current!);
    roomRef.current = room;
    (window as unknown as { __room: Room }).__room = room; // QA hook
    room.events = [{ type: "assemble", t: IDLE_START }];
    if (REDUCED) room.frozen = 40;
    const sync = () => {
      room.insetPx = isPhone() && boardRef.current ? Math.round(boardRef.current.getBoundingClientRect().height) : 0;
      room.resize();
    };
    sync();
    room.start();
    const observer = new ResizeObserver(sync);
    observer.observe(canvasRef.current!.parentElement!);
    if (boardRef.current) observer.observe(boardRef.current);
    return () => { observer.disconnect(); room.dispose(); roomRef.current = null; };
  }, []);
  // Board height changes (sheet open / closed, snapshot arriving) re-frame the room above it on phones.
  useEffect(() => {
    const room = roomRef.current;
    if (!room) return;
    room.insetPx = isPhone() && boardRef.current ? Math.round(boardRef.current.getBoundingClientRect().height) : 0;
    room.resize();
  }, [sheetOpen, sheetFull, dragH === null, snap, modal]);

  // Fill the room once the chosen warehouse's snapshot is in. No opening scene: you are already in the warehouse.
  useEffect(() => {
    const room = roomRef.current;
    if (!room || !snap || builtFor.current === wh) return;
    builtFor.current = wh;
    const toRoom = (i: Item): RoomItem => ({ id: i.id, name: i.name, group: i.group, low: i.low });
    const data: RoomData = {
      items: items.map(toRoom),
      groups: shelves.map((s) => ({ code: s.code, label: s.label, icon: s.icon, color: SHELF_HEX[s.code], items: s.items.map(toRoom), low: s.items.filter((i) => i.low).map(toRoom) })),
      low: low.map(toRoom),
    };
    room.setWarehouse(data, waiting);
    if (room.frozen !== null) room.renderAt(room.frozen);
    setReady(true);
  }, [wh, snap, items, shelves, low, waiting]);
  useEffect(() => { roomRef.current?.setDeskCount(waiting); }, [waiting]);


  // Bring in the shared basket once this warehouse's items are known; keep the rest parked.
  useEffect(() => {
    if (!snap || imported.current === wh) return;
    imported.current = wh;
    const byId = new Map(items.map((i) => [i.id, i]));
    const stored = loadBasket();
    const lines: Line[] = [];
    const rest: BasketLine[] = [];
    for (const b of stored) {
      const item = b.item_id ? byId.get(b.item_id) : undefined;
      if (!item) { rest.push(b); continue; }
      if (lines.some((l) => l.item.id === item.id)) continue;
      const qty = num(b.qty);
      const price = num(b.price);
      lines.push({ item, qty: qty > 0 ? qty : startQty(item), price: price >= 0 && b.price !== "" ? price : item.last_unit_price, supplierId: b.supplier_id ?? item.supplier_id, supplierName: b.supplier_id && b.supplier_id !== item.supplier_id ? null : item.supplier_name });
    }
    parked.current = rest;
    setBasket(lines);
  }, [wh, snap, items]);
  useEffect(() => {
    if (!imported.current) return;
    saveBasket([...parked.current, ...basket.map(toBasketLine)]);
  }, [basket]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(id);
  }, [toast]);
  // The notebook follows what you touched: top of the page, active chip in view.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    document.querySelector<HTMLElement>(".kvp .chip[aria-pressed=true]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [spot, query]);
  useEffect(() => {
    if (!modal && !zoom) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !docStack.length && !prOpen) closeModal(); };
    if (!modal && zoom && !docStack.length && !prOpen) {
      const z = (e: KeyboardEvent) => { if (e.key === "Escape") { if (picked) setPicked(null); else setZoom(null); } };
      window.addEventListener("keydown", z);
      return () => window.removeEventListener("keydown", z);
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  // ---- today's play: low items into the basket, PRs decided here
  const inBasket = new Map(basket.map((l) => [l.item.id, l.qty]));
  const lowDone = low.filter((item) => inBasket.has(item.id)).length;
  const prevLowDone = useRef(0);
  useEffect(() => {
    if (low.length && lowDone === low.length && prevLowDone.current < lowDone) setToast("🎉 Mọi món sắp hết đã vào khay. Mở máy để tạo đơn.");
    prevLowDone.current = lowDone;
  }, [lowDone, low.length]);

  const closeModal = () => setModal(null);
  const switchWarehouse = (id: OfficeOrderLocation) => {
    if (id === wh || sending) return;
    builtFor.current = null;
    imported.current = null;
    saveBasket([...parked.current, ...basket.map(toBasketLine)]);
    setWh(id); setReady(false); setZoom(null); setPicked(null); setSpot({ kind: "low" }); setQuery(""); setPicks({}); setOpen(null); setPrOpen(null); setDocStack([]); setSendError(null); setModal(null); setHover(null);
    roomRef.current?.push({ type: "clear", t: roomRef.current.now() });
    history.replaceState(null, "", `?kho=${id}`);
  };
  const choose = (next: Spot) => {
    const room = roomRef.current;
    setSpot(next); setQuery(""); setOpen(null); setSheetOpen(true);
    room?.push({ type: "station", t: room.now(), id: next.kind === "shelf" ? next.code : next.kind });
    setPicked(null); setZoom(next.kind === "shelf" ? next.code : null);
  };
  // Sushi is awake and standing in the warehouse (owner 17/10): tapping her opens the ordering panel at once;
  // the room just greets (hopper glow + smile) behind the panel.
  const startMachine = () => {
    if (modal || !ready) return;
    const room = roomRef.current;
    if (room && room.frozen === null) { room.push({ type: "hover", t: room.now(), on: true }); window.setTimeout(() => room.push({ type: "hover", t: room.now(), on: false }), 900); }
    setHover(null); setSheetOpen(false); setSheetFull(false); setModal("machine");
  };

  // ---- basket + drops (a crate flies from its shelf into the hopper)
  const addToBasket = (item: Item) => {
    setBasket((lines) => {
      const found = lines.find((l) => l.item.id === item.id);
      if (found) return lines.map((l) => (l.item.id === item.id ? { ...l, qty: l.qty + startQty(item) } : l));
      return [...lines, { item, qty: startQty(item), price: item.last_unit_price, supplierId: item.supplier_id, supplierName: item.supplier_name }];
    });
  };
  const dropItem = (item: Item) => {
    const room = roomRef.current;
    if (!room || room.frozen !== null) { addToBasket(item); return; }
    room.push({ type: "drop", t: room.now(), itemId: item.id, from: room.itemFrom(item.id, item.group) });
    window.setTimeout(() => addToBasket(item), FLY * 1000);
  };

  // ---- touching the room
  const hitAt = (x: number, y: number) => roomRef.current?.pick(x, y) ?? null;
  const onStageMove = (e: RPointerEvent<HTMLElement>) => {
    const room = roomRef.current;
    if (!room || !ready || modal || e.pointerType === "touch") return;
    const hit = hitAt(e.clientX, e.clientY);
    const code = hit?.kind === "shelf" ? hit.code : null;
    room.hoverShelf = code;
    const hot = hit?.kind === "machine";
    if (hot !== machineHot.current) { machineHot.current = hot; room.push({ type: "hover", t: room.now(), on: hot }); }
    let next: Hover | null = null;
    if (code) {
      const g = shelves.find((x) => x.code === code);
      const p = room.shelfScreen(code);
      const lowN = g ? g.items.filter((i) => i.low).length : 0;
      if (g && p) next = { label: `${g.icon} ${g.label}`, sub: `${g.items.length} món${lowN ? ` · ${lowN} sắp hết` : ""} · chạm để xem`, x: p.x, y: p.y };
    } else if (hit?.kind === "desk") { const p = room.deskPoint(); next = { label: "📋 Bàn duyệt PR", sub: `${waiting} phiếu chờ · chạm để xem`, x: p.x, y: p.y }; }
    else if (hit?.kind === "machine") { const p = room.machineScreen(); next = { label: "🤖 Máy đặt hàng tự động", sub: basket.length ? `${basket.length} món trong khay · chạm để mở` : "chạm để mở máy", x: p.x, y: p.y }; }
    setHover((h) => (h?.label === next?.label && h?.x === next?.x ? h : next));
    (e.currentTarget as HTMLElement).style.cursor = hit && hit.kind !== "floor" ? "pointer" : "default";
    if (room.frozen !== null) room.renderAt(room.frozen);
  };
  const onStageLeave = () => {
    const room = roomRef.current;
    if (room) { room.hoverShelf = null; if (machineHot.current) { machineHot.current = false; room.push({ type: "hover", t: room.now(), on: false }); } }
    setHover(null);
  };
  const onStageDown = (e: RPointerEvent<HTMLElement>) => { press.current = { x: e.clientX, y: e.clientY }; };
  const onStageUp = (e: RPointerEvent<HTMLElement>) => {
    const p = press.current; press.current = null;
    if (!p || !ready || modal || (e.target as HTMLElement).closest("button, a") || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) return;
    const hit = hitAt(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.kind === "shelf") choose({ kind: "shelf", code: hit.code as GroupCode });
    else if (hit.kind === "desk") choose({ kind: "desk" });
    else if (hit.kind === "machine") startMachine();
  };

  // ---- machine: one robot package per supplier
  const bySupplier = useMemo(() => {
    const map = new Map<string, Line[]>();
    for (const line of basket) map.set(line.supplierId ?? NO_SUP, [...(map.get(line.supplierId ?? NO_SUP) ?? []), line]);
    return [...map.entries()];
  }, [basket]);
  const supplierName = (id: string) => (id === NO_SUP ? "Chưa rõ NCC" : basket.find((l) => l.supplierId === id)?.supplierName ?? supplierOptions.find((s) => s.value === id)?.label ?? "NCC");
  const togglePick = (sup: string, pick: DebtPick) => setPicks((p) => ({ ...p, [sup]: toggleDebtPick(p[sup] ?? [], pick) }));

  const sendAll = async () => {
    const room = roomRef.current!;
    const groups = bySupplier.filter(([sup]) => sup !== NO_SUP);
    if (!groups.length || sending) return;
    setSending(true);
    setSendError(null);
    const done: RobotOrderPackageResult[] = [];
    const sentSuppliers: string[] = [];
    for (const [sup, lines] of groups) {
      const key = requestIds.current.get(sup) ?? newRequestId();
      requestIds.current.set(sup, key);
      try {
        const result = await create.mutateAsync({
          lines: lines.map((l) => ({ supplier_id: sup, product_name: l.item.name, quantity: l.qty, unit: lineUnit(l.item), unit_price: l.price ?? 0, item_id: l.item.id })),
          debt: picks[sup]?.length ? picks[sup] : null,
          note: "Kho văn phòng",
          idempotency_key: key,
        });
        done.push(result);
        sentSuppliers.push(sup);
        requestIds.current.delete(sup);
      } catch (error) {
        setSendError(`${supplierName(sup)}: ${robotOrderErrorText(robotOrderErrorCode(error))}`);
        break;
      }
    }
    setSending(false);
    if (!done.length) return;
    room.push({ type: "print", t: room.now(), slips: Math.min(10, done.length) });
    setBasket((ls) => ls.filter((l) => !sentSuppliers.includes(l.supplierId ?? NO_SUP)));
    setPicks((p) => Object.fromEntries(Object.entries(p).filter(([sup]) => !sentSuppliers.includes(sup))));
    setToast(done.map(packageSummary).join(" · "));
    queryClient.invalidateQueries({ queryKey: [OFFICE_PENDING_PAYMENT_REQUESTS_QUERY_KEY] });
    queryClient.invalidateQueries({ queryKey: ["robot-order-packages"] });
    if (sentSuppliers.length === groups.length) { closeModal(); choose({ kind: "desk" }); }
    window.setTimeout(() => room.push({ type: "clear", t: room.now() }), (0.4 + done.length * 0.45 + 0.9) * 1000);
  };

  const prDone = (text: string, ok: boolean | null) => {
    setToast(text);
    if (ok === null) return;
    const room = roomRef.current!;
    room.push({ type: "stamp", t: room.now() + 0.05, ok });
    setDecided((n) => n + 1);
    setPrOpen(null);
    setDocStack([]);
    queryClient.invalidateQueries({ queryKey: [OFFICE_PENDING_PAYMENT_REQUESTS_QUERY_KEY] });
  };
  const closeDocs = () => { setDocStack([]); setPrOpen(null); };

  // ---- notebook sheet drag (phones only; desktop keeps the side panel)
  const onSheetDown = (e: RPointerEvent<HTMLElement>) => {
    if (!isPhone() || (e.target as HTMLElement).closest("input, .chips, .search button")) return;
    const h = boardRef.current?.getBoundingClientRect().height ?? 0;
    sheetDrag.current = { y0: e.clientY, h0: h, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onSheetMove = (e: RPointerEvent<HTMLElement>) => {
    const d = sheetDrag.current;
    if (!d) return;
    const dy = d.y0 - e.clientY;
    if (!d.moved && Math.abs(dy) < 6) return;
    d.moved = true;
    const max = window.innerHeight - hudBottom - 6;
    setDragH(Math.max(56, Math.min(max, d.h0 + dy)));
  };
  const onSheetUp = () => {
    const d = sheetDrag.current;
    sheetDrag.current = null;
    if (!d) return;
    if (!d.moved) { // tap on the handle strip
      if (!sheetOpen) { setSheetOpen(true); setSheetFull(false); } else setSheetFull((v) => !v);
      setDragH(null);
      return;
    }
    const h = dragH ?? d.h0;
    const vh = window.innerHeight;
    if (h > vh * 0.68) { setSheetOpen(true); setSheetFull(true); }
    else if (h < vh * 0.26) { setSheetOpen(false); setSheetFull(false); }
    else { setSheetOpen(true); setSheetFull(false); }
    setDragH(null);
  };

  // ---- render helpers
  const total = basket.reduce((s, l) => s + (l.price ?? 0) * l.qty, 0);
  const setLine = (id: string, patch: Partial<Line>) => setBasket((ls) => ls.map((x) => (x.item.id === id ? { ...x, ...patch } : x)));
  const card = (item: Item) => {
    const days = item.daysLeft !== null ? daysLabel(item.daysLeft) : "";
    const qty = inBasket.get(item.id);
    const isOpen = open === item.id;
    const icon = shelves.find((s) => s.code === item.group)?.icon ?? "📦";
    const sug = suggestText(item);
    return (
      <li key={item.id} className={`card${item.low ? " is-low" : ""}${isOpen ? " is-open" : ""}`} data-item={item.id} style={{ ["--g" as string]: SHELF_HEX[item.group] }}>
        <div className="card-main">
          <span className="crate" aria-hidden>{icon}</span>
          <button type="button" className="name" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : item.id)}>
            <b>{item.name}</b>
            <small>{item.supplier_name ?? "Chưa rõ NCC"}{sug ? ` · lần trước ${sug}` : ""}</small>
            <span className="card-tags">
              {days ? <span className={`pill${item.low ? " low" : ""}`}>{days}</span> : <span className="pill muted">Chưa dự đoán</span>}
              {wh === "tan_tao" && item.pastry_q7 ? <span className="pill q7" data-office-to-q7>🧁 Giao về Tân Tạo → tự chuyển Q7</span> : null}
            </span>
          </button>
          <button type="button" className={`add${qty ? " added" : ""}`} onClick={() => dropItem(item)} aria-label={`Bỏ ${item.name} vào máy`} data-office-add>{qty ? `✓ ×${fmtNum(qty)}` : "+ Thêm"}</button>
        </div>
        {isOpen ? (
          <div className="card-more">
            <p className="facts">
              {item.last_unit_price ? <>Giá gần nhất <b>{fmtMoney(item.last_unit_price)}/{lineUnit(item)}</b> · </> : null}
              {item.last_date ? <>nhập {fmtDate(item.last_date)} · {item.receipts} ngày nhập/120 ngày</> : "Chưa có phiếu nhập 120 ngày"}
              {days ? <> · dự đoán: {days.toLowerCase()}</> : null}
            </p>
            <DebtPicker supplierId={item.supplier_id} picks={picks[item.supplier_id ?? NO_SUP] ?? []} onToggle={(p) => togglePick(item.supplier_id ?? NO_SUP, p)} onView={(k) => setDocStack([k])} compact />
            <button type="button" className="primary wide" onClick={() => dropItem(item)}>Bỏ vào máy ↑ {sug ? `(${sug})` : ""}</button>
          </div>
        ) : null}
      </li>
    );
  };
  const cards = (rows: Item[]) => (rows.length ? <ul className="cards">{rows.map(card)}</ul> : <div className="empty-state"><h3>Không có món nào</h3><p>Chạm vào một kệ trong kho để xem hàng.</p></div>);

  const machineView = () => (
    <section className="machine-view">
      {!basket.length ? <p className="empty">Máy đang trống. Chạm vào kệ trong kho rồi bấm “+ Thêm” để cho hàng vào khay.</p> : null}
      {bySupplier.map(([sup, lines]) => {
        const sum = lines.reduce((s, l) => s + (l.price ?? 0) * l.qty, 0);
        return (
          <article key={sup} className="sup-card" data-office-supplier={sup}>
            <h3>{supplierName(sup)}<small>{sum ? fmtMoney(sum) : "chưa có giá"}</small></h3>
            {sup === NO_SUP ? (
              <div className="sup-pick">
                <small>Món chưa có NCC: chọn NCC để đặt</small>
                <GamePicker value="" onChange={(id) => setBasket((ls) => ls.map((l) => (l.supplierId ? l : { ...l, supplierId: id, supplierName: supplierOptions.find((s) => s.value === id)?.label ?? null })))} options={supplierOptions} placeholder="Chọn NCC…" title="Nhà cung cấp" ariaLabel="Chọn nhà cung cấp" />
              </div>
            ) : null}
            <ul className="lines edit">
              {lines.map((l) => (
                <li key={l.item.id} data-office-line={l.item.name}>
                  <span className="lname">{l.item.name}{wh === "tan_tao" && l.item.pastry_q7 ? <em className="lq7"> → Q7</em> : null}</span>
                  <label className="lfield">SL
                    <input inputMode="decimal" defaultValue={String(l.qty)} key={`q-${l.qty}`} onBlur={(e) => { const v = num(e.target.value); if (v > 0) setLine(l.item.id, { qty: v }); else e.target.value = String(l.qty); }} aria-label={`Số lượng ${l.item.name}`} data-office-qty />
                    <small>{lineUnit(l.item)}</small>
                  </label>
                  <label className="lfield">Giá
                    <input inputMode="decimal" defaultValue={l.price === null ? "" : String(l.price)} key={`p-${l.price}`} placeholder="0" onBlur={(e) => { const v = num(e.target.value); setLine(l.item.id, { price: e.target.value.trim() === "" ? null : v >= 0 ? v : l.price }); }} aria-label={`Đơn giá ${l.item.name}`} data-office-price />
                    <small>đ/{lineUnit(l.item)}</small>
                  </label>
                  <button type="button" className="rm" aria-label={`Bỏ ${l.item.name}`} onClick={() => setBasket((ls) => ls.filter((x) => x.item.id !== l.item.id))}>✕</button>
                </li>
              ))}
            </ul>
            {sup !== NO_SUP ? <DebtPicker supplierId={sup} picks={picks[sup] ?? []} onToggle={(p) => togglePick(sup, p)} onView={(k) => setDocStack([k])} /> : null}
          </article>
        );
      })}
      {sendError ? <p className="err" role="alert">{sendError}</p> : null}
      {basket.length ? (
        <button type="button" className="primary wide big" disabled={sending || !bySupplier.some(([sup]) => sup !== NO_SUP)} onClick={sendAll}>
          {sending ? "Đang tạo đơn…" : `🖨️ Tạo ${bySupplier.filter(([sup]) => sup !== NO_SUP).length} đơn nháp & gửi phiếu cũ đi chi`}
        </button>
      ) : null}
      {basket.length ? <p className="note">Mỗi NCC thành một đơn nháp (PO). Phiếu cũ đã tick được gửi đi chi cùng đợt duyệt chi.</p> : null}
      {recent.data?.length ? (
        <div className="recent" data-office-recent>
          <h4>Đơn robot gần đây</h4>
          <ul>
            {recent.data.map((p) => (
              <li key={p.id}><span>{fmtDate(p.created_at)}</span><b>{(p.result?.po_numbers ?? []).join(", ") || "—"}</b><small>{packageDebtNumbers(p.result).length ? `chi kèm ${packageDebtNumbers(p.result).join(", ")}` : "không kèm phiếu cũ"}</small></li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );

  const prRows = () => {
    if (pending.isLoading) return <p className="empty">Đang tải PR chờ duyệt…</p>;
    if (pending.isError) return <p className="empty err">Không tải được danh sách PR.</p>;
    const rows = pending.data ?? [];
    if (!rows.length) return <div className="empty-state"><h3>Không còn PR chờ duyệt</h3><p>Bàn duyệt đang trống.</p></div>;
    return (
      <ul className="pr-list">
        {rows.map((p) => (
          <li key={p.id}>
            <button type="button" className={`pr-row${prOpen === p.id ? " is-on" : ""}`} onClick={() => { setDocStack([]); setPrOpen(p.id); }} data-pr={p.request_number} data-office-pr-photos={p.photo_count}>
              <PhotoThumb path={p.image_path} bucket="invoices" count={p.photo_count} />
              <span className="pr-name">
                <b>{p.request_number || p.id.slice(0, 8)}</b>
                <small>{p.supplier_name ?? "—"} · {fmtDate(p.created_at)} · {p.item_count} dòng</small>
                <PhotoBadge count={p.photo_count} />
              </span>
              <span className="pr-side"><strong>{fmtMoney(p.total_amount ?? 0)}</strong><span className="pill">Chờ duyệt</span></span>
            </button>
          </li>
        ))}
      </ul>
    );
  };

  const shelf = spot.kind === "shelf" ? shelves.find((s) => s.code === spot.code) ?? null : null;
  let heading: React.ReactNode; let body: React.ReactNode;
  if (query) {
    heading = <><span className="head-icon">🔍</span><div><b>Tìm trong kho</b><small>{results.length} món khớp “{query}”</small></div></>;
    body = results.length ? cards(results) : <div className="empty-state"><h3>Chưa tìm thấy</h3><p>Thử tên khác, mã hàng hoặc nhà cung cấp.</p><button type="button" onClick={() => setQuery("")}>Xoá tìm kiếm</button></div>;
  } else if (spot.kind === "desk") {
    heading = <><span className="head-icon">📋</span><div><b>Bàn duyệt PR</b><small>{waiting} phiếu chờ · mỗi phiếu kèm ảnh chứng từ để đối soát</small></div></>;
    body = prRows();
  } else if (shelf) {
    const lowN = shelf.items.filter((i) => i.low).length;
    heading = <><span className="head-icon" style={{ background: SHELF_HEX[shelf.code] }}>{shelf.icon}</span><div><b>Kệ {shelf.label}</b><small>{shelf.items.length} món{lowN ? ` · ${lowN} sắp hết` : " · đủ hàng"}</small></div></>;
    body = cards(shelf.items);
  } else {
    heading = <><span className="head-icon">☀️</span><div><b>Việc hôm nay</b><small>{low.length ? `${low.length} món dự đoán sắp hết` : "Kho ổn, chưa có món sắp hết"}</small></div></>;
    body = low.length ? <>{cards(low)}<p className="note">Dự đoán theo chu kỳ nhập 120 ngày gần nhất. Kho chưa kiểm kê nên chưa dùng số tồn.</p></> : <div className="empty-state"><h3>Kệ đang đầy</h3><p>Chạm vào một kệ trong kho để xem hàng.</p></div>;
  }
  const questPct = low.length ? Math.round((lowDone / low.length) * 100) : 100;
  const loading = !snap;

  // ---- shelf close-up
  const fillOf = (item: Item) => stockFill(item, onHand.get(item.id), ledgerStarted);
  const zoomShelf = zoom ? shelves.find((s) => s.code === zoom) ?? null : null;
  const zoomItems = zoomShelf ? zoomShelf.items.map((item) => ({ item, fill: fillOf(item) })) : [];
  const LEVEL_ORDER: Record<FillLevel, number> = { empty: 0, low: 1, half: 2, unknown: 3, full: 4 };
  zoomItems.sort((a, b) => LEVEL_ORDER[a.fill.level] - LEVEL_ORDER[b.fill.level] || a.item.name.localeCompare(b.item.name, "vi"));
  const counts = zoomItems.reduce((m, z) => ({ ...m, [z.fill.level]: (m[z.fill.level] ?? 0) + 1 }), {} as Partial<Record<FillLevel, number>>);
  const pickedRow = picked ? zoomItems.find((z) => z.item.id === picked) ?? null : null;
  const fillDetail = (item: Item, fill: StockFill) => {
    if (fill.source === "stock") {
      const oh = onHand.get(item.id) ?? 0;
      const usual = item.avg_qty ?? (item.total_qty && item.receipts ? item.total_qty / item.receipts : null);
      return `Tồn sổ ${qtyText(Math.max(0, oh), item.unit)}${usual ? ` · mỗi lần nhập ~${qtyText(usual, item.unit)}` : ""}`;
    }
    if (fill.source === "forecast") return item.daysLeft != null ? `Dự đoán theo chu kỳ nhập: ${daysLabel(item.daysLeft).toLowerCase()}` : "Dự đoán theo chu kỳ nhập";
    return "Chưa đủ dữ liệu nhập để đoán";
  };
  const zoomView = zoomShelf ? (
    <section className="shelf-zoom" role="dialog" aria-modal="true" aria-label={`Kệ ${zoomShelf.label}`} data-office-zoom={zoomShelf.code} style={{ ["--g" as string]: SHELF_HEX[zoomShelf.code] }}>
      <header className="sz-head">
        <button type="button" className="sz-back" onClick={() => { setZoom(null); setPicked(null); }} aria-label="Đóng kệ" data-office-zoom-back>‹ Về kho</button>
        <span className="sz-title"><i>{zoomShelf.icon}</i><span><b>Kệ {zoomShelf.label}</b><small>{zoomItems.length} món · {ledgerStarted ? "theo số tồn trong sổ kho" : "dự đoán theo chu kỳ nhập"}</small></span></span>
      </header>
      <div className="sz-legend" aria-label="Chú thích hộp">
        {(["full", "half", "low", "empty"] as FillLevel[]).map((lv) => <span key={lv} className={`sz-key is-${lv}`}><i />{FILL_LABEL[lv]}{counts[lv] ? <b>{counts[lv]}</b> : null}</span>)}
      </div>
      <div className="sz-shelf" data-office-zoom-items={zoomItems.length}>
        {zoomItems.length ? zoomItems.map(({ item, fill }) => {
          const qty = inBasket.get(item.id);
          return (
            <button key={item.id} type="button" className={`sz-item is-${fill.level}${picked === item.id ? " is-on" : ""}${qty ? " in-basket" : ""}`} onClick={() => setPicked(picked === item.id ? null : item.id)} aria-label={`${item.name}, ${fill.label}`} data-office-jar={fill.level} data-item={item.id}>
              <Jar fill={fill} color={SHELF_HEX[item.group]} icon={zoomShelf.icon} />
              {qty ? <em className="sz-in">✓ ×{fmtNum(qty)}</em> : null}
              <span className={`sz-pill is-${fill.level}`}>{fill.label}</span>
              <b>{item.name}</b>
            </button>
          );
        }) : <p className="empty">Kệ này chưa có món nào.</p>}
      </div>
      {pickedRow ? (
        <div className="sz-pick" data-office-zoom-pick={pickedRow.item.id}>
          <div className="sz-pick-head">
            <Jar fill={pickedRow.fill} color={SHELF_HEX[pickedRow.item.group]} icon={zoomShelf.icon} />
            <span><b>{pickedRow.item.name}</b><small>{pickedRow.item.supplier_name ?? "Chưa rõ NCC"}</small><span className={`sz-pill is-${pickedRow.fill.level}`}>{pickedRow.fill.label}</span></span>
            <button type="button" className="sz-close" onClick={() => setPicked(null)} aria-label="Đóng món">✕</button>
          </div>
          <p className="facts">
            <b>{fillDetail(pickedRow.item, pickedRow.fill)}</b>
            {pickedRow.item.last_unit_price ? <> · giá gần nhất {fmtMoney(pickedRow.item.last_unit_price)}/{lineUnit(pickedRow.item)}</> : null}
            {pickedRow.item.last_date ? <> · nhập {fmtDate(pickedRow.item.last_date)}</> : null}
            {suggestText(pickedRow.item) ? <> · lần trước {suggestText(pickedRow.item)}</> : null}
          </p>
          {wh === "tan_tao" && pickedRow.item.pastry_q7 ? <p className="sz-q7" data-office-to-q7>🧁 Giao về Tân Tạo → tự chuyển Q7</p> : null}
          <DebtPicker supplierId={pickedRow.item.supplier_id} picks={picks[pickedRow.item.supplier_id ?? NO_SUP] ?? []} onToggle={(pk) => togglePick(pickedRow.item.supplier_id ?? NO_SUP, pk)} onView={(k) => setDocStack([k])} compact />
          <button type="button" className="primary wide big" onClick={() => dropItem(pickedRow.item)} data-office-zoom-add>{inBasket.get(pickedRow.item.id) ? `✓ Đã có ×${fmtNum(inBasket.get(pickedRow.item.id)!)} · thêm nữa` : `+ Thêm vào máy${suggestText(pickedRow.item) ? ` (${suggestText(pickedRow.item)})` : ""}`}</button>
        </div>
      ) : null}
      <footer className="sz-foot">
        <span>🧺 {basket.length ? <><b>{basket.length} món</b> trong khay</> : "Chạm một món để chọn"}</span>
        <button type="button" className="open-machine" onClick={() => { setZoom(null); setPicked(null); startMachine(); }} disabled={!ready} data-office-zoom-machine>🤖 Mở máy{basket.length ? ` · ${basket.length}` : ""}</button>
      </footer>
    </section>
  ) : null;

  return (
    <div className={`kvp game${ready ? " is-ready" : ""}`} data-office-page data-office-version="sushi-game-v3">
      <section className="stage" onPointerMove={onStageMove} onPointerLeave={onStageLeave} onPointerDown={onStageDown} onPointerUp={onStageUp} onPointerCancel={() => { press.current = null; }}>
        <canvas ref={canvasRef} className="bay" aria-label="Kho minh hoạ: kệ hàng, bàn duyệt PR và máy đặt hàng tự động. Chạm vào kệ để xem hàng, chạm máy để đặt hàng." />
        <div ref={overlayRef} className="overlay" aria-hidden />
        {hover && !modal ? <div className="world-tag" style={{ left: hover.x, top: hover.y }} aria-hidden><b>{hover.label}</b><small>{hover.sub}</small></div> : null}
        <header className="hud" ref={hudRef}>
          <button type="button" className="exit" onClick={() => navigate(FROM_KHO ? `/warehouse/game?enter=${wh}` : "/warehouse/game")} aria-label="Về Kho">← Kho</button>
          <span className="wordmark">🤖 Đặt hàng tự động</span>
          {KHO_FIXED
            ? <span className="kho-here" data-office-here={wh} aria-label={`Đang ở ${WAREHOUSES[wh].label}`}>📍 {WAREHOUSES[wh].label}</span>
            : <div className="kho-tabs" role="group" aria-label="Chuyển kho">{(["tan_tao", "q7"] as OfficeOrderLocation[]).map((id) => <button type="button" key={id} data-kho={id} aria-pressed={id === wh} disabled={sending} onClick={() => switchWarehouse(id)}>{WAREHOUSES[id].emoji} {WAREHOUSES[id].short}</button>)}</div>}
        </header>
        <p className="stage-hint">🍃 Chạm kệ để xem hàng · chạm bàn để duyệt PR · chạm máy để đặt hàng</p>
        {loading ? (
          <div className="loading-card" role="status">
            {snapshot.isError ? <><b>Không tải được kho</b><p>{String((snapshot.error as Error)?.message ?? "").slice(0, 160)}</p><button type="button" onClick={() => snapshot.refetch()}>Thử lại</button></> : <><b>Đang mở {WAREHOUSES[wh].label}…</b><p>Đang xếp hàng lên kệ.</p></>}
          </div>
        ) : null}

      </section>

      <aside ref={boardRef} className={`board${sheetOpen ? "" : " is-closed"}${sheetOpen && sheetFull ? " is-full" : ""}${dragH !== null ? " is-dragging" : ""}`} style={dragH !== null ? { height: dragH } : sheetOpen && sheetFull && isPhone() ? { height: `calc(100dvh - ${hudBottom + 6}px)` } : undefined} aria-label="Sổ kho" data-office-sheet={!sheetOpen ? "closed" : sheetFull ? "full" : "half"}>
        <div className="board-top" onPointerDown={onSheetDown} onPointerMove={onSheetMove} onPointerUp={onSheetUp} onPointerCancel={() => { sheetDrag.current = null; setDragH(null); }}>
          <button type="button" className="handle" onClick={(e) => { if (e.detail === 0) { if (!sheetOpen) setSheetOpen(true); else setSheetFull((v) => !v); } }} aria-expanded={sheetOpen && sheetFull} aria-label={sheetFull ? "Thu nhỏ sổ kho" : "Kéo lên để mở rộng sổ kho"} data-office-handle><span /></button>
          <div className="quest" aria-label="Tiến độ hôm nay">
            <div className="quest-row"><span>🔮 Sắp hết vào khay</span><b data-quest-low>{lowDone}/{low.length}</b></div>
            <div className="quest-bar" aria-hidden><span style={{ width: `${questPct}%` }} /></div>
            <div className="quest-row"><span>📋 PR đã xử lý</span><b data-quest-pr>{decided}/{decided + waiting}</b></div>
          </div>
          <label className="search">
            <span aria-hidden>🔎</span>
            <input value={query} onChange={(e) => { setQuery(e.target.value); setOpen(null); }} placeholder="Tìm hàng, mã hoặc nhà cung cấp…" aria-label="Tìm nguyên vật liệu" enterKeyHint="search" onFocus={() => setSheetOpen(true)} />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="Xoá tìm kiếm">✕</button> : null}
          </label>
          <div className="chips" role="group" aria-label="Kệ trong kho">
            <button type="button" className="chip low" aria-pressed={spot.kind === "low" && !query} onClick={() => choose({ kind: "low" })} data-station="low">☀️ Hôm nay <b>{low.length}</b></button>
            {shelves.map((s) => <button type="button" key={s.code} className="chip" data-group={s.code} style={{ ["--g" as string]: SHELF_HEX[s.code] }} aria-pressed={spot.kind === "shelf" && spot.code === s.code && !query} onClick={() => choose({ kind: "shelf", code: s.code })}>{s.icon} {s.label} <b>{s.items.length}</b></button>)}
            <button type="button" className="chip desk" aria-pressed={spot.kind === "desk" && !query} onClick={() => choose({ kind: "desk" })} data-station="desk">📋 Phiếu PR <b>{waiting}</b></button>
          </div>
        </div>
        <div ref={bodyRef} className="board-body">
          <div className="board-head">{heading}</div>
          {snap ? body : <p className="empty">Đang tải kho…</p>}
        </div>
        <footer className="basket-bar">
          <span className="basket-info">🧺 <span>{basket.length ? <><b>{basket.length} món</b> · {bySupplier.length} NCC{total ? ` · ~${fmtMillion(total)}` : ""}</> : <><b>Khay trống</b> · chạm kệ để thêm hàng</>}</span></span>
          <button type="button" className="open-machine" onClick={startMachine} disabled={!ready} data-open-machine data-station="machine">🤖 Mở máy{basket.length ? ` · ${basket.length}` : ""}</button>
        </footer>
      </aside>

      {zoomView}
      {modal === "machine" ? (
        <div className="machine-modal" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
          <section className="machine-dialog" role="dialog" aria-modal="true" aria-label="Máy đặt hàng tự động" data-office-machine>
            <header><div><small>{WAREHOUSES[wh].label} · máy tại kho</small><h2>🤖 Máy đặt hàng tự động</h2></div><button type="button" aria-label="Đóng máy" onClick={closeModal}>✕</button></header>
            {machineView()}
            {!basket.length ? <button type="button" className="return-stock" onClick={closeModal}>Về kho chọn hàng ›</button> : null}
          </section>
        </div>
      ) : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
      {docStack.length || prOpen ? (
        <div className="sheet-wrap doc-modal" role="dialog" aria-label="Chi tiết phiếu" onClick={(e) => { if (e.target === e.currentTarget) closeDocs(); }}>
          <div className="sheet">
            <div className="doc-bar">
              {docStack.length && (docStack.length > 1 || prOpen) ? <button type="button" onClick={() => setDocStack((st) => st.slice(0, -1))}>← Quay lại</button> : <span />}
              <button type="button" onClick={closeDocs} aria-label="Đóng chi tiết">✕ Đóng</button>
            </div>
            {docStack.length
              ? <OfficeDocDetail doc={docStack[docStack.length - 1]} onOpen={(k) => setDocStack((st) => [...st, k])} />
              : prOpen ? <OfficeDocDetail doc={{ kind: "pr", id: prOpen }} onOpen={(k) => setDocStack([k])} actions={<ApproveBar prId={prOpen} onDone={prDone} />} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
