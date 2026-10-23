import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading";
import { supabase } from "@/integrations/supabase/client";
import { usePrepareSupplierOrder, useSendSupplierOrder, useSupplierOrderHistory } from "@/hooks/useSupplierOrder";
import {
  SupplierOrderClientError,
  blockerLabel,
  createSupplierOrderRequestId,
  formatQuantity,
  formatVnd,
  type SupplierOrderHistoryEntry,
} from "@/lib/supplier-order";
import type { KhoItem } from "@/lib/kho-items";
import { dmy, fmtAmount, parseNum } from "./kho-meta";

const SEND_ERROR: Record<string, string> = {
  mailbox_not_connected: "Chưa kết nối hộp thư order@bmq.vn (Cài đặt → Email đặt hàng).",
  no_supplier: "Món này chưa chọn nhà cung cấp.",
  no_supplier_email: "Nhà cung cấp chưa có email đặt hàng.",
  no_price: "Chưa có giá mua gần nhất của nhà cung cấp.",
  no_po_unit: "Món này chưa cài đơn vị đặt hàng.",
  over_quantity_limit: "Số lượng quá lớn so với mức dùng. Giảm bớt rồi gửi lại.",
  over_amount_limit: "Đơn vượt hạn mức tiền cho một lần đặt.",
  invalid_quantity: "Số lượng chưa hợp lệ.",
  in_progress: "Đơn này đang được gửi. Đợi vài giây rồi xem lại.",
  email_failed: "Chưa gửi được email. Bấm gửi lại.",
  state_update_failed: "Email có thể đã gửi nhưng chưa lưu được trạng thái. Kiểm tra hộp thư order@bmq.vn trước khi gửi lại.",
  forbidden: "Bạn chưa có quyền đặt hàng.",
  rate_limited: "Hôm nay đã gửi quá nhiều đơn. Thử lại sau.",
};

const STATUS_LABEL: Record<string, string> = { sent: "Đã gửi", failed: "Gửi lỗi", preparing: "Đang gửi" };

function sendErrorText(error: unknown): string {
  if (error instanceof SupplierOrderClientError) return SEND_ERROR[error.code] ?? "Chưa gửi được đơn. Thử lại.";
  return "Chưa gửi được đơn. Thử lại.";
}

/**
 * Owner-configured order supplier for this item (cheap gate before the forecast runs). Read through a
 * definer RPC: the settings table's RLS function is not executable by signed-in users.
 */
