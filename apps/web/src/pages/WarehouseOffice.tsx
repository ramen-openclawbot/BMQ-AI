import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
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
import {
  buildShelves, daysLabel, searchItems, startQty, suggestFromLast, type GroupCode, type PredictedOfficeOrderItem,
} from "@/lib/office-order";
import {
  MAX_DEBT_PICKS, packageDebtNumbers, packageSummary, rankDebtRows, robotOrderErrorCode, robotOrderErrorText, sumDebtPicks, toggleDebtPick,
  type DebtPick, type RobotOrderPackageResult, type SupplierDebtRow,
} from "@/lib/robot-order";
import { GamePicker } from "@/game/GamePicker";
import { newRequestId } from "@/game/meta";
import { loadBasket, saveBasket, type BasketLine } from "@/game/RobotDesk";
import { BEAT, FLY, Room, type RoomData, type RoomItem } from "@/game/office/Room";
import { OfficeDocDetail, type DocKey } from "@/game/office/OfficeDocDetail";
import { fmtDate, fmtMillion, fmtMoney, fmtNum } from "@/game/office/format";
import "@/game/office/office.css";

/**
 * Đặt hàng tự động — the office ordering room (owner approved the demo 16/10; 16/10 it replaced the old robot
 * desk inside the Kho 2D/3D "Đặt hàng tự động" kiosk, sharing its session basket): one fixed view of the warehouse room — no zoom, no camera moves.
 * The staff avatar walks to a shelf, the machine or the PR desk; products are dragged into the machine; each
 * product shows its supplier's old unpaid PR/PO to pay with the order; the machine sends one robot package per
 * supplier (create_robot_order_package); the desk opens PRs in full and approves / rejects through the finance flow.
 */
type Item = PredictedOfficeOrderItem;
type Line = { item: Item; qty: number; price: number | null; supplierId: string | null; supplierName: string | null };
type Drag = { item: Item; x: number; y: number; ox: number; oy: number; hot: boolean; back: boolean };
type Press = { item: Item; x0: number; y0: number; id: number; touch: boolean };
type View = "low" | "machine" | "desk" | GroupCode;

const SHELF_HEX: Record<GroupCode, string> = {
  flour: "#e8a23a", dairy_fat: "#7fb3d5", eggs: "#f6d79a", sugar_additives: "#cfc8f3", meat_filling: "#d9667a",
  cheese: "#f2c14e", vegetables: "#6f9e8b", packaging: "#d7a768", supplies: "#9aa7c7", other: "#b9b3a3",
};
const WAREHOUSES: Record<OfficeOrderLocation, { label: string; sub: string; emoji: string }> = {
  tan_tao: { label: "Kho Tân Tạo", sub: "Kho tổng · nhận mọi phiếu nhập", emoji: "🏭" },
  q7: { label: "Kho Q7", sub: "Bếp bánh ngọt", emoji: "🧁" },
};
const KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, 1], KeyW: [0, 1], ArrowDown: [0, -1], KeyS: [0, -1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
};
const NO_SUP = "__none__";
const REDUCED = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const lineUnit = (item: Item) => item.last_unit ?? item.unit ?? "";
const num = (text: string) => { const v = Number(String(text).replace(/\s/g, "").replace(",", ".")); return Number.isFinite(v) ? v : NaN; };
const toBasketLine = (l: Line): BasketLine => ({ key: l.item.id, item_id: l.item.id, name: l.item.name, unit: lineUnit(l.item), qty: String(l.qty), supplier_id: l.supplierId, price: l.price === null ? "" : String(l.price) });

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
  if (row.mark === "settled_outside") return row.mark_source === "learned" ? "đã chi ngoài hệ thống (học)" : row.mark_source === "manual" ? "đã chi ngoài hệ thống" : `Bé Mì: có thể đã chi${row.probability != null ? ` ${Math.round(row.probability * 100)}%` : ""}`;
  if (row.mark === "real_debt") return row.mark_source === "jev" ? `Bé Mì: nợ thật${row.probability != null ? ` ${Math.round(row.probability * 100)}%` : ""}` : "nợ thật";
  if (row.mark === "unsure") return "Bé Mì: chưa rõ";
  return null;
};
const suggestText = (item: Item) => {
  const s = suggestFromLast(item);
  return s ? `${fmtNum(s.qty)} ${s.unit ?? item.unit ?? ""}`.trim() : null;
};

