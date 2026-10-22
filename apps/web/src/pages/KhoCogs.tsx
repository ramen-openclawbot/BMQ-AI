import { useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, BookOpen, Check, PackageSearch, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionPicker } from "@/components/OptionPicker";
import { KhoDialog } from "@/components/kho/KhoDialog";
import { ReceiptNotes } from "@/components/kho/ReceiptNotes";
import { useKhoConfirm } from "@/components/kho/KhoConfirm";
import { KHO_LABEL, dmy, fmtAmount, newRequestId, parseNum, todayVN } from "@/components/kho/kho-meta";
import { useToast } from "@/hooks/use-toast";
import { useKhoItems } from "@/hooks/useKhoItems";
import { useItemReceiptLines } from "@/hooks/useWarehouseGame";
import {
  useCogsDecideIngredient,
  useCogsDecideRevenueProduct,
  useCogsItemTrace,
  useCogsOverview,
  useCogsRefreshNow,
  useCogsSetBackflush,
} from "@/hooks/useCogsBackflush";
import {
  ingredientReasonText,
  recipeVsIssuePct,
  type CogsGapIngredient,
  type CogsGapProduct,
  type CogsItemUsage,
  type CogsLocation,
  type CogsOverview,
  type CogsSetting,
  type CogsTraceLine,
} from "@/lib/cogs-backflush";
import { khoErrorText, standardUnitFactor } from "@/lib/kho-items";
import { cn } from "@/lib/utils";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-stock-ledger.css";
import "@/styles/bmq-purchase-usage.css";
import "@/styles/bmq-kho.css";
import "@/styles/bmq-cogs.css";

type RangeKey = "7" | "21" | "month";
const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: "7", label: "7 ngày" },
  { key: "21", label: "21 ngày" },
  { key: "month", label: "Tháng này" },
];

const LOCATIONS: CogsLocation[] = ["tan_tao", "q7"];

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function rangeFor(key: RangeKey): { from: string; to: string } {
  const to = todayVN();
  if (key === "month") return { from: `${to.slice(0, 8)}01`, to };
  return { from: addDays(to, -(Number(key) - 1)), to };
}

