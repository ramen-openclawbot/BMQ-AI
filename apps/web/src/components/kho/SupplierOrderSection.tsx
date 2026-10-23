import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { FileText, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useSupplierOrderHistory } from "@/hooks/useSupplierOrder";
import { formatQuantity, type SupplierOrderHistoryEntry } from "@/lib/supplier-order";
import type { KhoItem } from "@/lib/kho-items";
import { dmy } from "./kho-meta";

const STATUS_LABEL: Record<string, string> = { sent: "Đã gửi", failed: "Gửi lỗi", preparing: "Đang gửi" };

/**
 * Owner-configured order supplier for this item (cheap gate). Read through a definer RPC: the settings
 * table's RLS function is not executable by signed-in users.
 */
function useOrderSetting(itemId: string) {
  return useQuery({
    queryKey: ["supplier-order-setting", itemId],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("supplier_order_setting", { p_item_id: itemId });
      if (error) throw error;
      const row = data as { supplier_id?: string | null; supplier_name?: string | null; po_unit?: string | null } | null;
      if (!row?.supplier_id || !row.po_unit) return null;
      return { supplierId: String(row.supplier_id), supplierName: String(row.supplier_name ?? "").trim() };
    },
    staleTime: 60_000,
  });
}

async function openUpload(path: string) {
  const { data } = await supabase.storage.from("supplier-delivery-docs").createSignedUrl(path, 600);
  if (data?.signedUrl) window.open(data.signedUrl, "_blank", "noopener");
}

function HistoryList({ rows }: { rows: SupplierOrderHistoryEntry[] }) {
  if (!rows.length) return null;
  return (
    <ul className="d3-kho-order-hist" data-bmq-kho-order-history>
      {rows.slice(0, 5).map((row) => (
        <li key={row.id ?? row.requestId ?? row.poNumber ?? ""}>
          <div className="d3-kho-order-hist-row">
            <span>{row.poNumber ?? "—"}</span>
            <span>{dmy(row.sentAt)}</span>
            <b>{formatQuantity(row.quantity)} {row.unit}</b>
            <span className={row.status === "failed" ? "is-bad" : undefined}>{STATUS_LABEL[row.status] ?? row.status}</span>
          </div>
          {row.uploads.length ? (
            <div className="d3-kho-order-files">
              {row.uploads.map((file, index) => (
                <button key={file.storagePath} type="button" onClick={() => void openUpload(file.storagePath)}>
                  {file.mimeType === "application/pdf" ? <FileText aria-hidden="true" /> : <Paperclip aria-hidden="true" />}
                  {file.fileName ?? `File ${index + 1}`}
                </button>
              ))}
            </div>
          ) : row.status === "sent" ? (
            <small className="d3-kho-quiet">NCC chưa tải hoá đơn giao hàng</small>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Order this item from its supplier (owner 23/10). Orders are placed on the Đặt hàng page, which sends one
 * email per supplier with VAT; this card opens it on the right supplier and keeps the item's order history.
 */
export function SupplierOrderSection({ item }: { item: KhoItem; onToast?: (text: string) => void }) {
  const setting = useOrderSetting(item.id);
  const history = useSupplierOrderHistory(setting.data ? item.id : null);
  const navigate = useNavigate();

  if (!setting.data) return null;
  const { supplierId, supplierName } = setting.data;

  return (
    <section className="d3-kho-order" data-bmq-kho-order>
      <div className="d3-kho-order-head">
        <div className="d3-kho-sec-h">
          <h3>Đặt hàng · {supplierName || "nhà cung cấp"}</h3>
          <small>Lập đơn ở trang Đặt hàng: chọn số lượng, xem trước email có VAT rồi gửi từ order@bmq.vn</small>
        </div>
        <Button size="sm" onClick={() => navigate(`/dat-hang?ncc=${encodeURIComponent(supplierId)}`)} data-bmq-kho-order-open>Đặt hàng</Button>
      </div>
      <HistoryList rows={history.data ?? []} />
    </section>
  );
}
