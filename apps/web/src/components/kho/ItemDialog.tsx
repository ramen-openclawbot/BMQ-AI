import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { KHO_ITEMS_QUERY_KEY, useKhoSaveItem } from "@/hooks/useKhoItems";
import { useItemReceiptLines, useSetItemPastryQ7, useSetStockItemClass } from "@/hooks/useWarehouseGame";
import { khoErrorText, searchKey, standardUnitFactor, type KhoItem, type KhoLocation, type KhoSaveResult } from "@/lib/kho-items";
import { cn } from "@/lib/utils";
import { CLASS_OF, GROUPS, KHO_LABEL, KHO_LOCATIONS, fmtAmount, groupOf, newRequestId, parseNum, type Group } from "./kho-meta";
import type { KhoConfirmOptions } from "./KhoConfirm";
import { KhoDialog } from "./KhoDialog";
import { ReceiptNotes } from "./ReceiptNotes";
import { UnitAndConversions } from "./UnitSections";

type Ask = { kind: "merge"; other: { id: string; name: string; unit: string }; from: string; to: string } | { kind: "unit"; from: string; to: string };
type MovableGroup = Exclude<Group, "tp">;

/**
 * One item of the warehouse: one name, its group and kho, on/off, its unit and the conversions of its
 * delivery notes, and every delivery note already filed under the name (owner 22/10: unit, conversions and
 * on/off live here, not on the list). A name taken by another item asks once, then merges the two.
 */