const pct = (value: number) => `${value.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
const money = (value: number) =>
  Math.abs(value) >= 1_000_000
    ? `${(value / 1_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} tr`
    : `${Math.round(value / 1000).toLocaleString("vi-VN")}k`;
const timeOf = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" }) : "—";

const COGS_ERRORS: Record<string, string> = {
  start_date_not_after_cutover: "Ngày bắt đầu phải sau ngày kiểm kê gần nhất của kho này.",
  start_date_before_today: "Ngày bắt đầu không được trước hôm nay.",
  location_mismatch: "Món kho này nằm ở kho khác: chọn món đúng kho.",
  item_not_active: "Món kho này đã tắt hoặc đã gộp vào món khác.",
  factor_required: "Nhập hệ số quy đổi lớn hơn 0.",
  sku_required: "Chọn một sản phẩm.",
  invalid_units_per_revenue_unit: "Số lượng quy đổi phải lớn hơn 0.",
  map_not_found: "Thẻ này vừa được người khác xử lý. Tải lại trang.",
};

function cogsErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error ?? "");
  for (const [key, text] of Object.entries(COGS_ERRORS)) if (message.includes(key)) return text;
  return khoErrorText(error);
}

/* ------------------------------------------------------------------------ */
/* Kho status + switch                                                       */
/* ------------------------------------------------------------------------ */

function KhoState({ setting, canSwitch, onEnable, onDisable, busy }: {
  setting: CogsSetting;
  canSwitch: boolean;
  onEnable: () => void;
  onDisable: () => void;
  busy: boolean;
}) {
  const on = setting.enabled;
  return (
    <article className={cn("d3-cogs-kho", on && "is-on")} data-bmq-cogs-kho={setting.location} data-on={on ? "1" : "0"}>
      <div className="d3-cogs-kho-top">
        <h3>Kho {KHO_LABEL[setting.location]}</h3>
        <span className={cn("d3-pu-chip", on ? "is-green" : "is-grey")}>{on ? "Đang trừ sổ" : "Chạy thử"}</span>
      </div>
      <p>
        {on
          ? `Nguyên liệu trừ theo giá vốn từ ${dmy(setting.start_date)}.${setting.location === "q7" ? " Phiếu xuất NVL từ ngày đó không trừ nữa." : ""}`
          : "Máy tính lượng nguyên liệu theo doanh thu mỗi giờ nhưng chưa trừ sổ."}
      </p>
      <small>Kiểm kê gần nhất: {dmy(setting.cutover_date) ?? "chưa có"}</small>
      {canSwitch ? (
        on ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={onDisable} data-bmq-cogs-disable={setting.location}>Tắt trừ sổ</Button>
        ) : (
          <Button size="sm" disabled={busy || !setting.cutover_date} onClick={onEnable} data-bmq-cogs-enable={setting.location}>Bật trừ sổ…</Button>
        )
      ) : null}
    </article>
  );
}

function EnableDialog({ setting, onClose, onDone }: { setting: CogsSetting; onClose: () => void; onDone: (text: string) => void }) {
  const today = todayVN();
  const earliest = useMemo(() => {
    const afterCount = setting.cutover_date ? addDays(setting.cutover_date, 1) : today;
    return afterCount > today ? afterCount : today;
  }, [setting.cutover_date, today]);
  const [start, setStart] = useState(() => {
    const tomorrow = addDays(today, 1);
    return tomorrow > earliest ? tomorrow : earliest;
  });
  const [requestId] = useState(newRequestId);
  const set = useCogsSetBackflush();
  const refresh = useCogsRefreshNow();
  const q7 = setting.location === "q7";

  const submit = async () => {
    await set.mutateAsync({ location: setting.location, enabled: true, startDate: start, requestId });
    await refresh.mutateAsync().catch(() => undefined);
    onDone(`Kho ${KHO_LABEL[setting.location]} trừ sổ theo giá vốn từ ${dmy(start)}.`);
  };

  return (
    <KhoDialog title={`Bật trừ sổ · Kho ${KHO_LABEL[setting.location]}`} sub="Từ ngày này, nguyên liệu trừ theo công thức giá vốn của đơn đã ghi nhận doanh thu." onClose={onClose} data={{ "data-bmq-cogs-enable-dialog": "" }}>
      <label className="d3-kho-field">
        <span>Bắt đầu trừ từ ngày</span>
        <Input type="date" value={start} min={earliest} onChange={(event) => setStart(event.target.value)} data-bmq-cogs-start />
      </label>
      <ul className="d3-cogs-bullets">
        <li>Mỗi giờ máy trừ phần nguyên liệu của đơn giao từ ngày này. Doanh thu sửa thì máy tự bù lại.</li>
        {q7 ? <li>Phiếu xuất NVL Q7 từ ngày này không trừ nữa; phần phiếu xuất đã trừ cho những ngày đó được hoàn lại đúng ngày.</li> : null}
        <li>Ngày kiểm kê {dmy(setting.cutover_date)} và trước đó giữ nguyên.</li>
      </ul>
      {set.error ? <p className="d3-kho-error">{cogsErrorText(set.error)}</p> : null}
      <div className="d3-kho-actions">
        <Button disabled={set.isPending || refresh.isPending || !start || start < earliest} onClick={() => void submit()} data-bmq-cogs-enable-ok>
          {set.isPending || refresh.isPending ? "Đang bật…" : "Bật trừ sổ"}
        </Button>
        <Button variant="outline" onClick={onClose}>Thôi</Button>
      </div>
    </KhoDialog>
  );
}

/* ------------------------------------------------------------------------ */
/* Decisions                                                                 */
/* ------------------------------------------------------------------------ */

function ProductDialog({ gap, overview, onClose, onDone }: {
  gap: CogsGapProduct;
  overview: CogsOverview;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const candidates = useMemo(
    () =>
      gap.candidates
        .map((raw) => raw as { sku_id?: string; sku_code?: string; name?: string; score?: number })
        .filter((c) => c.sku_id && (c.score ?? 0) > 0)
        .slice(0, 3),
    [gap.candidates],
  );
  const [choice, setChoice] = useState<string>(candidates[0]?.sku_id ?? "");
  const [units, setUnits] = useState("1");
  const [requestId] = useState(newRequestId);
  const decide = useCogsDecideRevenueProduct();
  const refresh = useCogsRefreshNow();
  const sku = overview.sku_options.find((option) => option.sku_id === choice) ?? null;
  const unitsValue = parseNum(units);
  const reject = choice === "__skip";
  const busy = decide.isPending || refresh.isPending;

  const submit = async () => {
    if (!gap.map_id) return;
    await decide.mutateAsync({
      mapId: gap.map_id,
      skuId: reject ? null : choice,
      unitsPerRevenueUnit: reject ? 1 : unitsValue,
      reject,
      requestId,
    });
    await refresh.mutateAsync().catch(() => undefined);
    onDone(reject ? `"${gap.name}" không trừ kho.` : `"${gap.name}" tính theo công thức ${sku?.name ?? ""}.`);
  };

  return (
    <KhoDialog
      title={gap.name || gap.product_code || "Sản phẩm chưa rõ"}
      sub={`${gap.channel}${gap.product_code ? ` · mã ${gap.product_code}` : ""} · ${gap.lines} dòng doanh thu · ${money(gap.value)}`}
      onClose={onClose}
      data={{ "data-bmq-cogs-product-dialog": "" }}
    >
      <p className="d3-cogs-lead">Dòng doanh thu này là sản phẩm nào? Máy sẽ lấy công thức giá vốn của sản phẩm đó.</p>
      {candidates.length > 0 ? (
        <div className="d3-kho-options" role="radiogroup" aria-label="Sản phẩm gợi ý">
          {candidates.map((c) => (
            <button
              key={c.sku_id}
              type="button"
              role="radio"
              aria-checked={choice === c.sku_id}
              className={cn("d3-kho-option", choice === c.sku_id && "is-on")}
              onClick={() => setChoice(c.sku_id!)}
              data-bmq-cogs-candidate={c.sku_code}
            >
              <b>{c.name}</b>
              <small>{c.sku_code} · giống {Math.round((c.score ?? 0) * 100)}%</small>
            </button>
          ))}
        </div>
      ) : null}
      <label className="d3-kho-field">
        <span>{candidates.length > 0 ? "Hoặc chọn sản phẩm khác" : "Chọn sản phẩm"}</span>
        <OptionPicker
          value={choice === "__skip" ? "" : choice}
          onChange={setChoice}
          options={overview.sku_options.map((option) => ({ value: option.sku_id, label: `${option.name} · ${option.sku_code}` }))}
          placeholder="Tìm sản phẩm…"
          ariaLabel="Sản phẩm"
          dataAttrs={{ "bmq-cogs-sku-picker": "" }}
        />
      </label>
      {!reject && sku ? (
        <label className="d3-kho-field">
          <span>1 đơn vị trên doanh thu bằng bao nhiêu {sku.unit || "đơn vị"} {sku.name}?</span>
          <Input inputMode="decimal" value={units} onChange={(event) => setUnits(event.target.value)} className="d3-cogs-num" data-bmq-cogs-units />
        </label>
      ) : null}
      <button
        type="button"
        className={cn("d3-cogs-skip", reject && "is-on")}
        aria-pressed={reject}
        onClick={() => setChoice(reject ? candidates[0]?.sku_id ?? "" : "__skip")}
        data-bmq-cogs-skip
      >
        <b>Không trừ kho cho món này</b>
        <small>Ví dụ hàng mua về bán thẳng, không đi qua kho NVL.</small>
      </button>
      {!gap.map_id ? <p className="d3-kho-error">Thẻ này chưa sẵn sàng. Bấm "Chạy lại" ở đầu trang rồi mở lại.</p> : null}
      {decide.error ? <p className="d3-kho-error">{cogsErrorText(decide.error)}</p> : null}
      <div className="d3-kho-actions">
        <Button
          disabled={busy || !gap.map_id || (!reject && (!choice || !(unitsValue > 0)))}
          onClick={() => void submit()}
          data-bmq-cogs-product-save
        >
          {busy ? "Đang lưu…" : "Lưu"}
        </Button>
        <Button variant="outline" onClick={onClose}>Thôi</Button>
      </div>
    </KhoDialog>
  );
}

type IngredientAction = "deduct" | "finished_goods_ledger" | "not_tracked";

function IngredientDialog({ gap, onClose, onDone }: { gap: CogsGapIngredient; onClose: () => void; onDone: (text: string) => void }) {
  const kho = useKhoItems();
  // Grouped by kho (the picker groups consecutive rows), then by name.
  const items = useMemo(
    () =>
      (kho.data?.items ?? [])
        .filter((item) => item.active)
        .sort((a, b) => Number(a.in_q7) - Number(b.in_q7) || a.name.localeCompare(b.name, "vi")),
    [kho.data],
  );
  const firstCandidate = (gap.candidates[0] ?? {}) as { item_id?: string };
  const [action, setAction] = useState<IngredientAction>("deduct");
  const [itemId, setItemId] = useState<string>(firstCandidate.item_id ?? "");
  const item = items.find((row) => row.id === itemId) ?? null;
  const standard = item ? standardUnitFactor(gap.recipe_unit, item.unit) : null;
  // Owner rule: a typed factor is shown next to the item's delivery notes.
  const lines = useItemReceiptLines(item?.id ?? null, action === "deduct" && item !== null && standard === null);
  const [factorText, setFactorText] = useState("");
  const factor = standard ?? parseNum(factorText);
  const [requestId] = useState(newRequestId);
  const decide = useCogsDecideIngredient();
  const refresh = useCogsRefreshNow();
  const busy = decide.isPending || refresh.isPending;
  const ready = action !== "deduct" || (item !== null && factor > 0);

  const submit = async () => {
    await decide.mutateAsync({
      canonicalMaterialId: gap.canonical_material_id ?? "",
      recipeUnit: gap.recipe_unit,
      action,
      location: action === "deduct" && item ? (item.in_q7 ? "q7" : "tan_tao") : null,
      itemId: action === "deduct" ? itemId : null,
      factor: action === "deduct" ? factor : null,
      requestId,
    });
    await refresh.mutateAsync().catch(() => undefined);
    onDone(
      action === "deduct"
        ? `${gap.material_name} trừ vào ${item?.name ?? "món kho"}.`
        : action === "finished_goods_ledger"
          ? `${gap.material_name}: đã trừ ở sổ thành phẩm.`
          : `${gap.material_name}: không theo dõi kho.`,
    );
  };

  const ACTIONS: Array<{ id: IngredientAction; title: string; hint: string }> = [
    { id: "deduct", title: "Trừ vào món kho", hint: "Chọn món kho và quy đổi" },
    { id: "finished_goods_ledger", title: "Đã trừ ở sổ thành phẩm", hint: "Ví dụ bánh mì que nhập từ Tuyết Anh" },
    { id: "not_tracked", title: "Không theo dõi kho", hint: "Nước, phí, dòng ghi nhầm" },
  ];

  return (
    <KhoDialog
      title={gap.material_name || "Nguyên liệu chưa rõ"}
      sub={`Đơn vị công thức: ${gap.recipe_unit} · dùng trong ${gap.sku_codes.join(", ") || "—"}`}
      onClose={onClose}
      wide
      data={{ "data-bmq-cogs-ingredient-dialog": "" }}
    >
      <p className="d3-cogs-lead">{ingredientReasonText(gap)}</p>
      {!gap.canonical_material_id ? (
        <p className="d3-kho-error">Dòng này chưa có mã nguyên liệu chuẩn nên chưa chọn được ở đây: sửa công thức trong Giá vốn.</p>
      ) : (
        <>
          <div className="d3-kho-options d3-cogs-actions3" role="radiogroup" aria-label="Cách trừ">
            {ACTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={action === option.id}
                className={cn("d3-kho-option", action === option.id && "is-on")}
                onClick={() => setAction(option.id)}
                data-bmq-cogs-action={option.id}
              >
                <b>{option.title}</b>
                <small>{option.hint}</small>
              </button>
            ))}
          </div>
          {action === "deduct" ? (
            <div className="d3-cogs-deduct">
              <label className="d3-kho-field">
                <span>Món kho</span>
                <OptionPicker
                  value={itemId}
                  onChange={(next) => { setItemId(next); setFactorText(""); }}
                  options={items.map((row) => ({ value: row.id, label: `${row.name} · ${row.unit}`, group: `Kho ${row.in_q7 ? "Q7" : "Tân Tạo"}` }))}
                  placeholder={kho.isLoading ? "Đang tải danh mục…" : "Tìm món kho…"}
                  ariaLabel="Món kho"
                  dataAttrs={{ "bmq-cogs-item-picker": "" }}
                />
              </label>
              {item ? (
                standard !== null ? (
                  <p className="d3-cogs-conv" data-bmq-cogs-standard>
                    1 {gap.recipe_unit} = <b>{standard.toLocaleString("vi-VN")}</b> {item.unit} · tự đổi theo đơn vị chuẩn · trừ ở Kho {item.in_q7 ? "Q7" : "Tân Tạo"}
                  </p>
                ) : (
  <>
                    <label className="d3-kho-field">
                      <span>1 {gap.recipe_unit} trong công thức bằng bao nhiêu {item.unit} {item.name}?</span>
                      <Input inputMode="decimal" value={factorText} onChange={(event) => setFactorText(event.target.value)} placeholder="Ví dụ 1" className="d3-cogs-num" data-bmq-cogs-factor />
                    </label>
                    <ReceiptNotes title={`Phiếu giao của ${item.name}`} lines={lines.data} loading={lines.isLoading} error={lines.error} />
                  </>
                )
              ) : null}
            </div>
          ) : null}
        </>
      )}
      {decide.error ? <p className="d3-kho-error">{cogsErrorText(decide.error)}</p> : null}
      <div className="d3-kho-actions">
        <Button disabled={busy || !gap.canonical_material_id || !ready} onClick={() => void submit()} data-bmq-cogs-ingredient-save>
          {busy ? "Đang lưu…" : "Lưu"}
        </Button>
        <Button variant="outline" onClick={onClose}>Thôi</Button>
      </div>
    </KhoDialog>
  );
}

/* ------------------------------------------------------------------------ */
/* Item trace                                                                */
/* ------------------------------------------------------------------------ */

function ItemTraceDialog({ item, range, onClose }: { item: CogsItemUsage; range: { from: string; to: string }; onClose: () => void }) {
  const trace = useCogsItemTrace(item.location, item.item_id, range.from, range.to);
  const days = useMemo(() => {
    const map = new Map<string, { date: string; total: number; rows: CogsTraceLine[] }>();
    const rows = (trace.data?.rows ?? []).filter((row) => row.status === "ok");
    for (const row of rows) {
      const date = row.revenue_date ?? "";
      const day = map.get(date) ?? { date, total: 0, rows: [] as CogsTraceLine[] };
      day.total += row.stock_qty;
      day.rows.push(row);
      map.set(date, day);
    }
    return [...map.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [trace.data]);

  return (
    <KhoDialog
      title={item.name}
      sub={`Kho ${KHO_LABEL[item.location]} · ${dmy(range.from)} – ${dmy(range.to)}`}
      onClose={onClose}
      wide
      data={{ "data-bmq-cogs-trace": "" }}
    >
      <div className="d3-pu-sum">
        <span><small>Theo giá vốn</small><b>{fmtAmount(item.recipe_qty, item.unit)}</b></span>
        <span><small>Phiếu xuất NVL</small><b>{item.pxk_usage > 0 ? fmtAmount(item.pxk_usage, item.unit) : "—"}</b></span>
        <span><small>Đã trừ sổ</small><b>{item.posted_cogs > 0 ? fmtAmount(item.posted_cogs, item.unit) : "—"}</b></span>
      </div>
      {trace.isLoading ? (
        <div className="d3-wh-empty">Đang tải đơn…</div>
      ) : trace.isError ? (
        <p className="d3-kho-error">{cogsErrorText(trace.error)}</p>
      ) : days.length === 0 ? (
        <div className="d3-wh-empty">Không có đơn nào dùng món này trong kỳ.</div>
      ) : (
        <ol className="d3-cogs-days">
          {days.map((day) => (
            <li key={day.date}>
              <div className="d3-cogs-day-h">
                <b>{dmy(day.date)}</b>
                <span>{fmtAmount(day.total, item.unit)}</span>
              </div>
              <ul>
                {day.rows.map((row, index) => (
                  <li key={`${row.revenue_line_id}:${index}`} data-bmq-cogs-trace-row>
                    <span className="d3-cogs-trace-name">
                      <b>{row.sku_name || row.sku_code}</b>
                      <small>
                        {row.channel}
                        {row.customer ? ` · ${row.customer}` : ""}
                        {row.ref ? ` · ${row.ref}` : ""}
                        {row.revenue_qty > 0 ? ` · bán ${row.revenue_qty.toLocaleString("vi-VN")}` : ""}
                        {row.version_no ? ` · công thức v${row.version_no}` : ""}
                      </small>
                    </span>
                    <b className="d3-cogs-trace-qty">{fmtAmount(row.stock_qty, item.unit)}</b>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </KhoDialog>
  );
}

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export default function KhoCogs() {
  const [rangeKey, setRangeKey] = useState<RangeKey>("21");
  const range = useMemo(() => rangeFor(rangeKey), [rangeKey]);
  const overview = useCogsOverview(range.from, range.to);
  const data = overview.data;
  const [kho, setKho] = useState<CogsLocation>("q7");
  const [enableFor, setEnableFor] = useState<CogsSetting | null>(null);
  const [productGap, setProductGap] = useState<CogsGapProduct | null>(null);
  const [ingredientGap, setIngredientGap] = useState<CogsGapIngredient | null>(null);
  const [traceItem, setTraceItem] = useState<CogsItemUsage | null>(null);
  const { confirm, dialog } = useKhoConfirm();
  const { toast } = useToast();
  const say = (title: string) => toast({ title });
  const refresh = useCogsRefreshNow();
  const setBackflush = useCogsSetBackflush();

  const settings = useMemo(() => {
    const byLoc = new Map((data?.settings ?? []).map((s) => [s.location, s]));
    return LOCATIONS.map((location) => byLoc.get(location) ?? { location, enabled: false, start_date: null, cutover_date: null, updated_at: null });
  }, [data]);
  const coverage = useMemo(() => [...(data?.coverage ?? [])].sort((a, b) => b.value - a.value), [data]);
  const gaps = data?.gaps ?? { products: [], ingredients: [], recipes: [] };
  const gapTotal = gaps.products.length + gaps.ingredients.length + gaps.recipes.length;
  const items = useMemo(
    () => (data?.items ?? []).filter((item) => item.location === kho).sort((a, b) => b.recipe_qty - a.recipe_qty || b.pxk_usage - a.pxk_usage),
    [data, kho],
  );
  const countBy = (location: CogsLocation) => (data?.items ?? []).filter((item) => item.location === location).length;
  const canDecide = Boolean(data?.can_decide);
  const lastRun = data?.last_run ?? null;

  const disable = async (setting: CogsSetting) => {
    const ok = await confirm({
      title: `Tắt trừ sổ Kho ${KHO_LABEL[setting.location]}?`,
      message: "Phần đã trừ theo giá vốn giữ nguyên. Phiếu xuất NVL không tự trừ lại cho những ngày đó; máy quay về chạy thử.",
      ok: "Tắt trừ sổ",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await setBackflush.mutateAsync({ location: setting.location, enabled: false, startDate: null, requestId: newRequestId() });
      say(`Kho ${KHO_LABEL[setting.location]} quay về chạy thử.`);
    } catch (error) {
      say(cogsErrorText(error));
    }
  };

  const rerun = async () => {
    try {
      await refresh.mutateAsync();
      say("Đã chạy lại với số mới nhất.");
    } catch (error) {
      say(cogsErrorText(error));
    }
  };

  return (
    <div className="d3-wh d3-sl d3-pu d3-cogs min-w-0" data-bmq-kho-cogs>
      <header className="d3-wh-head">
        <div className="min-w-0">
          <h1>
            Giá vốn <b>→ Kho</b>
          </h1>
          <p className="d3-wh-tag">Đơn đã ghi nhận doanh thu × công thức giá vốn → nguyên liệu trừ ở từng kho</p>
        </div>
        <div className="d3-sl-switch" role="tablist" aria-label="Chọn kỳ">
          {RANGES.map((option) => (
            <button
              key={option.key}
              type="button"
              role="tab"
              aria-selected={rangeKey === option.key}
              className={cn(rangeKey === option.key && "is-on")}
              onClick={() => setRangeKey(option.key)}
              data-bmq-cogs-range={option.key}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      {overview.isError ? (
        <div className="d3-wh-alert is-error">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div><strong>Không tải được.</strong> {cogsErrorText(overview.error)}</div>
        </div>
      ) : null}

      <section className="d3-cogs-khos" aria-label="Trạng thái từng kho">
        {settings.map((setting) => (
          <KhoState
            key={setting.location}
            setting={setting}
            canSwitch={Boolean(data?.can_switch)}
            busy={setBackflush.isPending}
            onEnable={() => setEnableFor(setting)}
            onDisable={() => void disable(setting)}
          />
        ))}
        <div className="d3-cogs-run" data-bmq-cogs-run>
          <small>Lần chạy gần nhất</small>
          <b>{lastRun ? `${timeOf(lastRun.finished_at ?? lastRun.started_at)} · ${dmy(lastRun.started_at?.slice(0, 10) ?? null)}` : overview.isLoading ? "…" : "chưa có"}</b>
          <span>Máy tự chạy mỗi giờ (phút 15).</span>
          {lastRun?.error ? <p className="d3-kho-error">Lần chạy lỗi: {lastRun.error}</p> : null}
          {canDecide ? (
            <Button variant="outline" size="sm" disabled={refresh.isPending} onClick={() => void rerun()} data-bmq-cogs-rerun>
              <RefreshCw className={cn("h-4 w-4", refresh.isPending && "animate-spin")} />
              {refresh.isPending ? "Đang chạy…" : "Chạy lại"}
            </Button>
          ) : null}
        </div>
      </section>

      <section className="d3-wh-kpis d3-cogs-cover" aria-label="Doanh thu nối được công thức">
        {overview.isLoading
          ? [0, 1, 2].map((k) => <div key={k} className="d3-wh-kpi d3-cogs-skel" aria-hidden />)
          : coverage.map((row, k) => {
              const tone = row.mapped_value_pct >= 95 ? "is-good" : row.mapped_value_pct >= 50 ? "is-mid" : "is-low";
              return (
                <div key={row.channel} className={cn("d3-wh-kpi d3-cogs-tile", tone)} style={{ ["--i" as string]: k }} data-bmq-cogs-cover={row.channel}>
                  <span>{row.channel}</span>
                  <strong>{pct(row.mapped_value_pct)}</strong>
                  <small>{row.mapped_lines}/{row.lines} dòng nối được công thức · {money(row.value)}</small>
                  <i className="d3-cogs-bar" aria-hidden><i style={{ width: `${Math.min(100, Math.max(0, row.mapped_value_pct))}%` }} /></i>
                </div>
              );
            })}
      </section>

      <section className="d3-wh-card" data-bmq-cogs-gaps>
        <div className="d3-wh-card-h">
          <h2>Cần chọn</h2>
          <span className="d3-wh-pill">{overview.isLoading ? "…" : gapTotal}</span>
          <p>
            {canDecide
              ? "Máy không đoán những chỗ này. Chọn một lần, máy nhớ cho các đơn sau."
              : "Máy không đoán những chỗ này. Người có quyền sửa kho chọn một lần, máy nhớ cho các đơn sau."}
          </p>
        </div>
        {overview.isLoading ? (
          <div className="d3-wh-empty">Đang tải…</div>
        ) : gapTotal === 0 ? (
          <div className="d3-wh-empty d3-cogs-allset"><Check className="h-4 w-4" /> Mọi đơn trong kỳ đều tìm được công thức và món kho.</div>
        ) : (
          <ul className="d3-cogs-gaps">
            {gaps.ingredients.map((gap) => (
              <li key={`i:${gap.canonical_material_id}:${gap.recipe_unit}`}>
                <button type="button" className="d3-cogs-gap" disabled={!canDecide} onClick={() => setIngredientGap(gap)} data-bmq-cogs-gap="ingredient">
                  <PackageSearch className="h-5 w-5" aria-hidden />
                  <span>
                    <b>{gap.material_name || "Nguyên liệu chưa rõ"} <em>· {gap.recipe_unit}</em></b>
                    <small>{ingredientReasonText(gap)}</small>
                    <small className="d3-cogs-gap-use">Dùng trong {gap.sku_codes.join(", ") || "—"}</small>
                  </span>
                  {canDecide ? <ArrowRight className="h-4 w-4" aria-hidden /> : null}
                </button>
              </li>
            ))}
            {gaps.products.map((gap) => (
              <li key={`p:${gap.map_id ?? gap.name}:${gap.channel}`}>
                <button type="button" className="d3-cogs-gap" disabled={!canDecide} onClick={() => setProductGap(gap)} data-bmq-cogs-gap="product">
                  <BookOpen className="h-5 w-5" aria-hidden />
                  <span>
                    <b>{gap.name || gap.product_code || "Sản phẩm chưa rõ"}</b>
                    <small>Chưa biết là sản phẩm nào · {gap.channel}{gap.product_code ? ` · mã ${gap.product_code}` : ""}</small>
                    <small className="d3-cogs-gap-use">{gap.lines} dòng · {gap.qty.toLocaleString("vi-VN")} · {money(gap.value)}</small>
                  </span>
                  {canDecide ? <ArrowRight className="h-4 w-4" aria-hidden /> : null}
                </button>
              </li>
            ))}
            {gaps.recipes.map((gap) => (
              <li key={`r:${gap.sku_code}`}>
                <Link to="/sku-costs/management" className="d3-cogs-gap" data-bmq-cogs-gap="recipe">
                  <BookOpen className="h-5 w-5" aria-hidden />
                  <span>
                    <b>{gap.name || gap.sku_code}</b>
                    <small>Chưa có công thức giá vốn: nhập trong Giá vốn.</small>
                    <small className="d3-cogs-gap-use">{gap.sku_code} · {gap.lines} dòng doanh thu</small>
                  </span>
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="d3-wh-card" data-bmq-cogs-items>
        <div className="d3-wh-card-h">
          <h2>So số theo nguyên liệu</h2>
          <div className="d3-sl-switch d3-cogs-khotabs" role="tablist" aria-label="Chọn kho">
            {(["q7", "tan_tao"] as CogsLocation[]).map((location) => (
              <button
                key={location}
                type="button"
                role="tab"
                aria-selected={kho === location}
                className={cn(kho === location && "is-on")}
                onClick={() => setKho(location)}
                data-bmq-cogs-kho-tab={location}
              >
                {KHO_LABEL[location]} <small>{countBy(location)}</small>
              </button>
            ))}
          </div>
          <p>Theo giá vốn: lượng công thức của đơn đã bán, đổi ra đơn vị kho. Phiếu xuất: lượng phiếu xuất NVL đã trừ. Bấm từng món để xem đơn nào đã dùng.</p>
        </div>
        {overview.isLoading ? (
          <div className="d3-wh-empty">Đang tính…</div>
        ) : items.length === 0 ? (
          <div className="d3-wh-empty">Chưa có nguyên liệu nào của Kho {KHO_LABEL[kho]} được tính trong kỳ này.</div>
        ) : (
          <ul className="d3-pu-list">
            {items.map((item) => {
              const diff = recipeVsIssuePct(item);
              return (
                <li key={`${item.location}:${item.item_id}`} className="d3-pu-item" data-bmq-cogs-item>
                  <button type="button" className="d3-pu-row" onClick={() => setTraceItem(item)}>
                    <span className="d3-pu-name">
                      <strong>{item.name}</strong>
                      <span className="d3-pu-meta">
                        {item.recipe_qty <= 0 ? (
                          <span className="d3-pu-chip is-grey" data-bmq-cogs-diff="none">Không có trong công thức đã nối</span>
                        ) : diff === null ? (
                          <span className="d3-pu-chip is-grey">Chưa có phiếu xuất để so</span>
                        ) : (
                          <span className={cn("d3-pu-chip", Math.abs(diff) <= 10 ? "is-green" : Math.abs(diff) <= 30 ? "is-amber" : "is-red")} data-bmq-cogs-diff={diff}>
                            {diff === 0 ? "Bằng phiếu xuất" : `${diff > 0 ? "Cao" : "Thấp"} hơn phiếu xuất ${Math.abs(diff)}%`}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="d3-pu-total d3-cogs-total">
                      <span><small>Theo giá vốn</small><b>{item.recipe_qty > 0 ? fmtAmount(item.recipe_qty, item.unit) : "—"}</b></span>
                      <span><small>Phiếu xuất</small><b>{item.pxk_usage > 0 ? fmtAmount(item.pxk_usage, item.unit) : "—"}</b></span>
                      <span><small>Đã trừ sổ</small><b>{item.posted_cogs > 0 ? fmtAmount(item.posted_cogs, item.unit) : "—"}</b></span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {enableFor ? (
        <EnableDialog setting={enableFor} onClose={() => setEnableFor(null)} onDone={(text) => { say(text); setEnableFor(null); }} />
      ) : null}
      {productGap && data ? (
        <ProductDialog gap={productGap} overview={data} onClose={() => setProductGap(null)} onDone={(text) => { say(text); setProductGap(null); }} />
      ) : null}
      {ingredientGap ? (
        <IngredientDialog gap={ingredientGap} onClose={() => setIngredientGap(null)} onDone={(text) => { say(text); setIngredientGap(null); }} />
      ) : null}
      {traceItem ? <ItemTraceDialog item={traceItem} range={range} onClose={() => setTraceItem(null)} /> : null}
      {dialog}
    </div>
  );
}
