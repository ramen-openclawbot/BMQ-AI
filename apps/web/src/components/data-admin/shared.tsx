// Shared building blocks for the VNAgent data-assets admin panels.
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import type { AssetStage, Language } from "@/lib/dataAssets";
import { formatNumber, stageLabel } from "@/lib/dataAssets";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string;
}

/** Cancellable async loader with explicit loading/error state and manual reload. */
export function useAsync<T>(run: () => Promise<T>, deps: unknown[]): AsyncState<T> & { reload: () => Promise<void> } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: "" });
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const token = ++generation.current;
    setState((previous) => ({ ...previous, loading: true, error: "" }));
    try {
      const data = await run();
      if (token === generation.current) setState({ data, loading: false, error: "" });
    } catch (error) {
      if (token === generation.current) {
        setState({ data: null, loading: false, error: error instanceof Error ? error.message : "Unknown error." });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void reload();
    return () => { generation.current += 1; };
  }, [reload]);

  return { ...state, reload };
}

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="da-loading" role="status" aria-live="polite">
      <Loader2 className="da-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBlock({ message, onRetry, retryLabel }: { message: string; onRetry: () => void; retryLabel: string }) {
  return (
    <div className="da-alert da-alert--error" role="alert">
      <div className="da-actions" style={{ justifyContent: "space-between" }}>
        <span><AlertTriangle size={15} aria-hidden="true" /> {message}</span>
        <button type="button" className="da-btn da-btn--ghost" onClick={onRetry}>{retryLabel}</button>
      </div>
    </div>
  );
}

export function EmptyBlock({ label }: { label: string }) {
  return (
    <div className="da-empty">
      <Inbox size={18} aria-hidden="true" />
      <p style={{ margin: "8px 0 0" }}>{label}</p>
    </div>
  );
}

export function StageBadge({ stage, language }: { stage: AssetStage | string; language: Language }) {
  const tone = stage === "gold" ? "gold" : stage === "curated" ? "curated" : "raw";
  return <span className={`da-badge da-badge--${tone}`}>{stageLabel(stage, language)}</span>;
}

export function SectionCard({ title, hint, actions, children }: { title: string; hint?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="da-card">
      <div className="da-actions" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 className="da-card-title">{title}</h2>
          {hint && <p className="da-card-hint">{hint}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Admin numbers use English (en-US) grouping; the admin never inherits the BMQ locale. */
export function toLocalNumber(value: number): string {
  return formatNumber(value);
}

/** Trigger a client-side .md download for a server-built export. */
export function downloadMarkdown(markdown: string, fileName: string): void {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
