/*
 * Shared OpenStreetMap (Leaflet) loader for the dealer signup page and the CRM
 * dealer pin screen. Leaflet 1.9.4 comes from unpkg, pinned by Subresource
 * Integrity so a changed file is refused.
 */

export type LatLng = { lat: number; lng: number };

// Minimal typing for the Leaflet objects the BMQ map screens use.
export type LPoint = [number, number];
export type LMap = {
  setView(p: LPoint, zoom: number): LMap;
  panTo(p: LPoint): void;
  on(event: string, f: (ev: { latlng: LatLng }) => void): void;
  invalidateSize(): void;
  remove(): void;
};
export type LMarker = {
  setLatLng(p: LPoint): void;
  getLatLng(): LatLng;
  on(event: string, f: () => void): void;
  addTo(m: LMap): LMarker;
};
export type Leaflet = {
  map(el: HTMLElement, opts?: Record<string, unknown>): LMap;
  tileLayer(url: string, opts: Record<string, unknown>): { addTo(m: LMap): void };
  marker(p: LPoint, opts: Record<string, unknown>): LMarker;
  divIcon(opts: Record<string, unknown>): unknown;
};

declare global {
  interface Window {
    L?: Leaflet;
  }
}

export const HCMC: LatLng = { lat: 10.7769, lng: 106.7009 };
export const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

const LEAFLET_JS = { src: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", integrity: "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" };
const LEAFLET_CSS = { href: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", integrity: "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" };

let leafletPromise: Promise<Leaflet> | null = null;
export function loadLeaflet(): Promise<Leaflet> {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise<Leaflet>((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = LEAFLET_CSS.href;
    css.integrity = LEAFLET_CSS.integrity;
    css.crossOrigin = "";
    document.head.appendChild(css);
    const script = document.createElement("script");
    script.src = LEAFLET_JS.src;
    script.integrity = LEAFLET_JS.integrity;
    script.crossOrigin = "";
    script.async = true;
    script.onload = () => (window.L ? resolve(window.L) : reject(new Error("leaflet_missing")));
    script.onerror = () => {
      leafletPromise = null;
      reject(new Error("leaflet_load_failed"));
    };
    document.head.appendChild(script);
  });
  return leafletPromise;
}
