import { useRef, useState } from "react";
import { DealerSignupApiError, uploadDealerSlip } from "@/lib/dealer-signup-api";

/*
 * Dealer portal banner for a newly approved dealer who has not sent a bank
 * slip yet: the account can log in and browse, but dealer-order-submit refuses
 * orders until the slip arrives and accounting confirms the transfer. The
 * dealer can upload it right here with the current dealer session; after that
 * the banner says BMQ is confirming the payment.
 */

const MAX_BYTES = 10 * 1024 * 1024;

const ERRORS: Record<string, string> = {
  invalid_file_type: "Chỉ nhận ảnh JPEG, PNG, WebP hoặc tệp PDF.",
  file_too_large: "Tệp vượt quá 10 MB.",
  dealer_session_invalid: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  rate_limited: "Thử quá nhiều lần. Vui lòng đợi ít phút.",
};

export function DealerAwaitingSlipNotice({
  status,
  sessionToken,
  onActivated,
}: {
  status: "waiting_slip" | "slip_submitted" | "active" | null;
  sessionToken: string;
  onActivated: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  if (status === "slip_submitted") {
    return (
      <div data-dealer-awaiting-payment="true" role="status" className="border-b border-violet-200 bg-violet-50 px-4 py-3 text-violet-950">
        <p className="mx-auto max-w-6xl text-sm leading-5">
          <b>BMQ đã nhận bank slip.</b> Kế toán đang xác nhận tiền chuyển khoản, xong là anh/chị đặt bánh được.
        </p>
      </div>
    );
  }
  if (status !== "waiting_slip" || !sessionToken) return null;

  const upload = async (file: File | undefined) => {
    if (!file || uploading) return;
    setError("");
    if (file.size > MAX_BYTES) {
      setError(ERRORS.file_too_large);
      return;
    }
    setUploading(true);
    try {
      await uploadDealerSlip({ file, dealerToken: sessionToken });
      onActivated();
    } catch (err) {
      if (err instanceof DealerSignupApiError && err.code === "dealer_not_waiting_slip") {
        onActivated();
        return;
      }
      setError(
        err instanceof DealerSignupApiError
          ? (err.code && ERRORS[err.code]) || err.message
          : "Không gửi được bank slip. Kiểm tra mạng rồi thử lại.",
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      data-dealer-awaiting-slip="true"
      role="status"
      className="border-b border-sky-200 bg-sky-50 px-4 py-3 text-sky-950"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-5">
          <b>Tài khoản đang chờ bank slip.</b> Gửi bank slip để bắt đầu đặt bánh.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void upload(file);
          }}
        />
        <button
          type="button"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          className="inline-flex h-10 shrink-0 items-center justify-center rounded-xl bg-sky-700 px-4 text-sm font-semibold text-white transition hover:bg-sky-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {uploading ? "Đang gửi..." : "Gửi bank slip"}
        </button>
      </div>
      {error ? <p role="alert" className="mx-auto mt-2 max-w-6xl text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
