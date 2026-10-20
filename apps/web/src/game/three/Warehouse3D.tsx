import { Html } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { WarehouseGameLocation, WarehouseGamePendingRow } from "@/lib/warehouse-game";
import { CLASS_META, type GameClass } from "../meta";
import { C } from "../theme";
import type { ShelfRow } from "../Warehouse";
import { Block, Buddy, Crate, Cyl, JevBot, Truck } from "./parts";

type Vec3 = [number, number, number];

const HTML_Z: [number, number] = [5, 0];

const SLOTS: Vec3[] = [
  [-4.2, 0, -2.6],
  [0, 0, -2.6],
  [4.2, 0, -2.6],
  [-4.2, 0, 1.0],
  [0, 0, 1.0],
];

function hash(seed: number): number {
  const x = Math.sin(seed * 91.7) * 43758.5453;
  return x - Math.floor(x);
}

const pointer = (setHover?: (on: boolean) => void) => ({
  onPointerOver: (event: ThreeEvent<PointerEvent>) => { event.stopPropagation(); setHover?.(true); document.body.style.cursor = "pointer"; },
  onPointerOut: () => { setHover?.(false); document.body.style.cursor = ""; },
});

function Rack({ row, at, onOpen }: { row: ShelfRow; at: Vec3; onOpen: (cls: GameClass) => void }) {
  const meta = CLASS_META[row.cls];
  const [hover, setHover] = useState(false);
  const goods = Math.min(row.count, 15);
  return (
    <group position={at}>
      <group onClick={(event) => { event.stopPropagation(); onOpen(row.cls); }} {...pointer(setHover)} position={[0, hover ? 0.06 : 0, 0]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} receiveShadow>
          <planeGeometry args={[3.5, 1.7]} />
          <meshToonMaterial color={hover ? C.mustardLight : C.cream} />
        </mesh>
        {[-1.4, 1.4].flatMap((x) => [-0.4, 0.4].map((z) => (
          <Block key={`${x}${z}`} size={[0.1, 2.3, 0.1]} color={C.ink} position={[x, 1.15, z]} ink={0} />
        )))}
        {[0.45, 1.2, 1.95].map((y) => (
          <Block key={y} size={[3.0, 0.08, 0.95]} color={C.kraft} position={[0, y, 0]} ink={0.025} />
        ))}
        {Array.from({ length: goods }, (_, i) => {
          const level = i % 3;
          const slot = Math.floor(i / 3);
          const s = 0.34 + hash(i + row.count) * 0.16;
          const tall = s * (0.8 + hash(i * 7) * 0.4);
          return (
            <Block
              key={i}
              size={[s, tall, s]}
              color={i % 4 === 3 ? C.white : meta.tint}
              position={[-1.05 + slot * 0.52 + hash(i * 3) * 0.06, [0.49, 1.24, 1.99][level] + tall / 2, hash(i * 5) * 0.16 - 0.08]}
              ink={0.022}
            />
          );
        })}
      </group>
      <Html position={[0, 3.05, 0]} center zIndexRange={HTML_Z}>
        <button type="button" className="k3-tag" aria-label={`${meta.label}, ${row.count} mặt hàng`} onClick={() => onOpen(row.cls)} style={{ ["--tint" as string]: meta.tint }}>
          <i>{meta.icon}</i>
          <b>{meta.label}</b>
          <span>{row.count} món</span>
        </button>
      </Html>
    </group>
  );
}


