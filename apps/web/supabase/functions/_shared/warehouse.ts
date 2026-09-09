// Fixed server-owned origin only. Caller JWT is forwarded, then independently verified locally.
export class WarehouseError extends Error {
  code: string; status: number;
  constructor(code: string, status = 503) { super(code); this.code = code; this.status = status; }
}
export type WarehouseCall = (path: string, body?: unknown) => Promise<any>;
export function warehouseClient(base: string, authorization: string, signal: AbortSignal, fetcher: typeof fetch = fetch): WarehouseCall {
  let origin: URL;
  try {
    origin = new URL(base);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error();
  } catch { throw new WarehouseError("warehouse_unconfigured"); }
  return async (path, body) => {
    if (!new Set(["/v1/status", "/v1/sources", "/v1/ingest", "/v1/documents", "/v1/semantic", "/v1/query", "/v1/knowledge/search", "/v1/customer"]).has(path)) throw new WarehouseError("invalid_operation", 400);
    let response: Response;
    try { response = await fetcher(new URL(path, origin), { method: body === undefined ? "GET" : "POST", redirect: "error", signal,
      headers: { Authorization: authorization, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { throw new WarehouseError("warehouse_unavailable"); }
    if (!response.ok) throw new WarehouseError(response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : response.status < 500 ? "warehouse_rejected" : "warehouse_unavailable", response.status === 401 || response.status === 403 ? response.status : 503);
    // Read incrementally: Content-Length alone is not trustworthy.
    const reader = response.body?.getReader();
    if (!reader) throw new WarehouseError("warehouse_invalid_response");
    let size = 0; const chunks: Uint8Array[] = [];
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 128000) { await reader.cancel(); throw new WarehouseError("warehouse_result_limit"); } chunks.push(part.value); } }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new WarehouseError("warehouse_invalid_response"); }
  };
}
export async function boundedJson(request: Request, max = 2097152, signal: AbortSignal = request.signal): Promise<any> {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new WarehouseError("invalid_request", 415);
  const reader = request.body?.getReader(); if (!reader) throw new WarehouseError("invalid_request", 400);
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, {once:true});
  let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > max) { await reader.cancel(); throw new WarehouseError("body_limit", 413); } chunks.push(part.value); } }
  finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  signal.throwIfAborted();
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new WarehouseError("invalid_request", 400); }
}
export function warehouseMessage(code: string, en: boolean) {
  const messages: Record<string, [string, string]> = {
    warehouse_disabled: ["Kho dữ liệu chưa được bật.", "The data warehouse is not enabled."],
    warehouse_unconfigured: ["Chưa cấu hình kết nối kho dữ liệu.", "The data warehouse connection is not configured."],
    warehouse_unavailable: ["Không kết nối được kho dữ liệu. Không có kết quả thay thế.", "The data warehouse is unavailable. No substitute result was generated."],
    unauthorized: ["Vui lòng đăng nhập lại.", "Please sign in again."], forbidden: ["Chỉ chủ doanh nghiệp có quyền sử dụng.", "Available to business owners only."],
  };
  return (messages[code] ?? ["Không thể xử lý yêu cầu dữ liệu này. Kiểm tra định dạng và trạng thái nguồn.", "This data request could not be processed. Check its format and source status."])[en ? 1 : 0];
}
