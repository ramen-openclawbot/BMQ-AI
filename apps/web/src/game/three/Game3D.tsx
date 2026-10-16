import { CameraControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { WarehouseGameLocation as Location, WarehouseGamePendingRow } from "@/lib/warehouse-game";
import type { GameClass } from "../meta";
import { C } from "../theme";
import type { ShelfRow } from "../Warehouse";
import type { Zone } from "../Yard";
import { Warehouse3D } from "./Warehouse3D";
import { BUILDINGS, Yard3D } from "./Yard3D";

export type Game3DProps =
  | {
    kind: "yard";
    counts: Record<Location, number>;
    crates: Record<Location, number>;
    badges?: Record<string, number>;
    onEnter: (loc: Location) => void;
    onZone: (zone: Zone) => void;
  }
  | {
    kind: "warehouse";
    location: Location;
    rows: ShelfRow[];
    crates: WarehouseGamePendingRow[];
    canAssign: boolean;
    transfers: number;
    onShelf: (cls: GameClass) => void;
    onYard: () => void;
    onTransfers: () => void;
    onMachine: () => void;
  };

type Frame = { eye: THREE.Vector3; look: THREE.Vector3 };
const YARD: Frame = { eye: new THREE.Vector3(10, 14, 19), look: new THREE.Vector3(0, 0.6, 1.0) };
const ROOM: Frame = { eye: new THREE.Vector3(9, 12.5, 14), look: new THREE.Vector3(0, 0.6, 0.2) };
// Portrait phones look from the +x side, so the long x axis of each diorama runs up the screen.
const YARD_TALL: Frame = { eye: new THREE.Vector3(17, 18, 8), look: new THREE.Vector3(0.4, 0.6, 0.2) };
const ROOM_TALL: Frame = { eye: new THREE.Vector3(13, 22, 2.6), look: new THREE.Vector3(0.4, 0.4, 0.3) };

function framing(kind: Game3DProps["kind"], aspect: number) {
  if (aspect < 0.85) return { base: kind === "yard" ? YARD_TALL : ROOM_TALL, k: Math.max(1.2, (0.62 / aspect) * (kind === "yard" ? 1.42 : 1.5)) };
  return { base: kind === "yard" ? YARD : ROOM, k: aspect >= 1.2 ? 1 : 1.3 };
}

function Rig({ scene, focus }: { scene: string; focus: Location | null }) {
  const controls = useRef<CameraControls>(null);
  const { size } = useThree();
  const aspect = size.width / Math.max(1, size.height);
  const kind = scene === "yard" ? "yard" : "warehouse";

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const { base, k } = framing(kind, aspect);
    const eye = base.look.clone().add(base.eye.clone().sub(base.look).multiplyScalar(k));
    // start further out and swing in: the "fly into the warehouse" move
    const start = base.look.clone().add(base.eye.clone().sub(base.look).multiplyScalar(k * 1.45)).add(new THREE.Vector3(-4, 3, 0));
    void c.setLookAt(start.x, start.y, start.z, base.look.x, base.look.y, base.look.z, false);
    void c.setLookAt(eye.x, eye.y, eye.z, base.look.x, base.look.y, base.look.z, true);
    c.minDistance = 8 * Math.min(k, 1.3);
    c.maxDistance = 36 * k;
  }, [scene, kind, aspect]);

  useEffect(() => {
    const c = controls.current;
    if (!c || !focus) return;
    const [x, , z] = BUILDINGS[focus].at;
    const tall = aspect < 0.85;
    void c.setLookAt(tall ? x + 6.5 : x + 1.2, 3.4, tall ? z + 4 : z + 6.5, x, 1.4, z, true);
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  return <CameraControls ref={controls} makeDefault smoothTime={0.45} minPolarAngle={0.35} maxPolarAngle={1.25} truckSpeed={0.6} dollySpeed={0.6} />;
}

export default function Game3D(props: Game3DProps) {
  const [focus, setFocus] = useState<Location | null>(null);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const scene = props.kind === "yard" ? "yard" : `wh-${props.location}`;

  // Tapping a warehouse swings the camera to its door, then opens it.
  const enter = (loc: Location) => {
    if (props.kind !== "yard" || focus) return;
    setFocus(loc);
    timer.current = window.setTimeout(() => props.onEnter(loc), 520);
  };

  return (
    <div className="k3" data-bmq-game-3d={scene}>
      <Canvas
        shadows
        dpr={[1, 1.75]}
        camera={{ fov: 35, near: 0.5, far: 220, position: [10, 14, 19] }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        onCreated={({ gl }) => { gl.toneMapping = THREE.NoToneMapping; }}
      >
        <color attach="background" args={[C.paper]} />
        <fog attach="fog" args={[C.paper, 42, 80]} />
        <hemisphereLight args={[C.white, C.paperDeep, 1.6]} />
        <directionalLight
          castShadow
          position={[8, 16, 9]}
          intensity={1.9}
          shadow-mapSize={[1024, 1024]}
          shadow-camera-left={-15}
          shadow-camera-right={15}
          shadow-camera-top={15}
          shadow-camera-bottom={-15}
          shadow-bias={-0.0006}
        />
        <Rig scene={scene} focus={focus} />
        {props.kind === "yard" ? (
          <Yard3D counts={props.counts} crates={props.crates} badges={props.badges} onEnter={enter} onZone={props.onZone} />
        ) : (
          <Warehouse3D
            location={props.location}
            rows={props.rows}
            crates={props.crates}
            canAssign={props.canAssign}
            transfers={props.transfers}
            onShelf={props.onShelf}
            onYard={props.onYard}
            onTransfers={props.onTransfers}
            onMachine={props.onMachine}
          />
        )}
      </Canvas>
      <div className="k3-hint">Kéo để xoay · chụm hai ngón để phóng to</div>
    </div>
  );
}
