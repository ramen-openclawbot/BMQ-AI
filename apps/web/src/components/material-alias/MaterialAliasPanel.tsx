import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Pencil, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  useConfirmMaterialAlias,
  useCreateStockMaterialItem,
  useSuggestMaterialAliases,
  type MaterialAliasLocation,
} from "@/hooks/useMaterialAlias";
import { cleanNewItemName, defaultNewItemUnit, NEW_ITEM_OPTION, NewStockItemFields, unitFactor } from "./new-stock-item";
import type { MaterialAliasSuggestion } from "@/lib/material-alias";
import { toast } from "sonner";
import "@/styles/bmq-material-alias.css";

export interface MaterialAliasPanelLine {
  product_name: string;
  unit?: string | null;
}

/** What still blocks saving: lines that must be answered, or a lookup in flight. */
export interface MaterialAliasGate {
  pending: number;
  loading: boolean;
}

export const OPEN_MATERIAL_ALIAS_GATE: MaterialAliasGate = { pending: 0, loading: false };

/**
 * Owner decision 2026-10-11: every new line must be answered (kho item, Không
 * nhập kho or Chưa rõ) before a PO / phiếu chi is saved. Returns true when the
 * save must stop; scrolls to the panel and explains why.
 */
export function blockSaveForMaterialAlias(gate: MaterialAliasGate, onAttention: () => void): boolean {
  if (!gate.loading && gate.pending === 0) return false;
  onAttention();
  document.querySelector("[data-bmq-alias-panel]")?.scrollIntoView({ behavior: "smooth", block: "center" });
  toast.error(
    gate.loading
      ? "Đang dò mặt hàng kho, chờ 1 giây rồi bấm lưu lại."
      : `Còn ${gate.pending} dòng chưa chọn mặt hàng kho. Chọn mặt hàng, Không nhập kho hoặc Chưa rõ rồi lưu lại.`,
  );
  return true;
}

interface Props {
  supplierId: string | null | undefined;
  lines: MaterialAliasPanelLine[];
  /** Table name recorded on each confirmation, e.g. purchase_orders. */
  sourceTable: string;
  location?: MaterialAliasLocation;
  /** Reports what still blocks saving, so the dialog can gate its submit. */
  onGateChange?: (gate: MaterialAliasGate) => void;
  /** Bumped by the dialog when a save was blocked; highlights the open lines. */
  attention?: number;
}

const NON_STOCK_LABELS: Record<string, string> = { vat: "VAT", fee: "phí", service: "dịch vụ", jev: "Jev: phí/dịch vụ" };

const pct = (value: number) => `${Math.round(value * 100)}%`;

const errorText = (error: unknown) => {
  const message = String((error as { message?: string })?.message ?? error);
  if (message.includes("insufficient_privilege")) return "Tài khoản chưa có quyền xác nhận mặt hàng kho.";
  if (message.includes("daily") || message.includes("quota")) return "Đã hết hạn mức gọi Jev hôm nay, chọn tay vẫn được.";
  return message;
};

/** Jev's chosen candidate id, if its answer names one of the listed candidates. */
function jevChoice(row: MaterialAliasSuggestion): { id: string; probability: number } | null {
  const jev = row.jev;
  if (!jev) return null;
  const id = typeof jev.item_id === "string" ? jev.item_id : typeof jev.choice === "string" ? jev.choice : null;
  const probability = Number(jev.probability);
  if (!id || !Number.isFinite(probability)) return null;
  return row.candidates.some((candidate) => candidate.id === id) ? { id, probability } : null;
}

