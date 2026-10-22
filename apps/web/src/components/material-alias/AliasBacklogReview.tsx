import { CrateDocEvidence } from "@/components/DocEvidence";
import { useMemo, useState } from "react";
import { OptionPicker } from "@/components/OptionPicker";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY,
  useConfirmMaterialAlias,
  useCreateStockMaterialItem,
  useMaterialAliasBacklogReview,
  useRunAliasBacklog,
} from "@/hooks/useMaterialAlias";
import type { MaterialAliasBacklogReviewRow } from "@/lib/material-alias";
import type { MaterialAliasLocation } from "@/hooks/useMaterialAlias";
import {
  cleanNewItemName,
  defaultNewItemUnit,
  NEW_ITEM_OPTION,
  NewStockItemFields,
  packFactorFor,
  useStockCatalogItems,
  type StockCatalogItem,
} from "./new-stock-item";
import { LoadingState } from "@/components/ui/loading";
import "@/styles/bmq-material-alias.css";

const PAGE = 15;

const pct = (value: number) => `${Math.round(value * 100)}%`;

const shortDate = (iso: string | null | undefined) => {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}` : iso;
};

const errorText = (error: unknown) => {
  const message = String((error as { message?: string })?.message ?? error);
  if (message.includes("forbidden") || message.includes("insufficient_privilege")) return "Chỉ chủ hoặc người có quyền sửa kho Q7 làm được việc này.";
  if (message.includes("daily") || message.includes("quota")) return "Đã hết hạn mức gọi Sushi hôm nay. Chọn tay vẫn được.";
  if (message.includes("kill")) return "Sushi đang bị tắt bằng công tắc khẩn.";
  return message;
};

type Filter = "suggested" | "missing" | "all";

/** Select value: a shared NVL item id, or "sku:<id>" for a Tân Tạo finished-goods SKU. */
const SKU_PREFIX = "sku:";
const jevChoice = (row: MaterialAliasBacklogReviewRow) =>
  row.jev_item_id ? (row.jev_is_sku ? SKU_PREFIX + row.jev_item_id : row.jev_item_id) : null;
const topChoice = (row: MaterialAliasBacklogReviewRow) =>
  row.top_candidate?.item_id ?? (row.top_candidate?.sku_id ? SKU_PREFIX + row.top_candidate.sku_id : null);

/** Jev / exact-name pick the reviewer can accept as is. */
function suggestedItem(row: MaterialAliasBacklogReviewRow): string | null {
  if (row.jev_item_id && (row.jev_source === "exact" || (row.jev_probability ?? 0) >= 0.5)) return jevChoice(row);
  if (!row.jev_source && row.top_candidate?.reason.startsWith("name_exact")) return topChoice(row);
  return null;
}

function suggestionPill(row: MaterialAliasBacklogReviewRow) {
  if (row.jev_source === "exact") return <span className="d3-sc-prob is-high">Trùng tên</span>;
  if (row.jev_source === "rule") return <span className="d3-sc-prob">VAT/phí</span>;
  if (row.jev_source === "jev" || row.jev_source === "none") {
    if (!row.jev_item_id) return <span className="d3-sc-warn">Sushi: chưa có mã</span>;
    const p = row.jev_probability ?? 0;
    return <span className={`d3-sc-prob${p >= 0.9 ? " is-high" : p < 0.7 ? " is-low" : ""}`}>Sushi {pct(p)}</span>;
  }
  if (!row.top_candidate) return <span className="d3-sc-warn">Chưa có trong danh mục</span>;
  return <span className="d3-sc-prob">Chưa dò</span>;
}

function BacklogRow({
  row,
  catalog,
  location,
  onDone,
}: {
  row: MaterialAliasBacklogReviewRow;
  catalog: StockCatalogItem[];
  location: MaterialAliasLocation;
  onDone: (label: string) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const confirm = useConfirmMaterialAlias();
  const create = useCreateStockMaterialItem();
  const [requestId] = useState(() => crypto.randomUUID());
  const suggested = suggestedItem(row);
  const noCandidate = !row.top_candidate && !row.jev_item_id;
  const [choice, setChoice] = useState(suggested ?? (noCandidate ? NEW_ITEM_OPTION : ""));
  const [newName, setNewName] = useState(() => cleanNewItemName(row.raw_name));
  const [newUnit, setNewUnit] = useState(() => defaultNewItemUnit(row.raw_name, row.raw_unit));
  const [packEdit, setPackEdit] = useState<{ label: string; factor: string } | null>(null);

  const isNew = choice === NEW_ITEM_OPTION;
  const isSku = choice.startsWith(SKU_PREFIX);
  const item = catalog.find((entry) => entry.id === choice)
    ?? (choice && choice === jevChoice(row) ? { id: choice, name: row.jev_item_name ?? "", unit: row.jev_unit ?? "" } : null)
    ?? (choice && choice === topChoice(row) && row.top_candidate ? { id: choice, name: row.top_candidate.name, unit: row.top_candidate.unit } : null);
  const stockUnit = isNew ? newUnit.trim() : item?.unit ?? "";
  // Until the reviewer edits it, the pack follows the chosen item's unit.
  const pack = packFactorFor(row.raw_name, stockUnit);
  const label = packEdit?.label ?? pack?.label ?? stockUnit;
  const factorText = packEdit?.factor ?? String(pack?.factor ?? 1);
  const factor = Number(factorText.replace(",", "."));
  const factorOk = Number.isFinite(factor) && factor > 0;
  const busy = confirm.isPending || create.isPending;
  const ready = factorOk && (isNew ? newName.trim().length >= 2 && stockUnit.length > 0 : Boolean(item));

  const finish = (title: string, text: string) => {
    toast({ title, description: `${row.raw_name} → ${text}` });
    void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY] });
    onDone(text);
  };
  const fail = (title: string) => (error: unknown) => toast({ title, description: errorText(error), variant: "destructive" });

  const confirmWith = (target: string | null, itemName: string, lineClass: "stock" | "non_stock") =>
    confirm.mutate(
      {
        supplierId: row.supplier_id,
        location,
        rawName: row.raw_name,
        rawUnit: null,
        kitchenInventoryItemId: target && !target.startsWith(SKU_PREFIX) ? target : null,
        tanTaoSkuId: target && target.startsWith(SKU_PREFIX) ? target.slice(SKU_PREFIX.length) : null,
        enteredUnitLabel: lineClass === "stock" ? label.trim() || null : null,
        conversionFactor: lineClass === "stock" ? factor : 1,
        jevItemId: row.jev_item_id,
        jevProbability: row.jev_probability,
        sourceTable: "alias_backlog_review",
        sourceId: null,
        lineClass,
      },
      {
        onSuccess: (data) => {
          const status = String((data as { alias?: { status?: string } })?.alias?.status ?? "");
          finish(lineClass === "non_stock" ? "Đã đánh dấu không nhập kho" : status === "auto" ? "Đã ghi nhớ, lần sau tự chọn" : "Đã xác nhận", itemName);
        },
        onError: fail("Chưa xác nhận được"),
      },
    );

  const save = () => {
    if (!ready) return;
    if (!isNew && item) {
      confirmWith(item.id, item.name, "stock");
      return;
    }
    create.mutate(
      { name: newName.trim(), unit: stockUnit, location, requestId },
      {
        onSuccess: (result) => {
          void queryClient.invalidateQueries({ queryKey: ["stock-catalog-items"] });
          if (!result.created) toast({ title: "Mặt hàng đã có sẵn", description: `Dùng lại "${newName.trim()}".` });
          confirmWith(result.item_id, newName.trim(), "stock");
        },
        onError: fail("Chưa tạo được mặt hàng"),
      },
    );
  };

  const jevId = jevChoice(row);
  const topId = topChoice(row);
  const skuTag = (id: string | null) => (id?.startsWith(SKU_PREFIX) ? " · thành phẩm" : "");
  const suggestions = [
    jevId ? { id: jevId, name: row.jev_item_name ?? "—", unit: row.jev_unit ?? "", tag: (row.jev_source === "exact" ? " · trùng tên" : ` · Sushi ${pct(row.jev_probability ?? 0)}`) + skuTag(jevId) } : null,
    topId && topId !== jevId && row.top_candidate
      ? { id: topId, name: row.top_candidate.name, unit: row.top_candidate.unit, tag: " · gần nhất" + skuTag(topId) }
      : null,
  ].filter((entry): entry is { id: string; name: string; unit: string; tag: string } => entry !== null);
  const suggestionIds = new Set(suggestions.map((entry) => entry.id));

  return (
    <li className="d3-ma-row" data-bmq-alias-backlog-row>
      <div className="d3-ab-row-h">
        <div className="d3-ma-raw">
          <strong>{row.raw_name}</strong>
          <small>
            {row.line_count} dòng · {row.supplier_name ?? "chưa rõ NCC"}
            {row.last_receipt_date ? ` · ${shortDate(row.last_receipt_date)}` : ""}
          </small>
        </div>
        {suggestionPill(row)}
      </div>
      <div className="d3-ab-form">
        <label className="d3-ma-field d3-ma-item">
          <span>{isSku ? "Thành phẩm (SKU)" : "Mặt hàng trong kho"}</span>
          <OptionPicker
            value={choice}
            onChange={(value) => { setChoice(value); setPackEdit(null); }}
            title={`Mặt hàng kho cho “${row.raw_name}”`}
            ariaLabel={`Mặt hàng kho cho ${row.raw_name}`}
            options={[
              ...suggestions.map((entry) => ({ value: entry.id, label: `${entry.name} (${entry.unit})${entry.tag}`, group: "Gợi ý" })),
              ...catalog.filter((entry) => !suggestionIds.has(entry.id)).map((entry) => ({ value: entry.id, label: `${entry.name} (${entry.unit})`, group: "Tất cả mặt hàng" })),
              { value: NEW_ITEM_OPTION, label: "+ Tạo mặt hàng mới…", group: "Món mới" },
            ]}
          />
        </label>
        {isNew ? (
          <NewStockItemFields name={newName} unit={newUnit} onName={setNewName} onUnit={setNewUnit} idPrefix={`ab-${requestId}`} />
        ) : null}
        <label className="d3-ma-field">
          <span>Đơn vị nhập</span>
          <Input value={label} onChange={(event) => setPackEdit({ label: event.target.value, factor: factorText })} placeholder="bao 25kg" aria-label="Đơn vị trên phiếu nhập" />
        </label>
        <label className="d3-ma-field">
          <span>1 {label.trim() || "đv"} = ? {stockUnit || "đv kho"}</span>
          <Input inputMode="decimal" value={factorText} onChange={(event) => setPackEdit({ label, factor: event.target.value })} aria-label="Hệ số đổi sang đơn vị kho" />
        </label>
        <CrateDocEvidence location={location} supplierId={row.supplier_id} normalizedName={row.normalized_name} />
        <div className="d3-ma-actions">
          <Button type="button" size="sm" onClick={save} disabled={!ready || busy}>
            {isNew ? <Plus className="h-4 w-4" /> : <Check className="h-4 w-4" />}
            {busy ? "Đang lưu…" : isNew ? "Tạo và gán" : "Xác nhận"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => confirmWith(null, "không nhập kho", "non_stock")} disabled={busy}>
            Không nhập kho
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => onDone("")} disabled={busy}>
            Để sau
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * Receipt names that still have no stock item, with the exact-name / Jev pick.
 * One confirmation by an owner or Q7 editor makes the alias automatic.
 */
export function AliasBacklogReview({ canEdit, location = "q7" }: { canEdit: boolean; location?: MaterialAliasLocation }) {
  const { toast } = useToast();
  const reviewQuery = useMaterialAliasBacklogReview(location, 200);
  const catalogQuery = useStockCatalogItems(canEdit);
  const backlog = useRunAliasBacklog();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [filter, setFilter] = useState<Filter>("suggested");
  const [shown, setShown] = useState(PAGE);
  const [hidden, setHidden] = useState<Record<string, true>>({});

  const rows = useMemo(
    () => (reviewQuery.data ?? []).filter((row) => !hidden[`${location}|${row.supplier_id}|${row.normalized_name}`]),
    [reviewQuery.data, hidden],
  );
  const suggestedRows = rows.filter((row) => suggestedItem(row) !== null);
  const missingRows = rows.filter((row) => suggestedItem(row) === null);
  const list = filter === "suggested" ? suggestedRows : filter === "missing" ? missingRows : rows;
  const notScanned = rows.filter((row) => !row.jev_source && row.top_candidate).length;

  const scan = () => {
    setProgress({ done: 0, total: 0 });
    backlog.mutate(
      { location, onProgress: (done, total) => setProgress({ done, total }) },
      {
        onSuccess: (data) => {
          const d = data as { stopped?: string | null; usage?: { calls?: number; limit?: number } };
          toast({
            title: d.stopped ? "Sushi dừng vì hết hạn mức hôm nay" : "Sushi đã dò xong",
            description: d.usage ? `Đã dùng ${d.usage.calls ?? 0}/${d.usage.limit ?? 600} lượt hôm nay.` : undefined,
          });
          setProgress(null);
        },
        onError: (error) => {
          toast({ title: "Sushi chưa dò hết", description: errorText(error), variant: "destructive" });
          setProgress(null);
        },
      },
    );
  };

  const tabs: Array<{ id: Filter; label: string; count: number }> = [
    { id: "suggested", label: "Có gợi ý", count: suggestedRows.length },
    { id: "missing", label: "Cần chọn / tạo mới", count: missingRows.length },
    { id: "all", label: "Tất cả", count: rows.length },
  ];

  return (
    <section className="d3-wh-card" style={{ ["--i" as string]: 2 }} data-bmq-alias-backlog>
      <div className="d3-wh-card-h">
        <h2>Tên hàng chờ gán mã</h2>
        <span className="d3-wh-pill">{reviewQuery.data ? rows.length : "…"}</span>
        <p>
          Tên trên phiếu nhập chưa có mặt hàng kho. Kế toán hoặc chủ xác nhận một lần là lần sau tự chọn. Dòng ghi kg, g, l, ml tự đổi theo đơn vị; hệ số chỉ dùng khi phiếu ghi bao, thùng, gói…
          {notScanned ? ` ${notScanned} tên chưa dò bằng Sushi.` : ""}
        </p>
        {canEdit ? (
          <button type="button" className="d3-ap-link d3-ab-scan" disabled={backlog.isPending} onClick={scan} data-bmq-alias-backlog-scan>
            <Sparkles className="h-3.5 w-3.5" />
            {backlog.isPending ? "Sushi đang dò…" : "Dò tên tồn đọng"}
          </button>
        ) : null}
      </div>

      {progress ? (
        <div className="d3-ab-progress" role="status" aria-live="polite" data-bmq-alias-backlog-progress>
          <span className="d3-ab-bar"><i style={{ width: progress.total ? `${Math.round((progress.done / progress.total) * 100)}%` : "4%" }} /></span>
          <small>{progress.total ? `Đã dò ${progress.done}/${progress.total} tên` : "Đang bắt đầu…"}</small>
        </div>
      ) : null}

      {reviewQuery.isLoading ? (
        <LoadingState label="Đang tải…" />
      ) : reviewQuery.isError ? (
        <div className="d3-wh-empty">{errorText(reviewQuery.error)}</div>
      ) : rows.length === 0 ? (
        <div className="d3-wh-empty">Mọi tên trên phiếu nhập đã có mặt hàng kho.</div>
      ) : (
        <>
          <div className="d3-ab-tabs" role="tablist">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={filter === tab.id}
                className={filter === tab.id ? "is-on" : ""}
                onClick={() => { setFilter(tab.id); setShown(PAGE); }}
              >
                {tab.label} <b>{tab.count}</b>
              </button>
            ))}
          </div>
          {list.length === 0 ? (
            <div className="d3-wh-empty">Không còn tên nào trong mục này.</div>
          ) : canEdit ? (
            <ul className="d3-ma-list">
              {list.slice(0, shown).map((row) => (
                <BacklogRow
                  key={`${location}|${row.supplier_id}|${row.normalized_name}`}
                  row={row}
                  catalog={catalogQuery.data ?? []}
                  location={location}
                  onDone={() => setHidden((current) => ({ ...current, [`${location}|${row.supplier_id}|${row.normalized_name}`]: true }))}
                />
              ))}
            </ul>
          ) : (
            <ul className="d3-sc-list">
              {list.slice(0, shown).map((row) => (
                <li key={`${location}|${row.supplier_id}|${row.normalized_name}`} className="d3-sc-row is-history">
                  <div className="d3-sc-side">
                    <strong>{row.raw_name}</strong>
                    <span>{row.line_count} dòng · {row.jev_item_name ?? row.top_candidate?.name ?? "chưa có gợi ý"}</span>
                  </div>
                  {suggestionPill(row)}
                </li>
              ))}
            </ul>
          )}
          {list.length > shown ? (
            <Button type="button" variant="outline" className="d3-ab-more" onClick={() => setShown((n) => n + PAGE)}>
              Xem thêm {Math.min(PAGE, list.length - shown)} / còn {list.length - shown}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
