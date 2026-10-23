import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import "@/styles/bmq-settings.css";

/**
 * Settings kit (owner 23/10/2026): one list per group, one row per setting.
 * Rows show the label, a one-line hint, the current value and one action; anything
 * that needs fields opens in place under its row instead of a box inside a box.
 */

export function SettingsPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="st" data-bmq-settings>
      <h1 className="st-title">{title}</h1>
      {children}
    </div>
  );
}

export function SettingsGroup({ id, title, children, footer }: { id?: string; title: string; children: ReactNode; footer?: ReactNode }) {
  const headingId = useId();
  return (
    <section id={id} className="st-group" aria-labelledby={headingId}>
      <h2 id={headingId} className="st-group-title">{title}</h2>
      <div className="st-card">{children}</div>
      {footer ? <div className="st-group-foot">{footer}</div> : null}
    </section>
  );
}

type Tone = "ok" | "off" | "warn";

/** Small status word with a dot: Đã kết nối / Chưa kết nối / Cần sửa. */
export function SettingsStatus({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={cn("st-status", `is-${tone}`)}>{children}</span>;
}

type RowProps = {
  label: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  action?: ReactNode;
  /** Opens a panel under the row; the row itself becomes the toggle. */
  children?: ReactNode;
  defaultOpen?: boolean;
  tone?: "danger";
  className?: string;
  dataAttr?: string;
};

export function SettingsRow({ label, hint, value, action, children, defaultOpen = false, tone, className, dataAttr }: RowProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const data = dataAttr ? { [`data-${dataAttr}`]: "" } : {};
  const body = (
    <>
      <span className="st-row-text">
        <span className={cn("st-row-label", tone === "danger" && "is-danger")}>{label}</span>
        {hint ? <span className="st-row-hint">{hint}</span> : null}
      </span>
      {value !== undefined && value !== null ? <span className="st-row-value">{value}</span> : null}
    </>
  );

  if (!children) {
    return (
      <div className={cn("st-item", className)} {...data}>
        <div className="st-row">
          {body}
          {action ? <span className="st-row-action">{action}</span> : null}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("st-item", open && "is-open", className)} {...data}>
      <div className="st-row">
        <button type="button" className="st-row-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
          {body}
          <ChevronRight className="st-chev" aria-hidden="true" />
        </button>
        {action ? <span className="st-row-action">{action}</span> : null}
      </div>
      <div className="st-reveal" id={panelId} aria-hidden={!open}>
        <div className="st-reveal-inner">{open ? <div className="st-panel">{children}</div> : null}</div>
      </div>
    </div>
  );
}
