import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || '3000');
const RELAY_SECRET = process.env.RELAY_SECRET || '';
const ALLOWED_ENDPOINT_HOSTS = new Set((process.env.ALLOWED_ENDPOINT_HOSTS || 'api-v2.vietguys.biz').split(',').map((s) => s.trim()).filter(Boolean));
const DEFAULT_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || '15000');
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || '65536');
const MAX_SKEW_SECONDS = Number(process.env.MAX_SKEW_SECONDS || '300');

function jsonResponse(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function safeLog(level, message, meta = {}) {
  const sanitized = { ...meta };
  for (const key of Object.keys(sanitized)) {
    if (/token|secret|signature|otp|access/i.test(key)) sanitized[key] = '[redacted]';
  }
  console[level](JSON.stringify({ ts: new Date().toISOString(), message, ...sanitized }));
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (aa.length === 0 || aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function verifySignature(req, rawBody) {
  if (!RELAY_SECRET) return { ok: false, error: 'relay_not_configured' };
  const timestamp = req.headers['x-bmq-relay-timestamp'];
  const signature = req.headers['x-bmq-relay-signature'];
  if (!timestamp || !signature) return { ok: false, error: 'missing_signature' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, error: 'invalid_timestamp' };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) return { ok: false, error: 'stale_signature' };
  const expected = crypto.createHmac('sha256', RELAY_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
  if (!timingSafeEqualHex(String(signature), expected)) return { ok: false, error: 'invalid_signature' };
  return { ok: true };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleSend(req, res) {
  let rawBody = '';
  try {
    rawBody = await readBody(req);
  } catch (error) {
    return jsonResponse(res, error.status || 400, { error: error.message || 'invalid_body' });
  }

  const sig = verifySignature(req, rawBody);
  if (!sig.ok) {
    safeLog('warn', 'rejected request', { reason: sig.error, ip: req.socket.remoteAddress });
    return jsonResponse(res, 401, { error: sig.error });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse(res, 400, { error: 'invalid_json' });
  }

  const endpoint = String(body.endpoint || 'https://api-v2.vietguys.biz:4438/zalo/v4/send');
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return jsonResponse(res, 400, { error: 'invalid_endpoint' });
  }
  if (url.protocol !== 'https:' || !ALLOWED_ENDPOINT_HOSTS.has(url.hostname)) {
    return jsonResponse(res, 400, { error: 'endpoint_not_allowed' });
  }

  const accessToken = String(body.accessToken || '');
  const providerPayload = body.payload;
  if (!accessToken || !providerPayload || typeof providerPayload !== 'object') {
    return jsonResponse(res, 400, { error: 'missing_provider_payload' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const start = Date.now();
  try {
    const providerResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(providerPayload),
      signal: controller.signal,
    });
    const text = await providerResponse.text();
    const contentType = providerResponse.headers.get('content-type') || 'application/json; charset=utf-8';
    safeLog('info', 'provider response', {
      status: providerResponse.status,
      ok: providerResponse.ok,
      ms: Date.now() - start,
      tracking_id: providerPayload.tracking_id,
    });
    res.writeHead(providerResponse.status, {
      'content-type': contentType,
      'cache-control': 'no-store',
    });
    res.end(text);
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    safeLog('error', 'provider request failed', { aborted, ms: Date.now() - start, tracking_id: providerPayload.tracking_id });
    jsonResponse(res, aborted ? 504 : 502, { error: aborted ? 'provider_timeout' : 'provider_request_failed' });
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return jsonResponse(res, RELAY_SECRET ? 200 : 503, { ok: Boolean(RELAY_SECRET), service: 'bmq-otp-relay' });
  }
  if (req.method === 'POST' && req.url === '/send') {
    return handleSend(req, res);
  }
  jsonResponse(res, 404, { error: 'not_found' });
});

server.listen(PORT, '0.0.0.0', () => {
  safeLog('info', 'relay listening', { port: PORT });
});
