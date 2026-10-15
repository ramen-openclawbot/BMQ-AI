import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import "./game-picker.css";

/**
 * Notebook-style replacement for <select> (owner 15/10: the iOS wheel/menu broke the
 * game look). Same contract as a controlled select: `value` + `onChange(value)`.
 * Long lists get a search box; options can be grouped ("Gợi ý" / "Tất cả mặt hàng").
 */
export interface PickerOption {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
}

const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

export function GamePicker({ value, onChange, options, placeholder = "Chọn…", ariaLabel, title, className, disabled, dataAttrs }: {
  value: string;
  onChange: (value: string) => void;
  options: PickerOption[];
  placeholder?: string;
  ariaLabel?: string;
  title?: string;
  className?: string;
  disabled?: boolean;
  dataAttrs?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.value === value && option.value !== "");
  const searchable = options.length > 8;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const groups = useMemo(() => {
    const q = fold(query.trim());
    const shown = options.filter((option) => option.value !== "" && (!q || fold(option.label).includes(q)));
    const out: Array<{ name: string; items: PickerOption[] }> = [];
    for (const option of shown) {
      const name = option.group ?? "";
      const last = out[out.length - 1];
      if (last && last.name === name) last.items.push(option);
      else out.push({ name, items: [option] });
    }
    return out;
  }, [options, query]);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };
  const host = typeof document === "undefined" ? null : document.querySelector("[data-bmq-warehouse-game]") ?? document.body;

  return (
    <>
      <button
        type="button"
        className={`gpick-trigger${selected ? "" : " is-empty"}${className ? ` ${className}` : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen(true)}
        data-bmq-picker
        data-value={value}
        {...Object.fromEntries(Object.entries(dataAttrs ?? {}).map(([key, val]) => [`data-${key}`, val]))}
      >
        <span className="gpick-value">{selected?.label ?? placeholder}</span>
        <span className="gpick-caret" aria-hidden="true">▾</span>
      </button>
      {open && host ? createPortal(
        <div className="gpick-layer" data-bmq-picker-sheet>
          <div className="gpick-backdrop" onClick={() => setOpen(false)} />
          <section className="gpick-sheet" role="dialog" aria-modal="true" aria-label={title ?? ariaLabel ?? placeholder}>
            <div className="gpick-spiral" aria-hidden="true">{Array.from({ length: 7 }).map((_, i) => <i key={i} />)}</div>
            <header className="gpick-head">
              <h2>{title ?? ariaLabel ?? placeholder}</h2>
              <button type="button" className="gpick-close" onClick={() => setOpen(false)} aria-label="Đóng">✕</button>
            </header>
            {searchable ? (
              <label className="gpick-search">
                <span aria-hidden="true">🔍</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Gõ để tìm…" aria-label="Tìm trong danh sách" enterKeyHint="search" />
              </label>
            ) : null}
            <div className="gpick-list" role="listbox" aria-label={ariaLabel}>
              {groups.length === 0 ? <p className="gpick-none">Không thấy món nào khớp.</p> : null}
              {groups.map((group, gi) => (
                <div key={`${group.name}-${gi}`} className="gpick-group">
                  {group.name ? <p className="gpick-group-name">{group.name}</p> : null}
                  {group.items.map((option) => {
                    const on = option.value === value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={on}
                        disabled={option.disabled}
                        className={`gpick-option${on ? " is-on" : ""}`}
                        onClick={() => pick(option.value)}
                        data-bmq-picker-option={option.value}
                      >
                        <span>{option.label}</span>
                        {on ? <b aria-hidden="true">✓</b> : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        </div>,
        host,
      ) : null}
    </>
  );
}
