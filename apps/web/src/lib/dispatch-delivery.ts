/**
 * Pure helpers for the "Kho 2D" delivery gate (2026-11-01).
 *
 * The parsers validate / normalise the JSON returned by
 *   public.get_dispatch_game_queue() and build the arguments of
 *   public.record_dispatch_delivery(uuid, jsonb, text[], uuid).
 *
 * They deliberately follow the same defensive style as warehouse-game.ts: a
 * missing / null server payload is an empty list so an older server keeps the
 * game usable, while buildDeliveryPayload refuses anything the RPC would
 * reject (no photo, more than eight photos, negative / NaN quantities).
 */

export interface DispatchQueueItem {
  id: string;
  product_name: string;
  unit: string;
  quantity: number;
  /** Số thực giao; null / thiếu trên payload cũ được coi là 0. */
  delivered_qty: number;
}

export interface DispatchQueueRow {
  id: string;
  dispatch_number: string;
  status: string;
  dispatch_date: string | null;
  delivered_date: string | null;
  customer_id: string | null;
  customer_name: string | null;
  /** amount_status của phiếu xác nhận doanh thu; null khi chưa có. */
  amount_status: string | null;
  confirmation_id: string | null;
  evidence_count: number;
  can_edit: boolean;
  items: DispatchQueueItem[];
}

/** Cách xử lý phần giao thiếu của một dòng. */
export type ShortfallAction = "return_stock" | "write_off";

/** One delivered line the game sends back to record_dispatch_delivery. */
export interface DeliveryLine {
  item_id: string;
  /** Số lượng đặt trên phiếu; dùng để chặn giao vượt và nhận diện giao thiếu. */
  expected_qty: number | string | null | undefined;
  delivered_qty: number | string | null | undefined;
  /** Bắt buộc khi delivered_qty < expected_qty; bỏ qua khi giao đủ. */
  shortfall_action?: ShortfallAction | null;
  /** Bắt buộc (>= 3 ký tự) khi shortfall_action = 'write_off'. */
  shortfall_note?: string | null;
  /** Optional explicit confirmation line key; falls back to product_name. */
  source_line_key?: string | null;
}

export interface BuildDeliveryPayloadInput {
  dispatchId: string;
  lines: DeliveryLine[];
  photoPaths: string[];
  requestId: string;
}

export interface DispatchDeliveryRpcArgs {
  p_dispatch_id: string;
  p_lines: {
    item_id: string;
    delivered_qty: number;
    source_line_key: string | null;
    shortfall_action: ShortfallAction | null;
    shortfall_note: string | null;
  }[];
  p_photo_paths: string[];
  p_request_id: string;
}

export type DeliveryVarianceStatus = "full" | "short" | "over";

export interface DeliveryVariance {
  expected: number;
  delivered: number;
  /** delivered - expected (âm = thiếu, dương = thừa). */
  variance: number;
  status: DeliveryVarianceStatus;
  /** true khi giao thừa; cổng giao hàng coi đây là lỗi (over_delivery_not_allowed). */
  over_delivered: boolean;
}

function nullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

