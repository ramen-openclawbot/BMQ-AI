import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useKhoItemSuppliers, useKhoSetItemSuppliers, useKhoSupplierOptions } from "@/hooks/useKhoItemSuppliers";
import { khoErrorText, type KhoItem } from "@/lib/kho-items";
import { newRequestId } from "./kho-meta";
import { SupplierPicker } from "./SupplierPicker";

/**
 * Suppliers of one item (owner 30/10). An active item keeps at least one supplier; the links feed the invoice
 * scan names and the traceability (ATTP) checklist. Old items without any link show a warning until one is set.
 */
export function ItemSuppliersSection({ item, canEdit, onToast }: {
  item: KhoItem;
  canEdit: boolean;
  onToast?: (message: string) => void;
}) {
  const linked = useKhoItemSuppliers(item.id);
  const options = useKhoSupplierOptions();
  const save = useKhoSetItemSuppliers();
  const [draft, setDraft] = useState<string[] | null>(null);
  // One key per edit: a double tap or a retry after a lost reply applies the change once.
  const [requestId, setRequestId] = useState(newRequestId);

  useEffect(() => { setDraft(null); }, [item.id]);

  const saved = linked.data ?? [];
  const value = draft ?? saved;
  const changed = useMemo(() => {
    if (draft === null) return false;
    return draft.length !== saved.length || draft.some((id) => !saved.includes(id));
  }, [draft, saved]);
  const empty = value.length === 0;

  const submit = () => {
    save.mutate({ itemId: item.id, supplierIds: value, requestId }, {
      onSuccess: () => { setDraft(null); setRequestId(newRequestId()); onToast?.("Đã lưu nhà cung cấp của món."); },
    });
  };

  return (
    <div className="d3-kho-field" data-bmq-kho-item-suppliers>
      <span>Nhà cung cấp</span>
      <SupplierPicker options={options.data ?? []} value={value} onChange={(next) => { setDraft(next); setRequestId(newRequestId()); }}
        disabled={!canEdit} loading={options.isLoading || linked.isLoading} />
      {linked.error ? <p className="d3-kho-error">Không tải được nhà cung cấp của món này.</p> : null}
      {!linked.isLoading && !linked.error && empty && item.active
        ? <p className="d3-kho-hint is-warn" data-bmq-kho-supplier-missing>Món này chưa gắn nhà cung cấp. Chọn ít nhất một để nhận đúng khi scan và theo dõi giấy tờ nguồn gốc.</p>
        : null}
      {save.error ? <p className="d3-kho-error">{khoErrorText(save.error)}</p> : null}
      {canEdit && changed ? (
        <div className="d3-kho-actions">
          <Button disabled={save.isPending || (empty && item.active)} onClick={submit} data-bmq-kho-supplier-save>
            {save.isPending ? "Đang lưu…" : "Lưu nhà cung cấp"}
          </Button>
          <Button variant="outline" disabled={save.isPending} onClick={() => setDraft(null)}>Hủy thay đổi</Button>
        </div>
      ) : null}
    </div>
  );
}
