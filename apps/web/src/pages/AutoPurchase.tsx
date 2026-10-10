import { useMemo, useState } from "react";
import { AlertTriangle, Bot, CalendarClock, FilePlus2, Power, Send, ShoppingCart } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useSuppliers } from "@/hooks/useSuppliers";
import {
  useCreateQ7DraftPurchaseOrders,
  useQ7AutoPurchaseStatus,
  useQ7PurchaseForecast,
  useRunQ7AutoPurchaseNow,
  useUpdateQ7AutoPurchaseSettings,
  useUpsertQ7PurchaseItemSetting,
} from "@/hooks/usePurchaseForecast";
import {
  addDays,
  reasonLabel,
  type Q7AutoPurchaseDecision,
  type Q7AutoPurchaseSettings,
  type Q7ForecastFlags,
  type Q7PurchaseForecastItem,
  type Q7PurchaseMode,
} from "@/lib/purchase-forecast";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-stock-ledger.css";

const MODE_LABELS: Record<Q7PurchaseMode, string> = {
  off: "Tắt",
  suggest: "Chỉ đề xuất",
  auto_draft: "Tự tạo nháp",
  auto_send: "Tự gửi",
};

const DECISION_LABELS: Record<Q7AutoPurchaseDecision, string> = {
  skip: "Bỏ qua",
  suggest: "Đề xuất",
  draft: "PO nháp",
  auto_send: "Đã tự gửi",
};

const RUN_STATUS_LABELS: Record<string, string> = { done: "Đã chạy xong", disabled: "Đang tắt, không đặt", running: "Đang chạy" };

const num = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("vi-VN", { maximumFractionDigits: digits });

const money = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `${Math.round(value).toLocaleString("vi-VN")}đ`;

const shortDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}` : iso;
};

const todayVn = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });

const errorText = (error: unknown) => {
  const message = String((error as { message?: string })?.message ?? error);
  if (message.includes("insufficient_privilege") || message.includes("owner")) return "Tài khoản chưa có quyền thao tác này.";
  return message;
};

/** Quantity in packs when a pack size is known, else in book units. */
const packText = (item: Q7PurchaseForecastItem) =>
  item.pack_size && item.pack_size > 0
    ? `${num(Math.ceil(item.suggested_qty / item.pack_size - 1e-9), 0)} × ${item.pack_label ?? `${num(item.pack_size)} ${item.unit}`}`
    : `${num(item.suggested_qty)} ${item.unit}`;

const activeFlags = (flags: Q7ForecastFlags) =>
  (Object.keys(flags) as Array<keyof Q7ForecastFlags>).filter((key) => flags[key]);

function ItemRow({
  item,
  supplierName,
  selected,
  onToggle,
  isOwner,
  dueSoon,
}: {
  item: Q7PurchaseForecastItem;
  supplierName: string | null;
  selected: boolean;
  onToggle: () => void;
  isOwner: boolean;
  dueSoon: boolean;
}) {
  const { toast } = useToast();
  const upsert = useUpsertQ7PurchaseItemSetting();
  const flags = activeFlags(item.flags);

  const setMode = (mode: Q7PurchaseMode) =>
    upsert.mutate(
      { kitchenInventoryItemId: item.item_id, mode, supplierId: item.supplier_id, orderCycleDays: item.order_cycle_days },
      {
        onSuccess: () => toast({ title: "Đã đổi chế độ", description: `${item.item_name}: ${MODE_LABELS[mode]}` }),
        onError: (error) => toast({ title: "Chưa đổi được chế độ", description: errorText(error), variant: "destructive" }),
      },
    );

  return (
    <li className={`d3-ap-item${dueSoon ? " is-due" : ""}`} data-bmq-auto-purchase-item>
      <label className="d3-ap-check">
        <input
          type="checkbox"
          checked={selected}
          disabled={item.suggested_qty <= 0}
          onChange={onToggle}
          aria-label={`Chọn ${item.item_name} để tạo PO nháp`}
        />
      </label>
      <div className="d3-ap-main">
        <div className="d3-ap-title">
          <strong>{item.item_name}</strong>
          <small>
            {supplierName ?? "Chưa có NCC"} · dùng {num(item.daily_usage)} {item.unit}/ngày · tồn{" "}
            {item.on_hand === null ? "chưa kiểm kê" : `${num(item.on_hand)} ${item.unit}`}
            {item.open_po_qty > 0 ? ` · đang về ${num(item.open_po_qty)}` : ""}
          </small>
        </div>
        {flags.length ? (
          <div className="d3-ap-flags">
            {flags.map((flag) => (
              <span key={flag}>{reasonLabel(flag)}</span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="d3-ap-order">
        <strong>{item.suggested_qty > 0 ? packText(item) : "Đủ hàng"}</strong>
        <small>
          {item.suggested_qty > 0 ? `Hạn đặt ${shortDate(item.reorder_date)} · ${money(item.estimated_amount)}` : `Hạn đặt ${shortDate(item.reorder_date)}`}
        </small>
        <select
          className="d3-wh-select d3-ap-mode"
          aria-label={`Chế độ đặt hàng cho ${item.item_name}`}
          value={item.mode}
          disabled={upsert.isPending}
          onChange={(event) => setMode(event.target.value as Q7PurchaseMode)}
        >
          {(Object.keys(MODE_LABELS) as Q7PurchaseMode[]).map((mode) => (
            <option key={mode} value={mode} disabled={mode === "auto_send" && !isOwner}>
              {MODE_LABELS[mode]}
            </option>
          ))}
        </select>
      </div>
    </li>
  );
}

function SettingsCard({ settings, isOwner, userId }: { settings: Q7AutoPurchaseSettings; isOwner: boolean; userId: string | null }) {
  const { toast } = useToast();
  const update = useUpdateQ7AutoPurchaseSettings();
  const runNow = useRunQ7AutoPurchaseNow();
  const [maxPo, setMaxPo] = useState(String(settings.max_po_amount));
  const [maxDaily, setMaxDaily] = useState(String(settings.max_daily_amount));

  const save = (patch: Parameters<typeof update.mutate>[0], done: string) =>
    update.mutate(patch, {
      onSuccess: () => toast({ title: done }),
      onError: (error) => toast({ title: "Chưa lưu được", description: errorText(error), variant: "destructive" }),
    });

  const toggle = () =>
    save(
      settings.enabled ? { enabled: false } : { enabled: true, systemActorId: settings.system_actor_id ?? userId },
      settings.enabled ? "Đã tắt đặt hàng tự động" : "Đã bật đặt hàng tự động",
    );

  const limitsValid = Number(maxPo) > 0 && Number(maxDaily) > 0;

  return (
    <section className="d3-wh-card" style={{ ["--i" as string]: 2 }}>
      <div className="d3-wh-card-h">
        <h2>Cài đặt</h2>
        <span className={`d3-wh-pill d3-ap-state${settings.enabled ? " is-on" : ""}`}>{settings.enabled ? "Đang bật" : "Đang tắt"}</span>
        <p>Chạy lúc {settings.run_hour_vn}:00 mỗi sáng. Chỉ tự gửi khi kiểm kê trong {settings.max_stock_count_age_days} ngày và sai số dự báo ≤ {Math.round(settings.max_backtest_error * 100)}%.</p>
      </div>
      {isOwner ? (
        <div className="d3-sl-count">
          <Button type="button" variant={settings.enabled ? "outline" : "default"} className="d3-sl-count-submit" onClick={toggle} disabled={update.isPending}>
            <Power className="h-4 w-4" />
            {settings.enabled ? "Tắt đặt hàng tự động" : "Bật đặt hàng tự động"}
          </Button>
          <div>
            <Label htmlFor="ap-max-po">Hạn mức mỗi PO (đ)</Label>
            <Input id="ap-max-po" inputMode="numeric" value={maxPo} onChange={(event) => setMaxPo(event.target.value.replace(/\D/g, ""))} />
          </div>
          <div>
            <Label htmlFor="ap-max-daily">Hạn mức mỗi ngày (đ)</Label>
            <Input id="ap-max-daily" inputMode="numeric" value={maxDaily} onChange={(event) => setMaxDaily(event.target.value.replace(/\D/g, ""))} />
          </div>
          <Button
            type="button"
            variant="outline"
            className="d3-sl-count-submit"
            disabled={!limitsValid || update.isPending}
            onClick={() => save({ maxPoAmount: Number(maxPo), maxDailyAmount: Number(maxDaily) }, "Đã lưu hạn mức")}
          >
            Lưu hạn mức
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="d3-sl-count-submit"
            disabled={runNow.isPending || !settings.enabled}
            onClick={() =>
              runNow.mutate(undefined, {
                onSuccess: () => toast({ title: "Đã chạy lượt hôm nay", description: "Mỗi ngày chỉ chạy một lần; chạy lại không tạo thêm PO." }),
                onError: (error) => toast({ title: "Chưa chạy được", description: errorText(error), variant: "destructive" }),
              })
            }
          >
            <Bot className="h-4 w-4" />
            Chạy lượt hôm nay ngay
          </Button>
        </div>
      ) : (
        <p className="d3-wh-note">Chỉ chủ doanh nghiệp bật/tắt và đổi hạn mức. Hạn mức hiện tại: {money(settings.max_po_amount)} mỗi PO, {money(settings.max_daily_amount)} mỗi ngày.</p>
      )}
    </section>
  );
}

export default function AutoPurchase() {
  const { toast } = useToast();
  const { isOwner, user } = useAuth();
  const forecastQuery = useQ7PurchaseForecast();
  const statusQuery = useQ7AutoPurchaseStatus();
  const suppliersQuery = useSuppliers();
  const createDrafts = useCreateQ7DraftPurchaseOrders();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);

  const supplierNames = useMemo(
    () => new Map((suppliersQuery.data ?? []).map((supplier) => [supplier.id, supplier.name] as const)),
    [suppliersQuery.data],
  );
  const asOf = forecastQuery.data?.as_of ?? todayVn();
  const dueBy = addDays(asOf, 1);
  const items = useMemo(() => forecastQuery.data?.items ?? [], [forecastQuery.data]);
  const isDue = (item: Q7PurchaseForecastItem) => item.suggested_qty > 0 && Boolean(item.reorder_date) && (item.reorder_date as string) <= dueBy;
  const dueItems = items.filter(isDue);
  const shown = showAll ? items : dueItems;
  const status = statusQuery.data;
  const decisions = status?.decisions ?? [];
  const latestRun = status?.latest_run ?? null;
  const dueAmount = dueItems.reduce((sum, item) => sum + (item.estimated_amount ?? 0), 0);
  const autoSendCount = items.filter((item) => item.mode === "auto_send").length;

  const loading = forecastQuery.isLoading;
  const failed = forecastQuery.isError;
  const metrics: Array<{ label: string; value: string; hint: string; Icon: LucideIcon }> = [
    { label: "Cần đặt", value: String(dueItems.length), hint: `Hạn đặt đến ${shortDate(dueBy)}`, Icon: ShoppingCart },
    { label: "Ước tiền", value: money(dueAmount), hint: "Theo giá mua gần nhất", Icon: CalendarClock },
    { label: "Tự gửi", value: `${autoSendCount}/${items.length}`, hint: "Mặt hàng đang để Tự gửi", Icon: Send },
    { label: "Lượt gần nhất", value: shortDate(latestRun?.run_date), hint: latestRun ? RUN_STATUS_LABELS[latestRun.status] ?? latestRun.status : "Chưa chạy", Icon: Bot },
  ];

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const makeDrafts = () => {
    const lines = items
      .filter((item) => selected.has(item.item_id) && item.suggested_qty > 0)
      .map((item) => ({
        itemId: item.item_id,
        supplierId: item.supplier_id,
        productName: item.item_name,
        quantity: item.suggested_qty,
        unit: item.unit,
        unitPrice: item.last_unit_price,
        packSize: item.pack_size,
        packLabel: item.pack_label,
      }));
    if (!lines.length) return;
    createDrafts.mutate(
      { lines, idempotencyKey: `q7-manual-draft:${asOf}:${[...selected].sort().join(",")}` },
      {
        onSuccess: (data) => {
          const count = Number((data as { count?: number })?.count ?? 0);
          toast({ title: "Đã tạo PO nháp", description: `${count} PO nháp đang chờ duyệt ở mục PO (Mua hàng).` });
          setSelected(new Set());
        },
        onError: (error) => toast({ title: "Chưa tạo được PO nháp", description: errorText(error), variant: "destructive" }),
      },
    );
  };

  return (
    <div className="d3-wh d3-sl min-w-0" data-bmq-auto-purchase>
      <header className="d3-wh-head">
        <div className="min-w-0">
          <span className="d3-wh-tag">Dự báo từ phiếu xuất sản xuất Q7 · trừ tồn và hàng đang về · làm tròn theo bao/thùng</span>
          <h1>
            Đặt hàng tự động <b>NVL Q7</b>
          </h1>
        </div>
        {status ? (
          <span className={`d3-wh-pill d3-ap-state${status.settings.enabled ? " is-on" : ""}`}>
            {status.settings.enabled ? "Đang bật" : "Đang tắt"}
          </span>
        ) : null}
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
          <div><strong>Không tải được dự báo.</strong> {errorText(forecastQuery.error)}</div>
        </div>
      ) : null}

      {!loading && !failed && items.length > 0 && items.every((item) => item.on_hand === null) ? (
        <div className="d3-wh-alert is-warn">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div>
            <strong>Chưa có tồn thực tế.</strong> Số đề xuất đang là lượng cần cho một chu kỳ đặt hàng. Kiểm kê ở Sổ tồn NVL để có hạn đặt chính xác; trước đó không mặt hàng nào được tự gửi.
          </div>
        </div>
      ) : null}

      <div className="d3-sl-grid">
        <section className="d3-wh-card" style={{ ["--i" as string]: 1 }}>
          <div className="d3-wh-card-h">
            <h2>{showAll ? "Tất cả mặt hàng" : "Cần đặt"}</h2>
            <span className="d3-wh-pill">{shown.length} mặt hàng</span>
            <button type="button" className="d3-ap-link" onClick={() => setShowAll((value) => !value)}>
              {showAll ? "Chỉ hiện cần đặt" : `Xem tất cả ${items.length}`}
            </button>
          </div>
          {loading ? (
            <div className="d3-wh-empty">Đang tính dự báo…</div>
          ) : shown.length === 0 ? (
            <div className="d3-wh-empty">{showAll ? "Chưa có mặt hàng nào có dữ liệu xuất sản xuất." : "Chưa có mặt hàng nào tới hạn đặt."}</div>
          ) : (
            <ul className="d3-sl-items d3-ap-list">
              {shown.map((item) => (
                <ItemRow
                  key={item.item_id}
                  item={item}
                  supplierName={item.supplier_id ? supplierNames.get(item.supplier_id) ?? null : null}
                  selected={selected.has(item.item_id)}
                  onToggle={() => toggle(item.item_id)}
                  isOwner={isOwner}
                  dueSoon={isDue(item)}
                />
              ))}
            </ul>
          )}
          <div className="d3-ap-actions">
            <Button type="button" className="d3-sl-count-submit" onClick={makeDrafts} disabled={selected.size === 0 || createDrafts.isPending}>
              <FilePlus2 className="h-4 w-4" />
              {createDrafts.isPending ? "Đang tạo…" : `Tạo PO nháp (${selected.size})`}
            </Button>
          </div>
        </section>

        <div className="d3-sl-side">
          {status ? <SettingsCard key={status.settings.updated_at ?? "s"} settings={status.settings} isOwner={isOwner} userId={user?.id ?? null} /> : null}

          <section className="d3-wh-card" style={{ ["--i" as string]: 3 }}>
            <div className="d3-wh-card-h">
              <h2>Nhật ký quyết định</h2>
              <span className="d3-wh-pill">{decisions.length}</span>
              <p>Mỗi lượt chạy ghi lý do cho từng mặt hàng.</p>
            </div>
            {statusQuery.isLoading ? (
              <div className="d3-wh-empty">Đang tải…</div>
            ) : decisions.length === 0 ? (
              <div className="d3-wh-empty">Chưa có lượt chạy nào.</div>
            ) : (
              <ul className="d3-sl-items">
                {decisions.map((decision) => (
                  <li key={decision.id} className={decision.decision === "auto_send" ? "is-sent" : undefined}>
                    <div className="d3-sl-item-name">
                      <strong>{decision.item_name ?? "—"}</strong>
                      <small>{decision.reason_codes.map(reasonLabel).join(" · ")}</small>
                    </div>
                    <div className="d3-sl-item-qty">
                      <strong className="d3-ap-decision">{DECISION_LABELS[decision.decision]}</strong>
                      <small>
                        {shortDate(decision.created_at)}
                        {decision.purchase_order_number ? ` · ${decision.purchase_order_number}` : ""}
                        {decision.estimated_amount ? ` · ${money(decision.estimated_amount)}` : ""}
                      </small>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
