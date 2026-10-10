// Calls the scan-invoice edge function for one image. Shared by the cash phiếu dialog.
import type { CashPrScanExtracted } from "@/lib/cash-pr-lines";

export async function scanInvoiceFile(file: File, accessToken: string): Promise<CashPrScanExtracted & Record<string, unknown>> {
  const imageBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-invoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ imageBase64, mimeType: file.type || "image/jpeg", documentType: "payment_request" }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (payload as { error?: string }).error;
    if (response.status === 429) throw new Error(message || "Đang quét quá nhiều, thử lại sau ít phút");
    throw new Error(message || "Không đọc được hoá đơn");
  }
  const data = (payload as { data?: CashPrScanExtracted & Record<string, unknown> }).data;
  if (!data) throw new Error("Không đọc được hoá đơn");
  return data;
}