/** Coerce a numeric field, defaulting null / missing / malformed to fallback. */
function finiteOr(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function requireText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new TypeError(`${field} is required`);
  return text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeQueueItem(raw: unknown): DispatchQueueItem {
  const row = asRecord(raw);
  return {
    id: typeof row.id === "string" ? row.id : "",
    product_name: typeof row.product_name === "string" ? row.product_name : "",
    unit: typeof row.unit === "string" ? row.unit : "",
    quantity: finiteOr(row.quantity, 0),
    delivered_qty: finiteOr(row.delivered_qty, 0),
  };
}

/**
 * Parse the jsonb array returned by `get_dispatch_game_queue`. A missing /
 * null payload is an empty list; every number is normalised and a row with
 * missing fields still maps (empty strings, zero counts, empty items).
 */
export function mapDispatchQueue(raw: unknown): DispatchQueueRow[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new TypeError("dispatchQueue must be an array");

  return raw.map((entry) => {
    const row = asRecord(entry);
    const rawItems = row.items;
    return {
      id: typeof row.id === "string" ? row.id : "",
      dispatch_number: typeof row.dispatch_number === "string" ? row.dispatch_number : "",
      status: typeof row.status === "string" ? row.status : "",
      dispatch_date: nullableText(row.dispatch_date),
      delivered_date: nullableText(row.delivered_date),
      customer_id: nullableText(row.customer_id),
      customer_name: nullableText(row.customer_name),
      amount_status: nullableText(row.amount_status),
      confirmation_id: nullableText(row.confirmation_id),
      evidence_count: finiteOr(row.evidence_count, 0),
      can_edit: row.can_edit === true,
      items: Array.isArray(rawItems) ? rawItems.map(normalizeQueueItem) : [],
    };
  });
}

/**
 * Build the arguments of `record_dispatch_delivery`. Throws when a dispatch /
 * request id is missing, when there is no line, when a delivered quantity is
 * missing / negative / NaN, when a line delivers more than its `expected_qty`
 * (over_delivery_not_allowed), when a short line has no valid
 * `shortfall_action` (shortfall_action_required), when a `write_off` has no
 * >= 3 character note (shortfall_note_required), or when the photo count is
 * outside 1..8. `shortfall_action` / `shortfall_note` are sent as null when the
 * line is delivered in full.
 */
export function buildDeliveryPayload(input: BuildDeliveryPayloadInput): DispatchDeliveryRpcArgs {
  const dispatchId = requireText(input?.dispatchId, "dispatchId");
  const requestId = requireText(input?.requestId, "requestId");

  const lines = input?.lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new TypeError("lines must contain at least one line");
  }
  const normalizedLines = lines.map((line, index) => {
    const itemId = requireText(line?.item_id, `lines[${index}].item_id`);

    const expected = line?.expected_qty;
    if (expected === null || expected === undefined || expected === "") {
      throw new TypeError(`lines[${index}].expected_qty must be a finite number`);
    }
    const expectedNumeric = typeof expected === "number" ? expected : Number(expected);
    if (!Number.isFinite(expectedNumeric)) {
      throw new TypeError(`lines[${index}].expected_qty must be a finite number`);
    }

    const delivered = line?.delivered_qty;
    if (delivered === null || delivered === undefined || delivered === "") {
      throw new TypeError(`lines[${index}].delivered_qty must be a finite number`);
    }
    const numeric = typeof delivered === "number" ? delivered : Number(delivered);
    if (!Number.isFinite(numeric)) {
      throw new TypeError(`lines[${index}].delivered_qty must be a finite number`);
    }
    if (numeric < 0) {
      throw new TypeError(`lines[${index}].delivered_qty must be greater than or equal to 0`);
    }
    if (numeric > expectedNumeric) {
      throw new TypeError(
        `lines[${index}].delivered_qty must not exceed expected_qty (over_delivery_not_allowed)`,
      );
    }

    let shortfallAction: ShortfallAction | null = null;
    let shortfallNote: string | null = null;
    if (numeric < expectedNumeric) {
      const action = line?.shortfall_action;
      if (action !== "return_stock" && action !== "write_off") {
        throw new TypeError(
          `lines[${index}].shortfall_action is required when delivered_qty is below expected_qty (shortfall_action_required)`,
        );
      }
      shortfallAction = action;
      shortfallNote = nullableText(line?.shortfall_note);
      if (action === "write_off" && (shortfallNote === null || shortfallNote.length < 3)) {
        throw new TypeError(
          `lines[${index}].shortfall_note must be at least 3 characters for write_off (shortfall_note_required)`,
        );
      }
    }

    return {
      item_id: itemId,
      delivered_qty: numeric,
      source_line_key: nullableText(line?.source_line_key),
      shortfall_action: shortfallAction,
      shortfall_note: shortfallNote,
    };
  });

  const photos = input?.photoPaths;
  if (!Array.isArray(photos) || photos.length < 1) {
    throw new TypeError("photoPaths must contain at least 1 photo");
  }
  if (photos.length > 8) {
    throw new TypeError("photoPaths must contain at most 8 photos");
  }
  const normalizedPhotos = photos.map((photo, index) =>
    requireText(photo, `photoPaths[${index}]`),
  );

  return {
    p_dispatch_id: dispatchId,
    p_lines: normalizedLines,
    p_photo_paths: normalizedPhotos,
    p_request_id: requestId,
  };
}

/**
 * Storage path of one delivery photo: '<dispatch_id>/<safe file name>'.
 * The file name is reduced to its basename and only [A-Za-z0-9._-] survives,
 * so '..' / path separators / unicode punctuation cannot escape the folder.
 */
export function evidencePath(dispatchId: string, fileName: string): string {
  const id = requireText(dispatchId, "dispatchId");
  const raw = typeof fileName === "string" ? fileName : "";
  const base = raw.split(/[\\/]/).pop() ?? "";
  let safe = base
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+/, "")
    .replace(/[._]+$/, "");
  if (safe === "") safe = "evidence.jpg";
  if (safe.length > 120) {
    const dot = safe.lastIndexOf(".");
    const ext = dot > 0 ? safe.slice(dot, dot + 10) : "";
    safe = safe.slice(0, 120 - ext.length) + ext;
  }
  return `${id}/${safe}`;
}

/**
 * Đủ / thiếu / thừa giữa số đã xuất và số thực giao, kèm chênh lệch để game
 * hiển thị. Giá trị thiếu / null được coi là 0.
 */
export function computeDeliveryVariance(
  expectedQuantity: unknown,
  deliveredQuantity: unknown,
): DeliveryVariance {
  const expected = finiteOr(expectedQuantity, 0);
  const delivered = finiteOr(deliveredQuantity, 0);
  const variance = Math.round((delivered - expected) * 1000) / 1000;
  const status: DeliveryVarianceStatus =
    variance === 0 ? "full" : variance < 0 ? "short" : "over";
  return {
    expected,
    delivered,
    variance,
    status,
    over_delivered: variance > 0,
  };
}

/**
 * Dịch mã lỗi server mới của cổng giao hàng sang câu tiếng Việt cho người
 * dùng. Mã lạ được giữ nguyên (fallback), mã rỗng trả câu chung.
 */
export function shortfallErrorText(code: unknown): string {
  const key = typeof code === "string" ? code.trim() : "";
  switch (key) {
    case "over_delivery_not_allowed":
      return "Số thực giao không được lớn hơn số lượng đặt trên phiếu.";
    case "shortfall_action_required":
      return "Dòng giao thiếu phải chọn Trả lại kho hoặc Hao hụt.";
    case "shortfall_note_required":
      return "Hao hụt phải ghi lý do ít nhất 3 ký tự.";
    default:
      return key === "" ? "Không ghi được số thực giao, vui lòng thử lại." : key;
  }
}
