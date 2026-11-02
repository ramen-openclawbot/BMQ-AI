/**
 * Hiển thị số lượng tồn theo đơn vị lớn hơn cho món g / ml.
 *
 * Sổ vẫn lưu bằng g / ml (owner rule); đây chỉ là cách đọc: một món g có thể
 * bật hiện theo kg, một món ml có thể bật hiện theo lít. Không có display unit
 * thì mọi hàm giữ đúng hành vi cũ.
 */

export type KhoDisplayUnit = "kg" | "lít";

export interface DisplayAmount {
  value: number;
  unit: string;
}

export interface CountUnitChoice {
  label: string;
  factor: number;
}

function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase();
}

/**
 * 'kg' only for a g item, 'lít' only for an ml item; every other combination
 * (including a stale / unknown display unit) is off.
 */
export function displayUnitFor(
  unit: string,
  displayUnit: string | null | undefined,
): KhoDisplayUnit | null {
  const chosen = (displayUnit ?? "").trim().toLowerCase();
  const stored = normalizeUnit(unit);
  if (chosen === "kg" && stored === "g") return "kg";
  if (chosen === "lít" && stored === "ml") return "lít";
  return null;
}

/** The ledger keeps g / ml; the screen divides by 1000 only when a display unit is on. */
export function toDisplayAmount(
  value: number,
  unit: string,
  displayUnit: string | null | undefined,
): DisplayAmount {
  const display = displayUnitFor(unit, displayUnit);
  return display === null ? { value, unit } : { value: value / 1000, unit: display };
}

/**
 * A count box offers exactly the chosen unit (kg / lít) when the display unit is
 * on; otherwise it keeps the old g + kg / ml + lít choices.
 */
export function countUnitsFor(
  unit: string,
  displayUnit: string | null | undefined,
): CountUnitChoice[] {
  const display = displayUnitFor(unit, displayUnit);
  if (display !== null) return [{ label: display, factor: 1000 }];

  const stored = normalizeUnit(unit);
  if (stored === "g") return [{ label: "kg", factor: 1000 }, { label: "g", factor: 1 }];
  if (stored === "ml") return [{ label: "lít", factor: 1000 }, { label: "ml", factor: 1 }];
  return [{ label: unit, factor: 1 }];
}
