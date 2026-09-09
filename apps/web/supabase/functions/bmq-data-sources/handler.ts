import { boundedJson, warehouseClient, WarehouseError, warehouseMessage } from "../_shared/warehouse.ts";
export function sourceOperation(raw: any): { path: string; body?: unknown } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => !["action", "language", "source", "entity", "filename", "content", "title", "timezone"].includes(k))) throw new WarehouseError("invalid_request", 400);
  if (raw.action === "status" || raw.action === "sources") {
    if (Object.keys(raw).some(k => !["action", "language"].includes(k))) throw new WarehouseError("invalid_request", 400);
    return { path: `/v1/${raw.action}` };
  }
  if (!["ingest", "document"].includes(raw.action) || typeof raw.source !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw.source) || typeof raw.filename !== "string" || raw.filename.length > 160 || /[/\\\x00-\x1f]/.test(raw.filename) || typeof raw.content !== "string" || !raw.content.trim() || new TextEncoder().encode(raw.content).length > 1048576) throw new WarehouseError("invalid_request", 400);
  if (raw.action === "ingest") {
    if (!/\.(csv|json)$/i.test(raw.filename) || typeof raw.entity !== "string" || !/^[a-z_]{1,40}$/.test(raw.entity) || (raw.timezone !== undefined && (typeof raw.timezone !== "string" || raw.timezone.length > 80))) throw new WarehouseError("invalid_request", 400);
    return { path: "/v1/ingest", body: { source: raw.source, entity: raw.entity, filename: raw.filename, content: raw.content, ...(raw.timezone ? { timezone: raw.timezone } : {}) } };
  }
  if (!/\.(md|txt)$/i.test(raw.filename) || typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > 200) throw new WarehouseError("invalid_request", 400);
  return { path: "/v1/documents", body: { source: raw.source, title: raw.title, filename: raw.filename, content: raw.content } };
}
export function createSourcesHandler(config: { enabled: () => boolean; url: () => string; authenticate: (req: Request, signal: AbortSignal) => Promise<string>; fetcher?: typeof fetch }) {
  const active = new Set<string>();
  return async (req: Request) => {
    const origin = req.headers.get("origin"); let en = /^en/i.test(req.headers.get("accept-language") ?? "");
    const headers: Record<string,string> = { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin", "Access-Control-Allow-Headers": "authorization,apikey,content-type,accept-language,x-client-info,x-supabase-client-platform,x-supabase-client-platform-version,x-supabase-client-runtime,x-supabase-client-runtime-version", "Access-Control-Allow-Methods": "POST, OPTIONS" };
    const json = (body: unknown, status=200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !new Set(["https://ai.banhmique.vn", "http://localhost:5173", "http://localhost:8080", "http://localhost:3000"]).has(origin)) return json({ code: "forbidden", error: "Origin not allowed" },403);
    if (origin) headers["Access-Control-Allow-Origin"] = origin;
    if (req.method === "OPTIONS") return new Response(null,{status:204,headers});
    if (req.method !== "POST") return json({code:"invalid_request",error:"Method not allowed"},405);
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(20000)]); let lock: string | undefined;
    try {
      const authorization = await config.authenticate(req, signal);
      if (!config.enabled()) throw new WarehouseError("warehouse_disabled");
      // Hash instead of retaining a bearer in abuse-control metadata.
      lock = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authorization)))).join("");
      if (active.has(lock)) { lock = undefined; throw new WarehouseError("busy",429); } active.add(lock);
      const raw = await boundedJson(req, 2097152, signal); en = raw?.language === "en" || (raw?.language !== "vi" && en);
      const operation = sourceOperation(raw);
      return json(await warehouseClient(config.url(), authorization, signal, config.fetcher)(operation.path, operation.body));
    } catch (error) { const code = error instanceof WarehouseError ? error.code : "warehouse_unavailable"; return json({code,error:warehouseMessage(code,en)}, error instanceof WarehouseError ? error.status : 503); }
    finally { if (lock) active.delete(lock); }
  };
}
