export interface OptimizedSlipImage {
  imageBase64: string;
  mimeType: string;
}

export async function fileToBase64(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function drawCompressedImage(
  imageBase64: string,
  mimeType: string,
  options: {
    maxWidth: number;
    maxHeight?: number;
    quality: number;
    minSavingsRatio: number;
    fillWhite?: boolean;
  }
): Promise<OptimizedSlipImage> {
  try {
    if (typeof window === "undefined" || !mimeType.startsWith("image/")) {
      return { imageBase64, mimeType };
    }

    const src = `data:${mimeType || "image/jpeg"};base64,${imageBase64}`;
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Load image failed"));
      el.src = src;
    });

    const widthScale = options.maxWidth / Math.max(1, img.width);
    const heightScale = (options.maxHeight || options.maxWidth) / Math.max(1, img.height);
    const scale = Math.min(1, widthScale, heightScale);
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { imageBase64, mimeType };

    if (options.fillWhite) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
    }

    ctx.drawImage(img, 0, 0, width, height);

    const outMime = "image/jpeg";
    const outBase64 = canvas.toDataURL(outMime, options.quality).split(",")[1] || imageBase64;
    if (outBase64.length < imageBase64.length * options.minSavingsRatio) {
      return { imageBase64: outBase64, mimeType: outMime };
    }

    return { imageBase64, mimeType };
  } catch {
    return { imageBase64, mimeType };
  }
}

export async function normalizeUploadImage(file: File): Promise<OptimizedSlipImage> {
  const originalBase64 = await fileToBase64(file);
  const originalMime = file.type || "image/jpeg";

  return drawCompressedImage(originalBase64, originalMime, {
    maxWidth: 1800,
    maxHeight: 1800,
    quality: 0.82,
    minSavingsRatio: 0.98,
    fillWhite: true,
  });
}

export async function optimizeSlipImageForOcr(
  imageBase64: string,
  mimeType: string,
  aggressive = false
): Promise<OptimizedSlipImage> {
  return drawCompressedImage(imageBase64, mimeType || "image/jpeg", {
    maxWidth: aggressive ? 1200 : 1600,
    maxHeight: aggressive ? 1200 : 1600,
    quality: aggressive ? 0.6 : 0.76,
    minSavingsRatio: aggressive ? 0.88 : 0.96,
    fillWhite: false,
  });
}
