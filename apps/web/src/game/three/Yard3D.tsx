import { Html } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useRef, useState } from "react";
import * as THREE from "three";
import type { WarehouseGameLocation as Location } from "@/lib/warehouse-game";
import { C } from "../theme";
import { ZONES, type Zone } from "../Yard";
import { Block, Buddy, Crate, Roof, Tree, Truck } from "./parts";

type Vec3 = [number, number, number];

export const BUILDINGS: Record<Location, { at: Vec3; size: Vec3; roof: string; title: string }> = {
  tan_tao: { at: [-3.6, 0, -1.6], size: [5.2, 2.8, 4.2], roof: C.coral, title: "KHO TÂN TẠO" },
  q7: { at: [3.9, 0, -1.2], size: [3.8, 2.3, 3.4], roof: C.mustard, title: "KHO Q7" },
};

const HTML_Z: [number, number] = [5, 0];

function hoverProps(setHover: (on: boolean) => void) {
  return {
    onPointerOver: (event: ThreeEvent<PointerEvent>) => { event.stopPropagation(); setHover(true); document.body.style.cursor = "pointer"; },
    onPointerOut: () => { setHover(false); document.body.style.cursor = ""; },
  };
}

function useLift(hover: boolean) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!group.current) return;
    group.current.scale.setScalar(THREE.MathUtils.lerp(group.current.scale.x, hover ? 1.04 : 1, 0.15));
  });
  return group;
}

function Building({ loc, sub, crates, onEnter }: { loc: Location; sub: string; crates: number; onEnter: (loc: Location) => void }) {
  const { at, size, roof, title } = BUILDINGS[loc];
  const [w, h, d] = size;
  const [hover, setHover] = useState(false);
  const group = useLift(hover);
  const enter = (event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onEnter(loc); };
  return (
    <group position={at}>
      <group ref={group} onClick={enter} {...hoverProps(setHover)}>
        <Block size={[w + 0.5, 0.18, d + 0.5]} color={C.paperDeep} position={[0, 0.09, 0]} />
        <Block size={[w, h, d]} color={C.cream} position={[0, 0.18 + h / 2, 0]} />
        <Roof width={w + 0.7} height={1.3} depth={d + 0.4} color={roof} position={[0, 0.18 + h, 0]} />
        <Block size={[w * 0.42, h * 0.62, 0.08]} color={C.kraft} position={[0, 0.18 + h * 0.31, d / 2 + 0.04]} />
        {[0.2, 0.4, 0.6, 0.8].map((f) => (
          <Block key={f} size={[w * 0.42, 0.03, 0.02]} color={C.kraftDeep} position={[0, 0.18 + h * 0.62 * f, d / 2 + 0.09]} ink={0} shadow={false} />
        ))}
        {[-1, 1].map((side) => (
          <Block key={side} size={[w * 0.16, h * 0.22, 0.06]} color={C.sageLight} position={[side * w * 0.34, 0.18 + h * 0.7, d / 2 + 0.03]} />
        ))}
        <Block size={[w * 0.5, 0.42, 0.08]} color={C.white} position={[0, 0.18 + h + 0.05, d / 2 + 0.24]} />
      </group>
      {Array.from({ length: Math.min(crates, 5) }, (_, i) => (
        <Crate key={i} position={[w / 2 - 0.2 - (i % 3) * 0.66, 0.24 + Math.floor(i / 3) * 0.48, d / 2 + 0.7]} rotation={(i * 0.37) % 0.5} size={0.54} />
      ))}
      <Html position={[0, 0.18 + h + 2.0, 0]} center zIndexRange={HTML_Z}>
        <button type="button" className={`k3-sign is-${loc}`} aria-label={title} onClick={() => onEnter(loc)}>
          <b>{title}</b>
          <span>{sub}</span>
          {crates > 0 ? <em>📦 {crates} thùng chưa dán nhãn</em> : null}
        </button>
      </Html>
    </group>
  );
}