function PromptRow({
  row,
  line,
  supplierId,
  location,
  sourceTable,
  onDone,
  canMarkNonStock,
}: {
  row: MaterialAliasSuggestion;
  line: MaterialAliasPanelLine;
  supplierId: string | null;
  location: MaterialAliasLocation;
  sourceTable: string;
  onDone: (status: "confirmed" | "skipped", label: string) => void;
  /** Owner decision 2026-10-11: purchased goods must be received; only owners / Q7 editors may mark a line non-stock. */
  canMarkNonStock: boolean;
}) {
  const { toast } = useToast();
  const confirm = useConfirmMaterialAlias();
  const create = useCreateStockMaterialItem();
  const [requestId] = useState(() => crypto.randomUUID());
  const [newName, setNewName] = useState(() => cleanNewItemName(line.product_name));
  const [newUnit, setNewUnit] = useState(() => defaultNewItemUnit(line.product_name, line.unit));
  const jev = jevChoice(row);
  const preselected = row.alias?.item_id ?? row.alias?.sku_id ?? jev?.id ?? row.candidates[0]?.id ?? "";
  const [choice, setChoice] = useState(preselected);
  const [unitLabel, setUnitLabel] = useState(row.alias?.pack_label ?? row.pack_guess?.pack_label ?? line.unit ?? "");
  const [factor, setFactor] = useState(
    String(row.alias?.conversion_factor ?? (row.pack_guess?.pack_size && row.pack_guess.pack_size > 0 ? row.pack_guess.pack_size : 1)),
  );
  const isNew = choice === NEW_ITEM_OPTION;
  const candidate = row.candidates.find((item) => item.id === choice) ?? null;
  const stockUnit = isNew ? newUnit.trim() : candidate?.unit ?? "";
  // A kg / g / l / ml line converts by its own unit when it is posted, so no factor is asked.
  const autoFactor = unitFactor(line.unit, stockUnit);
  const factorValue = autoFactor ?? Number(factor.replace(",", "."));
  const factorOk = Number.isFinite(factorValue) && factorValue > 0;
  const busy = confirm.isPending || create.isPending;
  const ready = factorOk && (isNew ? newName.trim().length >= 2 && stockUnit.length > 0 : Boolean(candidate));

  const saveNonStock = () => {
    confirm.mutate(
      {
        supplierId,
        location,
        rawName: line.product_name,
        rawUnit: line.unit ?? null,
        kitchenInventoryItemId: null,
        tanTaoSkuId: null,
        enteredUnitLabel: unitLabel.trim() || null,
        conversionFactor: 1,
        jevItemId: jev?.id ?? null,
        jevProbability: jev?.probability ?? null,
        sourceTable,
        sourceId: null,
        lineClass: "non_stock",
      },
      {
        onSuccess: () => {
          toast({ title: "Đã đánh dấu không nhập kho", description: line.product_name });
          onDone("confirmed", "không nhập kho");
        },
        onError: (error) => toast({ title: "Chưa đánh dấu được", description: errorText(error), variant: "destructive" }),
      },
    );
  };

  const confirmItem = (target: { item_id: string | null; sku_id: string | null; name: string }) => {
    confirm.mutate(
      {
        supplierId,
        location,
        rawName: line.product_name,
        rawUnit: line.unit ?? null,
        kitchenInventoryItemId: target.item_id,
        tanTaoSkuId: target.sku_id,
        enteredUnitLabel: autoFactor !== null ? line.unit ?? null : unitLabel.trim() || null,
        conversionFactor: factorValue,
        jevItemId: jev?.id ?? null,
        jevProbability: jev?.probability ?? null,
        sourceTable,
        sourceId: null,
      },
      {
        onSuccess: (data) => {
          const status = String((data as { alias?: { status?: string } })?.alias?.status ?? "learning");
          toast({
            title: status === "auto" ? "Đã ghi nhớ, lần sau tự chọn" : "Đã xác nhận",
            description: `${line.product_name} → ${target.name}`,
          });
          onDone("confirmed", target.name);
        },
        onError: (error) => toast({ title: "Chưa xác nhận được", description: errorText(error), variant: "destructive" }),
      },
    );
  };

  const save = () => {
    if (!ready) return;
    if (!isNew) {
      if (candidate) confirmItem(candidate);
      return;
    }
    // Owner / Q7 editor only: the goods are not in the catalog yet.
    create.mutate(
      { name: newName.trim(), unit: stockUnit, location, requestId },
      {
        onSuccess: (result) => confirmItem({ item_id: result.item_id, sku_id: null, name: newName.trim() }),
        onError: (error) => toast({ title: "Chưa tạo được mặt hàng", description: errorText(error), variant: "destructive" }),
      },
    );
  };

  return (
    <li className="d3-ma-row" data-bmq-alias-prompt>
      <div className="d3-ma-raw">
        <strong>{line.product_name}</strong>
        <small>
          {line.unit ? `đơn vị trên hóa đơn: ${line.unit}` : "chưa có đơn vị"}
          {row.alias && row.alias.status !== "auto" ? ` · đã xác nhận ${row.alias.confirm_count}/3` : ""}
        </small>
      </div>
      <div className={`d3-ma-form${isNew ? " is-new" : ""}`}>
        <label className="d3-ma-field d3-ma-item">
          <span>Mặt hàng trong kho</span>
          <select className="d3-wh-select" value={choice} onChange={(event) => setChoice(event.target.value)} aria-label={`Mặt hàng kho cho ${line.product_name}`}>
            <option value="">Chọn…</option>
            {row.candidates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.unit}){jev && jev.id === item.id ? ` · Jev ${pct(jev.probability)}` : ""}
              </option>
            ))}
            {canMarkNonStock ? <option value={NEW_ITEM_OPTION}>+ Tạo mặt hàng mới…</option> : null}
          </select>
        </label>
        {isNew ? (
          <NewStockItemFields name={newName} unit={newUnit} onName={setNewName} onUnit={setNewUnit} idPrefix={`ma-${requestId}`} />
        ) : null}
        {autoFactor !== null ? (
          <p className="d3-ma-field d3-ma-auto" data-bmq-alias-autounit>
            <span>Đổi đơn vị</span>
            <strong>1 {line.unit} = {autoFactor.toLocaleString("vi-VN")} {stockUnit} · tự đổi</strong>
          </p>
        ) : (
          <>
            <label className="d3-ma-field">
              <span>Đơn vị nhập</span>
              <Input value={unitLabel} onChange={(event) => setUnitLabel(event.target.value)} placeholder="bao 25kg" aria-label="Đơn vị nhân viên nhập" />
            </label>
            <label className="d3-ma-field">
              <span>1 {unitLabel.trim() || "đv"} = ? {stockUnit || "đv kho"}</span>
              <Input inputMode="decimal" value={factor} onChange={(event) => setFactor(event.target.value)} aria-label="Hệ số đổi sang đơn vị kho" />
            </label>
          </>
        )}
        <div className="d3-ma-actions">
          <Button type="button" size="sm" onClick={save} disabled={!ready || busy}>
            {isNew ? <Plus className="h-4 w-4" /> : <Check className="h-4 w-4" />}
            {busy ? "Đang lưu…" : isNew ? "Tạo và gán" : "Xác nhận"}
          </Button>
          {canMarkNonStock ? (
            <Button type="button" size="sm" variant="outline" onClick={saveNonStock} disabled={busy} data-bmq-alias-nonstock>
              Không nhập kho
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" onClick={() => onDone("skipped", "")} disabled={busy}>
            Chưa rõ
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * Learn-as-you-go picker shown under the item list of PO / payment request
 * dialogs. Lines whose alias is already auto show a chip; the rest ask once.
 */
export function MaterialAliasPanel({ supplierId, lines, sourceTable, location = "q7", onGateChange, attention = 0 }: Props) {
  const suggest = useSuggestMaterialAliases();
  const { isOwner, canEditModule } = useAuth();
  const canMarkNonStock = isOwner || canEditModule("q7_material_inventory");
  const [rows, setRows] = useState<MaterialAliasSuggestion[]>([]);
  const [done, setDone] = useState<Record<string, { status: "confirmed" | "skipped"; label: string }>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const lastKey = useRef("");

  const named = useMemo(
    () => lines.map((line, index) => ({ index, line })).filter(({ line }) => line.product_name.trim().length >= 2),
    [lines],
  );
  const key = `${supplierId ?? ""}|${location}|${named.map(({ index, line }) => `${index}:${line.product_name.trim().toLowerCase()}:${(line.unit ?? "").trim().toLowerCase()}`).join("|")}`;

  useEffect(() => {
    if (!supplierId || named.length === 0 || key === lastKey.current) return;
    const timer = window.setTimeout(() => {
      lastKey.current = key;
      setDone({});
      setEditing({});
      suggest.mutate(
        {
          supplierId,
          location,
          lines: named.map(({ index, line }) => ({ line_key: String(index), raw_name: line.product_name.trim(), raw_unit: line.unit?.trim() || null })),
        },
        { onSuccess: setRows, onError: () => setRows([]) },
      );
    }, 700);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, supplierId, named.length]);

  const byKey = new Map(named.map(({ index, line }) => [String(index), line] as const));
  const prompts = rows.filter((row) => (row.needs_prompt || editing[row.line_key]) && !done[row.line_key] && byKey.has(row.line_key));
  // A lookup is in flight while the debounced key has not been fetched yet; a
  // failed lookup never blocks saving (staff without access, network errors).
  const active = Boolean(supplierId) && named.length > 0;
  const gateLoading = active && !suggest.isError && (key !== lastKey.current || suggest.isPending);
  const gatePending = active && !gateLoading ? prompts.length : 0;
  useEffect(() => {
    onGateChange?.({ pending: gatePending, loading: gateLoading });
  }, [gatePending, gateLoading, onGateChange]);

  if (!supplierId || named.length === 0) return null;

  const autos = rows.filter((row) => !row.needs_prompt && !row.auto_non_stock && !editing[row.line_key] && !done[row.line_key] && row.alias && byKey.has(row.line_key));
  // VAT, phí vận chuyển, dịch vụ: recognised automatically, never asked, never block saving.
  const nonStock = rows.filter((row) => row.auto_non_stock && byKey.has(row.line_key));
  const confirmed = Object.entries(done).filter(([, value]) => value.status === "confirmed");

  if (suggest.isPending && rows.length === 0) {
    return (
      <div className="d3-ma" data-bmq-alias-panel="loading">
        <span className="d3-ma-note"><Sparkles className="h-3.5 w-3.5" /> Đang dò mặt hàng kho cho {named.length} dòng…</span>
      </div>
    );
  }
  if (suggest.isError && rows.length === 0) {
    return (
      <div className="d3-ma" data-bmq-alias-panel="error">
        <span className="d3-ma-note is-error">Không dò được mặt hàng kho: {errorText(suggest.error)}. Phiếu vẫn lưu được; kế toán gán mã sau ở Sổ tồn NVL.</span>
      </div>
    );
  }
  if (rows.length === 0) return null;

  return (
    <div className={`d3-ma${attention > 0 && prompts.length ? " is-attention" : ""}`} key={prompts.length ? `att-${attention}` : "ok"} data-bmq-alias-panel={prompts.length ? "prompt" : "auto"}>
      <div className="d3-ma-head">
        <strong>Mặt hàng kho</strong>
        <small>
          {prompts.length ? `${prompts.length} dòng cần chọn trước khi lưu` : "Mọi dòng đã nhận diện"}
          {autos.length ? ` · ${autos.length} tự chọn` : ""}
          {nonStock.length ? ` · ${nonStock.length} VAT/phí bỏ qua` : ""}
          {confirmed.length ? ` · ${confirmed.length} vừa xác nhận` : ""}
        </small>
      </div>
      {prompts.length ? (
        <ul className="d3-ma-list">
          {prompts.map((row) => (
            <PromptRow
              key={`${row.line_key}:${row.candidates_hash}`}
              row={row}
              line={byKey.get(row.line_key) as MaterialAliasPanelLine}
              supplierId={supplierId}
              location={location}
              sourceTable={sourceTable}
              canMarkNonStock={canMarkNonStock}
              onDone={(status, label) => {
                setDone((current) => ({ ...current, [row.line_key]: { status, label } }));
                setEditing((current) => ({ ...current, [row.line_key]: false }));
              }}
            />
          ))}
        </ul>
      ) : null}
      {autos.length || confirmed.length || nonStock.length ? (
        <div className="d3-ma-chips">
          {nonStock.map((row) => (
            <span key={`ns-${row.line_key}`} className="d3-ma-chip is-nonstock" data-bmq-alias-autononstock>
              {byKey.get(row.line_key)?.product_name} · {NON_STOCK_LABELS[row.auto_non_stock?.reason ?? "jev"]} — không nhập kho
            </span>
          ))}
          {autos.map((row) => (
            <button
              key={row.line_key}
              type="button"
              className="d3-ma-chip"
              data-bmq-alias-auto
              onClick={() => setEditing((current) => ({ ...current, [row.line_key]: true }))}
              title="Bấm để sửa"
            >
              <Check className="h-3 w-3" />
              {byKey.get(row.line_key)?.product_name} → {row.alias?.line_class === "non_stock" ? "không nhập kho" : row.alias?.item_name}
              <Pencil className="h-3 w-3 d3-ma-edit" />
            </button>
          ))}
          {confirmed.map(([lineKey, value]) => (
            <span key={lineKey} className="d3-ma-chip is-new" data-bmq-alias-confirmed>
              <Check className="h-3 w-3" />
              {byKey.get(lineKey)?.product_name} → {value.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
