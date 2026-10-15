import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

/**
 * In-game replacement for window.confirm (owner 15/10: the iOS system box broke the
 * notebook theme). Resolves true on the main button, false on cancel / backdrop / Esc.
 */
export interface GameConfirmOptions {
  title: string;
  message?: string;
  ok?: string;
  cancel?: string;
  tone?: "danger" | "default";
}

function GameConfirm({ title, message, ok = "Đồng ý", cancel = "Thôi", tone = "default", onDone }: GameConfirmOptions & { onDone: (value: boolean) => void }) {
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    okRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onDone(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);
  return (
    <div className="gconfirm-layer" data-bmq-game-confirm>
      <div className="gconfirm-backdrop" onClick={() => onDone(false)} />
      <section className={`gconfirm is-${tone}`} role="alertdialog" aria-modal="true" aria-label={title}>
        <span className="gconfirm-icon" aria-hidden="true">{tone === "danger" ? "⏸️" : "❔"}</span>
        <h2>{title}</h2>
        {message ? <p>{message}</p> : null}
        <div className="gconfirm-row">
          <button type="button" className="btn ghost" onClick={() => onDone(false)} data-bmq-game-confirm-cancel>{cancel}</button>
          <button ref={okRef} type="button" className={`btn${tone === "danger" ? " danger" : ""}`} onClick={() => onDone(true)} data-bmq-game-confirm-ok>{ok}</button>
        </div>
      </section>
    </div>
  );
}

export function askGame(options: GameConfirmOptions): Promise<boolean> {
  const host = document.querySelector("[data-bmq-warehouse-game]") ?? document.body;
  const mount = document.createElement("div");
  if (host === document.body) mount.className = "kg";
  host.appendChild(mount);
  const root = createRoot(mount);
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      root.unmount();
      mount.remove();
      resolve(value);
    };
    root.render(<GameConfirm {...options} onDone={done} />);
  });
}
