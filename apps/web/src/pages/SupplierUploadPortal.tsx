import { useEffect, useRef, useState } from "react";
import { CheckCircle2, FileText, ImageUp, Loader2, TriangleAlert } from "lucide-react";
import {
  SupplierOrderClientError,
  fetchUploadOrder,
  formatQuantity,
  uploadDeliveryDoc,
  type SupplierOrderUploadSummary,
} from "@/lib/supplier-order";

const LOGO_SRC = "/assets/brand/bmq-logo-master-1024.png";
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";

type Row = { key: string; name: string; state: "uploading" | "done" | "error"; message?: string };

const UPLOAD_ERROR: Record<string, string> = {
  unsupported_type: "Chỉ nhận ảnh (JPG, PNG, WebP) hoặc PDF.",
  file_too_large: "File lớn hơn 10 MB.",
  empty_file: "File trống.",
  upload_limit_reached: "Đơn này đã nhận đủ 10 file.",
  link_invalid: "Liên kết đã hết hạn. Vui lòng liên hệ BMQ.",
  rate_limited: "Tải lên quá nhanh. Đợi một chút rồi thử lại.",
};

/** Phone photos above the limit are re-encoded to JPEG (max 2400 px) before upload. */
async function shrinkImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.size <= MAX_BYTES) return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) return file;
  return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
}

function sentDate(iso: string | null): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
}

/** ai.banhmique.vn/ncc/hoa-don/<token>: the supplier uploads the delivery invoice for one BMQ order. */
export default function SupplierUploadPortal({ token }: { token: string }) {
  const [order, setOrder] = useState<SupplierOrderUploadSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [count, setCount] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    fetchUploadOrder(token)
      .then((summary) => {
        if (!alive) return;
        setOrder(summary);
        setCount(summary.uploadCount);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [token]);

  const busy = rows.some((row) => row.state === "uploading");

  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const original of Array.from(files)) {
      const key = `${original.name}-${original.size}-${Date.now()}`;
      setRows((prev) => [...prev, { key, name: original.name, state: "uploading" }]);
      try {
        const file = await shrinkImage(original);
        if (!ACCEPT.split(",").includes(file.type)) throw new SupplierOrderClientError("unsupported_type", "");
        if (file.size > MAX_BYTES) throw new SupplierOrderClientError("file_too_large", "");
        const result = await uploadDeliveryDoc(token, file);
        setCount(result.count);
        setRows((prev) => prev.map((row) => (row.key === key ? { ...row, state: "done" } : row)));
      } catch (error) {
        const code = error instanceof SupplierOrderClientError ? error.code : "";
        setRows((prev) => prev.map((row) => (row.key === key
          ? { ...row, state: "error", message: UPLOAD_ERROR[code] ?? "Chưa tải lên được. Thử lại." }
          : row)));
      }
    }
    if (input.current) input.current.value = "";
  };

  return (
    <main className="min-h-screen bg-[#fefbf9] text-[#211d1e]" data-bmq-supplier-upload>
      <section className="mx-auto flex min-h-screen max-w-md flex-col px-5 pb-10 pt-9">
        <img src={LOGO_SRC} alt="BMQ - Bánh Mì Que Pháp" className="mx-auto h-auto w-[120px] object-contain" />
        <h1 className="mt-7 text-center text-[28px] font-bold leading-tight tracking-[-0.02em]">Gửi hoá đơn giao hàng</h1>

        {!order && !failed ? (
          <div className="mt-10 flex justify-center text-[#80566a]" role="status" aria-label="Đang tải đơn hàng">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : null}

        {failed ? (
          <div className="mt-8 rounded-2xl bg-white px-5 py-6 text-center shadow-[0_12px_28px_rgba(70,50,55,0.08)] ring-1 ring-[#eee8e5]" data-bmq-supplier-upload-invalid>
            <TriangleAlert className="mx-auto h-7 w-7 text-[#b45309]" />
            <p className="mt-3 text-[15px] leading-6">Liên kết không còn hiệu lực. Vui lòng liên hệ BMQ qua order@bmq.vn.</p>
          </div>
        ) : null}

        {order ? (
          <>
            <dl className="mt-7 grid grid-cols-2 gap-x-4 gap-y-3 rounded-2xl bg-white px-5 py-5 text-[14px] shadow-[0_12px_28px_rgba(70,50,55,0.08)] ring-1 ring-[#eee8e5]" data-bmq-supplier-upload-order>
              <div className="col-span-2">
                <dt className="text-[12px] text-[#6b6466]">Đơn hàng</dt>
                <dd className="mt-0.5 font-semibold">{order.poNumber}{order.supplierName ? ` · ${order.supplierName}` : ""}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-[12px] text-[#6b6466]">Hàng</dt>
                <dd className="mt-0.5 font-semibold [overflow-wrap:anywhere]">
                  {order.productName} · {formatQuantity(order.quantity)} {order.unit}
                </dd>
              </div>
              <div>
                <dt className="text-[12px] text-[#6b6466]">Ngày đặt</dt>
                <dd className="mt-0.5 tabular-nums">{sentDate(order.sentAt)}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-[#6b6466]">Đã nhận</dt>
                <dd className="mt-0.5 tabular-nums" data-bmq-supplier-upload-count>{count} file</dd>
              </div>
            </dl>

            <input ref={input} type="file" accept={ACCEPT} multiple className="sr-only" id="supplier-upload-file"
              onChange={(event) => void pick(event.target.files)} disabled={busy || count >= 10} />
            <label htmlFor="supplier-upload-file"
              className={`mt-5 flex min-h-[56px] cursor-pointer items-center justify-center gap-2 rounded-2xl bg-[#211d1e] px-5 text-[16px] font-semibold text-white transition active:scale-[0.98] ${busy || count >= 10 ? "pointer-events-none opacity-50" : ""}`}
              data-bmq-supplier-upload-pick>
              {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImageUp className="h-5 w-5" />}
              {busy ? "Đang tải lên…" : "Chụp hoặc chọn hoá đơn"}
            </label>
            <p className="mt-2 text-center text-[12.5px] leading-5 text-[#6b6466]">Ảnh hoặc PDF, tối đa 10 MB mỗi file. Gửi được nhiều file.</p>

            {rows.length ? (
              <ul className="mt-5 grid gap-2" data-bmq-supplier-upload-rows>
                {rows.map((row) => (
                  <li key={row.key} className="flex items-start gap-3 rounded-xl bg-white px-4 py-3 text-[14px] ring-1 ring-[#eee8e5]">
                    {row.state === "uploading" ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[#6b6466]" />
                      : row.state === "done" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#1f6b35]" />
                      : <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[#8f2414]" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{row.name}</span>
                      {row.state === "done" ? <span className="block text-[12.5px] text-[#1f6b35]">Đã gửi BMQ</span> : null}
                      {row.state === "error" ? <span className="block text-[12.5px] text-[#8f2414]">{row.message}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            {rows.some((row) => row.state === "done") && !busy ? (
              <p className="mt-6 text-center text-[15px] font-medium text-[#1f6b35]" data-bmq-supplier-upload-thanks>Cảm ơn quý NCC. BMQ đã nhận hoá đơn.</p>
            ) : null}
          </>
        ) : null}

        <p className="mt-auto pt-10 text-center text-[12px] text-[#9a9294]">Công ty CP Thực phẩm BMQ · order@bmq.vn</p>
      </section>
    </main>
  );
}
