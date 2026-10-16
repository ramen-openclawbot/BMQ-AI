import * as THREE from "three";
import { C, box, cyl, toon, inkMat, mulberry32, lerp, smoother, easeOutBack, span, ring, squash, dropY, type Part } from "./kit";

/** What the room needs to know about the warehouse (the page maps the live snapshot onto it). */
export type RoomItem = { id: string; name: string; group: string; low: boolean };
export type RoomShelf = { code: string; label: string; icon: string; color: string; items: RoomItem[]; low: RoomItem[] };
export type RoomData = { items: RoomItem[]; groups: RoomShelf[]; low: RoomItem[] };
type Item = RoomItem;
type WarehouseData = RoomData;

/**
 * Kho văn phòng (owner-approved demo 16/10, ported 16/10): one fixed orthographic view (no zoom, no camera moves), a staff avatar that walks,
 * shelves on the walls, the ordering machine, and the PR approval desk.
 * Every frame is renderAt(t): a pure function of time and the event list (walk paths are baked when pushed).
 */
export type RoomEvent =
  | { type: "assemble"; t: number }
  | { type: "walk"; t: number; path: Float32Array; face: number | null }
  | { type: "station"; t: number; id: string | null }
  | { type: "drag"; t: number; on: boolean }
  | { type: "hover"; t: number; on: boolean }
  | { type: "drop"; t: number; itemId: string; from: [number, number, number] }
  | { type: "print"; t: number; slips: number }
  | { type: "stamp"; t: number; ok: boolean }
  | { type: "clear"; t: number };

export const BEAT = {
  base: 0.25, body: 0.6, face: 0.85, hopper: 1.1, gears: 1.35, conveyor: 1.45, shelves: 1.2, shelfStep: 0.07,
  desk: 1.9, avatar: 2.2, eyes: 2.6, hop0: 2.75, hopStep: 0.1, wave: 3.3, end: 3.8,
};
export const FLY = 0.42;
export const WALK_DT = 1 / 60;
const SPEED = 4.4;
const HOP = 0.34;
const SLIP_GAP = 0.45;
const QUEUE_MAX = 6;

const M = new THREE.Vector3(0.4, 0, -1.3);
const HOPPER = M.clone().add(new THREE.Vector3(0, 2.62, 0));
const BELT_TOP = M.clone().add(new THREE.Vector3(-0.95, 2.62, 0.05));
const BELT_LOW = new THREE.Vector3(-3.0, 0.42, 1.9);
const DESK = new THREE.Vector3(3.9, 0, 1.5);
const ENTRY = new THREE.Vector3(2.4, 0, 6.2);
const START = new THREE.Vector3(1.6, 0, 3.3);
const BOUNDS = { x0: -4.9, x1: 6.1, z0: -3.95, z1: 4.75 };
const BACK = [-4.25, -2.5, -0.75, 1.0, 2.75, 4.5];
const LEFT = [-2.7, -0.95, 0.8, 2.55];
const SLOTS: Array<[number, number]> = [];
for (const y of [0.3, 0.9, 1.5]) for (const x of [-0.45, -0.15, 0.15, 0.45]) SLOTS.push([x, y]);
SLOTS.reverse();

export type Station = { id: string; kind: "shelf" | "machine" | "desk"; stand: THREE.Vector3; face: number };
type ShelfL = { code: string; color: string; low: number; pos: THREE.Vector3; rot: number; rise: number; group: THREE.Group; sign: THREE.Group };
type CrateL = { item: Item; shelf: number; local: THREE.Vector3; pop: number; queue: number; color: THREE.Color; lid: THREE.Color };

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const tmpC = new THREE.Color();
const CORAL = new THREE.Color(C.coral);
const Y = new THREE.Vector3(0, 1, 0);
const SKIN = "#f2cfa0";

function el(tag: string, cls: string, parent: HTMLElement): HTMLDivElement {
  const node = document.createElement(tag) as HTMLDivElement;
  node.className = cls;
  parent.appendChild(node);
  return node;
}

function signTexture(icon: string, label: string, count: number, low: number, color: string): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 640; cv.height = 256;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const draw = () => {
    const g = cv.getContext("2d")!;
    g.fillStyle = color; g.fillRect(0, 0, 640, 256);
    g.fillStyle = "rgba(255,250,240,0.94)";
    g.beginPath(); g.roundRect(18, 18, 604, 220, 26); g.fill();
    g.fillStyle = C.ink;
    g.textBaseline = "middle";
    let size = 84;
    g.font = `800 ${size}px "Baloo 2", sans-serif`;
    const text = `${icon} ${label}`;
    while (g.measureText(text).width > 570 && size > 44) { size -= 4; g.font = `800 ${size}px "Baloo 2", sans-serif`; }
    g.textAlign = "center";
    g.fillText(text, 320, 100);
    g.font = '800 50px "Nunito", sans-serif';
    const left = `${count} món`;
    const right = low ? ` · ${low} sắp hết` : "";
    const wl = g.measureText(left).width;
    const wr = g.measureText(right).width;
    const x0 = 320 - (wl + wr) / 2;
    g.textAlign = "left";
    g.fillStyle = "#6f6a85"; g.fillText(left, x0, 184);
    if (low) { g.fillStyle = C.coral; g.fillText(right, x0 + wl, 184); }
    tex.needsUpdate = true;
  };
  draw();
  document.fonts?.ready.then(draw);
  return tex;
}

export class Room {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
  events: RoomEvent[] = [];
  frozen: number | null = null;
  /** Bottom part of the canvas covered by a panel (mobile sheet); the fixed view frames the room above it. */
  insetPx = 0;
  /** Shelf under the pointer (game hover): its sign lifts and its crates bob like the selected station. */
  hoverShelf: string | null = null;
  private t0 = performance.now();
  private raf = 0;
  private wh: WarehouseData | null = null;
  private itemById = new Map<string, Item>();
  private deskBase = 0;
  stations: Station[] = [];

  private machine = new THREE.Group();
  private base!: Part; private body!: THREE.Group; private face!: THREE.Group; private hopper!: THREE.Group;
  private eyes: THREE.Mesh[] = []; private mouth!: THREE.Mesh; private blush: THREE.Mesh[] = [];
  private gears: THREE.Group[] = []; private tray!: THREE.Group; private arm!: THREE.Group; private beacon!: THREE.Mesh; private glow!: THREE.Mesh;
  private pad!: Part;
  private conveyor = new THREE.Group(); private belt: THREE.Mesh[] = []; private beltBasis = new THREE.Quaternion();
  private beltDir = new THREE.Vector3(); private beltLen = 1;
  private shelfRoot = new THREE.Group(); private shelves: ShelfL[] = [];
  private crates: CrateL[] = []; private crateBody: THREE.InstancedMesh | null = null; private crateHull: THREE.InstancedMesh | null = null; private crateLid: THREE.InstancedMesh | null = null;
  private flyPool: Part[] = []; private slips: THREE.Group[] = [];
  private desk = new THREE.Group(); private deskStack: THREE.Mesh[] = []; private stamp = new THREE.Group(); private deskScreen!: THREE.Mesh; private doneTray!: THREE.Group;
  private avatar = new THREE.Group(); private legs: THREE.Group[] = []; private arms: THREE.Group[] = []; private avatarHead = new THREE.Group();
  private dust!: THREE.Points; private dustSeed: Array<[number, number, number, number]> = [];

  private bubble: HTMLDivElement; private counter: HTMLDivElement; private hint: HTMLDivElement; private queueTag: HTMLDivElement;
  private nameTag: HTMLDivElement; private deskTag: HTMLDivElement;
  private texts = new WeakMap<HTMLElement, string>();
  private nodes: HTMLElement[] = [];

