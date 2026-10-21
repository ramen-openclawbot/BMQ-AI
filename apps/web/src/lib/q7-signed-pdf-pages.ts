import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

export const MAX_PAGES = 8;
export const PAGE_LONG_SIDE_PX = 1800;
export const PAGE_JPEG_QUALITY = 0.85;
export const PAGE_JPEG_RETRY_QUALITY = 0.7;
export const PAGE_MAX_BLOB_BYTES = 2.5 * 1024 * 1024;

export type RenderedPdfPage = {
  page: number;
  blob: Blob;
};

export type RenderPdfPagesOptions = {
  maxPages?: number;
  longSidePx?: number;
};

const encodeJpeg = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("page_image_encode_failed"))),
      "image/jpeg",
      quality,
    );
  });

/**
 * Render every page of a signed PDF to a JPEG Blob for the DeepSeek page-image
 * check. Kept free of React so the upload mutation owns the interaction state.
 */
export async function renderPdfPagesToJpeg(file: File, opts?: RenderPdfPagesOptions): Promise<RenderedPdfPage[]> {
  const maxPages = opts?.maxPages ?? MAX_PAGES;
  const longSidePx = opts?.longSidePx ?? PAGE_LONG_SIDE_PX;
  const loadingTask = getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await loadingTask.promise;

  try {
    if (pdf.numPages > maxPages) {
      throw new Error("Phiếu quá 8 trang, không gửi kiểm tra tự động được.");
    }
    if (pdf.numPages < 1) throw new Error("page_image_render_failed");

    const rendered: RenderedPdfPage[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const longestSide = Math.max(baseViewport.width, baseViewport.height);
      if (!Number.isFinite(longestSide) || longestSide <= 0) throw new Error("page_image_render_failed");
      const viewport = page.getViewport({ scale: longSidePx / longestSide });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("page_image_render_failed");

      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: context, viewport }).promise;

      let blob = await encodeJpeg(canvas, PAGE_JPEG_QUALITY);
      if (blob.size > PAGE_MAX_BLOB_BYTES) blob = await encodeJpeg(canvas, PAGE_JPEG_RETRY_QUALITY);
      rendered.push({ page: pageNumber, blob });
    }

    return rendered;
  } finally {
    await pdf.destroy();
  }
}
