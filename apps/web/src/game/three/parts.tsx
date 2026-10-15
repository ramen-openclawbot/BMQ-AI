import { Outlines } from "@react-three/drei";
import { useFrame, type ThreeElements } from "@react-three/fiber";
import { useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { C } from "../theme";

// Three-step toon ramp shared by every material: flat light / mid / shade bands, like the 2D sticker kit.
let ramp: THREE.DataTexture | null = null;
function toonRamp(): THREE.DataTexture {
  if (ramp) return ramp;
  ramp = new THREE.DataTexture(new Uint8Array([120, 200, 255]), 3, 1, THREE.RedFormat);
  ramp.minFilter = THREE.NearestFilter;
  ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  return ramp;
}

export function Toon({ color }: { color: string }) {
  return <meshToonMaterial color={color} gradientMap={toonRamp()} />;
}

type Vec3 = [number, number, number];
type MeshProps = Omit<ThreeElements["mesh"], "args">;

/** Box with navy ink outline. */
export function Block({ size, color, ink = 0.035, shadow = true, children, ...props }: MeshProps & { size: Vec3; color: string; ink?: number; shadow?: boolean; children?: ReactNode }) {
  return (
    <mesh castShadow={shadow} receiveShadow {...props}>
      <boxGeometry args={size} />
      <Toon color={color} />
      {ink > 0 && <Outlines thickness={ink} color={C.ink} />}
      {children}
    </mesh>
  );
}

export function Cyl({ r, h, color, seg = 18, ink = 0.03, ...props }: MeshProps & { r: number; h: number; color: string; seg?: number; ink?: number }) {
  return (
    <mesh castShadow receiveShadow {...props}>
      <cylinderGeometry args={[r, r, h, seg]} />
      <Toon color={color} />
      {ink > 0 && <Outlines thickness={ink} color={C.ink} />}
    </mesh>
  );
}

/** Gable roof: a triangular prism extruded along z. */
export function Roof({ width, height, depth, color, ...props }: MeshProps & { width: number; height: number; depth: number; color: string }) {
  const geometry = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, 0);
    shape.lineTo(width / 2, 0);
    shape.lineTo(0, height);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.translate(0, 0, -depth / 2);
    return geo;
  }, [width, height, depth]);
  return (
    <mesh castShadow receiveShadow geometry={geometry} {...props}>
      <Toon color={color} />
      <Outlines thickness={0.04} color={C.ink} />
    </mesh>
  );
}

export function Tree({ position, scale = 1 }: { position: Vec3; scale?: number }) {
  return (
    <group position={position} scale={scale}>
      <Cyl r={0.14} h={0.8} color={C.kraftDeep} position={[0, 0.4, 0]} />
      <mesh castShadow position={[0, 1.25, 0]}>
        <icosahedronGeometry args={[0.62, 0]} />
        <Toon color={C.sage} />
        <Outlines thickness={0.035} color={C.ink} />
      </mesh>
      <mesh castShadow position={[0.22, 1.7, 0.1]}>
        <icosahedronGeometry args={[0.38, 0]} />
        <Toon color={C.sageLight} />
        <Outlines thickness={0.03} color={C.ink} />
      </mesh>
    </group>
  );
}

function Eye({ x }: { x: number }) {
  return (
    <mesh position={[x, 0.04, 0.231]}>
      <boxGeometry args={[0.07, 0.11, 0.02]} />
      <meshBasicMaterial color={C.ink} />
    </mesh>
  );
}

/** Square-head buddy from the 2D kit, gently bobbing. */
export function Buddy({ position, rotation = 0, shirt = C.plum, head = "#f2c79a", cap, phase = 0, wave = false }: { position: Vec3; rotation?: number; shirt?: string; head?: string; cap?: string; phase?: number; wave?: boolean }) {
  const body = useRef<THREE.Group>(null);
  const arm = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime * 2.2 + phase;
    if (body.current) body.current.position.y = Math.abs(Math.sin(t)) * 0.06;
    if (arm.current && wave) arm.current.rotation.z = 2.4 + Math.sin(t * 2.2) * 0.45;
  });
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.32, 20]} />
        <meshBasicMaterial color={C.ink} transparent opacity={0.16} />
      </mesh>
      <group ref={body}>
        <Block size={[0.42, 0.46, 0.3]} color={shirt} position={[0, 0.42, 0]} ink={0.025} />
        <Block size={[0.12, 0.2, 0.14]} color={C.ink} position={[-0.11, 0.1, 0]} ink={0} />
        <Block size={[0.12, 0.2, 0.14]} color={C.ink} position={[0.11, 0.1, 0]} ink={0} />
        <mesh ref={arm} position={[0.26, 0.56, 0]} rotation={[0, 0, 0.15]} castShadow>
          <boxGeometry args={[0.1, 0.34, 0.12]} />
          <Toon color={shirt} />
          <Outlines thickness={0.02} color={C.ink} />
        </mesh>
        <Block size={[0.1, 0.34, 0.12]} color={shirt} position={[-0.26, 0.5, 0]} rotation={[0, 0, -0.15]} ink={0.02} />
        <group position={[0, 0.9, 0]}>
          <Block size={[0.46, 0.44, 0.44]} color={head} ink={0.03} />
          <Eye x={-0.09} />
          <Eye x={0.09} />
          <mesh position={[-0.16, -0.08, 0.231]}>
            <boxGeometry args={[0.08, 0.05, 0.01]} />
            <meshBasicMaterial color={C.coral} />
          </mesh>
          <mesh position={[0.16, -0.08, 0.231]}>
            <boxGeometry args={[0.08, 0.05, 0.01]} />
            <meshBasicMaterial color={C.coral} />
          </mesh>
          {cap && <Block size={[0.5, 0.12, 0.5]} color={cap} position={[0, 0.27, 0.02]} ink={0.025} />}
          {cap && <Block size={[0.44, 0.04, 0.2]} color={cap} position={[0, 0.22, 0.3]} ink={0.02} />}
        </group>
      </group>
    </group>
  );
}