function useOrderSetting(itemId: string) {
  return useQuery({
    queryKey: ["supplier-order-setting", itemId],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("supplier_order_setting", { p_item_id: itemId });
      if (error) throw error;
      const row = data as { supplier_id?: string | null; supplier_name?: string | null; po_unit?: string | null } | null;
      if (!row?.supplier_id || !row.po_unit) return null;
      return { supplierName: String(row.supplier_name ?? "").trim() };
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
 * Order this item from its supplier by email (owner 23/10, phase 1). The button runs the stock check,
 * shows one confirmation card, and only "Gửi email đặt hàng" creates the PO and emails the supplier.
 */
export function SupplierOrderSection({ item, onToast }: { item: KhoItem; onToast: (text: string) => void }) {
  const setting = useOrderSetting(item.id);
  const [open, setOpen] = useState(false);
  const [qtyText, setQtyText] = useState("");
  const [note, setNote] = useState("");
  const [requestId, setRequestId] = useState(createSupplierOrderRequestId);
  const prepare = usePrepareSupplierOrder(item.id, open);
  const history = useSupplierOrderHistory(setting.data ? item.id : null);
  const send = useSendSupplierOrder();
  const data = prepare.data;

  // Start from the proposal (once per opening); when stock is enough, start from one pack.
  useEffect(() => {
    if (!open || !data || qtyText !== "") return;
    const start = data.proposal.quantity > 0 ? data.proposal.quantity : data.proposal.packSizePoUnits ?? 0;
    if (start > 0) setQtyText(formatQuantity(start));
  }, [open, data, qtyText]);

  // "1.000" is a thousands group (vi-VN), "12,5" a decimal; otherwise parse as typed.
  const qtyRaw = qtyText.trim();
  const qty = parseNum(/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(qtyRaw) ? qtyRaw.replace(/\./g, "") : qtyRaw);
  const qtyOk = Number.isFinite(qty) && qty > 0;
  const total = useMemo(() => (qtyOk && data?.proposal.unitPrice ? qty * data.proposal.unitPrice : null), [qtyOk, qty, data]);

  if (!setting.data) return null;

  const close = () => {
    setOpen(false);
    setQtyText("");
    send.reset();
  };

  const submit = () => {
    if (!data || !qtyOk) return;
    send.mutate(
      { itemId: item.id, quantity: qty, note: note.trim(), requestId },
      {
        onSuccess: (result) => {
          onToast(`Đã gửi ${result.poNumber ?? "đơn"} tới ${result.toEmail ?? data.supplier?.email ?? "NCC"}`);
          setOpen(false);
          setNote("");
          setQtyText("");
          setRequestId(createSupplierOrderRequestId());
        },
      },
    );
  };

  const blockers = data?.blockers ?? [];
  const unit = data?.proposal.unit || "";

  return (
    <section className="d3-kho-order" data-bmq-kho-order>
      <div className="d3-kho-order-head">
        <div className="d3-kho-sec-h">
          <h3>Đặt hàng · {setting.data.supplierName || "nhà cung cấp"}</h3>
          <small>Gửi email từ order@bmq.vn, kèm link để NCC tải hoá đơn giao hàng</small>
        </div>
        {!open ? <Button size="sm" onClick={() => setOpen(true)} data-bmq-kho-order-open>Đặt hàng</Button> : null}
      </div>

      {open ? (
        prepare.isLoading ? (
          <LoadingState flat rows={2} label="Đang tính lượng cần đặt" />
        ) : prepare.error || !data ? (
          <p className="d3-kho-error">{SEND_ERROR.forbidden}</p>
        ) : (
          <div className="d3-kho-order-card" data-bmq-kho-order-confirm>
            <dl className="d3-kho-order-facts">
              <div><dt>Tồn Q7</dt><dd>{fmtAmount(data.stock.onHand, item.unit)}{data.stock.daysLeft === null ? null : data.stock.daysLeft <= 0
                ? <small className="is-bad" data-bmq-kho-order-out> · đã hết</small>
                : <small> · đủ ~{formatQuantity(data.stock.daysLeft)} ngày</small>}</dd></div>
              <div><dt>Dùng mỗi ngày</dt><dd>{fmtAmount(data.stock.dailyUsage, item.unit)}</dd></div>
              <div><dt>Đề xuất</dt><dd>{data.proposal.quantity > 0 ? `${formatQuantity(data.proposal.quantity)} ${unit}` : "Chưa cần đặt"}</dd></div>
              <div><dt>Gửi tới</dt><dd className="is-wrap">{data.supplier?.email || "—"}</dd></div>
            </dl>

            {data.proposal.quantity <= 0 && data.stock.daysLeft !== null ? (
              <p className="d3-kho-hint">Tồn còn đủ khoảng {formatQuantity(data.stock.daysLeft)} ngày. Vẫn đặt được nếu cần.</p>
            ) : null}
            {data.openOrder ? (
              <p className="d3-kho-hint is-warn" data-bmq-kho-order-open-po>
                {data.openOrder.poNumber} ({formatQuantity(data.openOrder.quantity)} {data.openOrder.unit}) đã gửi, chưa nhận hàng.
              </p>
            ) : null}

            <div className="d3-kho-order-line">
              <span className="d3-kho-order-product">{data.proposal.productName}</span>
              <label className="d3-kho-order-qty">
                <Input inputMode="decimal" value={qtyText} onChange={(event) => setQtyText(event.target.value)}
                  aria-label={`Số lượng (${unit})`} data-bmq-kho-order-qty />
                <span>{unit}</span>
              </label>
              <span className="d3-kho-order-price">× {formatVnd(data.proposal.unitPrice)}</span>
              <b className="d3-kho-order-total" data-bmq-kho-order-total>{total !== null ? formatVnd(total) : "—"}</b>
            </div>
            {data.proposal.packSizePoUnits ? (
              <small className="d3-kho-quiet">Đề xuất làm tròn theo thùng {formatQuantity(data.proposal.packSizePoUnits)} {unit}.</small>
            ) : null}

            {data.delivery.address ? (
              <p className="d3-kho-quiet">Giao tới: {data.delivery.address}{data.delivery.contactName ? ` · ${data.delivery.contactName}` : ""}{data.delivery.contactPhone ? ` ${data.delivery.contactPhone}` : ""}</p>
            ) : null}

            <label className="d3-kho-field">
              <span>Ghi chú cho NCC (không bắt buộc)</span>
              <textarea className="d3-kho-notearea" rows={2} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)}
                placeholder="Ví dụ: giao trước 10h sáng" data-bmq-kho-order-note />
            </label>

            {blockers.length ? (
              <ul className="d3-kho-error d3-kho-order-blockers" data-bmq-kho-order-blockers>
                {blockers.map((code) => <li key={code}>{blockerLabel(code)}</li>)}
              </ul>
            ) : null}
            {send.error ? <p className="d3-kho-error" data-bmq-kho-order-error>{sendErrorText(send.error)}</p> : null}

            <div className="d3-kho-actions">
              <Button disabled={!qtyOk || blockers.length > 0 || send.isPending} onClick={submit} data-bmq-kho-order-send>
                {send.isPending ? "Đang gửi…" : "Gửi email đặt hàng"}
              </Button>
              <Button variant="outline" onClick={close} disabled={send.isPending}>Huỷ</Button>
            </div>
          </div>
        )
      ) : null}

      <HistoryList rows={history.data ?? []} />
    </section>
  );
}
