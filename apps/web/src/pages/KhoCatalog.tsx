import { LoadingState } from "@/components/ui/loading";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CalendarClock, FileText, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useKhoItems } from "@/hooks/useKhoItems";
import { useKhoCommitments } from "@/hooks/useKhoCommitments";
import { useExpiryOverview } from "@/hooks/useKhoLots";
import { expiryTone, type ExpiryOverviewRow } from "@/lib/kho-lots";
import { commitmentByItem, commitmentBySku, dayLabel } from "@/lib/kho-commitments";
import { useWarehouseGameSnapshot, WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "@/hooks/useWarehouseGame";
import { filterItems, khoErrorText, searchKey, type KhoItem, type KhoLocation } from "@/lib/kho-items";
import type { WarehouseGamePendingRow, WarehouseGameSku } from "@/lib/warehouse-game";
import { cn } from "@/lib/utils";
import { GROUPS, KHO_LABEL, KHO_LOCATIONS, atKho, crateKey, fmtAmount, groupOf, newRequestId, type Group } from "@/components/kho/kho-meta";
import { useKhoConfirm } from "@/components/kho/KhoConfirm";
import { ItemDialog } from "@/components/kho/ItemDialog";
import { CreateItemDialog } from "@/components/kho/CreateItemDialog";
import { CrateDialog } from "@/components/kho/CrateDialog";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-stock-ledger.css";
import "@/styles/bmq-kho.css";

/**
 * Danh mục kho (owner 22/10/2026, replacing the warehouse game screen): every item of Kho Tân Tạo and Kho Q7 with one
 * name, one unit, its group and an on/off switch, plus the names on delivery notes the warehouse does not
 * know yet (?view=moi). Same data and RPCs as the game it replaces.
 */

/**
 * Thành phẩm in the warehouse are the Tân Tạo SKUs the owner named: frozen bánh mì que and pate 200g / 500g.
 * Fresh bánh mì que (BMQ-001) is not a stocked finished good. Stock comes from the Tân Tạo SKU ledger.
 */
const FINISHED: { sku: string; name: string }[] = [
  { sku: "BMQ-002", name: "Bánh mì que đông lạnh" },
  { sku: "PATE-200G", name: "Pate 200g" },
  { sku: "PATE-500G", name: "Pate 500g" },
];
type FinishedRow = { sku: string; name: string; unit: string; onHand: number | null };
type TanTaoSnapshot = { items?: { sku_code: string; unit?: string; on_hand_quantity?: number | string | null }[] };

function useFinishedGoods() {
  return useQuery({
    queryKey: ["tan-tao-warehouse-snapshot"],
    queryFn: async (): Promise<TanTaoSnapshot> => {
      const { data, error } = await (supabase as unknown as {
        rpc: (name: string) => Promise<{ data: unknown; error: { message: string } | null }>;
      }).rpc("get_tan_tao_warehouse_snapshot");
      if (error) throw new Error(error.message);
      return (data ?? {}) as TanTaoSnapshot;
    },
    staleTime: 60_000,
  });
}

function SkeletonRows({ count = 6 }: { count?: number }) {
  return <LoadingState rows={count} flat label="Đang đọc danh mục…" />;
}

function KhoSwitch({ value, onChange, counts }: { value: KhoLocation; onChange: (loc: KhoLocation) => void; counts?: Record<KhoLocation, number> }) {
  return (
    <div className="d3-sl-switch d3-kho-switch" role="tablist" aria-label="Kho" data-bmq-kho-switch>
      {KHO_LOCATIONS.map((loc) => (
        <button key={loc} type="button" role="tab" aria-selected={value === loc} className={cn(value === loc && "is-on")} onClick={() => onChange(loc)} data-bmq-kho-loc={loc}>
          Kho {KHO_LABEL[loc]}{counts ? <small>{counts[loc]}</small> : null}
        </button>
      ))}
    </div>
  );
}

export default function KhoCatalog() {
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "moi" ? "moi" : "list";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const list = useKhoItems();
  const q7 = useWarehouseGameSnapshot("q7");
  const tt = useWarehouseGameSnapshot("tan_tao");
  const { confirm, dialog } = useKhoConfirm();
  const say = (title: string) => toast({ title });

  const items = list.data?.items ?? [];
  const activeCount = items.filter((item) => item.active).length;
  const pending: { location: KhoLocation; crate: WarehouseGamePendingRow }[] = [
    ...(tt.data?.pending ?? []).map((crate) => ({ location: "tan_tao" as const, crate })),
    ...(q7.data?.pending ?? []).map((crate) => ({ location: "q7" as const, crate })),
  ];
  const goView = (next: "list" | "moi") => {
    const nextParams = new URLSearchParams(params);
    if (next === "moi") nextParams.set("view", "moi"); else nextParams.delete("view");
    setParams(nextParams);
  };

  if (view === "moi") {
    return (
      <div className="d3-wh d3-kho min-w-0" data-bmq-kho-catalog data-bmq-kho-view="moi">
        <header className="d3-wh-head">
          <div className="min-w-0">
            <h1>Tên mới trên phiếu</h1>
            <p className="d3-wh-tag">{q7.isLoading || tt.isLoading ? "Đang đọc phiếu giao…" : `${pending.length} tên trên hóa đơn, phiếu giao chưa có trong kho`}</p>
          </div>
          <Button variant="outline" onClick={() => goView("list")} data-bmq-kho-back><ArrowLeft aria-hidden="true" />Danh mục kho</Button>
        </header>
        <NewNames rows={pending} q7={q7.data} tt={tt.data} loading={q7.isLoading || tt.isLoading} failed={q7.isError || tt.isError}
          onRetry={() => { void q7.refetch(); void tt.refetch(); }}
          onAssigned={(text) => {
            say(text);
            void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
            void list.refetch();
          }} />
      </div>
    );
  }

  return (
    <div className="d3-wh d3-kho min-w-0" data-bmq-kho-catalog data-bmq-kho-view="list">
      <Catalog
        items={items}
        loading={list.isLoading}
        error={list.isError ? list.error : null}
        onRetry={() => void list.refetch()}
        activeCount={activeCount}
        canEdit={Boolean(list.data?.can_edit)}
        newCount={pending.length}
        onNew={() => goView("moi")}
        q7Skus={q7.data?.skus}
        q7SkusState={q7.isLoading ? "loading" : q7.isError ? "error" : "ok"}
        confirm={confirm}
        say={say}
      />
      {dialog}
    </div>
  );
}

const dmyShort = (iso: string) => iso.slice(0, 10).split("-").reverse().slice(0, 2).join("/");

function expiryText(days: number): string {
  return days < 0 ? `quá hạn ${-days} ngày` : days === 0 ? "hết hạn hôm nay" : `còn ${days} ngày`;
}

/** Lots whose HSD falls within 30 days at this kho (owner 23/10, traceability GĐ1). */
function ExpiryBanner({ rows }: { rows: ExpiryOverviewRow[] }) {
  const [open, setOpen] = useState(false);
  if (!rows.length) return null;
  const expired = rows.filter((r) => r.days_left < 0).length;
  return (
    <section className={cn("d3-kho-queue d3-kho-expiry", expired && "is-expired")} data-bmq-kho-expiry>
      <CalendarClock aria-hidden="true" />
      <p>
        <b>{rows.length} lô hết hạn trong 30 ngày{expired ? `, ${expired} đã quá hạn` : ""}</b>
        <span className="d3-kho-queue-more"> · dùng lô gần hết hạn trước</span>
      </p>
      <Button variant="outline" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-bmq-kho-expiry-toggle>{open ? "Thu gọn" : "Xem lô"}</Button>
      {open ? (
        <ul className="d3-kho-expiry-list" data-bmq-kho-expiry-list>
          {rows.map((r) => (
            <li key={r.batch_id}>
              <b>{r.name}</b>
              <small>
                <span className={cn("d3-kho-exp", r.days_left < 0 ? "is-expired" : "is-soon")}>HSD {dmyShort(r.expiry_date)} · {expiryText(r.days_left)}</span>
                {r.manufacturer_lot ? <span>Lô {r.manufacturer_lot}</span> : null}
                {r.receipt_number ? <span>{r.receipt_number}</span> : null}
                {r.quantity !== null ? <span>{fmtAmount(r.quantity, r.unit ?? "")}</span> : null}
              </small>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function Catalog({ items, loading, error, onRetry, activeCount, canEdit, newCount, onNew, q7Skus, q7SkusState, confirm, say }: {
  items: KhoItem[]; loading: boolean; error: unknown; onRetry: () => void; activeCount: number; canEdit: boolean;
  newCount: number; onNew: () => void; q7Skus: WarehouseGameSku[] | undefined; q7SkusState: "loading" | "error" | "ok";
  confirm: ReturnType<typeof useKhoConfirm>["confirm"]; say: (text: string) => void;
}) {
  const [kho, setKho] = useState<KhoLocation>("tan_tao");
  const [group, setGroup] = useState<Group>("nl");
  const [query, setQuery] = useState("");
  const [showOff, setShowOff] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  // Thêm món (source null) or Sao chép món (source = the item being copied).
  const [creating, setCreating] = useState<{ source: KhoItem | null } | null>(null);
  const fg = useFinishedGoods();
  const commitments = useKhoCommitments();
  const holds = useMemo(() => (commitments.data ? commitmentByItem(commitments.data) : null), [commitments.data]);
  const orders = useMemo(() => (commitments.data ? commitmentBySku(commitments.data) : null), [commitments.data]);
  const asOf = commitments.data?.as_of ?? "";
  const expiry = useExpiryOverview(30);
  const expiryAtKho = useMemo(() => (expiry.data ?? []).filter((r) => r.kho === kho && r.item_id), [expiry.data, kho]);
  // Nearest HSD per item at this kho, for the row chip.
  const expiryByItem = useMemo(() => {
    const m = new Map<string, ExpiryOverviewRow>();
    for (const r of expiryAtKho) {
      const cur = m.get(r.item_id as string);
      if (!cur || r.days_left < cur.days_left) m.set(r.item_id as string, r);
    }
    return m;
  }, [expiryAtKho]);
  const gaps = commitments.data?.gaps;
  const finished = useMemo<Record<KhoLocation, FinishedRow[]>>(() => {
    const bySku = new Map((fg.data?.items ?? []).map((row) => [row.sku_code, row]));
    const tanTao = FINISHED.map(({ sku, name }) => {
      const row = bySku.get(sku);
      const onHand = row ? Number(row.on_hand_quantity ?? 0) : null;
      return { sku, name, unit: row?.unit ?? (sku.startsWith("PATE") ? "hộp" : "que"), onHand: Number.isFinite(onHand) ? onHand : null };
    });
    // Q7 thành phẩm = the pastry SKUs of the Q7 finished-goods ledger (owner 21/10).
    const q7 = (q7Skus ?? []).map((sku) => ({ sku: sku.sku_code, name: sku.product_name, unit: sku.unit, onHand: sku.on_hand }));
    return { tan_tao: tanTao, q7 };
  }, [fg.data, q7Skus]);
  const fgState = kho === "q7" ? q7SkusState : fg.isLoading ? "loading" : fg.isError ? "error" : "ok";
  const inKhoItems = useMemo(() => items.filter((item) => atKho(item, kho)), [items, kho]);
  const inGroup = useMemo(() => inKhoItems.filter((item) => groupOf(item) === group), [inKhoItems, group]);
  const off = inGroup.filter((item) => !item.active);
  const rows = useMemo(() => filterItems(inGroup, query).filter((item) => item.active !== showOff), [inGroup, query, showOff]);
  const fgRows = useMemo(() => {
    const key = searchKey(query);
    return group !== "tp" || showOff ? [] : finished[kho].filter((row) => !key || searchKey(row.name).includes(key));
  }, [group, showOff, finished, kho, query]);
  const counts = useMemo(() => {
    const c: Record<Group, number> = { nl: 0, bb: 0, tp: finished[kho].length };
    for (const item of inKhoItems) if (item.active) c[groupOf(item)] += 1;
    return c;
  }, [inKhoItems, finished, kho]);
  const khoCounts = useMemo(() => {
    const c: Record<KhoLocation, number> = { tan_tao: finished.tan_tao.length, q7: finished.q7.length };
    for (const item of items) {
      if (!item.active) continue;
      if (atKho(item, "tan_tao")) c.tan_tao += 1;
      if (atKho(item, "q7")) c.q7 += 1;
    }
    return c;
  }, [items, finished]);
  const open = items.find((item) => item.id === openId) ?? null;
  const groupLabel = GROUPS.find((g) => g.id === group)?.label.toLowerCase() ?? "";

  const empty = rows.length === 0 && fgRows.length === 0;

  return (
    <>
      <header className="d3-wh-head">
        <div className="min-w-0">
          <h1>Danh mục kho</h1>
          <p className="d3-wh-tag">{loading ? "Đang đọc danh mục…" : error ? "Chưa đọc được danh mục" : `${activeCount} món đang bật · ${items.length - activeCount} đã tắt`}</p>
        </div>
        <div className="d3-kho-headtools">
          <KhoSwitch value={kho} onChange={(loc) => { setKho(loc); setShowOff(false); }} counts={loading || error ? undefined : khoCounts} />
          {canEdit && !loading && !error ? (
            <Button onClick={() => setCreating({ source: null })} data-bmq-kho-create-open><Plus aria-hidden="true" />Thêm món</Button>
          ) : null}
        </div>
      </header>

      {newCount ? (
        <section className="d3-kho-queue" data-bmq-kho-new>
          <FileText aria-hidden="true" />
          <p><b>{newCount} tên mới trên phiếu</b><span className="d3-kho-queue-more"> chưa có trong kho. Chọn đúng tên một lần, các phiếu sau tự vào đúng tên.</span></p>
          <Button onClick={onNew} data-bmq-kho-new-open>Gắn tên</Button>
        </section>
      ) : null}

      <ExpiryBanner rows={expiryAtKho} />

      <section className="d3-wh-card d3-kho-card">
        <div className="d3-kho-tabs" role="tablist" aria-label="Loại hàng" data-bmq-kho-groups>
          {GROUPS.map((g) => (
            <button key={g.id} type="button" role="tab" aria-selected={group === g.id} className={cn(group === g.id && "is-on")}
              onClick={() => { setGroup(g.id); setShowOff(false); }} data-bmq-kho-group={g.id}>
              {g.label}<small>{loading ? "…" : error ? "—" : counts[g.id]}</small>
            </button>
          ))}
        </div>
        <div className="d3-kho-tools">
          <span className="d3-kho-search">
            <Search aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Tìm ${groupLabel}…`} aria-label={`Tìm ${groupLabel}`} enterKeyHint="search" data-bmq-kho-search />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="Xóa tìm kiếm"><X /></button> : null}
          </span>
          {group !== "tp" || off.length ? (
            <div className="d3-kho-seg is-small" role="tablist" aria-label="Lọc">
              <button type="button" role="tab" aria-selected={!showOff} className={cn(!showOff && "is-on")} onClick={() => setShowOff(false)} data-bmq-kho-filter="on">Đang bật</button>
              <button type="button" role="tab" aria-selected={showOff} className={cn(showOff && "is-on")} onClick={() => setShowOff(true)} data-bmq-kho-filter="off">Đã tắt{off.length ? ` · ${off.length}` : ""}</button>
            </div>
          ) : null}
        </div>
        {!canEdit && !loading && !error ? <p className="d3-kho-hint">Tài khoản này chỉ xem được. Người có quyền sửa kho mới đổi được tên, đơn vị, loại hàng và bật/tắt.</p> : null}
        {kho === "q7" && group !== "tp" && gaps && gaps.pxk_lines_unposted > 0 ? (
          <p className="d3-kho-hint is-warn" data-bmq-kho-pxk-gap>
            {gaps.pxk_lines_unposted} dòng trên {gaps.pxk_unposted_issues.length} phiếu xuất NVL chưa trừ được vì chưa khớp công thức với món trong kho, nên số giữ cho sản xuất đang thiếu phần này.
          </p>
        ) : null}
        {group === "tp" && !showOff && !loading && !error ? (
          <p className="d3-kho-hint">{kho === "q7"
            ? "Bánh ngọt Kho Q7. Tồn lấy từ sổ thành phẩm Q7, nhập/xuất ở trang Phiếu kho."
            : "Thành phẩm Kho Tân Tạo. Tồn lấy từ sổ thành phẩm, nhập/xuất qua phiếu kho Tân Tạo."}</p>
        ) : null}

        {loading ? <SkeletonRows /> : error ? (
          <div className="d3-kho-failed" role="alert">
            <p>Không tải được danh mục kho. {khoErrorText(error)}</p>
            <Button variant="outline" onClick={onRetry}>Thử lại</Button>
          </div>
        ) : (
          <>
            <div className="d3-kho-listhead" aria-hidden="true"><span>Mặt hàng</span><span>Tồn sổ</span></div>
            {fgRows.length ? (
              <ul className="d3-kho-list" data-bmq-kho-finished>
                {fgRows.map((row) => {
                  const c = orders?.get(`${kho}:${row.sku}`);
                  const held = c ? c.committed_qty + c.overdue_qty : 0;
                  return (
                    <li key={row.sku} className="d3-kho-row is-static" data-bmq-kho-fg={row.sku}>
                      <span className="d3-kho-row-main">
                        <b>{row.name}</b>
                        <small>
                          <span>{row.unit}</span><span>{row.sku}</span>
                          {c && held > 0 ? <span className="d3-kho-hold" data-bmq-kho-fg-held>Đã đặt {fmtAmount(held, c.unit)} · {c.orders} đơn · {dayLabel(asOf, c.next_date)}</span> : null}
                          {c && c.incoming_qty > 0 ? <span>{kho === "q7" ? "sẽ làm" : "sắp nhập"} {fmtAmount(c.incoming_qty, c.unit)}</span> : null}
                        </small>
                      </span>
                      <span className="d3-kho-row-qty">
                        {fgState === "loading" ? "…" : fgState === "error" ? "Chưa đọc được" : fmtAmount(row.onHand, row.unit)}
                        {c && held > 0 ? <small className={cn(c.available < 0 && "is-short")} data-bmq-kho-fg-available>còn bán {fmtAmount(c.available, c.unit)}</small> : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <ul className="d3-kho-list" data-bmq-kho-names>
              {rows.map((item) => (
                <li key={item.id} className={cn("d3-kho-row", !item.active && "is-off")}>
                  <button type="button" className="d3-kho-row-main" onClick={() => setOpenId(item.id)} data-bmq-kho-item={item.id}>
                    <b>{item.name}</b>
                    <small>
                      {item.item_code ? <span className="d3-kho-code" data-bmq-kho-code>{item.item_code}</span> : null}
                      <span>{item.unit}</span>
                      <span>{item.doc_lines ? `${item.doc_lines} dòng phiếu` : "chưa có phiếu"}</span>
                      {expiryByItem.get(item.id) ? (
                        <span className={cn("d3-kho-exp", expiryTone(expiryByItem.get(item.id)!.days_left) === "expired" ? "is-expired" : "is-soon")} data-bmq-kho-item-exp>
                          HSD {expiryText(expiryByItem.get(item.id)!.days_left)}
                        </span>
                      ) : null}
                      {!item.item_class || item.item_class === "unclassified" ? <span className="is-flag">chưa phân loại</span> : item.item_class === "non_stock" ? <span>không tính tồn</span> : null}
                      <span className="d3-kho-row-qty-sub">Tồn {fmtAmount(item.qty[kho], item.unit)}</span>
                      {holds?.get(`${kho}:${item.id}`) ? (
                        <span className="d3-kho-hold" data-bmq-kho-held>Giữ cho sản xuất {fmtAmount(holds.get(`${kho}:${item.id}`)?.committed_qty, item.unit)} · {dayLabel(asOf, holds.get(`${kho}:${item.id}`)?.next_date)}</span>
                      ) : null}
                    </small>
                    {item.note ? <small className="d3-kho-note-line" data-bmq-kho-note>{item.note}</small> : null}
                  </button>
                  <span className="d3-kho-row-qty">
                    {fmtAmount(item.qty[kho], item.unit)}
                    {holds?.get(`${kho}:${item.id}`) && item.qty[kho] !== null ? (
                      <small className={cn((item.qty[kho] ?? 0) - (holds.get(`${kho}:${item.id}`)?.committed_qty ?? 0) < 0 && "is-short")}>
                        còn dùng {fmtAmount((item.qty[kho] ?? 0) - (holds.get(`${kho}:${item.id}`)?.committed_qty ?? 0), item.unit)}
                      </small>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            {empty ? (
              <p className="d3-kho-empty" data-bmq-kho-empty>
                {query ? `Không có món nào khớp “${query}”.` : showOff ? "Chưa có món nào tắt." : items.length === 0 ? "Danh mục kho chưa có món nào. Món mới vào kho từ hóa đơn, phiếu giao khi gắn tên." : `Kho ${KHO_LABEL[kho]} chưa có ${groupLabel} nào.`}
              </p>
            ) : null}
          </>
        )}
      </section>
      {open ? <ItemDialog key={open.id} item={open} items={items} canEdit={canEdit} confirm={confirm} onDone={(text) => { say(text); setOpenId(null); }} onClose={() => setOpenId(null)} onToast={say} onReplaced={setOpenId}
        onCopy={canEdit ? () => { setCreating({ source: open }); setOpenId(null); } : undefined} /> : null}
      {creating ? (
        <CreateItemDialog source={creating.source} items={items} defaultGroup={group} defaultKho={kho}
          onClose={() => setCreating(null)}
          onCreated={(created) => {
            say(`Đã tạo món “${created.name}” · ${created.code}`);
            setCreating(null);
            setOpenId(created.id);
          }} />
      ) : null}
    </>
  );
}

function NewNames({ rows, q7, tt, loading, failed, onRetry, onAssigned }: {
  rows: { location: KhoLocation; crate: WarehouseGamePendingRow }[];
  q7: ReturnType<typeof useWarehouseGameSnapshot>["data"]; tt: ReturnType<typeof useWarehouseGameSnapshot>["data"];
  loading: boolean; failed: boolean; onRetry: () => void; onAssigned: (text: string) => void;
}) {
  const [open, setOpen] = useState<{ location: KhoLocation; crate: WarehouseGamePendingRow } | null>(null);
  const snapshot = open ? (open.location === "q7" ? q7 : tt) : undefined;
  return (
    <section className="d3-wh-card d3-kho-card">
      <p className="d3-kho-hint">Đây là các tên ghi trên hóa đơn, phiếu giao mà kho chưa biết là món nào. Chọn đúng tên một lần, các phiếu sau cùng nhà cung cấp tự vào đúng tên.</p>
      {loading ? <SkeletonRows count={5} /> : failed ? (
        <div className="d3-kho-failed" role="alert">
          <p>Không đọc được phiếu giao. Thử lại sau ít phút.</p>
          <Button variant="outline" onClick={onRetry}>Thử lại</Button>
        </div>
      ) : (
        <>
          <ul className="d3-kho-list" data-bmq-kho-newlines>
            {rows.map(({ location, crate }) => (
              <li key={`${location}:${crateKey(crate)}`} className="d3-kho-row is-link">
                <button type="button" className="d3-kho-row-main" onClick={() => setOpen({ location, crate })} data-bmq-kho-crate={crateKey(crate)}>
                  <b>“{crate.raw_name}”</b>
                  <small><span>{crate.supplier_name ?? "chưa rõ nhà cung cấp"}</span><span>{crate.line_count} dòng phiếu</span><span>Kho {KHO_LABEL[location]}</span></small>
                  <span className="d3-kho-row-act" aria-hidden="true">Chọn tên</span>
                </button>
              </li>
            ))}
          </ul>
          {rows.length === 0 ? <p className="d3-kho-empty">Không còn tên mới nào. Mọi dòng phiếu đã có tên trong kho.</p> : null}
        </>
      )}
      {open && snapshot ? (
        <CrateDialog key={`${open.location}:${crateKey(open.crate)}`} location={open.location} crate={open.crate} snapshot={snapshot} autoPick
          onAssigned={(label) => { onAssigned(`“${open.crate.raw_name}” → ${label}`); setOpen(null); }}
          onClose={() => setOpen(null)} />
      ) : null}
    </section>
  );
}