/** Sushi, the ordering machine, lives inside each warehouse (owner 17/10: "đặt máy đặt hàng tự động trong kho này và kho Q7 luôn"). */
function SushiMachine({ at, onOpen }: { at: Vec3; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <group position={at}>
      <group onClick={(event) => { event.stopPropagation(); onOpen(); }} {...pointer(setHover)} position={[0, hover ? 0.06 : 0, 0]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} receiveShadow>
          <circleGeometry args={[1.35, 40]} />
          <meshToonMaterial color={hover ? C.mustardLight : C.cream} />
        </mesh>
        <Block size={[1.7, 0.3, 1.35]} color={C.cream} position={[0, 0.15, 0]} />
        <Block size={[1.35, 1.25, 1.0]} color="#c88169" position={[0, 0.92, 0]} />
        <Block size={[1.39, 0.1, 1.04]} color={C.cream} position={[0, 0.6, 0]} ink={0.02} shadow={false} />
        <Block size={[0.95, 0.5, 0.05]} color={C.ink} position={[0, 1.05, 0.52]} ink={0.02} shadow={false} />
        {[-0.2, 0.2].map((x) => <Block key={x} size={[0.12, 0.18, 0.02]} color={C.white} position={[x, 1.1, 0.56]} ink={0} shadow={false} />)}
        <Block size={[0.22, 0.04, 0.02]} color={C.white} position={[0, 0.9, 0.56]} ink={0} shadow={false} />
        <Cyl r={0.3} h={0.1} color={C.sage} position={[0, 1.6, 0]} />
        <mesh position={[0, 1.95, 0]} castShadow>
          <cylinderGeometry args={[0.62, 0.3, 0.5, 28]} />
          <meshToonMaterial color={C.mustard} />
        </mesh>
        <Cyl r={0.66} h={0.07} color={C.mustardLight} position={[0, 2.22, 0]} seg={28} />
        <Block size={[0.8, 0.05, 0.45]} color={C.cream} position={[0, 0.45, 0.78]} ink={0.02} />
        <Block size={[0.12, 0.42, 0.12]} color={C.sage} position={[0.78, 1.25, 0.3]} ink={0.02} />
        <Block size={[0.2, 0.18, 0.2]} color={C.cream} position={[0.78, 0.98, 0.3]} ink={0.02} />
      </group>
      <Html position={[0, 2.95, 0]} center zIndexRange={HTML_Z}>
        <button type="button" className="k3-tag is-machine" aria-label="Máy đặt hàng tự động" onClick={onOpen} data-bmq-sushi-machine>
          <i>🤖</i>
          <b className="k3-long">Máy đặt hàng tự động</b>
          <b className="k3-short">Máy đặt hàng</b>
        </button>
      </Html>
    </group>
  );
}

/** null while Sushi is still reading the ledger; "error" when it could not. */
export type StockBotState = number | null | "error";

/**
 * Sushi kiểm tồn (owner 20/10): a robot scanning the rack beside it; its lamp blinks
 * coral while raw materials are running low. 3D only (owner chose not to draw it in the 2D fallback).
 */
