import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { corsPreflightResponse, getCorsHeaders } from "../_shared/cors.ts";

type AutoCloseMode = "shadow" | "enforced";

type AutoCloseRequest = {
  dates?: string[];
  mode?: AutoCloseMode;
  limit?: number;
};

type Blocker = {
  code: string;
  message: string;
  fileId?: string;
  path?: string;
  scope?: "unc" | "qtm";
  detail?: unknown;
};

type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string | null;
};

type Evidence = {
  fileId: string;
  amount: number;
  confidence: number;
  reference: string | null;
  name: string;
  source?: "drive" | "ceo_declaration";
};

type ScanResult = {
  completed: boolean;
  files: DriveFile[];
  blockers: Blocker[];
};

type Declaration = {
  closing_date: string;
  unc_total_declared?: number | string | null;
  unc_extracted_amount?: number | string | null;
  unc_slip_image_base64?: string | null;
  cash_fund_topup_amount?: number | string | null;
  qtm_extracted_amount?: number | string | null;
  notes?: string | null;
  extraction_meta?: Record<string, unknown> | null;
};

type CacheValue = {
  amount: number | null;
  confidence: number;
  processedAt: string | null;
};

const LOW_CONFIDENCE_THRESHOLD = 0.85;
const UNC_PATH_TEMPLATE = "yyyy/MM/dd/UNC";
const QTM_PATH_TEMPLATE = "yyyy/MM/dd/QTM";
const ACTOR = "system_finance_auto_close_edge";

const jsonResponse = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });

const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
};

const coalesceNumber = (...values: unknown[]): number => {
  for (const value of values) {
    const parsed = numberOrNull(value);
    if (parsed !== null) return parsed;
  }
  return 0;
};

function getSingleDeclaredUncEvidence(
  declaration: Declaration,
  declaredUnc: number,
): Evidence | null {
  // Single-transfer exception: one CEO-uploaded UNC slip is already the bank
  // transaction evidence. Multiple transfers still require accountant Drive slips.
  const meta = declaration.extraction_meta || {};
  const uncItems = Array.isArray(meta.unc_items) ? meta.unc_items : [];
  const metaImages = Array.isArray(meta.unc_images)
    ? meta.unc_images.filter((image) =>
      typeof image === "string" && image.trim().length > 0
    )
    : [];
  const legacyUncImage = typeof declaration.unc_slip_image_base64 === "string" &&
      declaration.unc_slip_image_base64.trim().length > 0
    ? declaration.unc_slip_image_base64
    : null;
  const uncImages = metaImages.length > 0
    ? metaImages
    : (legacyUncImage
      ? [legacyUncImage]
      : []);

  if (uncItems.length !== 1 || uncImages.length !== 1 || declaredUnc <= 0) {
    return null;
  }

  const item = uncItems[0] as Record<string, unknown>;
  const amount = coalesceNumber(item?.amount, 0);
  if (amount !== declaredUnc) return null;
  const rawConfidence = Number(item?.confidence);
  const confidence = Number.isFinite(rawConfidence) ? rawConfidence : 0;

  return {
    fileId: `ceo-declaration-unc-${declaration.closing_date}`,
    amount,
    confidence,
    reference: item?.reference ? String(item.reference) : null,
    name: "CEO declaration UNC slip 1",
    source: "ceo_declaration",
  };
}

function vnToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function validateIsoDate(date: string, todayVn: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid ISO date: ${date}`);
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`Invalid calendar date: ${date}`);
  }

  if (date > todayVn) {
    throw new Error(`Cannot auto-close future Vietnam date: ${date}`);
  }

  return date;
}

function applyDatePathTemplate(template: string, date: string): string {
  const [yyyy, MM, dd] = date.split("-");
  return String(template || "yyyy/MM/dd")
    .replace(/yyyy/g, yyyy)
    .replace(/MM/g, MM)
    .replace(/dd/g, dd);
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : String(error || "Unknown error");
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [redacted]")
    .replace(
      /data:[^;]+;base64,[A-Za-z0-9+/=]+/g,
      "data:[redacted];base64,[redacted]",
    );
}

async function authenticate(req: Request) {
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const cronSecret = Deno.env.get("FINANCE_AUTO_CLOSE_CRON_SECRET") ||
    Deno.env.get("FINANCE_CRON_SECRET") || "";
  const bearer = req.headers.get("Authorization")?.replace("Bearer ", "") || "";
  const cronHeader = req.headers.get("x-finance-cron-secret") || "";

  if (!serviceRoleKey) {
    throw new Response(
      JSON.stringify({
        error: "Server misconfigured: missing service role key",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  if (cronHeader && !cronSecret) {
    throw new Response(
      JSON.stringify({
        error: "Server misconfigured: missing finance auto-close cron secret",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  let serviceBearerOk = Boolean(serviceRoleKey && bearer === serviceRoleKey);
  if (!serviceBearerOk && bearer) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    if (supabaseUrl) {
      const verification = await fetch(
        `${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`,
        {
          headers: {
            apikey: bearer,
            Authorization: `Bearer ${bearer}`,
          },
        },
      ).catch(() => null);
      serviceBearerOk = Boolean(verification?.ok);
    }
  }

  const cronSecretOk = cronSecret && cronHeader === cronSecret;
  if (!serviceBearerOk && !cronSecretOk) {
    throw new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return { serviceRoleKey, cronSecret };
}

async function getAppSetting(
  supabase: any,
  key: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  if (error || !data?.value) return null;
  return String(data.value);
}

async function getDriveRootFolderUrl(supabase: any): Promise<string> {
  const primary = await getAppSetting(
    supabase,
    "finance_drive_root_folder_url",
  );
  if (primary) return primary;

  const fallback = await getAppSetting(
    supabase,
    "google_drive_receipts_folder",
  );
  if (fallback) return fallback;

  throw new Error("Missing finance drive root folder setting");
}

async function getTargetDates(
  supabase: any,
  body: AutoCloseRequest,
  todayVn: string,
): Promise<string[]> {
  const limit = Number(body.limit ?? 1);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("limit must be an integer from 1 to 10");
  }

  if (body.dates !== undefined) {
    if (
      !Array.isArray(body.dates) || body.dates.length === 0 ||
      body.dates.length > 10
    ) {
      throw new Error("dates must be a non-empty array with at most 10 items");
    }
    return Array.from(
      new Set(body.dates.map((date) => validateIsoDate(String(date), todayVn))),
    ).sort();
  }

  const { data, error } = await supabase
    .from("ceo_daily_closing_declarations")
    .select("closing_date,extraction_meta")
    .lt("closing_date", todayVn)
    .order("closing_date", { ascending: true })
    .limit(500);

  if (error) throw error;
  return (data || [])
    .filter((row: { extraction_meta?: Record<string, unknown> | null }) =>
      row?.extraction_meta?.close_approval_locked !== true
    )
    .slice(0, limit)
    .map((row: { closing_date: string }) => String(row.closing_date));
}

async function loadDeclaration(
  supabase: any,
  closingDate: string,
): Promise<Declaration | null> {
  const { data, error } = await supabase
    .from("ceo_daily_closing_declarations")
    .select(
      "closing_date,unc_total_declared,unc_extracted_amount,unc_slip_image_base64,cash_fund_topup_amount,qtm_extracted_amount,notes,extraction_meta",
    )
    .eq("closing_date", closingDate)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function loadPreviousClosedQtmBalance(
  supabase: any,
  closingDate: string,
): Promise<{ closing: number; closingDate: string } | null> {
  const { data, error } = await supabase
    .from("ceo_daily_closing_declarations")
    .select(
      "closing_date,cash_fund_topup_amount,qtm_extracted_amount,extraction_meta",
    )
    .lt("closing_date", closingDate)
    .order("closing_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data || data?.extraction_meta?.close_approval_locked !== true) {
    return null;
  }

  const explicitClosing = numberOrNull(
    data?.extraction_meta?.qtm_closing_balance,
  );
  const closing = explicitClosing ?? (
    coalesceNumber(data?.extraction_meta?.qtm_opening_balance, 0) +
    coalesceNumber(
      data?.qtm_extracted_amount,
      data?.cash_fund_topup_amount,
      0,
    ) -
    coalesceNumber(data?.extraction_meta?.qtm_spent_from_folder, 0)
  );

  return { closing, closingDate: String(data.closing_date) };
}

async function callFunction(
  functionName: string,
  serviceRoleKey: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  if (!supabaseUrl) {
    throw new Error("Server misconfigured: missing SUPABASE_URL");
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });

  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      String(
        responseBody?.error || responseBody?.detail ||
          `${functionName} HTTP ${response.status}`,
      ),
    );
  }
  return responseBody;
}

async function scanEvidenceFolder(
  serviceRoleKey: string,
  folderUrl: string,
  subfolderDate: string,
  scope: "unc" | "qtm",
): Promise<ScanResult> {
  try {
    const data = await callFunction("scan-drive-folder", serviceRoleKey, {
      folderUrl,
      subfolderDate,
      folderType: "bank_slip",
      skipProcessed: false,
      includeBase64: false,
    });

    const files = Array.isArray(data?.files) ? data.files : [];
    const message = String(data?.message || "");
    const blockers: Blocker[] = [];
    if (message.includes("No subfolder")) {
      blockers.push({
        code: "folder_not_found",
        message: `Drive folder not found: ${subfolderDate}`,
        path: subfolderDate,
        scope,
      });
    }

    return { completed: true, files, blockers };
  } catch (error) {
    return {
      completed: false,
      files: [],
      blockers: [{
        code: "drive_connectivity",
        message: `Drive scan failed for ${subfolderDate}: ${
          sanitizeError(error)
        }`,
        path: subfolderDate,
        scope,
      }],
    };
  }
}

async function downloadDriveFile(
  serviceRoleKey: string,
  folderUrl: string,
  file: DriveFile,
): Promise<{ base64?: string; mimeType?: string; name?: string } | null> {
  const data = await callFunction("scan-drive-folder", serviceRoleKey, {
    mode: "download_file",
    folderUrl,
    fileId: file.id,
    fileName: file.name,
    mimeType: file.mimeType || "image/jpeg",
  });

  return data?.file || null;
}

async function extractSlipAmount(
  serviceRoleKey: string,
  cronSecret: string,
  imageBase64: string,
  mimeType: string,
  slipType: "unc" | "qtm",
) {
  if (!cronSecret) {
    throw new Error(
      "Server misconfigured: missing FINANCE_AUTO_CLOSE_CRON_SECRET for internal OCR",
    );
  }

  const data = await callFunction(
    "finance-extract-slip-amount",
    serviceRoleKey,
    {
      imageBase64,
      mimeType,
      slipType,
    },
    {
      "x-finance-cron-secret": cronSecret,
    },
  );

  return data?.data || null;
}

async function loadOcrCache(
  supabase: any,
  files: DriveFile[],
): Promise<Map<string, CacheValue>> {
  const ids = files.map((file) => file.id).filter((id): id is string =>
    Boolean(id)
  );
  const cache = new Map<string, CacheValue>();
  const chunkSize = 500;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("drive_file_index")
      .select(
        "file_id, file_name, mime_type, extracted_amount, extraction_confidence, processed_at",
      )
      .in("file_id", chunk)
      .not("extracted_amount", "is", null);

    if (error) {
      console.warn(
        "[finance-auto-close-day] cache lookup skipped:",
        sanitizeError(error),
      );
      return cache;
    }

    for (const row of data || []) {
      const amount = numberOrNull(row?.extracted_amount);
      cache.set(String(row.file_id), {
        amount,
        confidence: Number(row?.extraction_confidence || 0),
        processedAt: row?.processed_at ? String(row.processed_at) : null,
      });
    }
  }

  return cache;
}

async function upsertOcrCache(
  supabase: any,
  rows: Array<{ file: DriveFile; evidence: Evidence; folderDate: string }>,
) {
  if (!rows.length) return;

  const now = new Date().toISOString();
  const cacheRows = rows.map(({ file, evidence, folderDate }) => ({
    file_id: evidence.fileId,
    file_name: evidence.name || String(file.name || evidence.fileId),
    folder_date: folderDate,
    folder_type: "bank_slip",
    mime_type: file.mimeType || null,
    parent_folder_id: null,
    processed: true,
    processed_at: now,
    last_seen_at: now,
    extracted_amount: evidence.amount,
    extraction_confidence: evidence.confidence,
  }));

  const { error } = await supabase
    .from("drive_file_index")
    .upsert(cacheRows, { onConflict: "file_id", ignoreDuplicates: false });

  if (error) throw error;
}

function cacheMatches(
  file: DriveFile,
  cached: CacheValue | undefined,
): cached is CacheValue & { amount: number } {
  return Boolean(
    cached &&
      cached.amount !== null &&
      cached.amount > 0 &&
      file.modifiedTime &&
      cached.processedAt &&
      Number.isFinite(new Date(file.modifiedTime).getTime()) &&
      new Date(cached.processedAt).getTime() >=
        new Date(file.modifiedTime).getTime(),
  );
}

async function buildEvidence(
  supabase: any,
  serviceRoleKey: string,
  cronSecret: string,
  folderUrl: string,
  folderDate: string,
  files: DriveFile[],
  slipType: "unc" | "qtm",
  seenFileIds: Set<string>,
): Promise<{ evidence: Evidence[]; blockers: Blocker[] }> {
  const blockers: Blocker[] = [];
  const evidence: Evidence[] = [];
  const freshCacheRows: Array<
    { file: DriveFile; evidence: Evidence; folderDate: string }
  > = [];
  const cache = await loadOcrCache(supabase, files);

  for (const file of files) {
    const fileId = String(file.id || "");
    if (!fileId) {
      blockers.push({
        code: "missing_drive_file_id",
        message: "Drive returned a file without id",
        scope: slipType,
      });
      continue;
    }

    if (seenFileIds.has(fileId)) {
      blockers.push({
        code: "duplicate_file_id",
        message: `Duplicate Drive file id in UNC/QTM evidence: ${fileId}`,
        fileId,
        scope: slipType,
      });
      continue;
    }
    seenFileIds.add(fileId);

    if (file.mimeType && !String(file.mimeType).startsWith("image/")) {
      blockers.push({
        code: "unsupported_file",
        message: `Unsupported Drive file type: ${file.name || fileId}`,
        fileId,
        scope: slipType,
      });
      continue;
    }

    const cached = cache.get(fileId);
    if (cacheMatches(file, cached)) {
      const cachedEvidence = {
        fileId,
        amount: cached.amount,
        confidence: cached.confidence,
        reference: String(file.name || fileId),
        name: String(file.name || fileId),
      };
      if (cachedEvidence.confidence < LOW_CONFIDENCE_THRESHOLD) {
        blockers.push({
          code: "low_confidence",
          message:
            `Cached OCR confidence below threshold for ${cachedEvidence.name}`,
          fileId,
          scope: slipType,
        });
      }
      evidence.push(cachedEvidence);
      continue;
    }

    let downloaded:
      | { base64?: string; mimeType?: string; name?: string }
      | null = null;
    try {
      downloaded = await downloadDriveFile(serviceRoleKey, folderUrl, file);
    } catch (error) {
      blockers.push({
        code: "download_failed",
        message: `Failed downloading Drive file ${file.name || fileId}: ${
          sanitizeError(error)
        }`,
        fileId,
        scope: slipType,
      });
      continue;
    }

    if (!downloaded?.base64) {
      blockers.push({
        code: "missing_ocr",
        message: `Downloaded file has no base64 content for OCR: ${
          file.name || fileId
        }`,
        fileId,
        scope: slipType,
      });
      continue;
    }

    try {
      const extracted = await extractSlipAmount(
        serviceRoleKey,
        cronSecret,
        downloaded.base64,
        downloaded.mimeType || file.mimeType || "image/jpeg",
        slipType,
      );
      const amount = numberOrNull(extracted?.amount);
      const confidence = Number(extracted?.confidence || 0);
      if (amount === null || amount <= 0) {
        blockers.push({
          code: "missing_ocr",
          message: `OCR did not return a usable amount for ${
            file.name || fileId
          }`,
          fileId,
          scope: slipType,
        });
        continue;
      }

      const item: Evidence = {
        fileId,
        amount,
        confidence,
        reference: extracted?.reference
          ? String(extracted.reference)
          : String(file.name || fileId),
        name: String(file.name || downloaded.name || fileId),
      };
      if (confidence < LOW_CONFIDENCE_THRESHOLD) {
        blockers.push({
          code: "low_confidence",
          message: `OCR confidence below threshold for ${item.name}`,
          fileId,
          scope: slipType,
        });
      }
      evidence.push(item);
      freshCacheRows.push({ file, evidence: item, folderDate });
    } catch (error) {
      blockers.push({
        code: "ocr_failed",
        message: `OCR failed for ${file.name || fileId}: ${
          sanitizeError(error)
        }`,
        fileId,
        scope: slipType,
      });
    }
  }

  await upsertOcrCache(supabase, freshCacheRows);
  return { evidence, blockers };
}

function declarationMismatchFlags(declaration: Declaration): string[] {
  const meta = declaration.extraction_meta || {};
  const flags: string[] = [];
  const closeDecision = String(meta.close_decision || "");

  // Fresh Drive evidence is authoritative for folder totals and the derived QTM
  // balance. Preserve only an explicit prior human reject/conditional decision.
  if (closeDecision === "reject" || closeDecision === "conditional") {
    flags.push(`close_decision_${closeDecision}`);
  }
  return flags;
}

async function buildSnapshot(
  supabase: any,
  serviceRoleKey: string,
  cronSecret: string,
  rootFolderUrl: string,
  closingDate: string,
) {
  const declaration = await loadDeclaration(supabase, closingDate);
  if (!declaration) {
    return {
      snapshot: {
        closingDate,
        declaredUnc: 0,
        qtmTopup: 0,
        qtmOpening: 0,
        qtmSpent: 0,
        qtmClosing: 0,
        driveConnectivity: false,
        uncEvidence: [],
        qtmEvidence: [],
        blockers: [{
          code: "missing_declaration",
          message: "Missing CEO daily closing declaration",
        }],
        lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
        declarationMismatchFlags: [],
      },
      blockers: [{
        code: "missing_declaration",
        message: "Missing CEO daily closing declaration",
      }] as Blocker[],
    };
  }

  const priorQtmBalance = await loadPreviousClosedQtmBalance(
    supabase,
    closingDate,
  );

  const uncPath = applyDatePathTemplate(UNC_PATH_TEMPLATE, closingDate);
  const qtmPath = applyDatePathTemplate(QTM_PATH_TEMPLATE, closingDate);
  const declaredUnc = coalesceNumber(
    declaration.unc_extracted_amount,
    declaration.unc_total_declared,
    0,
  );
  const singleDeclaredUncEvidence = getSingleDeclaredUncEvidence(
    declaration,
    declaredUnc,
  );
  const uncDriveRequired = !singleDeclaredUncEvidence;

  const uncScan = uncDriveRequired ? await scanEvidenceFolder(
    serviceRoleKey,
    rootFolderUrl,
    uncPath,
    "unc",
  ) : { completed: true, files: [], blockers: [] };
  const qtmScan = await scanEvidenceFolder(
    serviceRoleKey,
    rootFolderUrl,
    qtmPath,
    "qtm",
  );

  const seenFileIds = new Set<string>();
  const uncProcessed = singleDeclaredUncEvidence
    ? { evidence: [singleDeclaredUncEvidence], blockers: [] }
    : await buildEvidence(
      supabase,
      serviceRoleKey,
      cronSecret,
      rootFolderUrl,
      closingDate,
      uncScan.files,
      "unc",
      seenFileIds,
    );
  const qtmProcessed = await buildEvidence(
    supabase,
    serviceRoleKey,
    cronSecret,
    rootFolderUrl,
    closingDate,
    qtmScan.files,
    "qtm",
    seenFileIds,
  );

  const qtmTopup = coalesceNumber(
    declaration.qtm_extracted_amount,
    declaration.cash_fund_topup_amount,
    0,
  );
  const storedQtmOpening = coalesceNumber(
    declaration.extraction_meta?.qtm_opening_balance,
    0,
  );
  const qtmOpening = priorQtmBalance?.closing ?? storedQtmOpening;
  const qtmOpeningSourceDate = priorQtmBalance?.closingDate ?? null;
  const expectedQtmSpent = coalesceNumber(
    declaration.extraction_meta?.qtm_spent_from_folder,
    0,
  );
  const qtmSpent = qtmProcessed.evidence.reduce(
    (sum, item) => sum + item.amount,
    0,
  );
  const qtmClosing = qtmOpening + qtmTopup - qtmSpent;
  const declarationMismatchFlagsValue = declarationMismatchFlags(declaration);

  const blockers: Blocker[] = [
    ...uncScan.blockers.filter((blocker) =>
      uncDriveRequired &&
      (blocker.code !== "folder_not_found" || declaredUnc > 0)
    ),
    ...qtmScan.blockers.filter((blocker) =>
      blocker.code !== "folder_not_found" || expectedQtmSpent > 0
    ),
    ...uncProcessed.blockers,
    ...qtmProcessed.blockers,
  ];

  const snapshot = {
    closingDate,
    declaredUnc,
    qtmTopup,
    qtmOpening,
    qtmOpeningSourceDate,
    qtmSpent,
    qtmClosing,
    driveConnectivity: (uncDriveRequired ? uncScan.completed : true) &&
      qtmScan.completed,
    uncEvidence: uncProcessed.evidence,
    qtmEvidence: qtmProcessed.evidence,
    blockers,
    lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
    declarationMismatchFlags: declarationMismatchFlagsValue,
    paths: {
      uncPath,
      qtmPath,
    },
  };

  return { snapshot, blockers };
}

async function invokeAutoCloseRpc(
  supabase: any,
  closingDate: string,
  mode: AutoCloseMode,
  snapshot: unknown,
) {
  const { data, error } = await supabase.rpc("finance_auto_close_day", {
    p_closing_date: closingDate,
    p_mode: mode,
    p_snapshot: snapshot,
    p_actor: ACTOR,
  });

  if (error) throw error;
  return data || {};
}

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    const { serviceRoleKey, cronSecret } = await authenticate(req);
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    if (!supabaseUrl) {
      throw new Error("Server misconfigured: missing SUPABASE_URL");
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = await req.json().catch(() => ({})) as AutoCloseRequest;
    const mode = body.mode || "shadow";
    if (mode !== "shadow" && mode !== "enforced") {
      return jsonResponse(
        req,
        { error: "mode must be shadow or enforced" },
        400,
      );
    }

    const todayVn = vnToday();
    const targetDates = await getTargetDates(supabase, body, todayVn);
    const rootFolderUrl = await getDriveRootFolderUrl(supabase);
    const results = [];
    let stopped = false;

    console.info(
      `[finance-auto-close-day] processing ${targetDates.length} date(s) in ${mode} mode`,
    );

    for (const closingDate of targetDates) {
      try {
        const { snapshot, blockers } = await buildSnapshot(
          supabase,
          serviceRoleKey,
          cronSecret,
          rootFolderUrl,
          closingDate,
        );
        const rpcResult = await invokeAutoCloseRpc(
          supabase,
          closingDate,
          mode,
          snapshot,
        );
        const rpcBlockers = Array.isArray(rpcResult?.blockers)
          ? rpcResult.blockers
          : [];
        const hasBlockers = blockers.length > 0 || rpcBlockers.length > 0;

        results.push({
          closingDate,
          mode,
          status: hasBlockers
            ? "blocked"
            : String(rpcResult?.status || "succeeded"),
          decision: rpcResult?.decision || (hasBlockers ? "block" : "approve"),
          runId: rpcResult?.runId || null,
          blockers: rpcBlockers.length > 0 ? rpcBlockers : blockers,
          snapshot: {
            declaredUnc: snapshot.declaredUnc,
            qtmTopup: snapshot.qtmTopup,
            qtmOpening: snapshot.qtmOpening,
            qtmSpent: snapshot.qtmSpent,
            qtmClosing: snapshot.qtmClosing,
            driveConnectivity: snapshot.driveConnectivity,
            uncEvidenceCount: snapshot.uncEvidence.length,
            qtmEvidenceCount: snapshot.qtmEvidence.length,
            lowConfidenceThreshold: snapshot.lowConfidenceThreshold,
            declarationMismatchFlags: snapshot.declarationMismatchFlags,
          },
        });

        if (hasBlockers) {
          stopped = true;
          break;
        }
      } catch (error) {
        results.push({
          closingDate,
          mode,
          status: "error",
          error: sanitizeError(error),
          blockers: [{ code: "edge_error", message: sanitizeError(error) }],
        });
        stopped = true;
        break;
      }
    }

    return jsonResponse(req, {
      success: true,
      mode,
      stopped,
      todayVn,
      results,
    });
  } catch (error) {
    if (error instanceof Response) {
      return new Response(error.body, {
        status: error.status,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }

    return jsonResponse(req, { error: sanitizeError(error) }, 500);
  }
});