/** Jev, the warehouse robot: hovering body, screen face, blinking antenna. */
export function JevBot({ path, speed = 0.035, color = C.sage }: { path: THREE.Vector3[]; speed?: number; color?: string }) {
  const root = useRef<THREE.Group>(null);
  const hover = useRef<THREE.Group>(null);
  const light = useRef<THREE.MeshBasicMaterial>(null);
  const curve = useMemo(() => new THREE.CatmullRomCurve3(path, true, "catmullrom", 0.2), [path]);
  const ahead = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ clock }) => {
    const t = (clock.elapsedTime * speed) % 1;
    const p = curve.getPointAt(t);
    curve.getPointAt((t + 0.01) % 1, ahead);
    if (root.current) {
      root.current.position.set(p.x, 0, p.z);
      root.current.rotation.y = Math.atan2(ahead.x - p.x, ahead.z - p.z);
    }
    if (hover.current) hover.current.position.y = 0.2 + Math.sin(clock.elapsedTime * 3) * 0.06;
    if (light.current) light.current.color.set(Math.sin(clock.elapsedTime * 5) > 0 ? C.mustard : C.cream);
  });
  return (
    <group ref={root}>
      <mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.36, 20]} />
        <meshBasicMaterial color={C.ink} transparent opacity={0.18} />
      </mesh>
      <group ref={hover}>
        <Block size={[0.62, 0.52, 0.5]} color={color} position={[0, 0.36, 0]} />
        <Block size={[0.46, 0.28, 0.04]} color={C.ink} position={[0, 0.42, 0.26]} ink={0} />
        <mesh position={[-0.1, 0.43, 0.285]}>
          <boxGeometry args={[0.07, 0.1, 0.01]} />
          <meshBasicMaterial color={C.sageLight} />
        </mesh>
        <mesh position={[0.1, 0.43, 0.285]}>
          <boxGeometry args={[0.07, 0.1, 0.01]} />
          <meshBasicMaterial color={C.sageLight} />
        </mesh>
        <Cyl r={0.025} h={0.22} color={C.ink} position={[0, 0.72, 0]} ink={0} seg={6} />
        <mesh position={[0, 0.86, 0]}>
          <sphereGeometry args={[0.07, 12, 10]} />
          <meshBasicMaterial ref={light} color={C.mustard} />
        </mesh>
        <Block size={[0.7, 0.08, 0.56]} color={C.cream} position={[0, 0.08, 0]} ink={0.025} />
      </group>
    </group>
  );
}

export function Crate({ position, rotation = 0, size = 0.6, color = C.kraft }: { position: Vec3; rotation?: number; size?: number; color?: string }) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <Block size={[size, size * 0.8, size]} color={color} ink={0.03} />
      <mesh position={[0, size * 0.401, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[size * 0.18, size * 1.001]} />
        <meshBasicMaterial color={C.kraftDeep} />
      </mesh>
    </group>
  );
}

export function Truck({ position, rotation = 0 }: { position: Vec3; rotation?: number }) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <Block size={[2.2, 1.4, 1.3]} color={C.white} position={[-0.4, 1.0, 0]} />
      <Block size={[0.9, 1.0, 1.25]} color={C.coral} position={[1.15, 0.8, 0]} />
      <Block size={[0.04, 0.42, 0.9]} color={C.sageLight} position={[1.61, 1.02, 0]} ink={0} />
      <Block size={[1.0, 0.36, 0.02]} color={C.mustard} position={[-0.4, 1.05, 0.66]} ink={0} />
      {[-1.0, 0.0, 1.15].map((x) => (
        <group key={x}>
          <Cyl r={0.26} h={0.2} color={C.ink} position={[x, 0.27, 0.6]} rotation={[Math.PI / 2, 0, 0]} ink={0} />
          <Cyl r={0.26} h={0.2} color={C.ink} position={[x, 0.27, -0.6]} rotation={[Math.PI / 2, 0, 0]} ink={0} />
        </group>
      ))}
    </group>
  );
}