// ---------------------------------------------------------------------------------------------------------------
// Old unpaid documents of one supplier (farthest first), with picks for the robot package. Same rules as the old
// robot desk: rows before the learned cutover fold away, rows already paid outside are faded, the last pick
// pattern is shown, and Bé Mì can review the list.
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
          <span className="num">{r.number ?? r.id.slice(0, 8)}</span>
          <span className="age">{fmtDate(r.doc_date)}{r.age_days !== null && r.age_days !== undefined ? ` · ${r.age_days} ngày` : ""}{r.has_receipt ? " · đã nhận hàng" : ""}{r.last_submission_number ? ` · đã trình ${r.last_submission_number}` : ""}{mark ? ` · ${mark}` : ""}</span>
          <b>{fmtMoney(r.remaining ?? r.amount ?? 0)}</b>
        </label>
        <button type="button" className="view" onClick={() => onView({ kind: r.kind, id: r.id })} aria-label={`Xem chi tiết ${r.number ?? ""}`} data-view={r.number ?? r.id}>Xem</button>
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
          <button type="button" className="fold" disabled={review.isPending} onClick={() => review.mutate(supplierId)} data-office-jev>{review.isPending ? "Bé Mì đang rà…" : "🤖 Bé Mì rà phiếu cũ"}</button>
          {review.data ? <small>Bé Mì xem {review.data.evaluated}, đánh dấu {review.data.marked}{review.data.stopped === "quota" ? " · hết hạn mức hôm nay" : ""}</small> : null}
          {review.error ? <small className="err">Bé Mì chưa chạy được</small> : null}
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
          <button type="button" className="ghost" onClick={() => setRejecting(false)}>Huỷ</button>
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<Room | null>(null);
  const pressRef = useRef<Press | null>(null);
  const keysRef = useRef(new Set<string>());
  const builtFor = useRef<string | null>(null);
  const requestIds = useRef(new Map<string, string>());
  // Shared session basket with the Kho 2D/3D shelves ("🤖 Đặt hàng món này"); lines of the other warehouse wait here.
  const parked = useRef<BasketLine[]>([]);
  const imported = useRef<string | null>(null);
  const [wh, setWh] = useState<OfficeOrderLocation | null>(() => {
    const kho = new URLSearchParams(window.location.search).get("kho");
    return kho === "tan_tao" || kho === "q7" ? kho : null;
  });
  const [ready, setReady] = useState(false);
  const [asmDone, setAsmDone] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("low");
  const [open, setOpen] = useState<string | null>(null);
  const [basket, setBasket] = useState<Line[]>([]);
  const [picks, setPicks] = useState<Record<string, DebtPick[]>>({});
  const [docStack, setDocStack] = useState<DocKey[]>([]);
  const [prOpen, setPrOpen] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const snapshot = useOfficeOrderSnapshot(wh ?? "tan_tao");
  const pending = usePendingPaymentRequests();
  const recent = useRecentPackages();
  const suppliers = useSuppliers();
  const create = useCreateRobotOrderPackage();
  const snap = wh && snapshot.data?.location === wh ? snapshot.data : null;

  const shelves = useMemo(() => (snap ? buildShelves(snap.items, snap.as_of) : []), [snap]);
  const items = useMemo(() => shelves.flatMap((s) => s.items), [shelves]);
  const low = useMemo(() => items.filter((i) => i.low).sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99)), [items]);
  const results = useMemo(() => (query ? (searchItems(items, query, snap?.as_of) as Item[]) : []), [items, query, snap]);
  const supplierOptions = useMemo(() => (suppliers.data ?? []).map((s) => ({ value: s.id, label: s.name })).sort((a, b) => a.label.localeCompare(b.label, "vi")), [suppliers.data]);
  const waiting = pending.data?.length ?? 0;

  // ---- scene lifecycle
  useEffect(() => {
    const room = new Room(canvasRef.current!, overlayRef.current!);
    roomRef.current = room;
    (window as unknown as { __room: Room }).__room = room; // QA hook (aims drags at the hopper)
    const onResize = () => {
      room.insetPx = window.innerWidth < 900 ? Math.round(window.innerHeight * 0.46) : 0;
      room.resize();
    };
    onResize();
    room.start();
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); room.dispose(); };
  }, []);

  // Build the room once the chosen warehouse's snapshot is in, then play the (skippable) assembly.
  useEffect(() => {
    const room = roomRef.current;
    if (!room || !wh || !snap || builtFor.current === wh) return;
    builtFor.current = wh;
    const toRoom = (i: Item): RoomItem => ({ id: i.id, name: i.name, group: i.group, low: i.low });
    const data: RoomData = {
      items: items.map(toRoom),
      groups: shelves.map((s) => ({ code: s.code, label: s.label, icon: s.icon, color: SHELF_HEX[s.code], items: s.items.map(toRoom), low: s.items.filter((i) => i.low).map(toRoom) })),
      low: low.map(toRoom),
    };
    room.setWarehouse(data, waiting);
    const t = room.now();
    room.push({ type: "assemble", t: REDUCED ? t - BEAT.end : t });
    setReady(false);
    setAsmDone(false);
    const id1 = window.setTimeout(() => setReady(true), REDUCED ? 0 : BEAT.shelves * 1000);
    const id2 = window.setTimeout(() => setAsmDone(true), REDUCED ? 0 : BEAT.end * 1000);
    return () => { window.clearTimeout(id1); window.clearTimeout(id2); };
  }, [wh, snap, items, shelves, low, waiting]);

  useEffect(() => { roomRef.current?.setDeskCount(waiting); }, [waiting]);

  // Bring in the shared basket once this warehouse's items are known; keep the rest parked.
  useEffect(() => {
    if (!wh || !snap || imported.current === wh) return;
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

  const choose = (id: OfficeOrderLocation) => {
    builtFor.current = null;
    imported.current = null;
    setWh(id);
    setView("low");
    setQuery("");
    setPicks({});
    setOpen(null);
    setPrOpen(null);
    setDocStack([]);
    setSendError(null);
  };

  const skip = () => {
    const room = roomRef.current!;
    const asm = room.events.filter((e) => e.type === "assemble").at(-1);
    if (asm && room.now() - asm.t < BEAT.end) room.push({ type: "assemble", t: room.now() - BEAT.end });
    setReady(true);
    setAsmDone(true);
  };

  // ---- walking
  const walkTo = useCallback((x: number, z: number, face: number | null = null) => {
    const room = roomRef.current!;
    const t = room.now();
    room.push({ type: "walk", t, path: room.planWalk(room.avatarAt(t), { x, z }), face });
  }, []);
  const goStation = useCallback((id: string) => {
    const room = roomRef.current!;
    const st = room.stations.find((s) => s.id === id);
    if (!st) return;
    walkTo(st.stand.x, st.stand.z, st.face);
    room.push({ type: "station", t: room.now(), id });
  }, [walkTo]);
  const openView = (v: View) => {
    setView(v);
    setQuery("");
    setOpen(null);
    setSheetOpen(true);
    if (v === "low") roomRef.current!.push({ type: "station", t: roomRef.current!.now(), id: null });
    else goStation(v);
  };

  // Arrows / WASD walk relative to the fixed view; stop on release.
  useEffect(() => {
    if (!wh) return;
    const az = 0.55;
    const update = () => {
      const room = roomRef.current!;
      let sx = 0, sy = 0;
      for (const code of keysRef.current) { const k = KEYS[code]; if (k) { sx += k[0]; sy += k[1]; } }
      const me = room.avatarAt(room.now());
      if (!sx && !sy) { room.push({ type: "walk", t: room.now(), path: new Float32Array([me.x, me.z]), face: null }); return; }
      const dx = Math.cos(az) * sx - Math.sin(az) * sy, dz = -Math.sin(az) * sx - Math.cos(az) * sy;
      const len = Math.hypot(dx, dz) || 1;
      room.push({ type: "walk", t: room.now(), path: room.planWalk(me, { x: me.x + (dx / len) * 14, z: me.z + (dz / len) * 14 }), face: null });
    };
    const down = (e: KeyboardEvent) => {
      if (!KEYS[e.code] || (e.target as HTMLElement).closest("input, textarea, [role=dialog]")) return;
      e.preventDefault();
      if (keysRef.current.has(e.code)) return;
      keysRef.current.add(e.code);
      update();
    };
    const up = (e: KeyboardEvent) => { if (keysRef.current.delete(e.code)) update(); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [wh]);

  // Walking up to a station by keys or floor clicks opens it.
  useEffect(() => {
    if (!wh || !ready) return;
    const id = window.setInterval(() => {
      const room = roomRef.current!;
      const me = room.avatarAt(room.now());
      if (me.moving || query) return;
      const near = room.stations.find((s) => Math.hypot(s.stand.x - me.x, s.stand.z - me.z) < 0.9);
      if (near && near.id !== view) {
        setView(near.id as View);
        setOpen(null);
        room.push({ type: "station", t: room.now(), id: near.id });
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [wh, ready, view, query]);

  // ---- basket + drops
  const addToBasket = (item: Item) => {
    setBasket((lines) => {
      const found = lines.find((l) => l.item.id === item.id);
      if (found) return lines.map((l) => (l.item.id === item.id ? { ...l, qty: l.qty + startQty(item) } : l));
      return [...lines, { item, qty: startQty(item), price: item.last_unit_price, supplierId: item.supplier_id, supplierName: item.supplier_name }];
    });
  };
  const dropInto = (item: Item, x: number, y: number) => {
    const room = roomRef.current!;
    room.push({ type: "drop", t: room.now(), itemId: item.id, from: room.worldFromScreen(x, y) });
    window.setTimeout(() => addToBasket(item), FLY * 1000);
  };
  const tapDrop = (item: Item, e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    dropInto(item, r.left + r.width / 2, r.top);
  };
  const pressRow = (item: Item, e: RPointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("button, input, label.pick")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const touch = e.pointerType !== "mouse";
    if (touch && !(e.target as HTMLElement).closest(".grip")) return;
    pressRef.current = { item, x0: e.clientX, y0: e.clientY, id: e.pointerId, touch };
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = pressRef.current;
      if (!p || p.id !== e.pointerId || drag) return;
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 6) {
        pressRef.current = null;
        const room = roomRef.current!;
        room.push({ type: "drag", t: room.now(), on: true });
        setDrag({ item: p.item, x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY, hot: false, back: false });
      }
    };
    const up = () => { pressRef.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
  }, [drag]);
  useEffect(() => {
    if (!drag || drag.back) return;
    const room = roomRef.current!;
    const move = (e: PointerEvent) => {
      const hot = room.machineHit(e.clientX, e.clientY);
      setDrag((d) => {
        if (!d) return d;
        if (hot !== d.hot) room.push({ type: "hover", t: room.now(), on: hot });
        return { ...d, x: e.clientX, y: e.clientY, hot };
      });
    };
    const up = (e: PointerEvent) => {
      const hot = room.machineHit(e.clientX, e.clientY);
      room.push({ type: "hover", t: room.now(), on: false });
      room.push({ type: "drag", t: room.now(), on: false });
      if (hot) { dropInto(drag.item, e.clientX, e.clientY); setDrag(null); }
      else {
        setToast("Thả trúng phễu của máy nhé");
        setDrag((d) => (d ? { ...d, back: true, x: d.ox, y: d.oy } : d));
        window.setTimeout(() => setDrag(null), 320);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.item.id, drag?.back]);

  // ---- clicks in the room
  const stageDown = useRef<{ x: number; y: number } | null>(null);
  const onStageUp = (e: RPointerEvent<HTMLElement>) => {
    const d = stageDown.current;
    stageDown.current = null;
    if (!d || !wh || !ready || drag || (e.target as HTMLElement).closest("button")) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) return;
    const hit = roomRef.current!.pick(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.kind === "shelf") openView(hit.code as GroupCode);
    else if (hit.kind === "machine") openView("machine");
    else if (hit.kind === "desk") openView("desk");
    else walkTo(hit.x, hit.z);
  };
  const onStageMove = (e: RPointerEvent<HTMLElement>) => {
    if (e.pointerType !== "mouse" || drag || !ready) return;
    const hit = roomRef.current!.pick(e.clientX, e.clientY);
    (e.currentTarget as HTMLElement).style.cursor = hit && hit.kind !== "floor" ? "pointer" : hit ? "crosshair" : "default";
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
    window.setTimeout(() => { room.push({ type: "clear", t: room.now() }); if (sentSuppliers.length === groups.length) openView("desk"); }, (0.4 + done.length * 0.45 + 0.9) * 1000);
  };

  const prDone = (text: string, ok: boolean | null) => {
    setToast(text);
    if (ok === null) return;
    const room = roomRef.current!;
    goStation("desk");
    room.push({ type: "stamp", t: room.now() + 0.05, ok });
    setPrOpen(null);
    setDocStack([]);
    queryClient.invalidateQueries({ queryKey: [OFFICE_PENDING_PAYMENT_REQUESTS_QUERY_KEY] });
  };
  const closeDocs = () => { setDocStack([]); setPrOpen(null); };

  // ---- render helpers
  const inBasket = new Map(basket.map((l) => [l.item.id, l.qty]));
  const total = basket.reduce((s, l) => s + (l.price ?? 0) * l.qty, 0);
  const setLine = (id: string, patch: Partial<Line>) => setBasket((ls) => ls.map((x) => (x.item.id === id ? { ...x, ...patch } : x)));
  const row = (item: Item) => {
    const days = item.daysLeft !== null ? daysLabel(item.daysLeft) : "";
    const qty = inBasket.get(item.id);
    const isOpen = open === item.id;
    const color = SHELF_HEX[item.group];
    const icon = shelves.find((s) => s.code === item.group)?.icon ?? "📦";
    const sug = suggestText(item);
    return (
      <li key={item.id} className={`row${item.low ? " is-low" : ""}${isOpen ? " is-open" : ""}${drag?.item.id === item.id ? " is-dragging" : ""}`} data-item={item.id}
        onPointerDown={(e) => pressRow(item, e)} style={{ ["--g" as string]: color }}>
        <div className="row-main" onClick={() => setOpen(isOpen ? null : item.id)} role="button" aria-expanded={isOpen}>
          <span className="grip" aria-label={`Kéo ${item.name} vào máy`}><i /><i /><i /></span>
          <span className="crate" aria-hidden>{icon}</span>
          <span className="info">
            <b>{item.name}</b>
            <small>{item.supplier_name ?? "Chưa rõ NCC"}{sug ? ` · lần trước ${sug}` : ""}</small>
            {wh === "tan_tao" && item.pastry_q7 ? <small className="to-q7" data-office-to-q7>🧁 Giao về Tân Tạo → tự chuyển Q7</small> : null}
          </span>
          <span className="side">
            {qty ? <em className="in">✓ ×{fmtNum(qty)}</em> : days ? <em className={`days${item.low ? " is-low" : ""}`}>{days}</em> : null}
            <button type="button" className="tap" onClick={(e) => tapDrop(item, e)} aria-label={`Bỏ ${item.name} vào máy`}>+ Máy</button>
          </span>
        </div>
        {isOpen ? (
          <div className="row-more">
            <p className="facts">
              {item.last_unit_price ? <>Giá gần nhất <b>{fmtMoney(item.last_unit_price)}/{lineUnit(item)}</b> · </> : null}
              {item.last_date ? <>nhập {fmtDate(item.last_date)} · {item.receipts} ngày nhập/120 ngày</> : "Chưa có phiếu nhập 120 ngày"}
              {days ? <> · dự đoán: {days.toLowerCase()}</> : null}
            </p>
            <DebtPicker supplierId={item.supplier_id} picks={picks[item.supplier_id ?? NO_SUP] ?? []} onToggle={(p) => togglePick(item.supplier_id ?? NO_SUP, p)} onView={(k) => setDocStack([k])} compact />
            <button type="button" className="primary wide" onClick={(e) => tapDrop(item, e)}>Bỏ vào máy ↑ {sug ? `(${sug})` : ""}</button>
          </div>
        ) : null}
      </li>
    );
  };
  const list = (rows: Item[]) => (rows.length ? <ul className="rows">{rows.map(row)}</ul> : <p className="empty">Không có món nào.</p>);

  const machineView = () => (
    <section className="machine-view">
      {!basket.length ? <p className="empty">Máy đang trống. Kéo hàng từ kệ hoặc từ ô tìm kiếm vào phễu (hoặc bấm “+ Máy”).</p> : null}
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

  const deskView = () => {
    if (pending.isLoading) return <p className="empty">Đang tải PR chờ duyệt…</p>;
    if (pending.isError) return <p className="empty err">Không tải được danh sách PR.</p>;
    const rows = pending.data ?? [];
    if (!rows.length) return <p className="empty">Không còn PR nào chờ duyệt.</p>;
    return (
      <ul className="prs">
        {rows.map((p) => (
          <li key={p.id}>
            <button type="button" className={`pr${prOpen === p.id ? " is-on" : ""}`} onClick={() => { setDocStack([]); setPrOpen(p.id); }} data-pr={p.request_number}>
              <span className="pr-top"><b>{p.request_number || p.id.slice(0, 8)}</b></span>
              <span className="pr-sup">{p.supplier_name ?? "—"} · {fmtDate(p.created_at)} · {p.item_count} dòng</span>
              <b className="pr-amt">{fmtMoney(p.total_amount ?? 0)}</b>
            </button>
          </li>
        ))}
      </ul>
    );
  };

  const shelf = shelves.find((s) => s.code === view) ?? null;
  const title = query ? `🔎 “${query}” · ${results.length}` : view === "machine" ? `🤖 Máy đặt hàng · ${basket.length} món` : view === "desk" ? `📋 Bàn duyệt PR · ${waiting} chờ duyệt` : shelf ? `${shelf.icon} Kệ ${shelf.label} · ${shelf.items.length} món` : `🔮 Sắp hết · dự đoán · ${low.length} món`;
  const loading = Boolean(wh) && !snap;

  return (
    <div className={`kvp app v2${wh ? " has-kho" : ""}${ready ? " is-ready" : ""}${drag ? " is-drag" : ""}${sheetOpen ? "" : " sheet-closed"}`} data-office-page>
      <section className="stage" onPointerDown={(e) => { stageDown.current = { x: e.clientX, y: e.clientY }; }} onPointerUp={onStageUp} onPointerMove={onStageMove}>
        <canvas ref={canvasRef} className="bay" />
        <div ref={overlayRef} className="overlay" aria-hidden />
        <header className="hud">
          <button type="button" className="chip-btn exit" onClick={() => navigate("/warehouse/game")} aria-label="Về Kho">←</button>
          <span className="logo">🤖 Đặt hàng tự động</span>
          {wh ? <button type="button" className="chip-btn" onClick={() => { builtFor.current = null; setWh(null); setReady(false); }}>{WAREHOUSES[wh].emoji} {WAREHOUSES[wh].label} · đổi</button> : null}
          {wh && snap && !asmDone ? <button type="button" className="chip-btn skip" onClick={skip}>Bỏ qua ⏭</button> : null}
          {wh && asmDone ? <span className="keys-hint">Bấm vào kệ / máy / bàn để đi · phím ← ↑ → ↓</span> : null}
        </header>
        {!wh ? (
          <div className="pick-kho">
            <h1>Chọn kho</h1>
            <p>Đi tới kệ lấy hàng, kéo vào máy, chọn phiếu cũ cần chi, tạo đơn và duyệt PR ở bàn.</p>
            <div className="kho-cards">
              {(Object.keys(WAREHOUSES) as OfficeOrderLocation[]).map((id) => (
                <button key={id} type="button" className="kho" onClick={() => choose(id)} data-kho={id}>
                  <span className="emoji">{WAREHOUSES[id].emoji}</span>
                  <b>{WAREHOUSES[id].label}</b>
                  <small>{WAREHOUSES[id].sub}</small>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {loading ? (
          <div className="pick-kho loading" role="status">
            {snapshot.isError ? <><h1>Không tải được kho</h1><p>{String((snapshot.error as Error)?.message ?? "").slice(0, 160)}</p><button type="button" className="chip-btn" onClick={() => snapshot.refetch()}>Thử lại</button></> : <><h1>Đang mở {WAREHOUSES[wh!].label}…</h1><p>Bé Mì đang đếm hàng và tính món sắp hết.</p></>}
          </div>
        ) : null}
      </section>

      {wh && snap ? (
        <aside className="panel" aria-label="Bảng thao tác">
          <div className="panel-top">
            <button type="button" className="sheet-toggle" onClick={() => setSheetOpen((v) => !v)} aria-label={sheetOpen ? "Thu gọn bảng" : "Mở bảng"}>{sheetOpen ? "⌄" : "⌃"}</button>
            <label className="search">
              <span aria-hidden>🔎</span>
              <input value={query} onChange={(e) => { setQuery(e.target.value); setOpen(null); setSheetOpen(true); }} placeholder="Tìm nguyên vật liệu…" aria-label="Tìm nguyên vật liệu" enterKeyHint="search" />
              {query ? <button type="button" onClick={() => setQuery("")} aria-label="Xoá tìm kiếm">✕</button> : null}
            </label>
            <ul className="chips" aria-label="Đi tới">
              <li><button type="button" className={`is-lowchip${view === "low" && !query ? " is-on" : ""}`} onClick={() => openView("low")}>🔮 Sắp hết <b>{low.length}</b></button></li>
              <li><button type="button" className={`is-machine${view === "machine" && !query ? " is-on" : ""}`} onClick={() => openView("machine")} data-station="machine">🤖 Máy <b>{basket.length}</b></button></li>
              <li><button type="button" className={`is-desk${view === "desk" && !query ? " is-on" : ""}`} onClick={() => openView("desk")} data-station="desk">📋 Duyệt PR <b>{waiting}</b></button></li>
              {shelves.map((s) => (
                <li key={s.code}><button type="button" className={view === s.code && !query ? "is-on" : undefined} onClick={() => openView(s.code)} style={{ ["--g" as string]: SHELF_HEX[s.code] }} data-group={s.code}>{s.icon} {s.label} <b>{s.items.length}</b></button></li>
              ))}
            </ul>
          </div>
          <div className="panel-body">
            <h2>{title}</h2>
            {query ? list(results)
              : view === "machine" ? machineView()
              : view === "desk" ? deskView()
              : shelf ? list(shelf.items)
              : <>{list(low)}<p className="note">Dự đoán theo chu kỳ nhập 120 ngày gần nhất. Kho chưa kiểm kê nên chưa dùng số tồn.</p></>}
          </div>
          <footer className="basket">
            <span>🧺 <b>{basket.length}</b> món · {bySupplier.length} NCC{total ? ` · ~${fmtMillion(total)}` : ""}</span>
            <button type="button" disabled={!basket.length} onClick={() => openView("machine")}>Chọn PR & đặt →</button>
          </footer>
        </aside>
      ) : null}

      {drag ? (
        <div className={`ghost${drag.hot ? " is-hot" : ""}${drag.back ? " is-back" : ""}`} style={{ transform: `translate(${drag.x}px, ${drag.y}px)`, ["--g" as string]: SHELF_HEX[drag.item.group] }}>
          <span className="crate">{shelves.find((s) => s.code === drag.item.group)?.icon ?? "📦"}</span>
          <b>{drag.item.name}</b>
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
              ? <OfficeDocDetail doc={docStack[docStack.length - 1]} />
              : prOpen ? <OfficeDocDetail doc={{ kind: "pr", id: prOpen }} actions={<ApproveBar prId={prOpen} onDone={prDone} />} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
