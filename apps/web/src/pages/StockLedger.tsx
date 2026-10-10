import { useMemo, useState } from "react";
import { AlertTriangle, CalendarCheck, ClipboardCheck, Link2, PackageCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useQ7InventoryPicker } from "@/hooks/useQ7MaterialInventory";
import {
  useRecordStockCount,
  useRecordTanTaoStockCount,
  useResolveStockAlias,
  useStockLedgerOverview,
} from "@/hooks/useStockLedger";
import type { StockLedgerLocation, StockLedgerOverviewItem, StockLedgerPendingAlias } from "@/lib/stock-ledger";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-stock-ledger.css";

const LOCATIONS: Array<{ id: StockLedgerLocation; label: string; hint: string }> = [
  { id: "q7", label: "Kho Q7", hint: "Nguyên vật liệu bếp" },
  { id: "tan_tao", label: "Kho Tân Tạo", hint: "Bánh mì và Pate" },
];

const qty = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("vi-VN", { maximumFractionDigits: 3 });

const signed = (value: number) => `${value > 0 ? "+" : ""}${qty(value)}`;

const shortDate = (iso: string | null) => {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
};

const errorText = (error: unknown) => {
  const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);
  if (message.includes("insufficient_privilege")) return "Tài khoản chưa có quyền ghi sổ kho này.";
  if (message.includes("not_found")) return "Không tìm thấy mặt hàng hoặc dòng phiếu nhập.";
  return message;
};

