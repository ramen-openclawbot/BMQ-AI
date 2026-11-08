import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createServiceClient,
  timingSafeEqual,
} from "../_shared/report.ts";
import {
  PAYROLL_ATTENDANCE_SELFIE_RETENTION_MAX_PER_RUN,
  selectExpiredSelfiePaths,
  selfieRetentionCutoff,
  type SelfieStorageObject,
} from "../_shared/payroll-attendance.ts";

const SELFIE_BUCKET = "payroll-attendance-selfies";
const PAGE_SIZE = 100;

interface StorageListRow {
  name: string;
  id: string | null;
  created_at?: string | null;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ success: false, error: "method_not_allowed" }, 405);
  }

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceRoleKey) {
    return json({ success: false, error: "service_role_not_configured" }, 503);
  }

  const supabase = createServiceClient();
  const authorization = req.headers.get("authorization") || "";
  const suppliedBearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const bearerOk = Boolean(suppliedBearer) && timingSafeEqual(suppliedBearer, serviceRoleKey);

  const configResult = await supabase
    .from("payroll_bn_attendance_consent_config")
    .select("worker_secret, selfie_retention_days")
    .eq("id", true)
    .maybeSingle();
  if (configResult.error) {
    console.error("[payroll-attendance-selfie-retention] Config read failed", configResult.error.message);
    return json({ success: false, error: "config_read_failed" }, 500);
  }
  if (!configResult.data) {
    return json({ success: false, error: "config_not_configured" }, 503);
  }

  const storedSecret = String(configResult.data.worker_secret || "");
  const suppliedSecret = req.headers.get("x-worker-secret") || "";
  const secretOk = Boolean(suppliedSecret) && Boolean(storedSecret) &&
    timingSafeEqual(suppliedSecret, storedSecret);
  if (!bearerOk && !secretOk) {
    return json({ success: false, error: "unauthorized" }, 401);
  }

  const retentionDays = Number(configResult.data.selfie_retention_days);
  if (!Number.isFinite(retentionDays)) {
    return json({ success: false, error: "retention_days_invalid" }, 500);
  }

  try {
    const cutoff = selfieRetentionCutoff(new Date(), retentionDays);
    const storage = supabase.storage.from(SELFIE_BUCKET);
    const folders: string[] = [""];
    const scannedObjects: SelfieStorageObject[] = [];
    let scanned = 0;

    while (folders.length > 0 && scanned < PAYROLL_ATTENDANCE_SELFIE_RETENTION_MAX_PER_RUN) {
      const folder = folders.shift() as string;
      let offset = 0;

      while (scanned < PAYROLL_ATTENDANCE_SELFIE_RETENTION_MAX_PER_RUN) {
        const { data, error } = await storage.list(folder, {
          limit: PAGE_SIZE,
          offset,
          sortBy: { column: "created_at", order: "asc" },
        });
        if (error) throw error;

        const rows = (data || []) as unknown as StorageListRow[];
        for (const row of rows) {
          if (!row?.name) continue;
          const path = folder ? `${folder}/${row.name}` : row.name;
          // Folder placeholders have no object id; recurse instead of counting
          // them as selfies.
          if (row.id === null) {
            // Selfies live under <employee>/<YYYY-MM-DD>/. Skip work-date
            // folders that are not yet expired so recent selfies never use up
            // the per-run scan budget and every employee folder is reached.
            if (/^\d{4}-\d{2}-\d{2}$/.test(row.name) && row.name >= cutoff.slice(0, 10)) {
              continue;
            }
            folders.push(path);
            continue;
          }
          if (scanned >= PAYROLL_ATTENDANCE_SELFIE_RETENTION_MAX_PER_RUN) break;
          scanned += 1;
          scannedObjects.push({ path, createdAt: row.created_at ?? null });
        }

        if (rows.length < PAGE_SIZE) break;
        offset += rows.length;
      }
    }

    const expired = selectExpiredSelfiePaths(
      scannedObjects,
      cutoff,
      PAYROLL_ATTENDANCE_SELFIE_RETENTION_MAX_PER_RUN,
    );

    let deleted = 0;
    for (let index = 0; index < expired.length; index += PAGE_SIZE) {
      const chunk = expired.slice(index, index + PAGE_SIZE);
      const { data, error } = await storage.remove(chunk);
      if (error) throw error;
      deleted += Array.isArray(data) ? data.length : chunk.length;
    }

    return json({
      success: true,
      deleted,
      scanned,
      retention_days: retentionDays,
      cutoff,
    });
  } catch (error) {
    console.error("[payroll-attendance-selfie-retention] Retention failed", error);
    return json({
      success: false,
      error: "retention_failed",
      deleted: 0,
      scanned: 0,
    }, 500);
  }
});
