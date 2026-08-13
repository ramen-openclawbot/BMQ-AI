const SUPABASE_PROJECT_REF = "cxntbdvfsikwmitapony";
const DEFAULT_FUNCTION_URL = `https://${SUPABASE_PROJECT_REF}.functions.supabase.co/po-gmail-sync`;

function readBearerToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length).trim();
}

function vietnamDateKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function shiftIsoDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function gmailDate(value) {
  const [year, month, day] = value.split("-");
  return `${year}/${Number(month)}/${Number(day)}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || readBearerToken(req.headers.authorization) !== cronSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const poSyncSecret = process.env.VIETJET_ORDER_CRON_SECRET;
  if (!poSyncSecret) {
    res.status(500).json({ error: "VIETJET_ORDER_CRON_SECRET is not configured" });
    return;
  }

  const today = vietnamDateKey();
  const tomorrow = shiftIsoDate(today, 1);
  const dayAfterTomorrow = shiftIsoDate(today, 2);
  const query = [
    "in:anywhere",
    "deliveredto:po@bmq.vn",
    "from:(vietjetair.com)",
    `after:${gmailDate(today)}`,
    `before:${gmailDate(dayAfterTomorrow)}`,
  ].join(" ");

  try {
    const upstream = await fetch(process.env.PO_GMAIL_SYNC_URL || DEFAULT_FUNCTION_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vietjet-order-secret": poSyncSecret,
      },
      body: JSON.stringify({ mode: "import", includeOnlyCrm: true, maxResults: 100, query }),
    });
    const raw = await upstream.text();
    res.status(upstream.status).setHeader("content-type", upstream.headers.get("content-type") || "application/json");
    res.send(raw || JSON.stringify({ success: upstream.ok, targetServiceDate: tomorrow }));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "VietJet parser cron failed" });
  }
}
