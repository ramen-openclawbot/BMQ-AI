import { useEffect, useRef, useState } from "react";
import bmqLogo from "@/assets/bmq-logo.png";
import {
  DealerSignupApiError,
  getDealerSlipStatus,
  uploadDealerSlip,
  type DealerSignupSlipStatusResult,
} from "@/lib/dealer-signup-api";

/*
 * Public bank-slip upload for a newly approved dealer
 * (dathang.banhmique.vn/dai-ly-moi/bank-slip?token=...). The one-time token
 * from the congratulations email is checked by dealer-signup-slip; a valid
 * upload turns the dealer official so ordering opens. Palette follows
 * /dai-ly-moi.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";

const primaryButton =
  "inline-flex h-12 w-full items-center justify-center rounded-xl bg-[#d94f8a] px-6 text-base font-semibold text-white transition hover:bg-[#bd3f75] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b83b70] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

const ERRORS: Record<string, string> = {
  slip_token_invalid: "Link không hợp lệ. Anh/chị mở lại link trong email BMQ đã gửi.",
  slip_token_expired: "Link đã hết hạn. Vui lòng gọi BMQ để được gửi link mới.",
  slip_token_used: "Bank slip đã được gửi trước đó. Anh/chị có thể đặt bánh ngay.",
  invalid_file_type: "Chỉ nhận ảnh JPEG, PNG, WebP hoặc tệp PDF.",
  file_too_large: "Tệp vượt quá 10 MB. Anh/chị chụp lại hoặc chọn tệp nhỏ hơn.",
  file_required: "Vui lòng chọn ảnh bank slip.",
  rate_limited: "Anh/chị thử quá nhiều lần. Vui lòng đợi ít phút rồi thử lại.",
};

function errorText(error: unknown): string {
  if (error instanceof DealerSignupApiError) {
    return (error.code && ERRORS[error.code]) || error.message || "Không gửi được bank slip. Vui lòng thử lại.";
  }
  return "Không gửi được bank slip. Kiểm tra kết nối mạng rồi thử lại.";
}

function readToken(): string {
  return new URLSearchParams(window.location.search).get("token")?.trim() || "";
}

type View =
  | { kind: "loading" }
  | { kind: "ready"; info: DealerSignupSlipStatusResult }
  | { kind: "done"; businessName?: string }
  | { kind: "blocked"; title: string; text: string };

export default function DealerBankSlipPage() {
  const token = useRef(readToken()).current;
  const inputRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    document.title = "BMQ · Gửi bank slip";
    if (!token) {
      setView({ kind: "blocked", title: "Thiếu link bank slip", text: ERRORS.slip_token_invalid });
      return;
    }
    let cancelled = false;
    getDealerSlipStatus(token)
      .then((info) => {
        if (cancelled) return;
        if (info.status === "valid") setView({ kind: "ready", info });
        else if (info.status === "used") setView({ kind: "done", businessName: info.business_name });
        else if (info.status === "expired") setView({ kind: "blocked", title: "Link đã hết hạn", text: ERRORS.slip_token_expired });
        else setView({ kind: "blocked", title: "Link không hợp lệ", text: ERRORS.slip_token_invalid });
      })
      .catch((err) => {
        if (cancelled) return;
        setView({ kind: "blocked", title: "Chưa mở được trang", text: errorText(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const choose = (next: File | undefined) => {
    setError("");
    if (!next) return;
    if (next.size > MAX_BYTES) {
      setFile(null);
      setError(ERRORS.file_too_large);
      return;
    }
    setFile(next);
  };

  const submit = async () => {
    if (!file || uploading) return;
    setUploading(true);
    setError("");
    try {
      const result = await uploadDealerSlip({ file, token });
      setView({ kind: "done", businessName: result.business_name });
    } catch (err) {
      if (err instanceof DealerSignupApiError && err.code === "slip_token_used") {
        setView({ kind: "done" });
      } else {
        setError(errorText(err));
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-[#fff9f5] text-[#34252c] antialiased">
      <header className="border-b border-[#f3dce6] bg-[#fff9f5]">
        <div className="mx-auto flex h-16 max-w-xl items-center gap-2.5 px-5">
          <img src={bmqLogo} alt="" className="h-9 w-9 rounded-full object-contain" />
          <span className="text-base font-bold">Bánh Mì Que BMQ</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-xl px-5 pb-16 pt-8 sm:pt-12" data-dealer-bank-slip={view.kind}>
        {view.kind === "loading" ? (
          <div className="space-y-3" aria-label="Đang kiểm tra link">
            <div className="h-4 w-32 animate-pulse rounded-full bg-[#f5dce7]" />
            <div className="h-8 w-3/4 animate-pulse rounded-full bg-[#f5dce7]" />
            <div className="h-40 w-full animate-pulse rounded-2xl bg-white" />
          </div>
        ) : null}

        {view.kind === "blocked" ? (
          <div role="status" className="rounded-2xl border border-[#edd4df] bg-white p-6 sm:p-8">
            <h1 className="text-2xl font-bold">{view.title}</h1>
            <p className="mt-3 text-base leading-7 text-[#806873]">{view.text}</p>
            <p className="mt-5 text-sm text-[#806873]">
              Cần hỗ trợ: <a href="tel:1900555591" className="font-semibold text-[#bd3f75]">1900 555591</a>
            </p>
          </div>
        ) : null}

        {view.kind === "done" ? (
          <div role="status" className="rounded-2xl border border-[#abefc6] bg-white p-6 sm:p-8">
            <p className="text-sm font-semibold text-[#067647]">Đã nhận bank slip</p>
            <h1 className="mt-2 text-2xl font-bold">
              {view.businessName ? `${view.businessName} đã là đại lý BMQ` : "Anh/chị đã là đại lý BMQ"}
            </h1>
            <p className="mt-3 text-base leading-7 text-[#806873]">
              Anh/chị đăng nhập bằng số điện thoại đã đăng ký để bắt đầu đặt bánh.
            </p>
            <a href="/" className={`${primaryButton} mt-6`}>Đặt bánh ngay</a>
          </div>
        ) : null}

        {view.kind === "ready" ? (
          <>
            {view.info.application_code ? (
              <p className="text-sm font-semibold text-[#bd3f75]">Mã hồ sơ {view.info.application_code}</p>
            ) : null}
            <h1 className="mt-2 text-[1.75rem] font-extrabold leading-tight sm:text-[2.1rem]">Gửi bank slip</h1>
            <p className="mt-3 text-base leading-7 text-[#806873]">
              {view.info.business_name ? <b className="text-[#34252c]">{view.info.business_name}</b> : "Hồ sơ của anh/chị"} đã được BMQ duyệt.
              Gửi ảnh chụp hoặc tệp PDF bank slip để bắt đầu đặt bánh.
            </p>

            <div className="mt-7 rounded-2xl border border-[#edd4df] bg-white p-5 sm:p-6">
              <input
                ref={inputRef}
                type="file"
                accept={ACCEPT}
                className="sr-only"
                id="bank-slip-file"
                onChange={(event) => {
                  choose(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              <label
                htmlFor="bank-slip-file"
                className="flex min-h-[11rem] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#edd4df] bg-[#fff9f5] p-4 text-center transition hover:border-[#d94f8a] focus-within:border-[#d94f8a]"
              >
                {preview ? (
                  <img src={preview} alt="Bank slip đã chọn" className="max-h-64 rounded-lg object-contain" />
                ) : file ? (
                  <span className="text-base font-semibold">{file.name}</span>
                ) : (
                  <>
                    <span className="text-base font-semibold">Chọn ảnh hoặc chụp bank slip</span>
                    <span className="text-sm text-[#806873]">JPEG, PNG, WebP hoặc PDF, tối đa 10 MB</span>
                  </>
                )}
              </label>
              {file ? (
                <button
                  type="button"
                  className="mt-3 text-sm font-semibold text-[#bd3f75] hover:underline"
                  onClick={() => inputRef.current?.click()}
                >
                  Chọn tệp khác
                </button>
              ) : null}

              {error ? (
                <p role="alert" className="mt-4 rounded-xl border border-[#f4c7c3] bg-[#fef3f2] p-3 text-sm leading-6 text-[#b42318]">
                  {error}
                </p>
              ) : null}

              <button type="button" className={`${primaryButton} mt-5`} disabled={!file || uploading} onClick={submit}>
                {uploading ? "Đang gửi..." : "Gửi bank slip"}
              </button>
            </div>

            <p className="mt-5 text-sm text-[#806873]">
              Cần hỗ trợ: <a href="tel:1900555591" className="font-semibold text-[#bd3f75]">1900 555591</a>
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}
