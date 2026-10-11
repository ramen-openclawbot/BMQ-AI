import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { stockUnitLabel } from "@/lib/stock-units";

/**
 * Units a purchase line may use (owner decision 2026-10-11: no free-typed
 * units). Weight and volume keep kg / l on documents; the stock catalog stores
 * g / ml and converts.
 */
export const DOCUMENT_UNITS = [
  "kg", "g", "l", "ml",
  "cái", "hộp", "gói", "bịch", "chai", "can", "bao", "thùng",
  "cuộn", "khối", "quả", "tờ", "con", "cây", "bình", "nắp",
] as const;

interface UnitSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  /**
   * The value already in the form (OCR or an old line). A spelling variant is
   * shown under its standard label; an unknown unit stays visible, marked, until
   * someone picks a standard one.
   */
  currentValue?: string | null;
}

/** Native select of standard units; works with react-hook-form register or a controlled field. */
export const UnitSelect = forwardRef<HTMLSelectElement, UnitSelectProps>(
  ({ className, currentValue, value, ...props }, ref) => {
    const current = String((value ?? currentValue) ?? "").trim();
    const known = current === "" || (DOCUMENT_UNITS as readonly string[]).includes(current);
    const standard = known ? null : stockUnitLabel(current);
    return (
      <select
        ref={ref}
        value={value}
        className={cn(
          "flex h-10 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          !known && !standard && "border-amber-500 text-amber-800",
          className,
        )}
        data-bmq-unit-select
        {...props}
      >
        {current === "" ? <option value="">ĐVT…</option> : null}
        {!known ? (
          <option value={current}>{standard ? `${current} → ${standard}` : `${current} (chưa chuẩn)`}</option>
        ) : null}
        {DOCUMENT_UNITS.map((unit) => (
          <option key={unit} value={unit}>{unit}</option>
        ))}
      </select>
    );
  },
);
UnitSelect.displayName = "UnitSelect";