function StockBot({ at, low, onOpen }: { at: Vec3; low: StockBotState; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  const bob = useRef<THREE.Group>(null);
  const lamp = useRef<THREE.MeshBasicMaterial>(null);
  const beam = useRef<THREE.Mesh>(null);
  const alert = typeof low === "number" && low > 0;
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (bob.current) bob.current.position.y = Math.sin(t * 2.4) * 0.05;
    if (lamp.current) lamp.current.color.set(alert ? (Math.sin(t * 5) > 0 ? C.coral : C.cream) : C.sageLight);
    if (beam.current) beam.current.rotation.y = Math.sin(t * 1.6) * 0.35;
  });
  const tag = low === null ? "…" : low === "error" ? "Chưa đọc được" : low > 0 ? `${low} sắp hết` : "Đủ hàng ✓";
  return (
    <group position={at}>
      <group onClick={(event) => { event.stopPropagation(); onOpen(); }} {...pointer(setHover)} position={[0, hover ? 0.06 : 0, 0]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} receiveShadow>
          <circleGeometry args={[0.78, 36]} />
          <meshToonMaterial color={hover ? C.mustardLight : C.cream} />
        </mesh>
        {/* turned toward the rack on its left, scanning the shelves */}
        <group ref={bob} rotation={[0, -0.55, 0]} scale={0.9}>
          <Block size={[0.78, 0.1, 0.62]} color={C.cream} position={[0, 0.12, 0]} ink={0.025} />
          {[-0.28, 0.28].map((x) => <Cyl key={x} r={0.09} h={0.06} color={C.ink} position={[x, 0.08, 0.26]} rotation={[0, 0, Math.PI / 2]} ink={0} seg={10} />)}
          <Block size={[0.62, 0.6, 0.5]} color={C.sage} position={[0, 0.5, 0]} />
          <Block size={[0.4, 0.05, 0.02]} color={C.cream} position={[0, 0.62, 0.26]} ink={0} shadow={false} />
          <Block size={[0.66, 0.46, 0.54]} color={C.sage} position={[0, 1.06, 0]} />
          <Block size={[0.5, 0.28, 0.04]} color={C.ink} position={[0, 1.08, 0.28]} ink={0} shadow={false} />
          {[-0.11, 0.11].map((x) => (
            <mesh key={x} position={[x, 1.09, 0.305]}>
              <boxGeometry args={[0.08, 0.11, 0.01]} />
              <meshBasicMaterial color={C.sageLight} />
            </mesh>
          ))}
          <Cyl r={0.025} h={0.24} color={C.ink} position={[0, 1.41, 0]} ink={0} seg={6} />
          <mesh position={[0, 1.56, 0]}>
            <sphereGeometry args={[0.08, 12, 10]} />
            <meshBasicMaterial ref={lamp} color={C.sageLight} />
          </mesh>
          {/* scanner arm sweeping a beam over the bins */}
          <group position={[-0.36, 0.72, 0.05]}>
            <Block size={[0.1, 0.1, 0.36]} color={C.mustard} position={[0, 0, 0.12]} ink={0.02} />
            <mesh ref={beam} position={[0, 0, 0.3]}>
              <coneGeometry args={[0.2, 0.5, 16, 1, true]} />
              <meshBasicMaterial color={C.mustardLight} transparent opacity={0.45} side={THREE.DoubleSide} />
            </mesh>
          </group>
          {/* clipboard in the other hand */}
          <group position={[0.38, 0.7, 0.18]} rotation={[-0.35, -0.3, 0]}>
            <Block size={[0.3, 0.38, 0.03]} color={C.white} ink={0.02} />
            {[0.08, 0, -0.08].map((y) => <Block key={y} size={[0.2, 0.025, 0.01]} color={y > 0 ? C.coral : C.ink} position={[0, y, 0.02]} ink={0} shadow={false} />)}
          </group>
        </group>
      </group>
      <Html position={[-0.1, 1.9, 0.05]} center zIndexRange={HTML_Z}>
        <button type="button" className="k3-tag is-stockbot" aria-label={`Sushi kiểm tồn: ${tag}`} onClick={onOpen} data-bmq-stock-bot>
          <i>🔎</i>
          <b className="k3-long">Sushi kiểm tồn</b>
          <b className="k3-short">Kiểm tồn</b>
          <span className={alert ? "is-alert" : undefined}>{tag}</span>
        </button>
      </Html>
    </group>
  );
}

