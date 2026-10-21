import * as THREE from "three";

// Cozy palette of the approved ordering-machine demo (16/10): clay machine, warm kraft shelves, sage accents.
export const C = {
  ink: "#3e4b40",
  paper: "#f5f1e5",
  paperDeep: "#e4ddc8",
  cream: "#fbf4e3",
  white: "#fff9ef",
  sage: "#859b7a",
  sageDeep: "#5e7856",
  sageLight: "#dce4d0",
  coral: "#c88169",
  coralLight: "#ebc3b0",
  mustard: "#ccaa65",
  mustardLight: "#efe1b7",
  plum: "#c4816a",
  plumLight: "#ebc3b0",
  kraft: "#b99464",
  kraftDeep: "#906c47",
} as const;

/** Seeded random (mulberry32): the only randomness allowed in the scene. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
export const smooth = (x: number) => { const k = clamp01(x); return k * k * (3 - 2 * k); };
export const smoother = (x: number) => { const k = clamp01(x); return k * k * k * (k * (k * 6 - 15) + 10); };
export const easeOutBack = (x: number, s = 1.7) => { const k = clamp01(x) - 1; return 1 + k * k * ((s + 1) * k + s); };
export const easeInQuad = (x: number) => { const k = clamp01(x); return k * k; };
/** Progress of [t0, t0 + d] at time t. */
export const span = (t: number, t0: number, d: number) => clamp01((t - t0) / d);

/** Damped ring after a contact at tc (0 before it). */
export function ring(t: number, tc: number, amp: number, freq = 16, decay = 7) {
  const dt = t - tc;
  if (dt < 0) return 0;
  return amp * Math.exp(-decay * dt) * Math.sin(freq * dt);
}
/** Squash factor after a contact: >0 means compressed. */
export function squash(t: number, tc: number, amp = 0.16) {
  const dt = t - tc;
  if (dt < 0) return 0;
  return amp * Math.exp(-9 * dt) * Math.cos(15 * dt);
}

/**
 * A part that falls from `h` above its rest height and lands at `tl`, then settles with a small hop.
 * Returns null before it appears.
 */
export function dropY(t: number, tl: number, h: number, fall = 0.32): number | null {
  if (t < tl - fall) return null;
  if (t < tl) return h * (1 - easeInQuad((t - (tl - fall)) / fall));
  const dt = t - tl;
  return 0.07 * Math.exp(-8 * dt) * Math.abs(Math.sin(13 * dt));
}

let rampTex: THREE.DataTexture | null = null;
export function toonRamp(): THREE.DataTexture {
  if (rampTex) return rampTex;
  rampTex = new THREE.DataTexture(new Uint8Array([120, 200, 255]), 3, 1, THREE.RedFormat);
  rampTex.minFilter = THREE.NearestFilter;
  rampTex.magFilter = THREE.NearestFilter;
  rampTex.needsUpdate = true;
  return rampTex;
}

const toonCache = new Map<string, THREE.MeshToonMaterial>();
export function toon(color: string): THREE.MeshToonMaterial {
  let mat = toonCache.get(color);
  if (!mat) {
    mat = new THREE.MeshToonMaterial({ color, gradientMap: toonRamp() });
    toonCache.set(color, mat);
  }
  return mat;
}

export const inkMat = new THREE.MeshBasicMaterial({ color: C.ink, side: THREE.BackSide });

export type Part = THREE.Group & { userData: { mesh: THREE.Mesh } };

function part(geometry: THREE.BufferGeometry, hull: THREE.BufferGeometry | null, material: THREE.Material, shadow: boolean): Part {
  const group = new THREE.Group() as Part;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  group.add(mesh);
  if (hull) group.add(new THREE.Mesh(hull, inkMat));
  group.userData.mesh = mesh;
  return group;
}

/** Box with a navy ink outline (inverted hull). */
export function box(w: number, h: number, d: number, color: string, ink = 0.03, shadow = true): Part {
  return part(new THREE.BoxGeometry(w, h, d), ink > 0 ? new THREE.BoxGeometry(w + 2 * ink, h + 2 * ink, d + 2 * ink) : null, toon(color), shadow);
}

/** Cylinder / truncated cone along y with an ink outline. */
export function cyl(rTop: number, rBot: number, h: number, color: string, seg = 28, ink = 0.03, shadow = true): Part {
  return part(
    new THREE.CylinderGeometry(rTop, rBot, h, seg),
    ink > 0 ? new THREE.CylinderGeometry(rTop + ink, rBot + ink, h + 2 * ink, seg) : null,
    toon(color),
    shadow,
  );
}

export function flat(color: string): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true });
}
