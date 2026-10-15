import { Component, Suspense, lazy, type ReactNode } from "react";
import { GameLoading } from "../Loading";
import type { Game3DProps } from "./Game3D";

const Game3D = lazy(() => import("./Game3D"));

let support: boolean | null = null;

/** 3D needs WebGL; `?kho=2d` (remembered on this device) keeps the flat 2D game. */
export function canUse3D(): boolean {
  if (support !== null) return support;
  try {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("kho");
    if (mode === "2d" || mode === "3d") window.localStorage.setItem("bmq-kho-mode", mode);
    if (window.localStorage.getItem("bmq-kho-mode") === "2d") return (support = false);
    const canvas = document.createElement("canvas");
    support = Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    support = false;
  }
  return support;
}

/** Any 3D failure (chunk load, WebGL context) falls back to the 2D scene for this session. */
class Fallback extends Component<{ flat: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    support = false;
    console.warn("Kho 3D unavailable, using 2D", error);
  }
  render() {
    return this.state.failed ? this.props.flat : this.props.children;
  }
}

export function Kho3D({ flat, ...props }: Game3DProps & { flat: ReactNode }) {
  return (
    <Fallback flat={flat}>
      <Suspense fallback={<GameLoading />}>
        <Game3D {...(props as Game3DProps)} />
      </Suspense>
    </Fallback>
  );
}