export function Warehouse3D({ location, rows, crates, canAssign, transfers, onShelf, onYard, onTransfers, onMachine, lowStock, onStockBot }: {
  location: WarehouseGameLocation; rows: ShelfRow[]; crates: WarehouseGamePendingRow[];
  canAssign: boolean; transfers: number; onShelf: (cls: GameClass) => void; onYard: () => void; onTransfers: () => void; onMachine: () => void;
  lowStock?: StockBotState; onStockBot?: () => void;
}) {
  const wall = location === "q7" ? C.mustard : C.coral;
  const path = useMemo(
    () => [new THREE.Vector3(-6.4, 0, -0.8), new THREE.Vector3(6.4, 0, -0.8), new THREE.Vector3(6.4, 0, 1.1), new THREE.Vector3(2.2, 0, 1.3), new THREE.Vector3(2.2, 0, 2.6), new THREE.Vector3(-6.4, 0, 2.6)],
    [],
  );
  const pile = Math.min(crates.length, 10);
  const vanLabel = location === "q7" ? `Nhận từ Tân Tạo · ${transfers}` : `Đã chuyển sang Q7 · ${transfers}`;
  return (
    <group>
      <Block size={[15, 0.3, 11]} color={C.paperDeep} position={[0, -0.15, 0]} ink={0.05} shadow={false} />
      {Array.from({ length: 7 }, (_, i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[-6 + i * 2, 0.004, 0]}>
          <planeGeometry args={[0.03, 11]} />
          <meshBasicMaterial color={C.kraft} transparent opacity={0.5} />
        </mesh>
      ))}
      {/* cutaway room: only the back and left walls, so the camera always sees in */}
      <Block size={[15, 3.4, 0.3]} color={C.cream} position={[0, 1.7, -5.35]} />
      <Block size={[0.3, 3.4, 11]} color={C.cream} position={[-7.35, 1.7, 0]} />
      <Block size={[15, 0.5, 0.32]} color={wall} position={[0, 3.25, -5.35]} />
      <Block size={[0.32, 0.5, 11]} color={wall} position={[-7.35, 3.25, 0]} />
      {[-4.5, 0, 4.5].map((x) => (
        <Block key={x} size={[1.6, 0.9, 0.06]} color={C.sageLight} position={[x, 2.1, -5.18]} />
      ))}
      {[-3, 0, 3].map((x) => (
        <mesh key={x} rotation={[-Math.PI / 2, 0, -Math.PI / 2]} position={[x, 0.008, -0.8]}>
          <circleGeometry args={[0.28, 3]} />
          <meshBasicMaterial color={C.mustard} />
        </mesh>
      ))}
      {rows.slice(0, SLOTS.length).map((row, i) => (
        <Rack key={row.cls} row={row} at={SLOTS[i]} onOpen={onShelf} />
      ))}

      {/* Khu phân loại: goods whose receipt name has no label yet */}
      <group position={[4.6, 0, 3.1]}>
        <group onClick={canAssign ? (event) => { event.stopPropagation(); onYard(); } : undefined} {...(canAssign ? pointer() : {})}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} receiveShadow>
            <planeGeometry args={[3.6, 2.6]} />
            <meshToonMaterial color={canAssign ? C.coralLight : C.paper} />
          </mesh>
          {[-1.8, 1.8].map((x) => (
            <Block key={x} size={[0.06, 0.03, 2.6]} color={C.mustard} position={[x, 0.02, 0]} ink={0} shadow={false} />
          ))}
          {Array.from({ length: pile }, (_, i) => (
            <Crate key={i} position={[-1.1 + (i % 4) * 0.72, 0.25 + Math.floor(i / 8) * 0.5, -0.5 + (Math.floor(i / 4) % 2) * 0.95]} rotation={hash(i) * 0.6 - 0.3} size={0.62} />
          ))}
          {crates.length === 0 ? <Block size={[0.9, 0.5, 0.6]} color={C.sage} position={[0, 0.25, 0]} /> : null}
        </group>
        <Html position={[0, 2.1, 0]} center zIndexRange={HTML_Z}>
          {canAssign ? (
            <button type="button" className="k3-tag is-sort" aria-label={`Khu phân loại, ${crates.length} món chưa dán nhãn`} onClick={onYard} data-bmq-yard-gate>
              <i>📦</i>
              <b>Khu phân loại</b>
              <span>{crates.length ? `${crates.length} món chờ` : "Đã xong ✓"}</span>
            </button>
          ) : (
            <div className="k3-tag is-locked">
              <b>Khu phân loại</b>
              <span>Chỉ chủ hoặc người sửa kho</span>
            </div>
          )}
        </Html>
      </group>

      {/* transfer van: Tân Tạo → Q7 */}
      <group position={[-4.6, 0, 4.4]}>
        <group scale={0.62} onClick={(event) => { event.stopPropagation(); onTransfers(); }} {...pointer()}>
          <Truck position={[0, 0, 0]} />
        </group>
        <Html position={[0, 1.9, 0]} center zIndexRange={HTML_Z}>
          <button type="button" className="k3-tag is-van" aria-label={`Phiếu chuyển kho, ${transfers} phiếu`} onClick={onTransfers} data-bmq-transfer-van>
            <i>🚚</i>
            <b className="k3-long">{vanLabel}</b>
            <b className="k3-short">Chuyển kho · {transfers}</b>
          </button>
        </Html>
      </group>

      {/* Sushi, the ordering machine, right inside this warehouse */}
      <SushiMachine at={[0.7, 0, 3.9]} onOpen={onMachine} />

      {/* Sushi kiểm tồn: at the end of the back-right rack, where its tag clears every other tag on phones and desktop */}
      {onStockBot ? <StockBot at={[6.7, 0, -2.6]} low={lowStock ?? null} onOpen={onStockBot} /> : null}

      <Buddy position={[2.6, 0, 3.6]} rotation={0.9} shirt={C.sage} cap={C.mustard} wave={crates.length > 0} />
      <Buddy position={[-5.6, 0, -1.5]} rotation={0.7} shirt={C.coral} phase={0.8} />
      <JevBot path={path} />
    </group>
  );
}
