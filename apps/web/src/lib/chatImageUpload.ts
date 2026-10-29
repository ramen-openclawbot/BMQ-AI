// Image preparation for the BMQ chat, following chat.vnagent.ai: the picked file is shown at once
// from an object URL while a downscaled copy (longest side 2048px, JPEG 0.84 on white) is made in
// the background, so Send only has to upload. The merchant agent reads JPEG/PNG/WebP up to 6 MB.

export const CHAT_IMAGE_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_SIDE = 2048;
const QUALITY = 0.84;

export type PreparedChatImage = {
  mimeType: "image/jpeg";
  base64: string;
  bytes: number;
  width: number;
  height: number;
  /** data: URL of the prepared copy, used for the sent-message thumbnail and the viewer. */
  dataUrl: string;
};

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Fall through to the <img> decoder (older Safari, HEIC handed over as image/*).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("decode_failed"));
      element.src = url;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** Downscale and re-encode one picked image. Throws a Vietnamese message the composer can show. */
export async function prepareChatImage(file: File): Promise<PreparedChatImage> {
  if (!file.type.startsWith("image/")) throw new Error("Anh chọn một ảnh (JPG, PNG hoặc WebP).");
  if (file.size > CHAT_IMAGE_MAX_SOURCE_BYTES) throw new Error(`${file.name || "Ảnh"} lớn hơn 10 MB. Anh chụp màn hình rồi gửi lại nhé.`);
  let decoded: Decoded;
  try {
    decoded = await decode(file);
  } catch {
    throw new Error("Ảnh này chưa đọc được. Anh chụp màn hình bankslip rồi gửi lại nhé.");
  }
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(1, decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas_unavailable");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(decoded.source, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", QUALITY);
    canvas.width = canvas.height = 1;
    const base64 = dataUrl.split(",")[1] || "";
    if (!base64) throw new Error("encode_failed");
    return { mimeType: "image/jpeg", base64, bytes: Math.floor(base64.length * 3 / 4), width, height, dataUrl };
  } catch {
    throw new Error("Ảnh này chưa đọc được. Anh chụp màn hình bankslip rồi gửi lại nhé.");
  } finally {
    decoded.close();
  }
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toLocaleString("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}
