import { useEffect, useMemo, useRef, useState } from "react";
import { AS_OF, GROUP_BY_CODE, PENDING, SUPPLIERS, WAREHOUSES, daysLabel, fmtDate, fmtMillion, fmtMoney, fmtNum, searchItems, startQty, suggestLabel, warehouseData, fold, type DebtRow, type Item, type PendingPr, type WarehouseId } from "./data";
import { BEAT, Room } from "./scene/Room";
import { DocDetail, type DocKey } from "./DocDetail";
import { Icon, GoodsIcon, GroveMark } from "./Icons";

/**
 * Kho BMQ — a warehouse you play in. The 3D room is the screen: shelves, the PR desk and the Bé Mì
 * machine are the things you touch. The notebook (side board / bottom sheet) shows what you touched.
 * The ordering flow inside the machine (basket, old receipts, print, approve) is retained from the
 * earlier demo unchanged.
 */
type Line = { item: Item; qty: number };
type DeskPr = PendingPr & { demo?: boolean; oldDocs?: DebtRow[]; state?: "approved" | "rejected" };
type Spot = { kind: "shelf"; code: string } | { kind: "desk" } | { kind: "low" };

const params = new URLSearchParams(location.search);
const rawTime = Number(params.get("t"));
const FROZEN = params.has("t") && Number.isFinite(rawTime) ? Math.max(0, rawTime) : null;
const START_KHO: WarehouseId = params.get("kho") === "q7" ? "q7" : "tan_tao";
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const NO_SUP = "Chưa rõ NCC";
const supOf = (item: Item) => item.supplier ?? NO_SUP;
const isPhone = () => window.innerWidth < 900;
const IDLE_START = -20; // the machine is already built when you walk in; the build plays only when you open it

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLElement>(null);
  const roomRef = useRef<Room | null>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const machineHot = useRef(false);
  const [wh, setWh] = useState<WarehouseId>(START_KHO);
  const [query, setQuery] = useState("");
  const [spot, setSpot] = useState<Spot>({ kind: "low" });
  const [open, setOpen] = useState<string | null>(null);
  const [basket, setBasket] = useState<Line[]>([]);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [desk, setDesk] = useState<DeskPr[]>(() => PENDING.map((p) => ({ ...p })));
  const [prOpen, setPrOpen] = useState<string | null>(null);
  const [docStack, setDocStack] = useState<DocKey[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [modal, setModal] = useState<"animation" | "machine" | null>(FROZEN !== null ? "animation" : null);
  const [sceneError, setSceneError] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [animTime, setAnimTime] = useState(FROZEN ?? 0);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [hover, setHover] = useState<{ label: string; sub: string; x: number; y: number } | null>(null);
  const [ready, setReady] = useState(false);
  const data = useMemo(() => warehouseData(wh), [wh]);
  const results = useMemo(() => searchItems(data.items, query), [data, query]);
  const kept = useRef<Record<WarehouseId, { basket: Line[]; picks: Record<string, string[]> }>>({ tan_tao: { basket: [], picks: {} }, q7: { basket: [], picks: {} } });
  const waiting = desk.filter((p) => !p.state).length;

  // ---- the room: live idle (breathing, blinking bulbs), frozen for ?t= stills and reduced motion
  useEffect(() => {
    let room: Room;
    try {
      room = new Room(canvasRef.current!, overlayRef.current!);
      roomRef.current = room;
      (window as unknown as { __room: Room }).__room = room;
    } catch { setSceneError(true); setReady(true); return; }
    room.events = [{ type: "assemble", t: FROZEN !== null ? 0 : IDLE_START }];
    if (FROZEN !== null) room.frozen = FROZEN;
    else if (REDUCED) room.frozen = 40;
    const sync = () => {
      room.insetPx = isPhone() && boardRef.current ? Math.round(boardRef.current.getBoundingClientRect().height) : 0;
      room.resize();
    };
    sync();
    room.start();
    const observer = new ResizeObserver(sync);
    observer.observe(canvasRef.current!.parentElement!);
    if (boardRef.current) observer.observe(boardRef.current);
    setReady(true);
    return () => { observer.disconnect(); room.dispose(); roomRef.current = null; };
  }, []);
  useEffect(() => {
    const room = roomRef.current;
    if (!room) return;
    room.setWarehouse(data, desk.filter((p) => !p.state).length);
    if (room.frozen !== null) room.renderAt(room.frozen);
  }, [data]);
  // Opening the machine: the build-up scene plays in place, then the ordering panel opens.
  useEffect(() => {
    const room = roomRef.current;
    if (!room || modal !== "animation") return;
    if (FROZEN !== null) { room.events = [{ type: "assemble", t: 0 }]; room.frozen = FROZEN; room.resize(); room.renderAt(FROZEN); return; }
    const t0 = room.now();
    room.events = [...room.events.filter((ev) => ev.type !== "assemble"), { type: "assemble", t: t0 }];
    let raf = 0;
    const tick = () => {
      const t = Math.min(BEAT.end, room.now() - t0);
      setAnimTime(t);
      if (t < BEAT.end) raf = requestAnimationFrame(tick); else setModal("machine");
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [modal]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const active = !!modal || !!prOpen || docStack.length > 0;
    if (!active) return;
    const before = document.activeElement as HTMLElement | null;
    const id = window.setTimeout(() => document.querySelector<HTMLElement>(".doc-modal button, .machine-dialog button, .wake button")?.focus(), 0);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { if (docStack.length || prOpen) { setDocStack([]); setPrOpen(null); } else closeModal(); }
      if (e.key === "Tab") {
        const layer = document.querySelector(".doc-modal") ?? document.querySelector(".machine-dialog") ?? document.querySelector(".wake");
        const els = Array.from(layer?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),[tabindex="0"]') ?? []).filter((el) => el.getClientRects().length);
        const first = els[0], last = els.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", key);
    return () => { clearTimeout(id); window.removeEventListener("keydown", key); before?.focus(); };
  }, [modal, prOpen, docStack.length]);

  // ---- quest progress (today's play): low items into the basket, PRs decided
  const inBasket = new Map(basket.map((line) => [line.item.id, line.qty]));
  const lowDone = data.low.filter((item) => inBasket.has(item.id)).length;
  const decided = desk.filter((p) => p.state).length;
  const prevLowDone = useRef(0);
  useEffect(() => {
    if (data.low.length && lowDone === data.low.length && prevLowDone.current < lowDone) setToast("🎉 Mọi món sắp hết đã vào khay. Mở máy để gửi PR.");
    prevLowDone.current = lowDone;
  }, [lowDone, data.low.length]);

  const closeModal = () => {
    const room = roomRef.current;
    if (room && room.frozen === null) room.events = [...room.events.filter((ev) => ev.type !== "assemble"), { type: "assemble", t: room.now() + IDLE_START }];
    setModal(null);
  };
  const switchWarehouse = (id: WarehouseId) => {
    if (id === wh || printing) return;
    kept.current[wh] = { basket, picks };
    const next = kept.current[id];
    setWh(id); setBasket(next.basket); setPicks(next.picks);
    setQuery(""); setSpot({ kind: "low" }); setOpen(null); setPrOpen(null); setDocStack([]); setModal(null); setHover(null);
    roomRef.current?.push({ type: "clear", t: roomRef.current.now() });
    history.replaceState(null, "", `?kho=${id}`);
  };
  const choose = (next: Spot) => {
    const room = roomRef.current;
    setSpot(next); setQuery(""); setOpen(null); setSheetOpen(true);
    room?.push({ type: "station", t: room.now(), id: next.kind === "shelf" ? next.code : next.kind });
  };
  const startMachine = () => {
    if (modal) return;
    setAnimTime(0); setHover(null); setSheetOpen(false);
    setModal(REDUCED || sceneError ? "machine" : "animation");
  };
  const skipScene = () => {
    const room = roomRef.current;
    if (room && room.frozen === null) room.events = [...room.events.filter((ev) => ev.type !== "assemble"), { type: "assemble", t: room.now() + IDLE_START }];
    setModal("machine");
  };
  const addToBasket = (item: Item) => {
    const room = roomRef.current;
    if (room) room.push({ type: "drop", t: room.now(), itemId: item.id, from: room.itemFrom(item.id, item.group) });
    setBasket((lines) => {
      const found = lines.find((line) => line.item.id === item.id);
      if (found) return lines.map((line) => (line.item.id === item.id ? { ...line, qty: line.qty + startQty(item) } : line));
      return [...lines, { item, qty: startQty(item) }];
    });
  };
  const togglePick = (sup: string, id: string) => {
    setPicks((p) => {
      const cur = new Set(p[sup] ?? []);
      if (cur.has(id)) cur.delete(id); else cur.add(id);
      return { ...p, [sup]: [...cur] };
    });
  };

  // ---- touching the room
  const hitAt = (x: number, y: number) => roomRef.current?.pick(x, y) ?? null;
  const onStageMove = (e: React.PointerEvent) => {
    const room = roomRef.current;
    if (!room || modal || e.pointerType === "touch") return;
    const hit = hitAt(e.clientX, e.clientY);
    const code = hit?.kind === "shelf" ? hit.code : null;
    room.hoverShelf = code;
    const hot = hit?.kind === "machine";
    if (hot !== machineHot.current) { machineHot.current = hot; room.push({ type: "hover", t: room.now(), on: hot }); }
    let next: typeof hover = null;
    if (code) {
      const g = data.groups.find((x) => x.code === code);
      const p = room.shelfScreen(code);
      if (g && p) next = { label: `${g.icon} ${g.label}`, sub: `${g.items.length} món${g.low.length ? ` · ${g.low.length} sắp hết` : ""} · chạm để xem`, x: p.x, y: p.y };
    } else if (hit?.kind === "desk") { const p = room.deskPoint(); next = { label: "📋 Bàn duyệt PR", sub: `${waiting} phiếu chờ · chạm để xem`, x: p.x, y: p.y }; }
    else if (hit?.kind === "machine") { const p = room.machineScreen(); next = { label: "🤖 Bé Mì · máy đặt hàng", sub: basket.length ? `${basket.length} món trong khay · chạm để mở` : "chạm để mở máy", x: p.x, y: p.y }; }
    setHover((h) => (h?.label === next?.label && h?.x === next?.x ? h : next));
    if (room.frozen !== null) room.renderAt(room.frozen);
  };
  const onStageLeave = () => {
    const room = roomRef.current;
    if (room) { room.hoverShelf = null; if (machineHot.current) { machineHot.current = false; room.push({ type: "hover", t: room.now(), on: false }); } }
    setHover(null);
  };
  const onStageDown = (e: React.PointerEvent) => { press.current = { x: e.clientX, y: e.clientY }; };
  const onStageUp = (e: React.PointerEvent) => {
    const p = press.current; press.current = null;
    if (!p || modal || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) return;
    const hit = hitAt(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.kind === "shelf") choose({ kind: "shelf", code: hit.code });
    else if (hit.kind === "desk") choose({ kind: "desk" });
    else if (hit.kind === "machine") startMachine();
  };

  // ---- ordering flow inside the machine (retained)
  const bySupplier = useMemo(() => {
    const map = new Map<string, Line[]>();
    for (const line of basket) map.set(supOf(line.item), [...(map.get(supOf(line.item)) ?? []), line]);
    return [...map.entries()];
  }, [basket]);
  const printAll = () => {
    const room = roomRef.current;
    if (!basket.length || printing) return;
    setPrinting(true);
    const now = room?.now() ?? 0;
    const n = bySupplier.length;
    room?.push({ type: "print", t: now, slips: Math.min(10, n) });
    const made: DeskPr[] = bySupplier.map(([sup, lines], i) => {
      const old = (SUPPLIERS[sup]?.rows ?? []).filter((r) => (picks[sup] ?? []).includes(r.id));
      const linesTotal = lines.reduce((s, l) => s + (l.item.last_price ?? 0) * l.qty, 0);
      return {
        id: `demo-${Date.now()}-${i}`, number: `PR-DEMO-${String(desk.filter((p) => p.demo).length + i + 1).padStart(2, "0")}`, title: "Robot đặt hàng (demo)", supplier: sup,
        amount: Math.round(linesTotal + old.reduce((s, r) => s + r.remaining, 0)), created_at: AS_OF, po_number: null, has_receipt: false, line_count: lines.length,
        lines: lines.map((l) => ({ name: l.item.name, qty: l.qty, unit: l.item.suggest_unit ?? l.item.unit, price: l.item.last_price, total: l.item.last_price ? l.item.last_price * l.qty : null })),
        demo: true, oldDocs: old,
      };
    });
    const doneAt = (0.4 + n * 0.45 + 0.9) * 1000;
    window.setTimeout(() => {
      setPrinting(false);
      setDesk((list) => [...made, ...list]);
      setBasket([]);
      setPicks({});
      room?.push({ type: "clear", t: room?.now() ?? 0 });
      setToast(`🖨️ Đã gửi ${n} PR sang bàn duyệt (demo)`);
      closeModal();
      choose({ kind: "desk" });
    }, doneAt);
  };
  const decide = (pr: DeskPr, ok: boolean) => {
    const room = roomRef.current;
    room?.push({ type: "stamp", t: (room?.now() ?? 0) + 0.05, ok });
    setDesk((list) => list.map((p) => (p.id === pr.id ? { ...p, state: ok ? "approved" : "rejected" } : p)));
    setToast(ok ? `✓ Đã duyệt ${pr.number} (demo)` : `✕ Đã từ chối ${pr.number} (demo)`);
    setPrOpen(null);
  };
  const prOpenPr = desk.find((p) => p.id === prOpen) ?? null;
  const closeDocs = () => { setDocStack([]); setPrOpen(null); };
  const prActions = (pr: DeskPr) => (pr.state ? <p className={`state state-${pr.state}`}>{pr.state === "approved" ? "✓ Đã duyệt (demo)" : "✕ Đã từ chối (demo)"}</p> : (
    <div className="actions doc-actions">
      <button type="button" className="primary" onClick={() => decide(pr, true)}>✓ Duyệt chi</button>
      <button type="button" onClick={() => decide(pr, false)}>Từ chối</button>
    </div>
  ));
  const total = basket.reduce((s, l) => s + (l.item.last_price ?? 0) * l.qty, 0);

  const debtList = (sup: string, compact = false) => {
    const debt = SUPPLIERS[sup];
    if (!debt || !debt.count) return <p className="debt-none">✓ {sup === NO_SUP ? "Chưa rõ NCC" : `${sup} không còn phiếu cũ chưa chi`}</p>;
    const chosen = picks[sup] ?? [];
    const sum = debt.rows.filter((r) => chosen.includes(r.id)).reduce((s, r) => s + r.remaining, 0);
    const lag = debt.stats.median_lag_days;
    return (
      <div className="debt">
        <div className="debt-head">
          <b>Phiếu cũ chưa chi · {debt.count}</b>
          <small>{fmtMillion(debt.total)}{lag !== null && lag !== undefined ? ` · thường trả sau ~${Math.round(lag)} ngày` : ""}</small>
        </div>
        <ul>
          {debt.rows.slice(0, compact ? 3 : 8).map((r) => (
            <li key={r.id}>
              <label className="pick">
                <input type="checkbox" checked={chosen.includes(r.id)} onChange={() => togglePick(sup, r.id)} />
                <span className={`kind kind-${r.kind}`}>{r.kind.toUpperCase()}</span>
                <span className="num">{r.number}</span>
                <span className="age">{fmtDate(r.doc_date)} · {r.age_days} ngày</span>
                <b>{fmtMoney(r.remaining)}</b>
              </label>
              <button type="button" className="view" onClick={() => setDocStack([{ kind: r.kind, id: r.id }])} aria-label={`Xem chi tiết ${r.number}`} data-view={r.number}>Xem</button>
            </li>
          ))}
        </ul>
        {debt.count > (compact ? 3 : 8) ? <small className="more">+{debt.count - (compact ? 3 : 8)} phiếu mới hơn{compact ? " · xem đủ ở Máy" : ""}</small> : null}
        <small className="sum">{chosen.length ? `Chi kèm ${chosen.length} phiếu · ${fmtMoney(sum)}` : "Chưa chọn phiếu cũ: chỉ chi đơn mới"}</small>
      </div>
    );
  };
  const machineView = () => (
    <section className="machine-view">
      {!basket.length ? <p className="empty">Máy đang trống. Chạm vào kệ trong kho rồi bấm “+ Thêm” để cho hàng vào khay.</p> : null}
      {bySupplier.map(([sup, lines]) => {
        const sum = lines.reduce((s, l) => s + (l.item.last_price ?? 0) * l.qty, 0);
        return (
          <article key={sup} className="sup-card">
            <h3>{sup}<small>{sum ? fmtMoney(sum) : "chưa có giá"}</small></h3>
            <ul className="lines">
              {lines.map((l) => (
                <li key={l.item.id}>
                  <span>{l.item.name}</span>
                  <span className="qty">
                    <button type="button" aria-label="Giảm" onClick={() => setBasket((ls) => ls.map((x) => (x.item.id === l.item.id ? { ...x, qty: Math.max(0, +(x.qty - startQty(x.item) / 4).toFixed(3)) } : x)).filter((x) => x.qty > 0))}>−</button>
                    <b>{fmtNum(l.qty)} {l.item.suggest_unit ?? l.item.unit}</b>
                    <button type="button" aria-label="Tăng" onClick={() => setBasket((ls) => ls.map((x) => (x.item.id === l.item.id ? { ...x, qty: +(x.qty + startQty(x.item) / 4).toFixed(3) } : x)))}>+</button>
                  </span>
                </li>
              ))}
            </ul>
            {debtList(sup)}
          </article>
        );
      })}
      {basket.length ? (
        <button type="button" className="primary wide big" onClick={printAll} disabled={printing}>{printing ? "Đang in phiếu…" : `In phiếu & gửi ${bySupplier.length} PR sang bàn duyệt`}</button>
      ) : null}
    </section>
  );

  // ---- the notebook (board): what you touched in the room
  const card = (item: Item) => {
    const g = GROUP_BY_CODE.get(item.group)!;
    const qty = inBasket.get(item.id); const isOpen = open === item.id;
    return <li key={item.id} className={`card${isOpen ? " is-open" : ""}${item.low ? " is-low" : ""}`} data-item={item.id} style={{ ["--g" as string]: g.color }}>
      <div className="card-main">
        <span className={`crate goods-${g.code}`} aria-hidden="true"><GoodsIcon group={g.code} /></span>
        <button type="button" className="name" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : item.id)}>
          <b>{item.name}</b><small>{item.code ?? g.label} · {supOf(item)}</small>
          <span className={`pill${item.low ? " low" : ""}`}>{daysLabel(item) ?? "Chưa dự đoán"}</span>
        </button>
        <button type="button" className={`add${qty ? " added" : ""}`} onClick={() => addToBasket(item)} aria-label={`Thêm ${item.name} vào máy`}><Icon name={qty ? "check" : "plus"} /><span>{qty ? fmtNum(qty) : "Thêm"}</span></button>
      </div>
      {isOpen && <div className="card-more">
        <p className="facts"><b>{item.last_price ? `${fmtMoney(item.last_price)}/${item.last_unit ?? item.unit}` : "Chưa có giá"}</b> · {item.last_date ? `nhập gần nhất ${fmtDate(item.last_date)}` : "chưa có phiếu nhập"} · {item.receipts} lần nhập / 120 ngày{suggestLabel(item) ? ` · gợi ý đặt ${suggestLabel(item)}` : ""}.</p>
        {debtList(supOf(item), true)}
      </div>}
    </li>;
  };
  const emptyItems = (title: string, text: string) => <div className="empty-state"><Icon name="search" /><h3>{title}</h3><p>{text}</p><button type="button" onClick={() => { setQuery(""); setSpot({ kind: "low" }); }}>Về việc hôm nay</button></div>;
  const queryWords = fold(query).split(/\s+/).filter(Boolean);
  const prMatches = desk.filter((p) => queryWords.every((w) => fold(`${p.number} ${p.supplier} ${p.title ?? ""} ${p.po_number ?? ""} ${p.lines.map((l) => l.name).join(" ")}`).includes(w)));
  const prList = (list: DeskPr[]) => list.length ? <ul className="pr-list">{list.map((p) => <li key={p.id}><button type="button" className={`pr-row${p.state ? ` is-${p.state}` : ""}`} data-pr={p.number} onClick={() => { setDocStack([]); setPrOpen(p.id); }}><span className="pr-icon"><Icon name="document" /></span><span className="pr-name"><b>{p.number}{p.demo && <em className="new">MỚI</em>}</b><small>{p.supplier} · {fmtDate(p.created_at)} · {p.line_count} dòng</small></span><span className="pr-side"><strong>{fmtMoney(p.amount)}</strong><span className={`pill${p.state ? ` ${p.state}` : ""}`}>{p.state === "approved" ? "Đã duyệt" : p.state === "rejected" ? "Từ chối" : "Chờ duyệt"}</span></span></button></li>)}</ul> : <div className="empty-state"><Icon name="document" /><h3>Không có phiếu phù hợp</h3><p>Thử số PR, PO hoặc nhà cung cấp khác.</p><button type="button" onClick={() => setQuery("")}>Xoá tìm kiếm</button></div>;

  const shelf = spot.kind === "shelf" ? data.groups.find((g) => g.code === spot.code) : null;
  let heading: React.ReactNode; let body: React.ReactNode;
  if (query) {
    if (spot.kind === "desk" && (prMatches.length || !results.length)) { heading = <><span className="head-icon">📋</span><div><b>Tìm phiếu PR</b><small>{prMatches.length} phiếu khớp “{query}”</small></div></>; body = prList(prMatches); }
    else { heading = <><span className="head-icon">🔍</span><div><b>Tìm trong kho</b><small>{results.length} món khớp “{query}”{prMatches.length ? ` · ${prMatches.length} PR` : ""}</small></div></>; body = results.length ? <ul className="cards">{results.map(card)}</ul> : emptyItems("Chưa tìm thấy", "Thử tên khác, mã hàng hoặc nhà cung cấp."); }
  } else if (spot.kind === "desk") {
    heading = <><span className="head-icon">📋</span><div><b>Bàn duyệt PR</b><small>{waiting} phiếu chờ · {decided} đã xử lý</small></div></>;
    body = prList(desk);
  } else if (shelf) {
    heading = <><span className="head-icon" style={{ background: shelf.color }}>{shelf.icon}</span><div><b>Kệ {shelf.label}</b><small>{shelf.items.length} món{shelf.low.length ? ` · ${shelf.low.length} sắp hết` : " · đủ hàng"}</small></div></>;
    body = <ul className="cards">{[...shelf.low, ...shelf.items.filter((i) => !i.low)].slice(0, 60).map(card)}</ul>;
  } else {
    heading = <><span className="head-icon">☀️</span><div><b>Việc hôm nay</b><small>{data.low.length ? `${data.low.length} món dự đoán sắp hết` : "Kho ổn, chưa có món sắp hết"}</small></div></>;
    body = data.low.length ? <ul className="cards">{data.low.map(card)}</ul> : <div className="empty-state"><Icon name="leaf" /><h3>Kệ đang đầy</h3><p>Chạm vào một kệ trong kho để xem hàng.</p></div>;
  }

  const questPct = data.low.length ? Math.round((lowDone / data.low.length) * 100) : 100;
  const board = (
    <aside ref={boardRef} className={`board${sheetOpen ? "" : " is-closed"}`} aria-label="Sổ kho">
      <div className="board-top">
        <button type="button" className="handle" onClick={() => setSheetOpen((v) => !v)} aria-expanded={sheetOpen} aria-label={sheetOpen ? "Thu gọn sổ kho" : "Mở sổ kho"}><span /></button>
        <div className="quest" aria-label="Tiến độ hôm nay">
          <div className="quest-row"><span>🔮 Sắp hết vào khay</span><b data-quest-low>{lowDone}/{data.low.length}</b></div>
          <div className="quest-bar" aria-hidden="true"><span style={{ width: `${questPct}%` }} /></div>
          <div className="quest-row"><span>📋 PR đã xử lý</span><b data-quest-pr>{decided}/{desk.length}</b></div>
        </div>
        <label className="search"><Icon name="search" /><input value={query} onChange={(e) => { setQuery(e.target.value); setOpen(null); }} placeholder={spot.kind === "desk" ? "Tìm số PR, PO, nhà cung cấp…" : "Tìm hàng, mã hoặc nhà cung cấp…"} aria-label="Tìm trong kho" enterKeyHint="search" onFocus={() => setSheetOpen(true)} />{query && <button type="button" onClick={() => setQuery("")} aria-label="Xoá tìm kiếm"><Icon name="close" /></button>}</label>
        <div className="chips" role="group" aria-label="Kệ trong kho">
          <button type="button" className="chip low" aria-pressed={spot.kind === "low" && !query} onClick={() => choose({ kind: "low" })}>☀️ Hôm nay <b>{data.low.length}</b></button>
          {data.groups.map((g) => <button type="button" key={g.code} className="chip" data-group={g.code} style={{ ["--g" as string]: g.color }} aria-pressed={spot.kind === "shelf" && spot.code === g.code && !query} onClick={() => choose({ kind: "shelf", code: g.code })}>{g.icon} {g.label} <b>{g.items.length}</b></button>)}
          <button type="button" className="chip desk" aria-pressed={spot.kind === "desk" && !query} onClick={() => choose({ kind: "desk" })}>📋 Phiếu PR <b>{waiting}</b></button>
        </div>
      </div>
      <div className="board-body">
        <div className="board-head">{heading}</div>
        {body}
        <p className="source-note">Dữ liệu chụp ngày {fmtDate(AS_OF)}/{AS_OF.slice(0, 4)}. “Sắp hết” là dự đoán theo chu kỳ nhập, không phải số tồn kiểm kê.</p>
      </div>
      <div className="basket-bar">
        <span className="basket-info"><Icon name="basket" /><span>{basket.length ? <><b>{basket.length} món</b> · {bySupplier.length} NCC{total ? ` · ~${fmtMillion(total)}` : ""}</> : <><b>Khay trống</b> · chạm kệ để thêm hàng</>}</span></span>
        <button type="button" className="open-machine" onClick={startMachine} data-open-machine><Icon name="machine" /> Mở máy</button>
      </div>
    </aside>
  );

  return <div className={`game${modal === "animation" ? " is-animating" : ""}${ready ? " is-ready" : ""}`} data-demo-version="pine-game-v2">
    <section className="stage" onPointerMove={onStageMove} onPointerLeave={onStageLeave} onPointerDown={onStageDown} onPointerUp={onStageUp} onPointerCancel={() => { press.current = null; }}>
      <canvas ref={canvasRef} className="bay" aria-label="Kho minh hoạ: kệ hàng, bàn duyệt PR và máy Bé Mì. Chạm vào kệ để xem hàng, chạm máy để đặt hàng." />
      <div ref={overlayRef} className="overlay" aria-hidden="true" />
      {sceneError && <div className="scene-fallback"><GoodsIcon group="flour" /><span>Không mở được mô hình 3D. Dùng các kệ bên dưới.</span></div>}
      {hover && !modal && <div className="world-tag" style={{ left: hover.x, top: hover.y }} aria-hidden="true"><b>{hover.label}</b><small>{hover.sub}</small></div>}
      <header className="hud">
        <a className="wordmark" href="/" aria-label="Kho BMQ"><GroveMark /><span>BMQ<i>/</i>Nhà kho</span><em>BẢN CHƠI THỬ</em></a>
        <div className="kho-tabs" role="group" aria-label="Chuyển kho">{(["tan_tao", "q7"] as WarehouseId[]).map((id) => <button type="button" key={id} data-kho={id} aria-pressed={id === wh} disabled={printing} onClick={() => switchWarehouse(id)}><Icon name={id === "q7" ? "oven" : "warehouse"} />{id === "q7" ? "Kho Q7" : "Tân Tạo"}</button>)}</div>
        <span className="hud-note">Không ghi dữ liệu thật</span>
      </header>
      <p className="stage-hint"><Icon name="leaf" /> Chạm kệ để xem hàng · chạm bàn để duyệt PR · chạm Bé Mì để đặt hàng</p>
      {modal === "animation" && <div className="wake" role="dialog" aria-modal="true" aria-label="Bé Mì thức dậy"><span className="kicker">MÁY CỦA {WAREHOUSES[wh].label.toUpperCase()}</span><h2>{animTime < 2.6 ? "Bé Mì đang thức dậy…" : "Sẵn sàng phụ một tay."}</h2><div className="wake-progress" aria-hidden="true"><span style={{ transform: `scaleX(${animTime / BEAT.end})` }} /></div><div className="wake-actions"><button type="button" onClick={skipScene}>Bỏ qua hoạt cảnh <Icon name="chevron" /></button><button type="button" className="quiet" onClick={closeModal}>Đóng</button></div></div>}
    </section>
    {board}
    {modal === "machine" && <div className="machine-modal" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}><section className="machine-dialog" role="dialog" aria-modal="true" aria-label="Máy đặt hàng tự động"><header><div><small>{WAREHOUSES[wh].label} · máy tại kho</small><h2>Máy đặt hàng tự động</h2></div><button type="button" aria-label="Đóng máy" onClick={closeModal}><Icon name="close" /></button></header><div className="machine-preserved-note"><Icon name="info" />Phần chọn phiếu cũ và gửi PR giữ nguyên từ demo trước.</div>{machineView()}{!basket.length && <button type="button" className="return-stock" onClick={closeModal}>Về kho chọn hàng <Icon name="chevron" /></button>}</section></div>}
    {toast && <div className="toast" role="status">{toast}</div>}
    {docStack.length || prOpenPr ? <div className="sheet-wrap doc-modal" role="dialog" aria-modal="true" aria-label="Chi tiết phiếu" onClick={(e) => { if (e.target === e.currentTarget) closeDocs(); }}><div className="sheet"><div className="doc-bar">{docStack.length && (docStack.length > 1 || prOpenPr) ? <button type="button" onClick={() => setDocStack((st) => st.slice(0, -1))}>← Quay lại</button> : <span />}<button type="button" onClick={closeDocs} aria-label="Đóng chi tiết">✕ Đóng</button></div>{docStack.length ? <DocDetail doc={docStack[docStack.length - 1]} onOpen={(k) => setDocStack((st) => [...st, k])} /> : prOpenPr ? <DocDetail doc={prOpenPr.demo ? undefined : { kind: "pr", id: prOpenPr.id }} demo={prOpenPr.demo ? prOpenPr : undefined} onOpen={(k) => setDocStack([k])} actions={prActions(prOpenPr)} /> : null}</div></div> : null}
  </div>;
}
