import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { WarehouseError } from "./warehouse.ts";
export async function authenticateOwner(request: Request, signal: AbortSignal) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) throw new WarehouseError("unauthorized", 401);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authorization }, fetch: (input, init) => fetch(input, { ...init, signal }) }, auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error } = await db.auth.getUser(authorization.slice(7));
  if (error || !user) throw new WarehouseError("unauthorized", 401);
  const roles = await db.from("user_roles").select("role").eq("user_id", user.id).abortSignal(signal);
  if (roles.error || !roles.data?.some(row => row.role === "owner")) throw new WarehouseError("forbidden", 403);
  return authorization;
}
