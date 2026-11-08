// Client-side selfie compression for the Bếp Q7 attendance flow.
//
// Draws a live-camera frame or an existing blob to a canvas, caps the longest
// side at 1280 px and steps JPEG quality 0.8 → 0.7 → 0.6 → 0.5 until the result
// is at most 300 KB (the Edge Function accepts up to 600 KB). Pure sizing math
// is exported so `node --test` can verify it without a DOM.

export const SELFIE_MAX_SIDE = 1280;
export const SELFIE_TARGET_BYTES = 300 * 1024;
export const SELFIE_QUALITY_STEPS = [0.8, 0.7, 0.6, 0.5] as const;

export interface SelfieSize {
  width: number;
  height: number;
}

/** Fit width/height inside a square maxSide while preserving aspect ratio. */
export function computeTargetSize(width: number, height: number, maxSide = SELFIE_MAX_SIDE): SelfieSize {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || maxSide <= 0) {
    return { width: 0, height: 0 };
  }
  const longest = Math.max(width, height);
  if (longest <= maxSide) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface SelfieCompressResult {
  blob: Blob;
  width: number;
  height: number;
  quality: number;
}

interface DrawableSource {
  width?: number;
  height?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  videoWidth?: number;
  videoHeight?: number;
}

function sourceSize(source: DrawableSource): SelfieSize {
  const width = Number(source.naturalWidth || source.videoWidth || source.width || 0);
  const height = Number(source.naturalHeight || source.videoHeight || source.height || 0);
  return { width, height };
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function loadBlob(blob: Blob): Promise<DrawableSource & CanvasImageSource> {
  if (typeof createImageBitmap === "function") {
    return (await createImageBitmap(blob)) as unknown as DrawableSource & CanvasImageSource;
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Không đọc được ảnh selfie."));
      image.src = url;
    });
    return image as unknown as DrawableSource & CanvasImageSource;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Compress a live frame (video/canvas/image) or a Blob. Returns the first
 * quality step that fits the 300 KB target, or the last (0.5) if none does.
 */
export async function compressSelfie(
  source: Blob | (DrawableSource & CanvasImageSource),
  maxSide = SELFIE_MAX_SIDE,
): Promise<SelfieCompressResult> {
  if (typeof document === "undefined") {
    throw new Error("Trình duyệt không hỗ trợ nén ảnh selfie.");
  }

  const drawable = source instanceof Blob ? await loadBlob(source) : source;
  const original = sourceSize(drawable);
  const target = computeTargetSize(original.width, original.height, maxSide);
  if (!target.width || !target.height) {
    throw new Error("Không đọc được kích thước ảnh selfie.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Trình duyệt không hỗ trợ nén ảnh selfie.");
  context.drawImage(drawable as CanvasImageSource, 0, 0, target.width, target.height);

  let lastBlob: Blob | null = null;
  for (const quality of SELFIE_QUALITY_STEPS) {
    const blob = await canvasToBlob(canvas, quality);
    if (!blob) continue;
    lastBlob = blob;
    if (blob.size <= SELFIE_TARGET_BYTES) {
      return { blob, width: target.width, height: target.height, quality };
    }
  }

  if (!lastBlob) throw new Error("Không nén được ảnh selfie.");
  return { blob: lastBlob, width: target.width, height: target.height, quality: SELFIE_QUALITY_STEPS[SELFIE_QUALITY_STEPS.length - 1] };
}
