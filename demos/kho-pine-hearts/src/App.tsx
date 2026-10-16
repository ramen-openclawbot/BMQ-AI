import { useEffect, useMemo, useRef, useState } from "react";
import { AS_OF, GROUP_BY_CODE, PENDING, SUPPLIERS, WAREHOUSES, daysLabel, fmtDate, fmtMillion, fmtMoney, fmtNum, searchItems, startQty, suggestLabel, warehouseData, fold, type DebtRow, type Item, type PendingPr, type WarehouseId } from "./data";
import { BEAT, Room } from "./scene/Room";
import { DocDetail, type DocKey } from "./DocDetail";
import { Icon, GoodsIcon, GroveMark } from "./Icons";

type Line = { item: Item; qty: number };
type DeskPr = PendingPr & { demo?: boolean; oldDocs?: DebtRow[]; state?: "approved" | "rejected" };
const params = new URLSearchParams(location.search);
const rawTime = Number(params.get("t"));
const FROZEN = params.has("t") && Number.isFinite(rawTime) ? Math.max(0,rawTime) : null;
const START_KHO: WarehouseId = params.get("kho") === "q7" ? "q7" : "tan_tao";
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const NO_SUP = "Chưa rõ NCC";
const supOf = (item: Item) => item.supplier ?? NO_SUP;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<Room | null>(null);
  const lastTrigger = useRef<HTMLButtonElement | null>(null);
  const [wh, setWh] = useState<WarehouseId>(START_KHO);
  const [query, setQuery] = useState("");
  const [view, setView] = useState("all");
  const [tab, setTab] = useState<"stock" | "desk">("stock");
  const [open, setOpen] = useState<string | null>(null);
  const [basket, setBasket] = useState<Line[]>([]);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [desk, setDesk] = useState<DeskPr[]>(() => PENDING.map(p => ({ ...p })));
  const [prOpen, setPrOpen] = useState<string | null>(null);
  const [docStack, setDocStack] = useState<DocKey[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [modal, setModal] = useState<"animation" | "machine" | null>(FROZEN !== null ? "animation" : null);
  const [sceneError, setSceneError] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [animTime, setAnimTime] = useState(FROZEN ?? 0);
  const data = useMemo(() => warehouseData(wh), [wh]);
  const results = useMemo(() => searchItems(data.items, query), [data, query]);
  const selectedBaskets = useRef<Record<WarehouseId,{ basket: Line[]; picks: Record<string,string[]> }>>({ tan_tao: {basket:[],picks:{}},q7: {basket:[],picks:{}} });

  // Static miniature. The only playback is the explicitly requested machine opening.
  useEffect(() => {
    let room: Room;
    try {
      room = new Room(canvasRef.current!,overlayRef.current!);
      roomRef.current = room;
      room.frozen = 4.2;
      (window as unknown as { __room: Room }).__room = room;
    } catch { setSceneError(true); return; }
    const observer = new ResizeObserver(() => room.resize());
    observer.observe(canvasRef.current!.parentElement!);
    return () => { observer.disconnect(); room.dispose(); roomRef.current = null; };
  },[]);
  useEffect(() => {
    const room = roomRef.current;
    if (!room) return;
    room.setWarehouse(data,desk.length);
    room.events = [{type:"assemble",t:0}];
    room.frozen = 4.2;
    room.renderAt(4.2);
  },[data]);
  useEffect(() => {
    const room = roomRef.current;
    if (!room || modal !== "animation") return;
    room.events = [{type:"assemble",t:0}];
    if (FROZEN !== null) { room.frozen = FROZEN;room.resize();room.renderAt(FROZEN);return; }
    const start=performance.now();let raf=0;
    const frame=() => {
      const t=Math.min(BEAT.end,(performance.now()-start)/1000);
      room.frozen=t;room.renderAt(t);setAnimTime(t);
      if(t < BEAT.end) raf=requestAnimationFrame(frame);else setModal("machine");
    };
    raf=requestAnimationFrame(frame);
    return () => {cancelAnimationFrame(raf);room.frozen=4.2;room.renderAt(4.2);};
  },[modal]);
  useEffect(() => {
    if(!toast)return;
    const id=setTimeout(()=>setToast(null),2600);return()=>clearTimeout(id);
  },[toast]);
  useEffect(() => {
    const active = !!modal || !!prOpen || docStack.length>0;
    if(!active)return;
    const before=document.activeElement as HTMLElement | null;
    const previous=document.body.style.overflow;
    document.body.style.overflow="hidden";
    const id=window.setTimeout(()=>document.querySelector<HTMLElement>(".doc-modal button, .machine-dialog button, .animation-controls button")?.focus(),0);
    const key=(e:KeyboardEvent)=>{
      if(e.key==="Escape"){if(docStack.length||prOpen){setDocStack([]);setPrOpen(null);}else setModal(null);}
      if(e.key==="Tab"){
        const layer=document.querySelector(".doc-modal") ?? document.querySelector(".machine-dialog") ?? document.querySelector(".animation-controls");
        const els=Array.from(layer?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),[tabindex="0"]') ?? []).filter(el=>el.getClientRects().length);
        const first=els[0],last=els.at(-1);
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
      }
    };
    window.addEventListener("keydown",key);
    return()=>{clearTimeout(id);window.removeEventListener("keydown",key);document.body.style.overflow=previous;before?.focus();};
  },[modal,prOpen,docStack.length]);

  const switchWarehouse = (id: WarehouseId) => {
    if(id===wh || printing)return;
    selectedBaskets.current[wh]={basket,picks};
    const kept=selectedBaskets.current[id];
    setWh(id);setBasket(kept.basket);setPicks(kept.picks);
    setQuery("");setView("all");setOpen(null);setPrOpen(null);setDocStack([]);setModal(null);
    history.replaceState(null,"",`?kho=${id}`);
  };
  const goStation = (_id: string) => {}; // Walking no longer gates or decorates workbench actions.
  const openView = (v: string) => { if(v==="desk"){setTab("desk");setQuery("");setModal(null);}else if(v==="machine")setModal("machine");else{setTab("stock");setView(v);setQuery("");} };
  const startMachine = (e: React.MouseEvent<HTMLButtonElement>) => {
    lastTrigger.current=e.currentTarget;
    setAnimTime(0);setModal(REDUCED||sceneError?"machine":"animation");
  };
  const addToBasket = (item: Item) => {
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

  const bySupplier = useMemo(() => {
    const map = new Map<string, Line[]>();
    for (const line of basket) map.set(supOf(line.item), [...(map.get(supOf(line.item)) ?? []), line]);
    return [...map.entries()];
  }, [basket]);

  const printAll = () => {
    const room = roomRef.current;
    if (!basket.length || printing) return;
    setPrinting(true);
    const now = room?.now() ?? 4.2;
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
      room?.push({ type: "clear", t: room?.now() ?? 4.2 });
      setToast(`Đã gửi ${n} PR sang bàn duyệt (demo)`);
      openView("desk");
    }, doneAt);
  };

  const decide = (pr: DeskPr, ok: boolean) => {
    const room = roomRef.current;
    if (room?.stations.length) goStation("desk");
    room?.push({ type: "stamp", t: (room?.now() ?? 4.2) + 0.05, ok });
    setDesk((list) => list.map((p) => (p.id === pr.id ? { ...p, state: ok ? "approved" : "rejected" } : p)));
    setToast(ok ? `Đã duyệt ${pr.number} (demo)` : `Đã từ chối ${pr.number} (demo)`);
    setPrOpen(null);
  };

  // ---- PR detail (modal: readable width on desktop, full sheet on phones)
  const prOpenPr = desk.find((p) => p.id === prOpen) ?? null;
  const closeDocs = () => { setDocStack([]); setPrOpen(null); };
  const prActions = (pr: DeskPr) => (pr.state ? <p className={`state state-${pr.state}`}>{pr.state === "approved" ? "✓ Đã duyệt (demo)" : "✕ Đã từ chối (demo)"}</p> : (
    <div className="actions doc-actions">
      <button type="button" className="primary" onClick={() => decide(pr, true)}>✓ Duyệt chi</button>
      <button type="button" onClick={() => decide(pr, false)}>Từ chối</button>
    </div>
  ));

  // ---- render helpers
  const inBasket = new Map(basket.map((line) => [line.item.id, line.qty]));
  const total = basket.reduce((s, l) => s + (l.item.last_price ?? 0) * l.qty, 0);
  const waiting = desk.filter((p) => !p.state).length;

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

  const row = (item: Item) => {
    const g=GROUP_BY_CODE.get(item.group)!;
    const qty=inBasket.get(item.id);const isOpen=open===item.id;
    return <li key={item.id} className={`stock-row${isOpen?" expanded":""}`} data-item={item.id}>
      <div className="stock-main">
        <span className={`goods-thumb goods-${g.code}`} aria-hidden="true"><GoodsIcon group={g.code}/></span>
        <button type="button" className="item-name" aria-expanded={isOpen} onClick={()=>setOpen(isOpen?null:item.id)}>
          <b>{item.name}</b><small>{item.code ?? g.label} <span>· {supOf(item)}</span></small>
        </button>
        <div className="item-cycle"><span className={`stock-status${item.low?" low":""}`}>{daysLabel(item) ?? "Chưa dự đoán"}</span><small>{item.last_date?`Nhập gần nhất ${fmtDate(item.last_date)}`:"Chưa có phiếu nhập"}</small></div>
        <div className="item-price"><b>{item.last_price?fmtMoney(item.last_price):"—"}</b><small>/{item.last_unit ?? item.unit}</small></div>
        <button type="button" className={`add-item${qty?" added":""}`} onClick={()=>addToBasket(item)} aria-label={`Thêm ${item.name} vào máy`}><Icon name={qty?"check":"plus"}/><span>{qty?fmtNum(qty):"Thêm"}</span></button>
      </div>
      {isOpen&&<div className="row-more"><p className="facts">{item.receipts} lần nhập / 120 ngày{suggestLabel(item)?` · Gợi ý đặt ${suggestLabel(item)}`:""}. {item.low?"Dự đoán theo chu kỳ nhập, không phải số tồn kiểm kê.":"Mở phiếu cũ để kiểm tra trước khi đặt."}</p>{debtList(supOf(item),true)}</div>}
    </li>;
  };
  const list=(items:Item[])=>items.length?<ul className="stock-list">{items.map(row)}</ul>:<div className="empty-state"><Icon name="search"/><h3>Chưa tìm thấy nguyên vật liệu</h3><p>Thử tên khác, mã hàng hoặc nhà cung cấp.</p><button type="button" onClick={()=>{setQuery("");setView("all");}}>Xem tất cả</button></div>;
  const currentItems=query?results:view==="low"?data.low:view==="all"?data.items:data.groups.find(g=>g.code===view)?.items ?? [];
  const queryWords=fold(query).split(/\s+/).filter(Boolean);
  const currentPr=desk.filter(p=>queryWords.every(w=>fold(`${p.number} ${p.supplier} ${p.title??""} ${p.po_number??""} ${p.lines.map(l=>l.name).join(" ")}`).includes(w)));
  const prList=()=>currentPr.length?<ul className="pr-work-list">{currentPr.map(p=><li key={p.id}><button type="button" className="pr-work" data-pr={p.number} onClick={()=>{setDocStack([]);setPrOpen(p.id);}}><span className="pr-doc-icon"><Icon name="document"/></span><span className="pr-work-name"><b>{p.number}</b><small>{p.supplier} · {fmtDate(p.created_at)} · {p.line_count} dòng</small></span><span className="pr-work-status">{p.state==="approved"?"Đã duyệt":p.state==="rejected"?"Từ chối":"Chờ duyệt"}</span><strong>{fmtMoney(p.amount)}</strong><Icon name="chevron"/></button></li>)}</ul>:<div className="empty-state"><Icon name="document"/><h3>Không có phiếu phù hợp</h3><p>Thử số PR, PO hoặc nhà cung cấp khác.</p><button type="button" onClick={()=>setQuery("")}>Xoá tìm kiếm</button></div>;
  const machineView = () => (
    <section className="machine-view">
      {!basket.length ? <p className="empty">Máy đang trống. Kéo hàng từ kệ hoặc từ ô tìm kiếm vào phễu (hoặc bấm “+ Máy”).</p> : null}
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


  return <div className={`pine-app${modal==="animation"?" is-animating":""}`} data-demo-version="pine-workbench-v1">
    <header className="topbar"><a className="wordmark" href="/" aria-label="Kho BMQ"><GroveMark/><span>BMQ<span className="wordmark-divider">/</span> Nhà kho</span></a><span className="demo-label">BẢN CHƠI THỬ</span><span className="topbar-note"><span className="status-dot"/> Không ghi dữ liệu thật</span></header>
    <main className="workbench">
      <div className="warehouse-heading"><div><p className="breadcrumb">Nhà kho <Icon name="chevron"/> {WAREHOUSES[wh].label}</p><h1>Một ngày ở {wh==="q7"?"kho Q7":"kho Tân Tạo"}.</h1><p className="intro">Hàng ở đúng kệ. Việc ở ngay đây.</p></div><div className="warehouse-switch" role="group" aria-label="Chuyển kho">{(["tan_tao","q7"] as WarehouseId[]).map(id=><button type="button" key={id} data-kho={id} aria-pressed={id===wh} disabled={printing} onClick={()=>switchWarehouse(id)}><Icon name={id==="q7"?"oven":"warehouse"}/>{id==="q7"?"Kho Q7":"Tân Tạo"}</button>)}</div></div>
      <div className="workspace-grid">
        <section className="inventory" aria-label="Bàn kho">
          <div className="workspace-tabs" role="group" aria-label="Nội dung kho"><button type="button" aria-pressed={tab==="stock"} className={tab==="stock"?"active":""} onClick={()=>{setTab("stock");setQuery("");}}><Icon name="shelf"/> Nguyên vật liệu <span>{data.items.length}</span></button><button type="button" aria-pressed={tab==="desk"} className={tab==="desk"?"active":""} onClick={()=>{setTab("desk");setQuery("");}}><Icon name="document"/> Phiếu PR <span>{waiting}</span></button></div>
          <div className="inventory-tools"><label className="work-search"><Icon name="search"/><input value={query} onChange={e=>{setQuery(e.target.value);setOpen(null);}} placeholder={tab==="stock"?"Tìm tên hàng, mã hoặc nhà cung cấp…":"Tìm số PR, PO hoặc nhà cung cấp…"} aria-label={tab==="stock"?"Tìm nguyên vật liệu":"Tìm PR"} enterKeyHint="search"/>{query&&<button type="button" onClick={()=>setQuery("")} aria-label="Xoá tìm kiếm"><Icon name="close"/></button>}</label></div>
          {tab==="stock"&&<div className="group-filters" aria-label="Phân loại nguyên vật liệu"><button type="button" aria-pressed={view==="all"} onClick={()=>{setView("all");setQuery("");}}>Tất cả</button><button type="button" className="low-filter" aria-pressed={view==="low"} onClick={()=>{setView("low");setQuery("");}}><span className="low-dot"/>Sắp hết <b>{data.low.length}</b></button>{data.groups.map(g=><button type="button" key={g.code} data-group={g.code} aria-pressed={view===g.code} onClick={()=>{setView(g.code);setQuery("");}}>{g.label} <b>{g.items.length}</b></button>)}</div>}
          <div className="list-heading"><h2>{tab==="desk"?"Bàn phiếu PR":query?"Kết quả tìm kiếm":view==="low"?"Cần để mắt hôm nay":view==="all"?"Trên kệ nhà mình":data.groups.find(g=>g.code===view)?.label}</h2><span>{tab==="desk"?currentPr.length:currentItems.length} {tab==="desk"?"phiếu":"mặt hàng"}</span></div>
          {tab==="stock"?<><div className="table-labels"><span>NGUYÊN VẬT LIỆU</span><span>CHU KỲ NHẬP</span><span>GIÁ GẦN NHẤT</span><span/></div>{list(currentItems.slice(0,60))}{currentItems.length>60&&<p className="list-note">Đang hiện 60 / {currentItems.length} món. Chọn nhóm hoặc tìm kiếm để xem đúng hàng cần tìm.</p>}</>:prList()}
          <div className="source-note"><Icon name="info"/><span>Dữ liệu chụp ngày {fmtDate(AS_OF)}/{AS_OF.slice(0,4)}. “Sắp hết” là dự đoán chu kỳ nhập, không phải số tồn kiểm kê.</span></div>
        </section>
        <aside className="warehouse-aside" aria-label="Máy trong kho">
          <section className="machine-card"><div className="machine-title"><span className="status-dot"/> BÉ MÌ Ở {wh==="q7"?"KHO Q7":"TÂN TẠO"}<Icon name="spark"/></div>
            <div className="scene-wrap" aria-label="Mô hình kho và máy đặt hàng">
              {modal==="animation"&&<div className="animation-scrim"/>}
              <div className="scene-stage"><canvas ref={canvasRef} className="bay" aria-label="Kho minh hoạ: máy Bé Mì, kệ hàng và bàn PR"/><div ref={overlayRef} className="overlay" aria-hidden="true"/>{sceneError&&<div className="scene-fallback"><GoodsIcon group="BOT"/><span>Máy Bé Mì sẵn sàng</span></div>}</div>
              {modal==="animation"&&<div className="animation-controls" role="dialog" aria-modal="true" aria-label="Bé Mì thức dậy"><span className="animation-kicker">MÁY CỦA {WAREHOUSES[wh].label.toUpperCase()}</span><h2>{animTime<2.6?"Bé Mì đang thức dậy…":"Sẵn sàng phụ một tay."}</h2><p>Mở máy, không đổi kho. Mọi thứ đã ở đúng chỗ.</p><div className="animation-progress" aria-hidden="true"><span style={{transform:`scaleX(${animTime/BEAT.end})`}}/></div><button type="button" onClick={()=>setModal("machine")}>Bỏ qua hoạt cảnh <Icon name="chevron"/></button><button type="button" className="animation-close" onClick={()=>setModal(null)} aria-label="Đóng hoạt cảnh"><Icon name="close"/></button></div>}
            </div>
            <div className="machine-copy"><h2>Máy đặt hàng tự động</h2><p>Chọn hàng trên kệ, Bé Mì gom đơn theo nhà cung cấp.</p><button type="button" className="open-machine" onClick={startMachine} data-open-machine><Icon name="machine"/> Mở máy đặt hàng <Icon name="chevron"/></button><small>Hoạt cảnh chỉ chạy khi mở máy · có thể bỏ qua</small></div>
          </section>
          <section className="basket-summary"><div className="basket-heading"><Icon name="basket"/><h2>Khay đặt hàng</h2><span>{basket.length}</span></div>{basket.length?<><ul>{basket.slice(0,4).map(l=><li key={l.item.id}><span>{l.item.name}</span><b>{fmtNum(l.qty)} {l.item.suggest_unit??l.item.unit}</b></li>)}</ul>{basket.length>4&&<p className="basket-extra">và {basket.length-4} món khác</p>}<div className="basket-total"><span>{bySupplier.length} nhà cung cấp</span><b>{total?`~${fmtMillion(total)}`:"Chưa có giá"}</b></div><button type="button" onClick={()=>setModal("machine")}>Kiểm tra khay <Icon name="chevron"/></button></>:<div className="basket-empty"><span className="basket-empty-art"><Icon name="basket"/></span><p>Khay đang chờ món đầu tiên.</p><small>Bấm <b>+ Thêm</b> ngay trên kệ để bắt đầu.</small></div>}</section>
          <div className="field-note"><Icon name="leaf"/><p>Không cần đi vòng quanh.<br/>Chạm vào hàng để xem, thêm vào khay rồi mở máy.</p></div>
        </aside>
      </div>
    </main>
    <footer className="page-footer"><GroveMark/><span>Kho gọn, một ngày nhẹ hơn.</span><small>Demo giao diện · không tạo đơn, không chi tiền thật</small></footer>
    <div className="mobile-machine"><span><b>{basket.length?`${basket.length} món trong khay`:"Máy ở ngay trong kho"}</b><small>{WAREHOUSES[wh].label} · {bySupplier.length} NCC</small></span><button type="button" onClick={startMachine}><Icon name="machine"/>Mở máy</button></div>
    {modal==="machine"&&<div className="machine-modal" onClick={e=>{if(e.target===e.currentTarget)setModal(null);}}><section className="machine-dialog" role="dialog" aria-modal="true" aria-label="Máy đặt hàng tự động"><header><div><small>{WAREHOUSES[wh].label} · máy tại kho</small><h2>Máy đặt hàng tự động</h2></div><button type="button" aria-label="Đóng máy" onClick={()=>setModal(null)}><Icon name="close"/></button></header><div className="machine-preserved-note"><Icon name="info"/>Phần chọn phiếu cũ và gửi PR giữ nguyên từ demo trước.</div>{machineView()}{!basket.length&&<button type="button" className="return-stock" onClick={()=>{setModal(null);setTab("stock");}}>Về kệ chọn nguyên vật liệu <Icon name="chevron"/></button>}</section></div>}
    {toast&&<div className="toast" role="status">{toast}</div>}
    {docStack.length||prOpenPr?<div className="sheet-wrap doc-modal" role="dialog" aria-modal="true" aria-label="Chi tiết phiếu" onClick={e=>{if(e.target===e.currentTarget)closeDocs();}}><div className="sheet"><div className="doc-bar">{docStack.length&&(docStack.length>1||prOpenPr)?<button type="button" onClick={()=>setDocStack(st=>st.slice(0,-1))}>← Quay lại</button>:<span/>}<button type="button" onClick={closeDocs} aria-label="Đóng chi tiết">✕ Đóng</button></div>{docStack.length?<DocDetail doc={docStack[docStack.length-1]} onOpen={k=>setDocStack(st=>[...st,k])}/>:prOpenPr?<DocDetail doc={prOpenPr.demo?undefined:{kind:"pr",id:prOpenPr.id}} demo={prOpenPr.demo?prOpenPr:undefined} onOpen={k=>setDocStack([k])} actions={prActions(prOpenPr)}/>:null}</div></div>:null}
  </div>;
}
