import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useKhoCreateItem } from "@/hooks/useKhoItems";
import { useKhoSupplierOptions } from "@/hooks/useKhoItemSuppliers";
import { useKhoUnits } from "@/hooks/useKhoUnits";
import { hasTanTaoPlace, khoErrorText, searchKey, type KhoItem, type KhoLocation } from "@/lib/kho-items";
import { cn } from "@/lib/utils";
import { CLASS_OF, GROUPS, ITEM_UNITS, KHO_LABEL, KHO_LOCATIONS, groupOf, newRequestId, type Group } from "./kho-meta";
import { KhoDialog } from "./KhoDialog";
import { SupplierPicker } from "./SupplierPicker";

type MovableGroup = Exclude<Group, "tp">;

/**
 * Thêm món / Sao chép món (owner 27/10): a new item from scratch, or a copy of `source` where only the name
 * needs changing. A copy takes the unit, count units, group, kho and note; never stock, lots, supplier labels
 * or the material code, because it is a different product.
 */
export function CreateItemDialog({ source, items, defaultGroup, defaultKho, onCreated, onClose }: {
  source: KhoItem | null;
  items: KhoItem[];
  defaultGroup: Group;
  defaultKho: KhoLocation;
  onCreated: (item: { id: string; name: string; code: string }) => void;
  onClose: () => void;
}) {
  const create = useKhoCreateItem();
  const units = useKhoUnits();
  const suppliers = useKhoSupplierOptions();
  const [name, setName] = useState(source ? `${source.name} (bản sao)` : "");
  const [unit, setUnit] = useState(source?.unit ?? "g");
  const [group, setGroup] = useState<MovableGroup>(() => {
    const g = source ? groupOf(source) : defaultGroup;
    return g === "tp" ? "nl" : g;
  });
  const [places, setPlaces] = useState<Record<KhoLocation, boolean>>(() =>
    source ? { tan_tao: hasTanTaoPlace(source), q7: source.in_q7 } : { tan_tao: defaultKho === "tan_tao", q7: defaultKho === "q7" });
  const [note, setNote] = useState(source?.note ?? "");
  // A copy never carries the source's suppliers: the new item is a different product and picks its own.
  const [supplierIds, setSupplierIds] = useState<string[]>([]);
  // One key per form: a double tap or a retry after a lost reply creates the item once.
  const [requestId] = useState(newRequestId);

  const unitOptions = useMemo(() => {
    const codes = units.data?.map((u) => u.code) ?? ITEM_UNITS;
    return codes.includes(unit) ? codes : [unit, ...codes];
  }, [units.data, unit]);
  const twin = useMemo(() => {
    const key = searchKey(name);
    return key ? items.find((other) => other.active && searchKey(other.name) === key) ?? null : null;
  }, [name, items]);
  const nameOk = name.trim().length >= 2 && name.trim().length <= 120;

  const toggle = (loc: KhoLocation) => {
    const next = { ...places, [loc]: !places[loc] };
    if (next.tan_tao || next.q7) setPlaces(next);
  };
  const submit = () => {
    create.mutate(
      {
        name: name.trim(), unit, itemClass: CLASS_OF[group], inTanTao: places.tan_tao, inQ7: places.q7,
        note: note.trim() || null, copyFrom: source?.id ?? null, supplierIds, requestId,
      },
      { onSuccess: (result) => onCreated({ id: result.item_id, name: result.name, code: result.item_code }) },
    );
  };

  return (
    <KhoDialog
      title={source ? "Sao chép món" : "Thêm món"}
      sub={source ? `Từ “${source.name}” · giữ đơn vị, đơn vị đếm, loại hàng, kho và ghi chú; không mang theo tồn kho` : "Món mới chưa có tồn; nhập kho hoặc đếm sau khi tạo"}
      onClose={onClose}
      data={{ "data-bmq-kho-create-dialog": source ? "copy" : "new" }}
    >
      <label className="d3-kho-field">
        <span>Tên duy nhất</span>
        <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoFocus placeholder="Ví dụ: Bơ Peerless 2.5 kg" data-bmq-kho-create-name />
      </label>
      {twin ? <p className="d3-kho-hint is-warn" data-bmq-kho-create-twin>Đã có món “{twin.name}”. Đặt tên khác để tạo món mới.</p> : null}
      <label className="d3-kho-field">
        <span>Đơn vị kho</span>
        <select className="d3-kr-select" value={unit} onChange={(event) => setUnit(event.target.value)} disabled={Boolean(source)} data-bmq-kho-create-unit>
          {unitOptions.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
        {source ? <small className="d3-kho-quiet">Bản sao giữ đơn vị {source.unit} của món gốc.</small> : null}
      </label>
      <div className="d3-kho-field">
        <span>Loại hàng</span>
        <div className="d3-kho-seg" role="group" aria-label="Loại hàng" data-bmq-kho-create-class>
          {GROUPS.filter((g): g is { id: MovableGroup; label: string } => g.id !== "tp").map((g) => (
            <button key={g.id} type="button" aria-pressed={group === g.id} className={cn(group === g.id && "is-on")} onClick={() => setGroup(g.id)}>{g.label}</button>
          ))}
        </div>
      </div>
      <div className="d3-kho-field">
        <span>Có ở kho</span>
        <div className="d3-kho-checks" role="group" aria-label="Có ở kho" data-bmq-kho-create-place>
          {KHO_LOCATIONS.map((loc) => {
            const on = places[loc];
            const last = on && !places[loc === "q7" ? "tan_tao" : "q7"];
            return (
              <button key={loc} type="button" role="checkbox" aria-checked={on} className={cn("d3-kho-check", on && "is-on")}
                disabled={last} title={last ? "Món phải có ở ít nhất 1 kho" : undefined} onClick={() => toggle(loc)}>
                <span className="d3-kho-check-box" aria-hidden="true"><Check /></span>
                <span><b>Kho {KHO_LABEL[loc]}</b><small>{loc === "q7" ? "Nhập ở Tân Tạo tự chuyển sang Q7 nếu chỉ tick Q7" : "Kho chính"}</small></span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="d3-kho-field">
        <span>Nhà cung cấp (bắt buộc)</span>
        <SupplierPicker options={suppliers.data ?? []} value={supplierIds} onChange={setSupplierIds} loading={suppliers.isLoading} />
        <small className="d3-kho-quiet">Món gắn với nhà cung cấp để nhận đúng khi scan hóa đơn và để theo dõi giấy tờ nguồn gốc (ATTP).</small>
        {suppliers.error ? <p className="d3-kho-error">Không tải được danh sách nhà cung cấp. Tải lại trang giúp.</p> : null}
      </div>
      <label className="d3-kho-field">
        <span>Ghi chú</span>
        <textarea className="d3-kho-notearea" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} rows={2}
          placeholder="Ví dụ: cắt khối 2.5 kg, giá cao hơn bơ 25 kg" data-bmq-kho-create-note />
      </label>
      {places.q7 ? <p className="d3-kho-hint">Món ở Kho Q7 cần gắn mã nguyên liệu thì mới đếm được ở Q7. Nhắn VNAgent để gắn sau khi tạo.</p> : null}
      {create.error ? <p className="d3-kho-error">{khoErrorText(create.error)}</p> : null}
      <div className="d3-kho-actions">
        <Button disabled={!nameOk || Boolean(twin) || supplierIds.length === 0 || create.isPending} onClick={submit} data-bmq-kho-create-save>
          {create.isPending ? "Đang tạo…" : source ? "Tạo bản sao" : "Tạo món"}
        </Button>
        <Button variant="outline" onClick={onClose}>Đóng</Button>
      </div>
    </KhoDialog>
  );
}