/** Market-stall kiosk for the other warehouse functions: counter + striped awning. */
function Kiosk({ zone, at, badge, onZone }: { zone: Zone; at: Vec3; badge: number; onZone: (zone: Zone) => void }) {
  const [hover, setHover] = useState(false);
  const group = useLift(hover);
  return (
    <group position={at}>
      <group ref={group} onClick={(event) => { event.stopPropagation(); onZone(zone); }} {...hoverProps(setHover)}>
        <Block size={[1.5, 0.75, 0.8]} color={C.cream} position={[0, 0.375, 0]} />
        <Block size={[1.5, 0.12, 0.85]} color={zone.color} position={[0, 0.8, 0]} />
        {[-0.68, 0.68].map((x) => (
          <Block key={x} size={[0.08, 1.0, 0.08]} color={C.ink} position={[x, 1.35, -0.3]} ink={0} />
        ))}
        {[-0.56, -0.28, 0, 0.28, 0.56].map((x, i) => (
          <Block key={x} size={[0.28, 0.1, 1.05]} color={i % 2 ? C.white : zone.color} position={[x, 1.9, 0.05]} rotation={[0.28, 0, 0]} ink={0.02} />
        ))}
        <Block size={[0.4, 0.3, 0.3]} color={C.kraft} position={[-0.4, 1.0, 0]} ink={0.02} />
        <Block size={[0.3, 0.38, 0.3]} color={C.white} position={[0.35, 1.04, 0.05]} ink={0.02} />
      </group>
      <Html position={[0, 2.55, 0]} center zIndexRange={HTML_Z}>
        <button type="button" className="k3-kiosk" aria-label={zone.label} onClick={() => onZone(zone)} style={{ ["--tint" as string]: zone.color }}>
          <i>{zone.icon}</i>
          <b>{zone.label}</b>
          {badge > 0 ? <em data-bmq-kiosk-badge={zone.id}>{badge}</em> : null}
        </button>
      </Html>
    </group>
  );
}

function MovingVan() {
  const van = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!van.current) return;
    const s = clock.elapsedTime * 0.26;
    const t = (Math.sin(s) + 1) / 2;
    const forward = Math.cos(s) >= 0;
    van.current.position.set(THREE.MathUtils.lerp(-9, 9.5, t), 0, forward ? 4.25 : 5.15);
    van.current.rotation.y = forward ? 0 : Math.PI;
  });
  return (
    <group ref={van} scale={0.6}>
      <Truck position={[0, 0, 0]} />
    </group>
  );
}

export function Yard3D({ counts, crates, badges = {}, onEnter, onZone }: {
  counts: Record<Location, number>;
  crates: Record<Location, number>;
  badges?: Record<string, number>;
  onEnter: (loc: Location) => void;
  onZone: (zone: Zone) => void;
}) {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, -0.01, 0]}>
        <planeGeometry args={[90, 90]} />
        <meshToonMaterial color={C.paper} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 4.7]} receiveShadow>
        <planeGeometry args={[44, 2.6]} />
        <meshToonMaterial color={C.road} />
      </mesh>
      {Array.from({ length: 18 }, (_, i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[-17 + i * 2, 0.005, 4.7]}>
          <planeGeometry args={[0.9, 0.12]} />
          <meshBasicMaterial color={C.white} />
        </mesh>
      ))}
      {([[-10, -4, 2.4], [10.5, -3.5, 2], [0.2, -6, 1.6], [-9, 8.4, 2.2], [9, 8.4, 1.8]] as const).map(([x, z, r]) => (
        <mesh key={`${x}${z}`} rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.004, z]} receiveShadow>
          <circleGeometry args={[r, 24]} />
          <meshToonMaterial color={C.sageLight} />
        </mesh>
      ))}
      <Tree position={[-9.6, 0, -3.8]} scale={1.1} />
      <Tree position={[-10.4, 0, -1.6]} scale={0.8} />
      <Tree position={[10.2, 0, -3.2]} />
      <Tree position={[0.2, 0, -5.6]} scale={0.9} />
      <Tree position={[-8.6, 0, 8]} scale={0.9} />
      <Tree position={[9.2, 0, 8.1]} scale={1.05} />
      <Building loc="tan_tao" sub={`${counts.tan_tao} mặt hàng · TP + NVL`} crates={crates.tan_tao} onEnter={onEnter} />
      <Building loc="q7" sub={`${counts.q7} mặt hàng · NVL bếp`} crates={crates.q7} onEnter={onEnter} />
      {ZONES.map((zone, i) => (
        <Kiosk key={zone.id} zone={zone} at={[-6.4 + i * 3.2, 0, 2.6]} badge={badges[zone.id] ?? 0} onZone={onZone} />
      ))}
      <MovingVan />
      <Truck position={[-8.2, 0, 0.6]} rotation={Math.PI / 2} />
      <Buddy position={[0.2, 0, 1.1]} rotation={0.4} shirt={C.sage} cap={C.mustard} wave />
      <Buddy position={[1.6, 0, 3.6]} rotation={-0.6} shirt={C.coral} phase={1.3} />
    </group>
  );
}
