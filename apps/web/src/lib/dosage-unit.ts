/**
 * Pure helpers for the formulation dosage unit.
 *
 * A formulation line stores two different units:
 *   - `unit` is the material default unit (auto-filled by the UI);
 *   - `dosage_unit` is the unit the dosage_qty and unit_price are expressed in.
 *
 * cogs_explode_revenue normalizes coalesce(nullif(dosage_unit, ''), unit), so a
 * missing/blank dosage_unit keeps the old behaviour.
 */
import { STOCK_UNITS } from "./stock-units.ts";

/** Units a dosage may be expressed in: the shared stock-catalog codes. */
export const DOSAGE_UNITS: readonly string[] = STOCK_UNITS.map((unit) => unit.code);

export interface DosageUnitFields {
  dosage_unit?: string | null;
  unit?: string | null;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** dosage_unit when set, otherwise unit, otherwise the 'g' fallback. */
export function effectiveDosageUnit(
  row: DosageUnitFields | null | undefined,
): string {
  const dosageUnit = trimmed(row?.dosage_unit);
  if (dosageUnit) return dosageUnit;
  const unit = trimmed(row?.unit);
  return unit || "g";
}

/**
 * Copy the row with an explicit dosage_unit: keep an already-set value, else
 * use the material default unit, else 'g'. The row's `unit` is only a display
 * default and is deliberately not used here.
 */
export function withDosageUnit<T extends Record<string, unknown>>(
  row: T,
  materialDefaultUnit?: string | null,
): T & { dosage_unit: string } {
  const current = trimmed(row?.dosage_unit);
  const fallback = trimmed(materialDefaultUnit);
  return { ...row, dosage_unit: current || fallback || "g" };
}

/** The stock unit code a stored unit means ("Kg" → "kg"), or the trimmed text when it is not a known code. */
export function dosageUnitCode(value: string | null | undefined): string {
  const text = trimmed(value);
  const known = DOSAGE_UNITS.find((code) => code.toLowerCase() === text.toLowerCase());
  return known ?? text;
}

/** Choices for the dosage-unit picker: every known unit, plus the current one when it is not in the list. */
export function dosageUnitOptions(current: string | null | undefined): string[] {
  const code = dosageUnitCode(current);
  return code && !DOSAGE_UNITS.includes(code) ? [code, ...DOSAGE_UNITS] : [...DOSAGE_UNITS];
}