export function ItemDialog({ item, items, canEdit, confirm, onDone, onClose, onToast, onReplaced }: {
  item: KhoItem; items: KhoItem[]; canEdit: boolean;
  confirm: (options: KhoConfirmOptions) => Promise<boolean>;
  onDone: (text: string) => void; onClose: () => void;
  /** A message that keeps the dialog open (unit and conversion saves). */
  onToast: (text: string) => void;
  /** A unit change with history moves the item to a new id. */
  onReplaced: (newId: string) => void;
}) {
  const save = useKhoSaveItem();
  const setClass = useSetStockItemClass();
  const queryClient = useQueryClient();
  const lines = useItemReceiptLines(item.id, true);
  const setPlace = useSetItemPastryQ7();
  const group = groupOf(item);
  const [name, setName] = useState(item.name);
  const unit = item.unit;
  const [active, setActive] = useState(item.active);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [factorText, setFactorText] = useState("");
  const [requestId, setRequestId] = useState(newRequestId);

  const placeTo = (loc: KhoLocation) => {
    if ((loc === "q7") === item.in_q7) return;
    setPlace.mutate(
      { itemId: item.id, value: loc === "q7" },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: [KHO_ITEMS_QUERY_KEY] });
          onDone(`Đã chuyển “${item.name}” sang Kho ${KHO_LABEL[loc]}`);
        },
      },
    );
  };
  const moveTo = (next: MovableGroup) => {
    if (next === group) return;
    setClass.mutate(
      { itemId: item.id, itemClass: CLASS_OF[next] },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: [KHO_ITEMS_QUERY_KEY] });
          onDone(`Đã chuyển “${item.name}” sang ${GROUPS.find((g) => g.id === next)?.label}`);
        },
      },
    );
  };

  // Name already used by another item? Say it before the save; the server decides.
  const twin = useMemo(() => {
    const key = searchKey(name);
    return key && key !== searchKey(item.name) ? items.find((other) => other.id !== item.id && searchKey(other.name) === key) ?? null : null;
  }, [name, items, item]);
  const changed = name.trim() !== item.name || active !== item.active;
  const x = parseNum(factorText);
  const factorOk = Number.isFinite(x) && x > 0;

  const handle = (result: KhoSaveResult, other: { id: string; name: string; unit: string } | null) => {
    if (result.status === "saved") { onDone(`Đã lưu “${result.item.name}” · ${result.item.unit}${result.item.active ? "" : " · đã tắt"}`); return; }
    if (result.status === "merged") { onDone(`Đã gộp “${item.name}” vào “${result.into.name}”`); return; }
    if (result.status === "unit_factor_needed") {
      setRequestId(newRequestId());
      setFactorText("");
      setAsk(other ? { kind: "merge", other, from: result.from, to: result.to } : { kind: "unit", from: result.from, to: result.to });
      return;
    }
    // name_taken: ask once, then merge.
    void confirm({
      title: `Đã có món “${result.other.name}”`,
      message: `Gộp “${item.name}” vào “${result.other.name}” làm một? Hóa đơn, phiếu giao và tồn kho của hai tên sẽ về chung một tên.`,
      ok: "Gộp làm một", cancel: "Đặt tên khác",
    }).then((ok) => {
      if (!ok) return;
      const nextId = newRequestId();
      setRequestId(nextId);
      const target = { id: result.other.id, name: result.other.name, unit: result.other.unit };
      save.mutate({ itemId: item.id, name: name.trim(), unit, active, merge: true, requestId: nextId }, { onSuccess: (next) => handle(next, target) });
    });
  };

  const submit = async () => {
    // Turning an item off hides it from counting and ordering: ask once, as the list switch used to.
    if (item.active && !active && !ask) {
      const ok = await confirm({
        title: `Tắt “${item.name}”?`,
        message: "Món đã tắt không hiện khi đếm và khi đặt hàng. Sổ tồn giữ nguyên, bật lại lúc nào cũng được.",
        ok: "Tắt món này", cancel: "Thôi", tone: "danger",
      });
      if (!ok) return;
    }
    const other = ask?.kind === "merge" ? ask.other : null;
    // The server takes old -> new: 1 g = 1/x bao when 1 bao = x g.
    const unitFactor = ask && factorOk ? 1 / x : null;
    save.mutate(
      { itemId: item.id, name: name.trim(), unit, active, unitFactor, merge: other !== null, requestId },
      { onSuccess: (result) => handle(result, other) },
    );
  };

  const standard = ask ? standardUnitFactor(ask.from, ask.to) : null;
  const sub = `${item.in_q7 ? "Kho Q7" : "Kho Tân Tạo"} · tồn Tân Tạo ${fmtAmount(item.qty.tan_tao, item.unit)} · Q7 ${fmtAmount(item.qty.q7, item.unit)}`;

  return (
    <KhoDialog title={item.name} sub={sub} onClose={onClose} data={{ "data-bmq-kho-item-dialog": "" }}>
      <label className="d3-kho-field">
        <span>Tên duy nhất</span>
        <Input value={name} onChange={(event) => { setName(event.target.value); setAsk(null); }} maxLength={120} disabled={!canEdit} data-bmq-kho-name />
      </label>
      {twin ? <p className="d3-kho-hint is-warn" data-bmq-kho-twin>Đã có món “{twin.name}”. Lưu tên này sẽ hỏi gộp hai món làm một.</p> : null}
      <div className="d3-kho-field">
        <span>Loại hàng</span>
        <div className="d3-kho-seg" role="group" aria-label="Loại hàng" data-bmq-kho-class>
          {GROUPS.filter((g): g is { id: MovableGroup; label: string } => g.id !== "tp").map((g) => (
            <button key={g.id} type="button" aria-pressed={group === g.id} className={cn(group === g.id && "is-on")}
              disabled={!canEdit || setClass.isPending} onClick={() => moveTo(g.id)} data-bmq-kho-class-pick={g.id}>{g.label}</button>
          ))}
        </div>
      </div>
      {setClass.error ? <p className="d3-kho-error">{khoErrorText(setClass.error)}</p> : null}
      <div className="d3-kho-field">
        <span>Kho</span>
        <div className="d3-kho-seg" role="group" aria-label="Kho" data-bmq-kho-place>
          {KHO_LOCATIONS.map((loc) => (
            <button key={loc} type="button" aria-pressed={(loc === "q7") === item.in_q7} className={cn((loc === "q7") === item.in_q7 && "is-on")}
              disabled={!canEdit || setPlace.isPending} onClick={() => placeTo(loc)} data-bmq-kho-place-pick={loc}>Kho {KHO_LABEL[loc]}</button>
          ))}
        </div>
      </div>
      {setPlace.error ? <p className="d3-kho-error">{khoErrorText(setPlace.error)}</p> : null}
      <div className="d3-kho-switchrow">
        <span><b>{active ? "Đang bật" : "Đã tắt"}</b><small>{active ? "Hiện khi đếm và khi đặt hàng" : "Không hiện khi đếm, sổ tồn giữ nguyên"}</small></span>
        <Switch checked={active} onCheckedChange={setActive} disabled={!canEdit} aria-label="Bật/tắt món" />
      </div>
      {ask ? (
        <div className="d3-kho-ask" data-bmq-kho-ask={ask.kind}>
          <b>{ask.kind === "merge" ? `Gộp vào “${ask.other.name}” (đơn vị ${ask.to})` : `Đổi đơn vị ${ask.from} → ${ask.to}`}</b>
          {standard ? <small>Máy tự đổi theo chuẩn.</small> : (
            <>
              <small>Xem phiếu giao bên dưới rồi gõ: 1 {ask.to} bằng bao nhiêu {ask.from}?</small>
              <label className="d3-kho-conv">
                1 {ask.to} =
                <Input inputMode="decimal" value={factorText} onChange={(event) => setFactorText(event.target.value)} placeholder="?" aria-label={`1 ${ask.to} bằng bao nhiêu ${ask.from}`} />
                {ask.from}
              </label>
            </>
          )}
        </div>
      ) : null}
      {save.error ? <p className="d3-kho-error">{khoErrorText(save.error)}</p> : null}
      {canEdit ? (
        <div className="d3-kho-actions">
          <Button disabled={save.isPending || name.trim().length < 2 || (!changed && !ask) || (ask !== null && !factorOk && !standard)} onClick={() => void submit()} data-bmq-kho-save>
            {save.isPending ? "Đang lưu…" : ask?.kind === "merge" ? "Gộp làm một" : "Lưu"}
          </Button>
          <Button variant="outline" onClick={onClose}>Đóng</Button>
        </div>
      ) : null}
      <UnitAndConversions item={item} canEdit={canEdit} lines={lines.data} linesLoading={lines.isLoading} linesError={lines.error}
        onToast={onToast} onReplaced={onReplaced} />
      <ReceiptNotes title={`Hóa đơn, phiếu giao đã gộp vào tên này${item.doc_lines ? ` · ${item.doc_lines} dòng` : ""}`} lines={lines.data} loading={lines.isLoading} error={lines.error} />
    </KhoDialog>
  );
}