const newKey = (prefix: string) =>
  `${prefix}:${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;

function PendingAliasRow({
  row,
  lineCount,
  location,
  options,
}: {
  row: StockLedgerPendingAlias;
  lineCount: number;
  location: StockLedgerLocation;
  options: Array<{ id: string; label: string }>;
}) {
  const { toast } = useToast();
  const resolveAlias = useResolveStockAlias();
  const [itemId, setItemId] = useState("");
  const [factor, setFactor] = useState("1");
  const factorValue = Number(factor.replace(",", "."));
  const canSave = Boolean(itemId) && Number.isFinite(factorValue) && factorValue > 0 && !resolveAlias.isPending;

  const save = () => {
    resolveAlias.mutate(
      {
        goodsReceiptItemId: row.goods_receipt_item_id,
        location,
        kitchenInventoryItemId: location === "q7" ? itemId : null,
        tanTaoSkuId: location === "tan_tao" ? itemId : null,
        conversionFactor: factorValue,
      },
      {
        onSuccess: (count) =>
          toast({ title: "Đã gán mã", description: `Đã ghi ${count} dòng nhập vào sổ. Lần sau tên này tự vào sổ.` }),
        onError: (error) => toast({ title: "Chưa gán được mã", description: errorText(error), variant: "destructive" }),
      },
    );
  };

  return (
    <li className="d3-sl-pending">
      <div className="d3-sl-pending-name">
        <strong>{row.product_name}</strong>
        <small>
          {row.supplier || "Chưa có NCC"} · {lineCount > 1 ? `${lineCount} dòng, gần nhất ${row.receipt_number}` : row.receipt_number} · {shortDate(row.receipt_date)}
        </small>
      </div>
      <div className="d3-sl-pending-form">
        <select
          className="d3-wh-select"
          aria-label={`Mặt hàng trong sổ cho ${row.product_name}`}
          value={itemId}
          onChange={(event) => setItemId(event.target.value)}
        >
          <option value="">Chọn mặt hàng trong sổ…</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
        <label className="d3-sl-factor">
          <span>Hệ số</span>
          <Input
            inputMode="decimal"
            value={factor}
            onChange={(event) => setFactor(event.target.value)}
            aria-label="Hệ số quy đổi sang đơn vị sổ"
          />
        </label>
        <Button type="button" onClick={save} disabled={!canSave}>
          {resolveAlias.isPending ? "Đang gán…" : "Gán mã"}
        </Button>
      </div>
    </li>
  );
}

function CountCard({ location, items }: { location: StockLedgerLocation; items: StockLedgerOverviewItem[] }) {
  const { toast } = useToast();
  const q7Count = useRecordStockCount();
  const tanTaoCount = useRecordTanTaoStockCount();
  const [itemId, setItemId] = useState("");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const selected = items.find((item) => item.item_id === itemId) ?? null;
  const countedValue = Number(counted.replace(",", "."));
  const pending = q7Count.isPending || tanTaoCount.isPending;
  const canSave = Boolean(selected) && counted.trim() !== "" && Number.isFinite(countedValue) && countedValue >= 0 && !pending;

  const reset = () => {
    setCounted("");
    setNote("");
  };
  const onError = (error: unknown) =>
    toast({ title: "Chưa ghi được kiểm kê", description: errorText(error), variant: "destructive" });

  const save = () => {
    if (!selected) return;
    const difference = countedValue - selected.current_qty;
    const onSuccess = () => {
      toast({
        title: "Đã ghi kiểm kê",
        description: `${selected.item_name}: đếm ${qty(countedValue)} ${selected.unit}, chênh lệch ${signed(difference)}.`,
      });
      reset();
    };
    if (location === "q7") {
      q7Count.mutate(
        {
          kitchenInventoryItemId: selected.item_id,
          countedQty: countedValue,
          countDate: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }),
          note: note.trim() || null,
          idempotencyKey: newKey("q7-stock-count-ui"),
        },
        { onSuccess, onError },
      );
    } else {
      tanTaoCount.mutate(
        { skuCode: selected.item_code, countedQty: countedValue, note, idempotencyKey: newKey("tan-tao-count-ui") },
        { onSuccess, onError },
      );
    }
  };

  return (
    <section className="d3-wh-card" style={{ ["--i" as string]: 2 }}>
      <div className="d3-wh-card-h">
        <h2>Kiểm kê</h2>
        <span className="d3-wh-pill">Hằng tuần</span>
        <p>Đếm thực tế rồi nhập số. Sổ tự ghi phần chênh lệch.</p>
      </div>
      <div className="d3-sl-count">
        <div>
          <Label htmlFor={`stock-count-item-${location}`}>Mặt hàng</Label>
          <select
            id={`stock-count-item-${location}`}
            className="d3-wh-select"
            value={itemId}
            onChange={(event) => setItemId(event.target.value)}
          >
            <option value="">Chọn mặt hàng…</option>
            {items.map((item) => (
              <option key={item.item_id} value={item.item_id}>{item.item_name} ({item.unit})</option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor={`stock-count-qty-${location}`}>Số đếm thực tế{selected ? ` (${selected.unit})` : ""}</Label>
          <Input
            id={`stock-count-qty-${location}`}
            inputMode="decimal"
            value={counted}
            onChange={(event) => setCounted(event.target.value)}
            placeholder={selected ? `Sổ đang ghi ${qty(selected.current_qty)}` : "0"}
          />
        </div>
        <div>
          <Label htmlFor={`stock-count-note-${location}`}>Ghi chú</Label>
          <Input
            id={`stock-count-note-${location}`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Không bắt buộc"
          />
        </div>
        <Button type="button" className="d3-sl-count-submit" onClick={save} disabled={!canSave}>
          <ClipboardCheck className="h-4 w-4" />
          {pending ? "Đang ghi…" : "Ghi kiểm kê"}
        </Button>
      </div>
      {selected && counted.trim() !== "" && Number.isFinite(countedValue) ? (
        <p className="d3-wh-note">Chênh lệch sẽ ghi: {signed(countedValue - selected.current_qty)} {selected.unit}</p>
      ) : null}
    </section>
  );
}

export default function StockLedger() {
  const [location, setLocation] = useState<StockLedgerLocation>("q7");
  const overviewQuery = useStockLedgerOverview(location);
  const pickerQuery = useQ7InventoryPicker();
  const overview = overviewQuery.data;
  const items = useMemo(() => overview?.items ?? [], [overview]);
  const pendingRows = overview?.pending_aliases ?? [];
  // One assignment covers every line with the same supplier and name, so list each pair once.
  const pendingGroups = useMemo(() => {
    const groups = new Map<string, { row: StockLedgerPendingAlias; lineCount: number }>();
    for (const row of overview?.pending_aliases ?? []) {
      const key = `${row.supplier ?? ""}|${row.normalized_name ?? row.product_name}`;
      const group = groups.get(key);
      if (!group) groups.set(key, { row, lineCount: 1 });
      else groups.set(key, { row: row.receipt_date >= group.row.receipt_date ? row : group.row, lineCount: group.lineCount + 1 });
    }
    return [...groups.values()];
  }, [overview]);
  const lowItems = items.filter((item) => item.is_low_stock);
  const started = Boolean(overview?.cutover_date);

  const aliasOptions = useMemo(() => {
    if (location === "tan_tao") return items.map((item) => ({ id: item.item_id, label: `${item.item_code} · ${item.item_name}` }));
    const seen = new Set<string>();
    return (pickerQuery.data ?? [])
      .filter((row) => (seen.has(row.kitchen_inventory_item_id) ? false : (seen.add(row.kitchen_inventory_item_id), true)))
      .map((row) => ({ id: row.kitchen_inventory_item_id, label: row.display_label }));
  }, [location, items, pickerQuery.data]);

  const loading = overviewQuery.isLoading;
  const failed = overviewQuery.isError;
  const metrics: Array<{ label: string; value: string; hint: string; Icon: LucideIcon }> = [
    { label: "Mặt hàng", value: String(items.length), hint: "Đang có trong sổ", Icon: PackageCheck },
    { label: "Sắp hết", value: String(lowItems.length), hint: "Dưới 3 ngày xuất", Icon: AlertTriangle },
    { label: "Chờ gán mã", value: String(pendingGroups.length), hint: `${pendingRows.length} dòng nhập chưa vào sổ`, Icon: Link2 },
    { label: "Bắt đầu sổ", value: shortDate(overview?.cutover_date ?? null), hint: "Từ lần kiểm kê đầu", Icon: CalendarCheck },
  ];

  return (
    <div className="d3-wh d3-sl min-w-0" data-bmq-stock-ledger>
      <header className="d3-wh-head">
        <div className="min-w-0">
          <span className="d3-wh-tag">Tự cộng từ phiếu nhập kho · tự trừ từ phiếu xuất sản xuất · kiểm kê hằng tuần</span>
          <h1>
            Sổ tồn NVL <b>{LOCATIONS.find((item) => item.id === location)?.label}</b>
          </h1>
        </div>
        <div className="d3-sl-switch" role="tablist" aria-label="Chọn kho">
          {LOCATIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={location === item.id}
              className={location === item.id ? "is-on" : undefined}
              onClick={() => setLocation(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <section className="d3-wh-kpis">
        {metrics.map(({ label, value, hint, Icon }, k) => (
          <div key={label} className="d3-wh-kpi" style={{ ["--i" as string]: k }}>
            <span><Icon className="h-4 w-4" />{label}</span>
            <strong>{loading ? "…" : failed ? "—" : value}</strong>
            <small>{hint}</small>
          </div>
        ))}
      </section>

      {failed ? (
        <div className="d3-wh-alert is-error">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div><strong>Không tải được sổ tồn.</strong> {errorText(overviewQuery.error)}</div>
        </div>
      ) : null}

      {!loading && !failed && !started ? (
        <div className="d3-wh-alert is-warn">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div>
            <strong>Sổ chưa bắt đầu.</strong> Ghi kiểm kê lần đầu cho kho này. Từ ngày đó, phiếu nhập và phiếu xuất sản xuất tự vào sổ.
          </div>
        </div>
      ) : null}

      <div className="d3-sl-grid">
        <section className="d3-wh-card" style={{ ["--i" as string]: 1 }}>
          <div className="d3-wh-card-h">
            <h2>Tồn hiện tại</h2>
            <span className="d3-wh-pill">{items.length} mặt hàng</span>
          </div>
          {loading ? (
            <div className="d3-wh-empty">Đang tải sổ…</div>
          ) : items.length === 0 ? (
            <div className="d3-wh-empty">Chưa có mặt hàng nào trong sổ kho này.</div>
          ) : (
            <ul className="d3-sl-items">
              {items.map((item) => (
                <li key={item.item_id} className={item.is_low_stock ? "is-low" : undefined}>
                  <div className="d3-sl-item-name">
                    <strong>{item.item_name}</strong>
                    <small>
                      {item.item_code} · nhập 7 ngày {qty(item.in_qty_7d)} · xuất 7 ngày {qty(item.out_qty_7d)}
                    </small>
                  </div>
                  <div className="d3-sl-item-qty">
                    <strong>{qty(item.current_qty)}<small>{item.unit}</small></strong>
                    <small>
                      {item.is_low_stock ? <b>Sắp hết · </b> : null}
                      {item.last_count_date
                        ? `Kiểm ${shortDate(item.last_count_date)} · lệch ${signed(item.last_count_difference ?? 0)}`
                        : "Chưa kiểm kê"}
                    </small>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="d3-sl-side">
          <CountCard key={location} location={location} items={items} />

          <section className="d3-wh-card" style={{ ["--i" as string]: 3 }}>
            <div className="d3-wh-card-h">
              <h2>Chờ gán mã</h2>
              <span className="d3-wh-pill">{pendingGroups.length} tên · {pendingRows.length} dòng</span>
              <p>Gán mỗi tên hàng một lần cho mỗi nhà cung cấp. Các phiếu sau tự vào sổ.</p>
            </div>
            {!started ? (
              <div className="d3-wh-empty">Danh sách hiện sau khi sổ bắt đầu.</div>
            ) : pendingGroups.length === 0 ? (
              <div className="d3-wh-empty">Mọi dòng nhập đã vào sổ.</div>
            ) : (
              <ul className="d3-sl-pending-list">
                {pendingGroups.map(({ row, lineCount }) => (
                  <PendingAliasRow key={row.goods_receipt_item_id} row={row} lineCount={lineCount} location={location} options={aliasOptions} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
