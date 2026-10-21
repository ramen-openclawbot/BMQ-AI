import { useMemo, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import "@/styles/bmq-option-picker.css";

/**
 * A controlled select in the app theme: `value` + `onChange(value)`.
 * Short flat lists use the app's Select; long or grouped lists open a list with a search box
 * ("Gợi ý" / "Tất cả mặt hàng"), so a 200-item catalogue stays usable on a phone.
 */
export interface PickerOption {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
}

const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

export function OptionPicker({ value, onChange, options, placeholder = "Chọn…", ariaLabel, title, className, disabled, dataAttrs }: {
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
  const real = options.filter((option) => option.value !== "");
  const selected = real.find((option) => option.value === value);
  const long = real.length > 8 || real.some((option) => option.group);
  const data = Object.fromEntries(Object.entries(dataAttrs ?? {}).map(([key, val]) => [`data-${key}`, val]));

  const groups = useMemo(() => {
    const q = fold(query.trim());
    const out: Array<{ name: string; items: PickerOption[] }> = [];
    for (const option of real) {
      if (q && !fold(option.label).includes(q)) continue;
      const name = option.group ?? "";
      const last = out[out.length - 1];
      if (last && last.name === name) last.items.push(option);
      else out.push({ name, items: [option] });
    }
    return out;
  }, [real, query]);

  if (!long) {
    return (
      <Select value={selected ? value : undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className={cn("d3-pick-trigger", className)} aria-label={ariaLabel} data-bmq-picker data-value={value} {...data}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent className="d3-pick-menu">
          {real.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled} data-bmq-picker-option={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };
  const heading = title ?? ariaLabel ?? placeholder;

  return (
    <>
      <button
        type="button"
        className={cn("d3-pick-trigger", !selected && "is-empty", className)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen(true)}
        data-bmq-picker
        data-value={value}
        {...data}
      >
        <span className="d3-pick-value">{selected?.label ?? placeholder}</span>
        <ChevronDown className="d3-pick-caret" aria-hidden="true" />
      </button>
      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
        <DialogContent className="d3-pick" data-bmq-picker-sheet onOpenAutoFocus={(event) => {
          // A phone keyboard over the list hides the options; only desktop starts in the search box.
          if (real.length <= 8 || window.matchMedia("(pointer: coarse)").matches) event.preventDefault();
        }}>
          <DialogTitle className="d3-pick-title">{heading}</DialogTitle>
          {real.length > 8 ? (
            <label className="d3-pick-search">
              <Search aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Gõ để tìm…" aria-label="Tìm trong danh sách" enterKeyHint="search" />
            </label>
          ) : null}
          <div className="d3-pick-list" role="listbox" aria-label={ariaLabel ?? heading}>
            {groups.length === 0 ? <p className="d3-pick-none">Không thấy mục nào khớp “{query}”.</p> : null}
            {groups.map((group, gi) => (
              <div key={`${group.name}-${gi}`} className="d3-pick-group" role="group" aria-label={group.name || undefined}>
                {group.name ? <p className="d3-pick-group-name">{group.name}</p> : null}
                {group.items.map((option) => {
                  const on = option.value === value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="option"
                      aria-selected={on}
                      disabled={option.disabled}
                      className={cn("d3-pick-option", on && "is-on")}
                      onClick={() => pick(option.value)}
                      data-bmq-picker-option={option.value}
                    >
                      <span>{option.label}</span>
                      {on ? <Check aria-hidden="true" /> : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
