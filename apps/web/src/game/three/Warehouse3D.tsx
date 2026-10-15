import { Html } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";
import { useMemo, useState } from "react";
import * as THREE from "three";
import type { WarehouseGameLocation, WarehouseGamePendingRow } from "@/lib/warehouse-game";
import { CLASS_META, type GameClass } from "../meta";
import { C } from "../theme";
import type { ShelfRow } from "../Warehouse";
import { Block, Buddy, Crate, JevBot, Truck } from "./parts";

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

export function Warehouse3D({ location, rows, crates, canAssign, transfers, onShelf, onYard, onTransfers }: {
  location: WarehouseGameLocation; rows: ShelfRow[]; crates: WarehouseGamePendingRow[];
  canAssign: boolean; transfers: number; onShelf: (cls: GameClass) => void; onYard: () => void; onTransfers: () => void;
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

      <Buddy position={[2.6, 0, 3.6]} rotation={0.9} shirt={C.sage} cap={C.mustard} wave={crates.length > 0} />
      <Buddy position={[-5.6, 0, -1.5]} rotation={0.7} shirt={C.coral} phase={0.8} />
      <JevBot path={path} />
    </group>
  );
}
