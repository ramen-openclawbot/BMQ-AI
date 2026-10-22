import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { KHO_ITEMS_QUERY_KEY, useKhoSaveItem } from "@/hooks/useKhoItems";
import { useItemReceiptLines, useSetItemKhoLocations, useSetStockItemClass } from "@/hooks/useWarehouseGame";
import { hasTanTaoPlace, khoErrorText, searchKey, standardUnitFactor, type KhoItem, type KhoLocation, type KhoSaveResult } from "@/lib/kho-items";
import { cn } from "@/lib/utils";
import { CLASS_OF, GROUPS, KHO_LABEL, KHO_LOCATIONS, fmtAmount, groupOf, newRequestId, parseNum, type Group } from "./kho-meta";
import type { KhoConfirmOptions } from "./KhoConfirm";
import { KhoDialog } from "./KhoDialog";
import { ReceiptNotes } from "./ReceiptNotes";
import { UnitAndConversions } from "./UnitSections";
import { useKhoCommitments } from "@/hooks/useKhoCommitments";
import { dayLabel } from "@/lib/kho-commitments";

type Ask = { kind: "merge"; other: { id: string; name: string; unit: string }; from: string; to: string } | { kind: "unit"; from: string; to: string };
type MovableGroup = Exclude<Group, "tp">;

const placeLabel = (places: Record<KhoLocation, boolean>) =>
  places.tan_tao && places.q7 ? "Kho Tân Tạo + Kho Q7" : places.q7 ? "Kho Q7" : "Kho Tân Tạo";

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
  const commitments = useKhoCommitments();
  // An item can have a place at both kho (owner 22/10): one tick per kho, at least one.
  const [places, setPlaces] = useState<Record<KhoLocation, boolean>>({ tan_tao: hasTanTaoPlace(item), q7: item.in_q7 });
  const holds = (commitments.data?.items ?? []).filter((c) => c.kitchen_inventory_item_id === item.id && places[c.location as KhoLocation]);
  const setPlace = useSetItemKhoLocations();
  const group = groupOf(item);
  const [name, setName] = useState(item.name);
  const unit = item.unit;
  const [active, setActive] = useState(item.active);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [factorText, setFactorText] = useState("");
  const [requestId, setRequestId] = useState(newRequestId);

  const togglePlace = async (loc: KhoLocation) => {
    const next = { ...places, [loc]: !places[loc] };
    if (!next.tan_tao && !next.q7) return;
    const stock = item.qty[loc] ?? 0;
    if (!next[loc] && stock !== 0) {
      const ok = await confirm({
        title: `Bỏ “${item.name}” khỏi Kho ${KHO_LABEL[loc]}?`,
        message: `Kho ${KHO_LABEL[loc]} còn ${fmtAmount(stock, item.unit)} trong sổ. Bỏ tick thì món không hiện khi đếm ở kho này; số trong sổ giữ nguyên.`,
        ok: "Bỏ tick", cancel: "Thôi",
      });
      if (!ok) return;
    }
    const before = places;
    setPlaces(next);
    setPlace.mutate(
      { itemId: item.id, tanTao: next.tan_tao, q7: next.q7 },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: [KHO_ITEMS_QUERY_KEY] });
          onToast(`“${item.name}” có ở ${placeLabel(next)}`);
        },
        onError: () => setPlaces(before),
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
  const sub = `${placeLabel(places)} · tồn Tân Tạo ${fmtAmount(item.qty.tan_tao, item.unit)} · Q7 ${fmtAmount(item.qty.q7, item.unit)}`;

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
        <span>Có ở kho</span>
        <div className="d3-kho-checks" role="group" aria-label="Có ở kho" data-bmq-kho-place>
          {KHO_LOCATIONS.map((loc) => {
            const on = places[loc];
            const last = on && !places[loc === "q7" ? "tan_tao" : "q7"];
            return (
              <button key={loc} type="button" role="checkbox" aria-checked={on} className={cn("d3-kho-check", on && "is-on")}
                disabled={!canEdit || setPlace.isPending || last} title={last ? "Món phải có ở ít nhất 1 kho" : undefined}
                onClick={() => void togglePlace(loc)} data-bmq-kho-place-pick={loc}>
                <span className="d3-kho-check-box" aria-hidden="true"><Check /></span>
                <span><b>Kho {KHO_LABEL[loc]}</b><small>tồn {fmtAmount(item.qty[loc], item.unit)}</small></span>
              </button>
            );
          })}
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
      {holds.map((hold) => (
        <section key={hold.location} className="d3-kho-holdsec" data-bmq-kho-hold-detail>
          <div className="d3-kho-sec-h">
            <h3>Giữ cho sản xuất{places.tan_tao && places.q7 ? ` · Kho ${KHO_LABEL[hold.location as KhoLocation]}` : ""} · {fmtAmount(hold.committed_qty, item.unit)}</h3>
            <small>Phiếu xuất NVL cho ngày tới. Sổ tồn trừ vào đầu ngày đó; hôm nay hàng vẫn trên kệ.</small>
          </div>
          <ul className="d3-kho-holdlist">
            {hold.sources.map((source) => (
              <li key={`${source.ref}-${source.date}`}>
                <span>{source.ref}</span>
                <span>{dayLabel(commitments.data?.as_of ?? "", source.date)}</span>
                <b>{fmtAmount(source.qty, item.unit)}</b>
              </li>
            ))}
          </ul>
          {item.qty[hold.location as KhoLocation] !== null ? <p className="d3-kho-quiet">Còn dùng được sau khi trừ: <b>{fmtAmount((item.qty[hold.location as KhoLocation] ?? 0) - hold.committed_qty, item.unit)}</b></p> : null}
        </section>
      ))}
      <UnitAndConversions item={item} canEdit={canEdit} lines={lines.data} linesLoading={lines.isLoading} linesError={lines.error}
        onToast={onToast} onReplaced={onReplaced} />
      <ReceiptNotes title={`Hóa đơn, phiếu giao đã gộp vào tên này${item.doc_lines ? ` · ${item.doc_lines} dòng` : ""}`} lines={lines.data} loading={lines.isLoading} error={lines.error} />
    </KhoDialog>
  );
}
