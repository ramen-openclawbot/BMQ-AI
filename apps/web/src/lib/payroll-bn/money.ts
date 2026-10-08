// Exact integer / rational money math for the Bếp BN payroll engine.
//
// Wages are rates (VND per day/hour) multiplied by fractional day/hour counts,
// so every intermediate value is kept as a BigInt fraction `n / d`. Rounding to
// whole đồng happens exactly once, at the final net-pay step (R5: nearest
// 1.000 đồng, half up). Nothing here uses floating point for stored results.

export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

export const RATIONAL_ZERO: Rational = { n: 0n, d: 1n };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

/** Build a reduced fraction; the denominator must be non-zero. */
export function rational(n: bigint | number, d: bigint | number = 1n): Rational {
  let num = typeof n === "bigint" ? n : BigInt(Math.trunc(n));
  let den = typeof d === "bigint" ? d : BigInt(Math.trunc(d));
  if (den === 0n) throw new Error("rational_division_by_zero");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  return { n: num / g, d: den / g };
}

/**
 * Convert a JS number to an exact-enough fraction without floating point drift:
 * the decimal text is moved into an integer numerator over a power of ten.
 */
export function rationalFromNumber(value: number): Rational {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("rational_invalid_number");
  }
  if (Number.isInteger(value)) return rational(BigInt(value));
  const text = value.toString();
  if (text.includes("e") || text.includes("E")) {
    return rational(BigInt(Math.round(value * 1e9)), 1_000_000_000n);
  }
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [rawInt, fracPart = ""] = unsigned.split(".");
  const intPart = rawInt.length > 0 ? rawInt : "0";
  const digits = fracPart.length;
  const numerator = BigInt(intPart + fracPart) * (negative ? -1n : 1n);
  return rational(numerator, 10n ** BigInt(digits));
}

export function isRational(value: unknown): value is Rational {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Rational).n === "bigint" &&
    typeof (value as Rational).d === "bigint"
  );
}

/** Coerce an engine input (number / bigint / Rational) into a fraction. */
export function toRational(value: number | bigint | Rational): Rational {
  if (isRational(value)) return rational(value.n, value.d);
  if (typeof value === "bigint") return rational(value);
  return rationalFromNumber(value);
}

export function addRational(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function subRational(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function mulRational(a: Rational, b: Rational): Rational {
  return rational(a.n * b.n, a.d * b.d);
}

export function divRational(a: Rational, b: Rational): Rational {
  if (b.n === 0n) throw new Error("rational_division_by_zero");
  return rational(a.n * b.d, a.d * b.n);
}

export function negRational(a: Rational): Rational {
  return { n: -a.n, d: a.d };
}

export function isZeroRational(a: Rational): boolean {
  return a.n === 0n;
}

export function compareRational(a: Rational, b: Rational): number {
  const left = a.n * b.d;
  const right = b.n * a.d;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function maxRational(a: Rational, b: Rational): Rational {
  return compareRational(a, b) >= 0 ? a : b;
}

export function sumRational(values: readonly Rational[]): Rational {
  let total = RATIONAL_ZERO;
  for (const value of values) total = addRational(total, value);
  return total;
}

export function rationalToNumber(a: Rational): number {
  return Number(a.n) / Number(a.d);
}

/** Floor division for BigInt (JS `/` truncates toward zero). */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("rational_division_by_zero");
  let num = a;
  let den = b;
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const q = num / den;
  const r = num % den;
  return r !== 0n && r < 0n ? q - 1n : q;
}

/**
 * Round a fraction to the nearest multiple of `step`, halves going up
 * (toward +Infinity). Used for R5 with step = 1.000 đồng.
 */
export function roundHalfUpToStep(value: Rational, step: bigint): bigint {
  if (step <= 0n) throw new Error("round_invalid_step");
  const numerator = value.n * 2n + value.d * step;
  const denominator = value.d * 2n * step;
  return floorDiv(numerator, denominator) * step;
}

/** R5: round the exact net pay to the nearest 1.000 đồng, half up. */
export function roundVndToThousand(value: Rational): bigint {
  return roundHalfUpToStep(value, 1000n);
}
