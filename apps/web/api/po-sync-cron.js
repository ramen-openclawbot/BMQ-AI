const SUPABASE_PROJECT_REF = "cxntbdvfsikwmitapony";
const DEFAULT_FUNCTION_URL = `https://${SUPABASE_PROJECT_REF}.functions.supabase.co/po-sync-scheduler-run`;

function readBearerToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length).trim();
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const vercelCronSecret = process.env.CRON_SECRET;
  if (!vercelCronSecret) {
    res.status(500).json({ error: "Server misconfigured: CRON_SECRET not set" });
    return;
  }

  const cronToken = readBearerToken(req.headers.authorization);
  if (cronToken !== vercelCronSecret) {
    res.status(401).json({ error: "Unauthorized: invalid cron secret" });
    return;
  }

  const supabaseCronSecret = process.env.PO_SYNC_CRON_SECRET;
  if (!supabaseCronSecret) {
    res.status(500).json({ error: "Server misconfigured: PO_SYNC_CRON_SECRET not set" });
    return;
  }

  const targetUrl = process.env.PO_SYNC_SCHEDULER_URL || DEFAULT_FUNCTION_URL;

  try {
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": supabaseCronSecret,
      },
      body: JSON.stringify({ mode: "cron" }),
    });

    const raw = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "application/json";
    res.status(upstream.status);
    res.setHeader("content-type", contentType);
    res.send(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: `Cron proxy failed: ${message}` });
  }
}
