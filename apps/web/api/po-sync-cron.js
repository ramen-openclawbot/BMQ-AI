const SUPABASE_PROJECT_REF = "cxntbdvfsikwmitapony";
const DEFAULT_FUNCTION_URL = `https://${SUPABASE_PROJECT_REF}.functions.supabase.co/revenue-monthly-parse-preview`;

function readBearerToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length).trim();
}

function parseJsonIfPossible(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function safeReportSummary(upstreamPayload) {
  if (!upstreamPayload || typeof upstreamPayload !== "object" || Array.isArray(upstreamPayload)) return null;
  const postResult = upstreamPayload.postResult || {};
  const postSummary = postResult.summary || postResult || {};
  return {
    action: upstreamPayload.action,
    success: upstreamPayload.success,
    revenueDate: upstreamPayload.revenueDate,
    poReceivedFrom: upstreamPayload.poReceivedFrom,
    poReceivedTo: upstreamPayload.poReceivedTo,
    stagingRunId: upstreamPayload.stagingRunId,
    sourceDocumentId: postResult.sourceDocumentId,
    postedLineCount: postSummary.posted_line_count || postSummary.row_count,
    reviewFlaggedLineCount: postSummary.review_flagged_line_count,
    grossTotal: postSummary.gross_total,
    channels: postSummary.channels,
    trustSemantics: postSummary.trust_semantics,
    temporaryControlledRevenue: postSummary.temporary_controlled_revenue,
  };
}

async function reportComposioRevenueCron(upstreamPayload) {
  const reportUrl = process.env.COMPOSIO_REPORT_URL || process.env.COMPOSIO_WEBHOOK_URL;
  if (!reportUrl) return { configured: false, attempted: false };

  const body = [
    "BMQ temporary controlled revenue auto daily post completed.",
    "Recipient/watch owner: tam@bmq.vn.",
    "This is temporary controlled revenue from PO/email parsing, not trusted month-end audit revenue.",
  ].join(" ");

  try {
    const response = await fetch(reportUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.COMPOSIO_API_KEY ? { Authorization: `Bearer ${process.env.COMPOSIO_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        type: "bmq_revenue_auto_daily_post",
        to: "tam@bmq.vn",
        subject: "BMQ temporary controlled revenue auto daily post",
        body,
        message: body,
        temporary_controlled_revenue: true,
        trust_semantics: "not_trusted_month_end_audit_source",
        summary: safeReportSummary(upstreamPayload),
      }),
    });

    return {
      configured: true,
      attempted: true,
      ok: response.ok,
      status: response.status,
    };
  } catch (error) {
    return {
      configured: true,
      attempted: true,
      ok: false,
      error: error instanceof Error ? error.message : "Unknown Composio report error",
    };
  }
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

  const supabaseCronSecret = process.env.REVENUE_CRON_SECRET || process.env.PO_SYNC_CRON_SECRET;
  if (!supabaseCronSecret) {
    res.status(500).json({ error: "Server misconfigured: REVENUE_CRON_SECRET or PO_SYNC_CRON_SECRET not set" });
    return;
  }

  const targetUrl = process.env.REVENUE_MONTHLY_PARSE_PREVIEW_URL || DEFAULT_FUNCTION_URL;

  try {
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": supabaseCronSecret,
      },
      body: JSON.stringify({ action: "auto_daily_post" }),
    });

    const raw = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "application/json";
    const parsed = parseJsonIfPossible(raw);
    const reporting = upstream.ok
      ? await reportComposioRevenueCron(parsed || { raw })
      : { configured: false, attempted: false };

    res.status(upstream.status);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      res.setHeader("content-type", "application/json");
      res.send(JSON.stringify({ ...parsed, reporting }));
      return;
    }
    res.setHeader("content-type", contentType);
    res.send(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: `Cron proxy failed: ${message}` });
  }
}
