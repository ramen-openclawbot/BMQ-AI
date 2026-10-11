import { useEffect, useState, type ReactNode } from "react";

/** Scene viewport; the key change replays the entry animation. */
export function Scene({ id, scroll = false, fill = false, children }: { id: string; scroll?: boolean; fill?: boolean; children: ReactNode }) {
  return <div className={`scene${scroll ? " is-scroll" : ""}${fill ? " is-fill" : ""}`} key={id}>{children}</div>;
}

/** Portrait layout for phones and narrow windows. */
export function usePortrait(): boolean {
  const read = () => typeof window !== "undefined" && (window.innerWidth < 760 || window.innerHeight > window.innerWidth * 1.05);
  const [portrait, setPortrait] = useState(read);
  useEffect(() => {
    const onResize = () => setPortrait(read());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return portrait;
}
