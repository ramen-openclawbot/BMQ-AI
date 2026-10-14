/** Clockwise degrees an image must be rotated so its printed text reads upright. */
export type ImageRotation = 0 | 90 | 180 | 270;

const VALID_ROTATIONS: readonly ImageRotation[] = [0, 90, 180, 270];

const IMAGE_ROTATION_ERROR_CODES = [
  "not_authenticated",
  "invalid_rotation",
  "invalid_path",
  "forbidden",
] as const;

/**
 * Coerce a stored / AI rotation to the four supported values. Anything that is
 * not a finite multiple of 90 in (-inf, +inf) collapses to 0 (upright), so a
 * bad value can never make the viewer render a broken angle. Negatives and
 * values at or above 360 are wrapped first.
 */
export function normalizeRotation(value: unknown): ImageRotation {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const wrapped = ((value % 360) + 360) % 360;
  return (VALID_ROTATIONS as readonly number[]).includes(wrapped)
    ? (wrapped as ImageRotation)
    : 0;
}

/** The next clockwise step of the manual rotate button. */
export function nextRotation(r: ImageRotation): ImageRotation {
  return ((r + 90) % 360) as ImageRotation;
}

/** True when the manual rotate button is useful (90 / 270 show sideways text). */
export function isSideways(r: ImageRotation): boolean {
  return r === 90 || r === 270;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/** Extract one of the known rotation RPC error codes, or null. */
export function imageRotationErrorCode(error: unknown): string | null {
  const message = errorMessage(error);
  if (!message) return null;
  for (const code of IMAGE_ROTATION_ERROR_CODES) {
    if (message.includes(code)) return code;
  }
  return null;
}

/** Short Vietnamese text for a rotation error code. */
export function imageRotationErrorText(code: string | null): string {
  if (code === "forbidden") return "Bạn không có quyền xoay ảnh phiếu";
  return "Chưa lưu được hướng xoay ảnh";
}