  constructor(private canvas: HTMLCanvasElement, private overlay: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color(C.paper);
    this.buildRoom();
    this.buildMachine();
    this.buildConveyor();
    this.buildDesk();
    this.buildAvatar();
    this.scene.add(this.shelfRoot);
    this.bubble = el("div", "bay-bubble", overlay);
    this.counter = el("div", "bay-counter", overlay);
    this.hint = el("div", "bay-hint", overlay);
    this.queueTag = el("div", "bay-queue", overlay);
    this.nameTag = el("div", "bay-name", overlay);
    this.deskTag = el("div", "bay-desk", overlay);
    this.hint.textContent = "Thả vào phễu";
    this.nameTag.textContent = "Thủ kho";
    this.nodes.push(this.bubble, this.counter, this.hint, this.queueTag, this.nameTag, this.deskTag);
    // Fixed three-quarter view.
    const az = 0.55, elv = 0.68;
    const target = new THREE.Vector3(0, 0.9, -0.4);
    this.camera.position.set(target.x + Math.sin(az) * Math.cos(elv) * 40, target.y + Math.sin(elv) * 40, target.z + Math.cos(az) * Math.cos(elv) * 40);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
    this.resize();
  }

  // ---------------------------------------------------------------- build
  private buildRoom() {
    const key = new THREE.DirectionalLight("#fffaf6", 2.4);
    key.position.set(7, 12, 9);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: 1, far: 50 });
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);
    this.scene.add(new THREE.AmbientLight("#ffebd6", 0.75));
    const rim = new THREE.DirectionalLight("#9cc3e6", 0.9);
    rim.position.set(-7, 5, -9);
    this.scene.add(rim);

    const cv = document.createElement("canvas");
    cv.width = cv.height = 64;
    const g = cv.getContext("2d")!;
    g.fillStyle = C.paperDeep; g.fillRect(0, 0, 64, 64);
    g.fillStyle = "rgba(44,41,71,0.10)";
    for (const [x, y] of [[16, 16], [48, 48]]) { g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = "rgba(44,41,71,0.08)"; g.lineWidth = 2; g.strokeRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(12.6 / 1.2, 10.6 / 1.2);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(12.6, 0.2, 10.6), new THREE.MeshToonMaterial({ color: "#ffffff", map: tex, gradientMap: toon(C.paper).gradientMap }));
    floor.position.set(0, -0.1, -0.2);
    floor.receiveShadow = true;
    this.scene.add(floor);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(12.68, 0.2, 10.68), inkMat);
    edge.position.copy(floor.position);
    this.scene.add(edge);
    // Back and left walls with a sage wainscot.
    const back = box(12.6, 3.0, 0.24, C.cream, 0.03);
    back.position.set(0, 1.5, -5.62);
    this.scene.add(back);
    const left = box(0.24, 3.0, 10.6, C.cream, 0.03);
    left.position.set(-6.42, 1.5, -0.2);
    this.scene.add(left);
    const wb = box(12.6, 0.55, 0.06, C.sageLight, 0, false);
    wb.position.set(0, 0.28, -5.48);
    this.scene.add(wb);
    const wl = box(0.06, 0.55, 10.6, C.sageLight, 0, false);
    wl.position.set(-6.28, 0.28, -0.2);
    this.scene.add(wl);

    // Assembly pad under the machine.
    this.pad = cyl(1.9, 1.95, 0.08, C.cream, 48, 0.03);
    this.pad.position.set(M.x, 0.04, M.z + 0.2);
    this.scene.add(this.pad);

    const rnd = mulberry32(1606);
    const pts = new Float32Array(50 * 3);
    for (let i = 0; i < 50; i++) this.dustSeed.push([rnd() * 11 - 5.5, rnd(), rnd() * 9 - 4.5, rnd() * Math.PI * 2]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    this.dust = new THREE.Points(geo, new THREE.PointsMaterial({ color: "#fff1cf", size: 0.06, transparent: true, opacity: 0.7, depthWrite: false }));
    this.scene.add(this.dust);
  }

  private buildMachine() {
    const m = this.machine;
    m.position.copy(M);
    this.scene.add(m);
    this.base = box(2.2, 0.35, 1.8, C.cream, 0.035);
    m.add(this.base);
    for (const [x, z] of [[-0.85, -0.65], [0.85, -0.65], [-0.85, 0.65], [0.85, 0.65]]) {
      const foot = cyl(0.13, 0.15, 0.12, C.sage, 16, 0.025);
      foot.position.set(x, -0.2, z);
      this.base.add(foot);
    }
    const plate = document.createElement("canvas");
    plate.width = 512; plate.height = 80;
    const plateTex = new THREE.CanvasTexture(plate);
    plateTex.colorSpace = THREE.SRGBColorSpace;
    const drawPlate = () => {
      const g = plate.getContext("2d")!;
      g.fillStyle = C.ink; g.fillRect(0, 0, 512, 80);
      g.fillStyle = C.mustardLight;
      g.font = '800 46px "Baloo 2", sans-serif';
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText("MÁY ĐẶT HÀNG", 256, 44);
      plateTex.needsUpdate = true;
    };
    drawPlate();
    document.fonts?.ready.then(drawPlate);
    const plateMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 0.2), new THREE.MeshBasicMaterial({ map: plateTex }));
    plateMesh.position.set(0, 0, 0.905);
    this.base.add(plateMesh);

    this.body = new THREE.Group();
    m.add(this.body);
    const shell = box(1.8, 1.5, 1.3, C.plum, 0.035);
    shell.position.y = 0.75;
    this.body.add(shell);
    const stripe = box(1.84, 0.12, 1.34, C.cream, 0.02, false);
    stripe.position.y = 0.36;
    this.body.add(stripe);
    const neck = cyl(0.36, 0.4, 0.14, C.sageDeep, 24, 0.025);
    neck.position.y = 1.56;
    this.body.add(neck);
    const slot = box(1.0, 0.1, 0.06, C.ink, 0, false);
    slot.position.set(0, 0.24, 0.66);
    this.body.add(slot);
    this.tray = new THREE.Group();
    this.tray.add(box(1.05, 0.05, 0.6, C.cream, 0.025));
    for (const [x, z, w, d] of [[0, 0.29, 1.05, 0.04], [-0.51, 0, 0.04, 0.6], [0.51, 0, 0.04, 0.6]] as const) {
      const lip = box(w, 0.09, d, C.cream, 0.02, false);
      lip.position.set(x, 0.06, z);
      this.tray.add(lip);
    }
    this.tray.position.set(0, 0.54, 1.12);
    m.add(this.tray);

    this.face = new THREE.Group();
    this.face.add(box(1.3, 0.78, 0.06, C.ink, 0.025, false));
    const white = new THREE.MeshBasicMaterial({ color: C.white });
    for (const x of [-0.27, 0.27]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.24, 0.03), white);
      eye.position.set(x, 0.07, 0.045);
      this.face.add(eye);
      this.eyes.push(eye);
    }
    this.mouth = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 0.03), white);
    this.mouth.position.set(0, -0.19, 0.045);
    this.face.add(this.mouth);
    const blushMat = new THREE.MeshBasicMaterial({ color: C.coralLight });
    for (const x of [-0.46, 0.46]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.07, 0.02), blushMat);
      b.position.set(x, -0.08, 0.04);
      this.face.add(b);
      this.blush.push(b);
    }
    this.face.position.set(0, 0.95, 0.68);
    this.body.add(this.face);

    for (const [r, y, z] of [[0.36, 0.78, 0.1], [0.22, 1.18, -0.32]] as const) {
      const gear = new THREE.Group();
      const disc = cyl(r, r, 0.12, C.sage, 24, 0.025);
      disc.rotation.z = Math.PI / 2;
      gear.add(disc);
      const teeth = Math.round(r * 26);
      for (let i = 0; i < teeth; i++) {
        const a = (i / teeth) * Math.PI * 2;
        const tooth = box(0.12, r * 0.42, r * 0.42, C.sage, 0.02, false);
        tooth.position.set(0, Math.cos(a) * (r + 0.05), Math.sin(a) * (r + 0.05));
        tooth.rotation.x = -a;
        gear.add(tooth);
      }
      const hub = cyl(r * 0.35, r * 0.35, 0.16, C.mustard, 16, 0.02, false);
      hub.rotation.z = Math.PI / 2;
      gear.add(hub);
      gear.position.set(0.97, y, z);
      this.body.add(gear);
      this.gears.push(gear);
    }
    this.arm = new THREE.Group();
    const shoulder = cyl(0.13, 0.13, 0.14, C.mustard, 16, 0.025);
    shoulder.rotation.z = Math.PI / 2;
    this.arm.add(shoulder);
    const upper = box(0.14, 0.55, 0.14, C.plum, 0.025);
    upper.position.y = -0.3;
    this.arm.add(upper);
    const hand = box(0.24, 0.2, 0.22, C.cream, 0.025);
    hand.position.y = -0.62;
    this.arm.add(hand);
    this.arm.position.set(1.0, 1.32, 0.38);
    this.body.add(this.arm);
    const post = cyl(0.04, 0.04, 0.42, C.ink, 8, 0);
    post.position.set(-0.7, 1.71, -0.5);
    this.body.add(post);
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), new THREE.MeshBasicMaterial({ color: C.coral }));
    this.beacon.position.set(-0.7, 1.96, -0.5);
    this.body.add(this.beacon);

    this.hopper = new THREE.Group();
    const cone = cyl(0.78, 0.34, 0.66, C.mustard, 32, 0.035);
    cone.position.y = 0.33;
    this.hopper.add(cone);
    const rim = cyl(0.84, 0.84, 0.08, C.mustardLight, 32, 0.03);
    rim.position.y = 0.68;
    this.hopper.add(rim);
    const mouth = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.02, 32), new THREE.MeshBasicMaterial({ color: C.ink }));
    mouth.position.y = 0.725;
    this.hopper.add(mouth);
    this.glow = new THREE.Mesh(new THREE.TorusGeometry(0.98, 0.07, 10, 48), new THREE.MeshBasicMaterial({ color: C.mustardLight, transparent: true, opacity: 0 }));
    this.glow.rotation.x = Math.PI / 2;
    this.glow.position.y = 0.74;
    this.hopper.add(this.glow);
    m.add(this.hopper);

    for (let i = 0; i < 8; i++) {
      const crate = box(0.3, 0.3, 0.3, C.kraft, 0.025);
      crate.visible = false;
      this.scene.add(crate);
      this.flyPool.push(crate);
    }
    for (let i = 0; i < 10; i++) {
      const slip = new THREE.Group();
      slip.add(box(0.62, 0.012, 0.44, C.white, 0.012));
      for (let k = 0; k < 3; k++) {
        const line = new THREE.Mesh(new THREE.BoxGeometry(k === 0 ? 0.3 : 0.44, 0.004, 0.03), new THREE.MeshBasicMaterial({ color: k === 0 ? C.plum : C.ink }));
        line.position.set(k === 0 ? -0.07 : 0, 0.009, -0.12 + k * 0.11);
        slip.add(line);
      }
      slip.visible = false;
      this.scene.add(slip);
      this.slips.push(slip);
    }
  }

  private buildConveyor() {
    const dir = new THREE.Vector3().subVectors(BELT_TOP, BELT_LOW);
    this.beltLen = dir.length();
    dir.normalize();
    this.beltDir.copy(dir);
    const up = new THREE.Vector3(0, 1, 0).sub(dir.clone().multiplyScalar(dir.y)).normalize();
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    this.beltBasis.setFromRotationMatrix(new THREE.Matrix4().makeBasis(dir, up, side));
    const frame = new THREE.Group();
    frame.position.copy(new THREE.Vector3().addVectors(BELT_TOP, BELT_LOW).multiplyScalar(0.5));
    frame.quaternion.copy(this.beltBasis);
    const bed = box(this.beltLen + 0.2, 0.1, 0.62, C.sageDeep, 0.03);
    bed.position.y = -0.08;
    frame.add(bed);
    frame.add(box(this.beltLen, 0.04, 0.52, C.ink, 0, false));
    for (const s of [-1, 1]) {
      const rail = box(this.beltLen + 0.2, 0.12, 0.05, C.sage, 0.02, false);
      rail.position.set(0, 0.02, s * 0.31);
      frame.add(rail);
    }
    for (let i = 0; i < 8; i++) {
      const cleat = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.5), new THREE.MeshBasicMaterial({ color: C.sageLight }));
      cleat.position.y = 0.03;
      frame.add(cleat);
      this.belt.push(cleat);
    }
    for (const s of [-0.5, 0.5]) {
      const roller = cyl(0.11, 0.11, 0.66, C.mustard, 16, 0.02);
      roller.rotation.x = Math.PI / 2;
      roller.position.set(s * this.beltLen, -0.06, 0);
      frame.add(roller);
    }
    this.conveyor.add(frame);
    for (const k of [0.12, 0.5, 0.85]) {
      const p = new THREE.Vector3().lerpVectors(BELT_LOW, BELT_TOP, k);
      const h = p.y - 0.2;
      if (h < 0.15) continue;
      const leg = box(0.12, h, 0.12, C.kraftDeep, 0.025);
      leg.position.set(p.x, h / 2, p.z);
      this.conveyor.add(leg);
    }
    this.scene.add(this.conveyor);
  }

  private buildDesk() {
    const d = this.desk;
    d.position.copy(DESK);
    const top = box(2.1, 0.1, 1.0, C.kraft, 0.03);
    top.position.y = 0.86;
    d.add(top);
    for (const [x, z] of [[-0.95, -0.4], [0.95, -0.4], [-0.95, 0.4], [0.95, 0.4]]) {
      const leg = box(0.1, 0.82, 0.1, C.kraftDeep, 0.02);
      leg.position.set(x, 0.41, z);
      d.add(leg);
    }
    // Monitor facing the room (+z) so its screen is readable from the fixed view.
    const stand = box(0.12, 0.3, 0.12, C.ink, 0, false);
    stand.position.set(0.2, 1.06, -0.25);
    d.add(stand);
    const frame = box(0.95, 0.62, 0.08, C.plum, 0.025);
    frame.position.set(0.2, 1.48, -0.25);
    d.add(frame);
    this.deskScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.52), new THREE.MeshBasicMaterial({ color: C.ink }));
    this.deskScreen.position.set(0.2, 1.48, -0.205);
    d.add(this.deskScreen);
    // Inbox stack (left) — one sheet per PR waiting; approved tray (right).
    for (let i = 0; i < 18; i++) {
      const sheet = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.022, 0.36), toon(i % 2 ? C.white : C.cream));
      sheet.position.set(-0.62, 0.925 + i * 0.024, 0.1);
      sheet.rotation.y = (mulberry32(i + 7)() - 0.5) * 0.12;
      sheet.castShadow = true;
      d.add(sheet);
      this.deskStack.push(sheet);
    }
    this.doneTray = new THREE.Group();
    this.doneTray.add(box(0.56, 0.05, 0.42, C.sage, 0.02));
    this.doneTray.position.set(0.72, 0.94, 0.22);
    d.add(this.doneTray);
    // Stamp.
    const handle = cyl(0.05, 0.05, 0.18, C.ink, 10, 0.015);
    handle.position.y = 0.16;
    this.stamp.add(handle);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 10), toon(C.coral));
    knob.position.y = 0.27;
    this.stamp.add(knob);
    this.stamp.add(cyl(0.11, 0.11, 0.07, C.coral, 16, 0.02));
    this.stamp.position.set(-0.15, 0.95, 0.25);
    d.add(this.stamp);
    // Chair in front.
    const seat = box(0.55, 0.08, 0.5, C.plumLight, 0.02);
    seat.position.set(0.1, 0.5, 0.85);
    d.add(seat);
    const back = box(0.55, 0.5, 0.08, C.plumLight, 0.02);
    back.position.set(0.1, 0.78, 1.08);
    d.add(back);
    for (const [x, z] of [[-0.15, 0.65], [0.35, 0.65], [-0.15, 1.05], [0.35, 1.05]]) {
      const leg = box(0.05, 0.46, 0.05, C.ink, 0, false);
      leg.position.set(x, 0.23, z);
      d.add(leg);
    }
    this.scene.add(d);
  }

  private buildAvatar() {
    const a = this.avatar;
    for (const x of [-0.12, 0.12]) {
      const leg = new THREE.Group();
      const mesh = box(0.17, 0.42, 0.19, C.ink, 0.02);
      mesh.position.y = -0.21;
      leg.add(mesh);
      leg.position.set(x, 0.44, 0);
      a.add(leg);
      this.legs.push(leg);
    }
    const body = box(0.54, 0.56, 0.34, C.sage, 0.025);
    body.position.y = 0.72;
    a.add(body);
    const apron = box(0.38, 0.4, 0.03, C.cream, 0, false);
    apron.position.set(0, 0.68, 0.18);
    a.add(apron);
    for (const x of [-0.34, 0.34]) {
      const arm = new THREE.Group();
      const sleeve = box(0.14, 0.42, 0.16, C.sage, 0.02);
      sleeve.position.y = -0.2;
      arm.add(sleeve);
      const handM = box(0.15, 0.12, 0.17, SKIN, 0.02);
      handM.position.y = -0.46;
      arm.add(handM);
      arm.position.set(x, 0.96, 0);
      a.add(arm);
      this.arms.push(arm);
    }
    const head = this.avatarHead;
    head.add(box(0.46, 0.42, 0.42, SKIN, 0.025));
    for (const x of [-0.1, 0.1]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.11, 0.02), new THREE.MeshBasicMaterial({ color: C.ink }));
      eye.position.set(x, 0.03, 0.215);
      head.add(eye);
    }
    for (const x of [-0.16, 0.16]) {
      const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.04, 0.02), new THREE.MeshBasicMaterial({ color: C.coralLight }));
      cheek.position.set(x, -0.07, 0.214);
      head.add(cheek);
    }
    const cap = box(0.5, 0.12, 0.46, C.coral, 0.02);
    cap.position.y = 0.26;
    head.add(cap);
    const brim = box(0.34, 0.04, 0.2, C.coral, 0.015);
    brim.position.set(0, 0.21, 0.3);
    head.add(brim);
    head.position.y = 1.22;
    a.add(head);
    a.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
    this.scene.add(a);
  }

  /** Shelves + crates for one warehouse; stations follow the shelf layout. */
  setWarehouse(data: WarehouseData, deskPending: number) {
    this.wh = data;
    this.deskBase = deskPending;
    this.itemById = new Map(data.items.map((item) => [item.id, item]));
    this.shelfRoot.clear();
    this.shelves = [];
    this.crates = [];
    const queueIds = data.low.slice(0, QUEUE_MAX).map((item) => item.id);
    const groups = data.groups.slice(0, BACK.length + LEFT.length);
    groups.forEach((g, i) => {
      const onBack = i < BACK.length;
      const pos = onBack ? new THREE.Vector3(BACK[i], 0, -4.78) : new THREE.Vector3(-5.78, 0, LEFT[i - BACK.length]);
      const rot = onBack ? 0 : Math.PI / 2;
      const group = new THREE.Group();
      group.position.copy(pos);
      group.rotation.y = rot;
      for (const x of [-0.66, 0.66]) for (const z of [-0.24, 0.24]) {
        const post = box(0.08, 2.0, 0.08, C.kraftDeep, 0.022);
        post.position.set(x, 1.0, z);
        group.add(post);
      }
      for (const y of [0.12, 0.72, 1.32]) {
        const board = box(1.38, 0.06, 0.56, C.kraft, 0.022);
        board.position.y = y;
        group.add(board);
      }
      const backPanel = box(1.3, 1.85, 0.03, C.paperDeep, 0, false);
      backPanel.position.set(0, 1.0, -0.26);
      group.add(backPanel);
      const sign = new THREE.Group();
      sign.add(box(1.5, 0.62, 0.07, g.color, 0.03));
      const face = new THREE.Mesh(new THREE.PlaneGeometry(1.44, 0.565), new THREE.MeshBasicMaterial({ map: signTexture(g.icon, g.label, g.items.length, g.low.length, g.color) }));
      face.position.z = 0.04;
      sign.add(face);
      sign.position.set(0, 2.34, 0.05);
      group.add(sign);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), new THREE.MeshBasicMaterial({ color: C.coral }));
      bulb.position.set(0.66, 2.7, 0.05);
      bulb.name = "bulb";
      group.add(bulb);
      this.shelfRoot.add(group);
      const rise = BEAT.shelves + i * BEAT.shelfStep;
      this.shelves.push({ code: g.code, color: g.color, low: g.low.length, pos, rot, rise, group, sign });
      const ordered = [...g.low, ...g.items.filter((item) => !item.low)].slice(0, SLOTS.length);
      ordered.forEach((item, k) => {
        const [x, y] = SLOTS[k];
        const color = new THREE.Color(g.color).offsetHSL(0, 0, (mulberry32(k * 97 + i * 13)() - 0.5) * 0.08);
        this.crates.push({ item, shelf: i, local: new THREE.Vector3(x, y + 0.17, 0.04), pop: rise + 0.3 + k * 0.02, queue: queueIds.indexOf(item.id), color, lid: color.clone().lerp(new THREE.Color(C.white), 0.4) });
      });
    });
    queueIds.forEach((id, q) => {
      if (this.crates.some((c) => c.queue === q)) return;
      const item = this.itemById.get(id)!;
      const shelf = Math.max(0, this.shelves.findIndex((s) => s.code === item.group));
      const color = new THREE.Color(this.shelves[shelf]?.color ?? C.kraft);
      this.crates.push({ item, shelf, local: new THREE.Vector3(0, 2.6, 0.04), pop: BEAT.hop0 - 0.2, queue: q, color, lid: color.clone().lerp(new THREE.Color(C.white), 0.4) });
    });
    for (const mesh of [this.crateBody, this.crateHull, this.crateLid]) if (mesh) { this.scene.remove(mesh); mesh.dispose(); }
    const count = Math.max(1, this.crates.length);
    const gm = toon(C.cream).gradientMap;
    this.crateBody = new THREE.InstancedMesh(new THREE.BoxGeometry(0.28, 0.28, 0.28), new THREE.MeshToonMaterial({ color: "#ffffff", gradientMap: gm }), count);
    this.crateHull = new THREE.InstancedMesh(new THREE.BoxGeometry(0.33, 0.33, 0.33), inkMat, count);
    this.crateLid = new THREE.InstancedMesh(new THREE.BoxGeometry(0.29, 0.045, 0.29), new THREE.MeshToonMaterial({ color: "#ffffff", gradientMap: gm }), count);
    this.crateBody.castShadow = true;
    this.crates.forEach((c, i) => { this.crateBody!.setColorAt(i, c.color); this.crateLid!.setColorAt(i, c.lid); });
    this.scene.add(this.crateBody, this.crateHull, this.crateLid);
    this.queueTag.innerHTML = `🔮 Dự đoán sắp hết <b>${data.low.length}</b>`;
    // Stations: stand 1.25 in front of each shelf, front-right of the machine, in front of the desk.
    this.stations = [
      ...this.shelves.map((s) => {
        const front = new THREE.Vector3(Math.sin(s.rot), 0, Math.cos(s.rot));
        return { id: s.code, kind: "shelf" as const, stand: s.pos.clone().addScaledVector(front, 1.3), face: Math.atan2(-front.x, -front.z) };
      }),
      { id: "machine", kind: "machine", stand: M.clone().add(new THREE.Vector3(1.55, 0, 1.75)), face: Math.atan2(-1.55, -1.75) },
      { id: "desk", kind: "desk", stand: DESK.clone().add(new THREE.Vector3(0.1, 0, 1.8)), face: Math.PI },
    ];
  }

  /** PRs waiting at the desk (sheets on the inbox stack). */
  setDeskCount(count: number) {
    this.deskBase = Math.max(0, Math.floor(count));
    if (this.frozen !== null) this.renderAt(this.frozen);
  }

  // ---------------------------------------------------------------- events + time
  now(): number {
    return this.frozen ?? (performance.now() - this.t0) / 1000;
  }

  push(ev: RoomEvent) {
    this.events.push(ev);
    if (this.frozen !== null) this.renderAt(this.frozen);
  }

  private last<T extends RoomEvent["type"]>(type: T, t: number): Extract<RoomEvent, { type: T }> | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (ev.type === type && ev.t <= t) return ev as Extract<RoomEvent, { type: T }>;
    }
    return null;
  }

  private sinceClear(t: number) {
    const clear = this.last("clear", t)?.t ?? -Infinity;
    return this.events.filter((ev) => ev.t <= t && ev.t > clear);
  }

  private toggle(type: "drag" | "hover", t: number, dur = 0.18) {
    const ev = this.last(type, t);
    if (!ev) return 0;
    const k = smoother((t - ev.t) / dur);
    return ev.on ? k : 1 - k;
  }

  start() {
    const loop = () => {
      this.renderAt(this.now());
      this.raf = requestAnimationFrame(loop);
    };
    if (this.frozen === null) this.raf = requestAnimationFrame(loop);
    else this.renderAt(this.frozen);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    for (const node of this.nodes) node.remove();
    this.renderer.dispose();
  }

  /** Fixed framing: the whole room fits the canvas (above the mobile sheet). Recomputed only on resize. */
  resize() {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);
    const pts: THREE.Vector3[] = [];
    for (const x of [-6.5, 6.4]) for (const z of [-5.75, 4.95]) pts.push(new THREE.Vector3(x, 0, z));
    pts.push(new THREE.Vector3(-6.5, 3.0, -5.75), new THREE.Vector3(6.4, 3.0, -5.75), new THREE.Vector3(-6.5, 3.0, 4.95));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) {
      const v = p.clone().applyMatrix4(this.camera.matrixWorldInverse);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    const freeH = Math.max(1, h - this.insetPx);
    const pad = 0.35;
    const rangeX = x1 - x0 + pad * 2;
    const rangeY = y1 - y0 + pad * 2;
    // Portrait phones crop the empty left/right floor tips so the room reads bigger.
    const crop = w / freeH < 1 ? 0.8 : 1;
    const unit = Math.max((rangeX * crop) / w, rangeY / freeH); // world units per pixel
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const halfW = (w * unit) / 2;
    const top = cy + (freeH * unit) / 2;
    this.camera.left = cx - halfW;
    this.camera.right = cx + halfW;
    this.camera.top = top;
    this.camera.bottom = top - h * unit;
    this.camera.updateProjectionMatrix();
    if (this.frozen !== null) this.renderAt(this.frozen);
  }

  // ---------------------------------------------------------------- walking
  private obstacles(): Array<[number, number, number]> {
    const list: Array<[number, number, number]> = [[M.x, M.z, 1.3], [M.x, M.z + 1.15, 0.7], [DESK.x - 0.6, DESK.z, 0.72], [DESK.x + 0.6, DESK.z, 0.72], [DESK.x + 0.1, DESK.z + 0.8, 0.4]];
    for (const k of [0.08, 0.3, 0.55]) {
      const p = new THREE.Vector3().lerpVectors(BELT_LOW, BELT_TOP, k);
      list.push([p.x, p.z, 0.45]);
    }
    for (const s of this.shelves) list.push([s.pos.x, s.pos.z, 0.8]);
    return list;
  }

  /** Bake a walk from `from` toward `to`, sliding around obstacles; positions every WALK_DT. */
  planWalk(from: { x: number; z: number }, to: { x: number; z: number }): Float32Array {
    const obs = this.obstacles();
    const r = 0.28;
    const out: number[] = [from.x, from.z];
    let x = from.x, z = from.z;
    let stuck = 0;
    const step = SPEED * WALK_DT;
    for (let i = 0; i < 8 / WALK_DT; i++) {
      const dx = to.x - x, dz = to.z - z;
      const d = Math.hypot(dx, dz);
      if (d < 0.05) break;
      const s = Math.min(step, d);
      let nx = x + (dx / d) * s, nz = z + (dz / d) * s;
      for (const [ox, oz, or] of obs) {
        const ex = nx - ox, ez = nz - oz;
        const ed = Math.hypot(ex, ez);
        if (ed < or + r) { nx = ox + (ex / (ed || 1)) * (or + r); nz = oz + (ez / (ed || 1)) * (or + r); }
      }
      nx = Math.min(BOUNDS.x1, Math.max(BOUNDS.x0, nx));
      nz = Math.min(BOUNDS.z1, Math.max(BOUNDS.z0, nz));
      stuck = Math.hypot(nx - x, nz - z) < s * 0.2 ? stuck + 1 : 0;
      x = nx; z = nz;
      out.push(x, z);
      if (stuck > 24) break;
    }
    return new Float32Array(out);
  }

  /** Where the avatar is at t: baked walk paths after the walk-in. */
  avatarAt(t: number): { x: number; z: number; heading: number; moving: boolean; dist: number } {
    const asm = this.last("assemble", t);
    const a = asm ? t - asm.t : -1;
    const walk = this.last("walk", t);
    if (!walk) {
      const k = span(a, BEAT.avatar, 0.9);
      const x = lerp(ENTRY.x, START.x, k), z = lerp(ENTRY.z, START.z, k);
      const moving = k > 0 && k < 1;
      return { x, z, heading: moving ? Math.atan2(START.x - ENTRY.x, START.z - ENTRY.z) : 0.5, moving, dist: k * ENTRY.distanceTo(START) };
    }
    const n = walk.path.length / 2;
    const idx = Math.min(n - 1, Math.floor((t - walk.t) / WALK_DT));
    const x = walk.path[idx * 2], z = walk.path[idx * 2 + 1];
    const moving = idx < n - 1;
    let heading = 0;
    const j = Math.max(1, Math.min(n - 1, idx + 1));
    const hx = walk.path[j * 2] - walk.path[(j - 1) * 2], hz = walk.path[j * 2 + 1] - walk.path[(j - 1) * 2 + 1];
    if (moving || walk.face === null) heading = Math.hypot(hx, hz) > 1e-4 ? Math.atan2(hx, hz) : 0;
    else heading = walk.face;
    return { x, z, heading, moving, dist: idx * SPEED * WALK_DT };
  }

  // ---------------------------------------------------------------- picking + screen helpers
  pick(clientX: number, clientY: number): { kind: "shelf"; code: string } | { kind: "machine" } | { kind: "desk" } | { kind: "floor"; x: number; z: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects([this.machine, this.desk, this.shelfRoot, ...(this.crateBody ? [this.crateBody] : [])], true);
    for (const hit of hits) {
      if (hit.object === this.crateBody && hit.instanceId !== undefined) {
        const c = this.crates[hit.instanceId];
        if (c && c.queue < 0) return { kind: "shelf", code: this.shelves[c.shelf].code };
        continue;
      }
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        if (node === this.machine) return { kind: "machine" };
        if (node === this.desk) return { kind: "desk" };
        if (node.parent === this.shelfRoot) {
          const shelf = this.shelves.find((s) => s.group === node);
          if (shelf) return { kind: "shelf", code: shelf.code };
        }
        node = node.parent;
      }
    }
    const p = new THREE.Vector3();
    if (ray.ray.intersectPlane(new THREE.Plane(Y, 0), p) && p.x > -6.4 && p.x < 6.4 && p.z > -5.5 && p.z < 5) return { kind: "floor", x: p.x, z: p.z };
    return null;
  }

  private toClient(world: THREE.Vector3) {
    const rect = this.canvas.getBoundingClientRect();
    const p = world.clone().project(this.camera);
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
  }

  hopperScreen() { return this.toClient(HOPPER); }
  deskScreenPoint() { return this.toClient(DESK.clone().add(new THREE.Vector3(0, 1.0, 0))); }
  shelfScreen(code: string) {
    const s = this.shelves.find((x) => x.code === code);
    return s ? this.toClient(new THREE.Vector3(0, 1.0, 0.1).applyMatrix4(s.group.matrixWorld)) : null;
  }
  deskPoint() { return this.toClient(DESK.clone().add(new THREE.Vector3(0.2, 1.1, 0))); }
  machineScreen() { return this.toClient(M.clone().add(new THREE.Vector3(0, 1.4, 0.3))); }
  /** World point a crate flies from when an item is added: its crate on the shelf, else the shelf of its group. */
  itemFrom(itemId: string, group: string): [number, number, number] {
    const c = this.crates.find((x) => x.item.id === itemId && x.queue < 0);
    if (c) { const p = this.crateRest(c, new THREE.Vector3()); return [p.x, p.y, p.z]; }
    const s = this.shelves.find((x) => x.code === group);
    if (s) { s.group.updateMatrixWorld(); const p = new THREE.Vector3(0, 1.2, 0.3).applyMatrix4(s.group.matrixWorld); return [p.x, p.y, p.z]; }
    return [M.x - 2, 1.5, M.z + 2];
  }

  machineHit(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const x of [-1.2, 1.2]) for (const y of [0, 2.8]) for (const z of [-0.9, 0.9]) {
      const p = this.toClient(M.clone().add(new THREE.Vector3(x, y, z)));
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    const pad = 30;
    return clientX >= x0 - pad && clientX <= x1 + pad && clientY >= y0 - pad && clientY <= y1 + pad;
  }

  worldFromScreen(clientX: number, clientY: number): [number, number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const normal = new THREE.Vector3();
    this.camera.getWorldDirection(normal);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal.negate(), HOPPER), hit)) hit.copy(HOPPER).add(new THREE.Vector3(0, 2, 2));
    hit.y = Math.max(hit.y, 0.4);
    return [hit.x, hit.y, hit.z];
  }

  private beltPoint(pos: number, out: THREE.Vector3) {
    return out.copy(BELT_TOP).addScaledVector(this.beltDir, -(0.42 + pos * 0.52)).addScaledVector(Y, 0.2);
  }

  private crateRest(c: CrateL, out: THREE.Vector3) {
    const shelf = this.shelves[c.shelf];
    shelf.group.updateMatrixWorld();
    return out.copy(c.local).applyMatrix4(shelf.group.matrixWorld);
  }

  // ---------------------------------------------------------------- render
  renderAt(t: number) {
    const asm = this.last("assemble", t);
    const a = asm ? t - asm.t : -1;
    const live = this.sinceClear(t);
    const drops = live.filter((ev): ev is Extract<RoomEvent, { type: "drop" }> => ev.type === "drop");
    const landed = drops.filter((ev) => t >= ev.t + FLY);
    const lastLand = landed.length ? landed[landed.length - 1].t + FLY : -Infinity;
    const prints = this.events.filter((ev): ev is Extract<RoomEvent, { type: "print" }> => ev.type === "print" && ev.t <= t);
    const print = prints[prints.length - 1] ?? null;
    const printEnd = print ? print.t + 0.4 + print.slips * SLIP_GAP + 0.9 : -Infinity;
    const printing = print !== null && t < printEnd;
    const stamps = this.events.filter((ev): ev is Extract<RoomEvent, { type: "stamp" }> => ev.type === "stamp" && ev.t <= t);
    const drag = this.toggle("drag", t);
    const hover = this.toggle("hover", t);
    const station = this.last("station", t)?.id ?? null;
    const me = this.avatarAt(t);

    // ---- machine (assembly beats + contacts)
    const padK = asm ? easeOutBack(span(a, 0, 0.3)) : 0;
    this.pad.scale.set(Math.max(0.001, padK), 1, Math.max(0.001, padK));
    const baseY = dropY(a, BEAT.base, 2.0, 0.24);
    this.base.visible = baseY !== null;
    this.base.position.y = 0.175 + 0.08 + (baseY ?? 0);
    const bodyY = dropY(a, BEAT.body, 2.0, 0.24);
    this.body.visible = bodyY !== null;
    let bodySquash = squash(a, BEAT.body, 0.14) + squash(a, BEAT.hopper, 0.05);
    for (const ev of landed) bodySquash += squash(t, ev.t + FLY, 0.035);
    const breathe = a > BEAT.end ? 0.012 * Math.sin(t * 2.1) : 0;
    this.body.position.y = 0.43 + (bodyY ?? 0);
    this.body.scale.set(1 + bodySquash * 0.5, 1 - bodySquash + breathe, 1 + bodySquash * 0.5);
    const faceK = span(a, BEAT.face - 0.25, 0.3);
    this.face.visible = a >= BEAT.face - 0.25;
    this.face.position.z = 0.68 + (1 - easeOutBack(faceK)) * 0.8;
    let eyeOpen = smoother((a - BEAT.eyes) / 0.12);
    const blinkCycle = (t * 0.27) % 1;
    if (a > BEAT.eyes + 0.5 && blinkCycle > 0.955) eyeOpen = Math.min(eyeOpen, Math.abs(blinkCycle - 0.9775) / 0.0225);
    const happy = Math.max(
      landed.length && t - lastLand < 0.9 ? smoother(1 - (t - lastLand) / 0.9) : 0,
      a > BEAT.wave && a < BEAT.wave + 0.9 ? 1 : 0,
      print && !printing && t < printEnd + 1.0 ? 1 : 0,
    );
    // Sushi's eyes follow the player around the room.
    const lookX = Math.max(-0.09, Math.min(0.09, (me.x - M.x) * 0.018));
    this.eyes.forEach((eye, i) => {
      eye.scale.set(1 + happy * 0.25, Math.max(0.12, eyeOpen) * (1 - happy * 0.62), 1);
      eye.position.x = (i ? 0.27 : -0.27) + (a > BEAT.eyes ? lookX : 0);
      eye.position.y = 0.07 + happy * 0.04;
    });
    this.mouth.scale.set(1 + happy * 0.6 + hover * 0.3, 1 + happy * 1.6 + hover * 1.2, 1);
    for (const b of this.blush) b.visible = happy > 0.2 || hover > 0.5;
    const hopY = dropY(a, BEAT.hopper, 1.7, 0.22);
    this.hopper.visible = hopY !== null;
    let hopSquash = squash(a, BEAT.hopper, 0.12);
    for (const ev of drops) hopSquash += squash(t, ev.t + FLY, 0.22);
    this.hopper.position.y = 1.98 + (hopY ?? 0);
    this.hopper.rotation.z = ring(a, BEAT.hopper, 0.1);
    this.hopper.scale.set(1 + hopSquash * 0.6 + hover * 0.08, 1 - hopSquash, 1 + hopSquash * 0.6 + hover * 0.08);
    const glowMat = this.glow.material as THREE.MeshBasicMaterial;
    const ready = asm ? smoother((a - BEAT.wave) / 0.4) : 0;
    glowMat.opacity = Math.min(1, ready * (0.15 + 0.1 * Math.sin(t * 3)) + drag * (0.35 + 0.2 * Math.sin(t * 9)) + hover * 0.45);
    glowMat.color.set(hover > 0.5 ? C.white : C.mustardLight);
    this.glow.scale.setScalar(1 + hover * 0.12);
    const gearK = easeOutBack(span(a, BEAT.gears, 0.25));
    let spin = Math.max(0, a - BEAT.gears) * 0.7;
    for (const ev of landed) spin += 5 * (1 - Math.exp(-3 * (t - ev.t - FLY)));
    if (print) spin += Math.max(0, Math.min(t, printEnd) - print.t) * 9;
    this.gears.forEach((gear, i) => {
      gear.visible = a >= BEAT.gears;
      gear.scale.setScalar(Math.max(0.001, gearK));
      gear.rotation.x = (i ? -1.6 : 1) * spin;
    });
    this.tray.visible = a >= BEAT.gears;
    this.tray.position.z = 0.4 + 0.72 * smoother(span(a, BEAT.gears, 0.3));
    const unfold = smoother(span(a, BEAT.gears + 0.05, 0.3));
    const waveAt = (t0: number) => { const dt = t - t0; return dt >= 0 && dt < 1.1 ? Math.sin(dt * 14) * 0.35 * Math.sin((dt / 1.1) * Math.PI) : 0; };
    const lift = (t0: number) => { const dt = t - t0; return dt >= 0 && dt < 1.1 ? Math.sin((dt / 1.1) * Math.PI) : 0; };
    const waveT = asm ? asm.t + BEAT.wave : Infinity;
    this.arm.visible = a >= BEAT.gears + 0.05;
    this.arm.rotation.z = lerp(-0.1, 0.35, unfold) + Math.max(lift(waveT), print ? lift(printEnd) : 0) * 2.3 + waveAt(waveT) + (print ? waveAt(printEnd) : 0);
    const busy = printing || drops.some((ev) => t >= ev.t && t < ev.t + FLY + 0.8) || (asm !== null && a < BEAT.wave);
    (this.beacon.material as THREE.MeshBasicMaterial).color.set(busy && Math.sin(t * 16) > 0 ? C.coral : C.coralLight);

    // ---- conveyor + shelves
    const convK = asm ? easeOutBack(span(a, BEAT.conveyor, 0.4), 1.2) : 0;
    this.conveyor.visible = convK > 0.001;
    this.conveyor.position.y = (convK - 1) * 3.2;
    this.shelves.forEach((s, i) => {
      const k = asm ? span(a, s.rise, 0.4) : 0;
      s.group.visible = k > 0;
      s.group.position.y = (easeOutBack(k, 1.4) - 1) * 2.6;
      const active = station === s.code || this.hoverShelf === s.code;
      s.sign.position.y = 2.34 + (active ? 0.05 * Math.sin(t * 5) : 0);
      s.sign.scale.setScalar(active ? 1.08 : 1);
      const bulb = s.group.getObjectByName("bulb");
      if (bulb) bulb.visible = s.low > 0 && a > BEAT.eyes && Math.sin(t * 7 + i) > -0.2;
    });

    // ---- desk drops in; inbox stack = pending PRs + delivered slips − stamped
    const deskY = dropY(a, BEAT.desk, 1.6, 0.24);
    this.desk.visible = deskY !== null;
    this.desk.position.y = deskY ?? 0;
    const delivered = prints.reduce((n, p) => n + Array.from({ length: p.slips }, (_, j) => (t >= p.t + 0.4 + j * SLIP_GAP + 0.9 ? 1 : 0) as number).reduce((x, y) => x + y, 0), 0);
    const stamped = stamps.filter((s) => t >= s.t + 0.25).length;
    const stack = Math.max(0, Math.min(this.deskStack.length, this.deskBase + delivered - stamped));
    this.deskStack.forEach((sheet, i) => { sheet.visible = i < stack; });
    const lastStamp = stamps[stamps.length - 1];
    const sk = lastStamp ? t - lastStamp.t : 9;
    const down = sk < 0.12 ? smoother(sk / 0.12) : sk < 0.35 ? 1 - smoother((sk - 0.12) / 0.23) : 0;
    this.stamp.position.set(lerp(-0.15, -0.62, down), 0.95 + 0.4 * Math.sin(Math.PI * Math.min(1, sk / 0.35)) * (sk < 0.35 ? 1 : 0) + (stack * 0.024) * down, lerp(0.25, 0.1, down));
    this.doneTray.scale.y = 1 + squash(t, lastStamp ? lastStamp.t + 0.6 : -9, 0.3);
    (this.deskScreen.material as THREE.MeshBasicMaterial).color.set(stack > 0 && Math.sin(t * 3) > 0 ? "#3b356b" : C.ink);

    // ---- crates
    const removedQ = new Map<number, number>();
    for (const ev of drops) {
      const c = this.crates.find((x) => x.item.id === ev.itemId && x.queue >= 0);
      if (c && !removedQ.has(c.queue)) removedQ.set(c.queue, ev.t);
    }
    const queueShift = (q: number) => {
      let shift = 0;
      for (const [rq, rt] of removedQ) if (rq < q) shift += smoother((t - rt - FLY * 0.6) / 0.35);
      return shift;
    };
    let beltPhase = asm ? smoother(span(a, BEAT.hop0, QUEUE_MAX * BEAT.hopStep + HOP)) * 0.8 : 0;
    for (const [, rt] of removedQ) beltPhase += smoother((t - rt - FLY * 0.6) / 0.35) * 0.52;
    this.belt.forEach((cleat, i) => {
      const x = ((((i / this.belt.length) * this.beltLen + beltPhase) % this.beltLen) + this.beltLen) % this.beltLen;
      cleat.position.x = x - this.beltLen / 2;
    });
    const blinkOn = a > BEAT.eyes ? 0.5 + 0.5 * Math.sin(t * 7) : 0;
    if (this.crateBody && this.crateHull && this.crateLid) {
      this.crates.forEach((c, i) => {
        let scale = asm ? easeOutBack(span(a, c.pop, 0.22), 2.2) : 0;
        const rest = this.crateRest(c, tmpP.clone());
        const pos = rest.clone();
        tmpQ.copy(this.shelves[c.shelf].group.quaternion);
        let blink = c.item.low ? blinkOn : 0;
        if ((station === this.shelves[c.shelf].code || this.hoverShelf === this.shelves[c.shelf].code) && c.queue < 0) pos.y += 0.02 * Math.abs(Math.sin(t * 5 + i));
        if (c.queue >= 0) {
          const hopT = BEAT.hop0 + c.queue * BEAT.hopStep;
          const hk = span(a, hopT, HOP);
          if (hk > 0) {
            const slot = this.beltPoint(c.queue - queueShift(c.queue), tmpV.clone());
            pos.lerpVectors(rest, slot, smoother(hk));
            pos.y += Math.sin(Math.PI * hk) * 1.3 + Math.abs(ring(a, hopT + HOP, 0.05, 18, 9));
            if (hk >= 1) tmpQ.copy(this.beltBasis); else tmpQ.slerp(this.beltBasis, hk);
          }
          const dropAt = removedQ.get(c.queue);
          if (dropAt !== undefined && t >= dropAt) {
            const fk = span(t, dropAt, FLY);
            pos.lerpVectors(this.beltPoint(c.queue - queueShift(c.queue), tmpV.clone()), HOPPER, smoother(fk));
            pos.y += Math.sin(Math.PI * fk) * 0.9;
            scale *= fk >= 1 ? 0 : 1 - 0.35 * fk;
            blink = 0;
          }
        }
        tmpS.setScalar(Math.max(0.0001, scale));
        tmpM.compose(pos, tmpQ, tmpS);
        this.crateBody!.setMatrixAt(i, tmpM);
        this.crateHull!.setMatrixAt(i, tmpM);
        tmpV.set(0, 0.155 * scale, 0).applyQuaternion(tmpQ);
        tmpM.compose(pos.clone().add(tmpV), tmpQ, tmpS);
        this.crateLid!.setMatrixAt(i, tmpM);
        this.crateBody!.setColorAt(i, tmpC.copy(c.color).lerp(CORAL, blink * 0.55));
      });
      this.crateBody.instanceMatrix.needsUpdate = true;
      this.crateHull.instanceMatrix.needsUpdate = true;
      this.crateLid.instanceMatrix.needsUpdate = true;
      if (this.crateBody.instanceColor) this.crateBody.instanceColor.needsUpdate = true;
    }
    const flying = drops.filter((ev) => t >= ev.t && t < ev.t + FLY && !this.crates.some((c) => c.item.id === ev.itemId && c.queue >= 0));
    this.flyPool.forEach((crate, i) => {
      const ev = flying[flying.length - 1 - i];
      crate.visible = !!ev;
      if (!ev) return;
      const k = span(t, ev.t, FLY);
      crate.position.lerpVectors(tmpV.set(...ev.from), HOPPER, smoother(k));
      crate.position.y += Math.sin(Math.PI * k) * 0.8;
      crate.rotation.set(k * 4, k * 3, 0);
      crate.scale.setScalar(1.1 - 0.4 * k);
      const item = this.itemById.get(ev.itemId);
      (crate.userData.mesh as THREE.Mesh).material = toon(this.shelves.find((s) => s.code === item?.group)?.color ?? C.kraft);
    });

    // ---- slips: out of the machine slot, then fly across the room onto the desk inbox (one contact each)
    let slot = 0;
    for (const p of prints) {
      for (let j = 0; j < p.slips && slot < this.slips.length; j++, slot++) {
        const slip = this.slips[slot];
        const t0 = p.t + 0.4 + j * SLIP_GAP;
        const dt = t - t0;
        slip.visible = dt >= 0 && dt < 0.9;
        if (!slip.visible) continue;
        const out = smoother(dt / 0.25);
        const fly = smoother((dt - 0.25) / 0.65);
        const from = M.clone().add(new THREE.Vector3(0, 0.66, lerp(0.6, 1.0, out)));
        const to = DESK.clone().add(new THREE.Vector3(-0.62, 0.95 + (this.deskBase + j) * 0.024, 0.1));
        slip.position.lerpVectors(from, to, fly);
        slip.position.y += Math.sin(Math.PI * fly) * 1.6;
        slip.rotation.set(Math.sin(dt * 14) * 0.4 * (1 - fly) - 1.1 * (1 - out), fly * 1.2, 0);
      }
    }
    for (; slot < this.slips.length; slot++) this.slips[slot].visible = false;

    // ---- avatar: walk-in, walk paths, toss toward the machine on a drop
    this.avatar.visible = a >= BEAT.avatar;
    this.avatar.position.set(me.x, 0, me.z);
    const tossEv = drops.find((ev) => t >= ev.t && t < ev.t + 0.5);
    const toMachine = Math.atan2(M.x - me.x, M.z - me.z);
    let heading = me.heading;
    if (tossEv && !me.moving && Math.hypot(M.x - me.x, M.z - me.z) < 4.5) heading = toMachine;
    this.avatar.rotation.y = heading;
    const phase = me.dist * 3.4;
    const swing = me.moving ? Math.sin(phase) * 0.6 : 0;
    this.legs[0].rotation.x = swing; this.legs[1].rotation.x = -swing;
    const toss = tossEv ? Math.sin(Math.PI * span(t, tossEv.t, 0.45)) : 0;
    this.arms[0].rotation.x = -swing * 0.8 - toss * 2.2; this.arms[1].rotation.x = swing * 0.8 - toss * 2.2;
    this.avatar.position.y = me.moving ? Math.abs(Math.sin(phase)) * 0.06 : 0.01 * Math.sin(t * 2.4);
    this.avatarHead.rotation.y = !me.moving && station === "desk" ? 0 : 0.15 * Math.sin(t * 0.7);

    // ---- dust
    const pos = this.dust.geometry.getAttribute("position") as THREE.BufferAttribute;
    this.dustSeed.forEach(([x, y, z, ph], i) => pos.setXYZ(i, x + Math.sin(t * 0.4 + ph) * 0.25, 0.3 + ((y + t * 0.035) % 1) * 3.4, z + Math.cos(t * 0.3 + ph) * 0.2));
    pos.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
    this.layoutOverlay(t, a, { landed, print, printing, hover, drag, stack, me });
  }

  // ---------------------------------------------------------------- overlay
  private place(node: HTMLElement, world: THREE.Vector3, opacity: number) {
    const p = world.clone().project(this.camera);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const half = node.offsetWidth / 2;
    const x = Math.min(w - half - 6, Math.max(half + 6, ((p.x + 1) / 2) * w));
    const y = Math.max(node.offsetHeight + 6, ((1 - p.y) / 2) * h);
    const visible = opacity > 0.01;
    node.style.opacity = visible ? String(Math.min(1, opacity)) : "0";
    node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    node.style.visibility = visible ? "visible" : "hidden";
  }

  private setText(node: HTMLElement, text: string, html = false) {
    if (this.texts.get(node) === text) return;
    this.texts.set(node, text);
    if (html) node.innerHTML = text; else node.textContent = text;
  }

  private layoutOverlay(t: number, a: number, s: {
    landed: Array<Extract<RoomEvent, { type: "drop" }>>; print: Extract<RoomEvent, { type: "print" }> | null; printing: boolean;
    hover: number; drag: number; stack: number; me: { x: number; z: number; moving: boolean };
  }) {
    const asm = a >= 0;
    let text = "";
    const lastLanded = s.landed[s.landed.length - 1];
    const low = this.wh?.low.length ?? 0;
    const interacted = this.events.some((ev) => (ev.type === "walk" || ev.type === "drag" || ev.type === "station") && ev.t <= t);
    if (s.printing && s.print) text = `🖨️ In ${s.print.slips} phiếu đặt → bàn duyệt`;
    else if (lastLanded && t - (lastLanded.t + FLY) < 1.4) text = `+1 · ${this.itemById.get(lastLanded.itemId)?.name ?? ""}`;
    else if (s.hover > 0.5) text = "Thả vào phễu nè! 😋";
    else if (s.drag > 0.5) text = "Kéo lên phễu của máy";
    else if (asm && a >= BEAT.eyes && a < BEAT.end + 1.5) text = low ? `Máy dự đoán: ${low} món sắp hết!` : "Kho ổn, chưa có món sắp hết";
    else if (asm && a >= BEAT.end + 1.5 && !interacted) text = "Chạm vào kệ để xem hàng 👆";
    else if (asm && a >= BEAT.base && a < BEAT.eyes) text = "Đang lắp máy…";
    if (text) this.setText(this.bubble, text);
    this.bubble.classList.toggle("is-warn", text.startsWith("Máy dự đoán"));
    this.place(this.bubble, M.clone().add(new THREE.Vector3(0.2, 3.3, 0.2)), text ? 1 : 0);
    this.setText(this.counter, `🧺 ${s.landed.length}`);
    this.place(this.counter, M.clone().add(new THREE.Vector3(0.95, 2.0, 0.7)), asm && a > BEAT.end && s.landed.length > 0 ? 1 : 0);
    this.place(this.hint, M.clone().add(new THREE.Vector3(1.0, 2.55, 0.4)), Math.max(s.drag, s.hover) * (asm ? 1 : 0));
    this.hint.classList.toggle("is-hot", s.hover > 0.5);
    this.place(this.queueTag, new THREE.Vector3().lerpVectors(BELT_LOW, BELT_TOP, 0.1).add(new THREE.Vector3(0, 0.5, 0)), asm ? smoother((a - BEAT.hop0) / 0.3) * (low > 0 ? 1 : 0) : 0);
    this.place(this.nameTag, new THREE.Vector3(s.me.x, 1.95, s.me.z), asm ? smoother((a - BEAT.avatar - 0.3) / 0.3) : 0);
    this.setText(this.deskTag, `📋 Bàn duyệt PR <b>${s.stack}</b>`, true);
    this.place(this.deskTag, DESK.clone().add(new THREE.Vector3(0.2, 2.05, -0.25)), asm ? smoother((a - BEAT.desk - 0.2) / 0.3) : 0);
  }
}
