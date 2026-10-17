import { useEffect } from "react";

/**
 * Game screens (Kho 2D/3D, Đặt hàng tự động) own the pinch gesture: it zooms the 3D camera, never the page.
 * Owner 17/10 IMG_5826: a pinch on iPhone zoomed the whole page, and because the canvas takes every touch the
 * page could not be pinched back out ("Phóng to bị kẹt"). While a game screen is mounted:
 *   - iOS gesture events and two-finger touchmoves no longer zoom the page (pointer events still reach the canvas);
 *   - a page that is already zoomed (visualViewport.scale > 1) is snapped back to 1×.
 */
export function resetPageZoom() {
  const vv = window.visualViewport;
  if (!vv || vv.scale <= 1.01) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  const original = meta.getAttribute("content") ?? "width=device-width, initial-scale=1.0";
  // Pinning the scale for a moment makes iOS Safari drop the page zoom; the original tag comes back right after,
  // so pinch-zoom elsewhere in the app is untouched.
  meta.setAttribute("content", `${original.replace(/,\s*maximum-scale=[^,]*/g, "")}, maximum-scale=1`);
  window.setTimeout(() => meta.setAttribute("content", original), 350);
}

export function usePageZoomGuard() {
  useEffect(() => {
    const block = (e: Event) => { e.preventDefault(); };
    const twoFingers = (e: TouchEvent) => { if (e.touches.length > 1) e.preventDefault(); };
    const settle = () => resetPageZoom();
    document.addEventListener("gesturestart", block, { passive: false });
    document.addEventListener("gesturechange", block, { passive: false });
    document.addEventListener("gestureend", settle);
    document.addEventListener("touchmove", twoFingers, { passive: false });
    window.visualViewport?.addEventListener("resize", settle);
    resetPageZoom();
    return () => {
      document.removeEventListener("gesturestart", block);
      document.removeEventListener("gesturechange", block);
      document.removeEventListener("gestureend", settle);
      document.removeEventListener("touchmove", twoFingers);
      window.visualViewport?.removeEventListener("resize", settle);
    };
  }, []);
}
