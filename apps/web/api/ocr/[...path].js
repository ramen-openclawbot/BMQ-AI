export const config = {
  api: {
    bodyParser: {
      sizeLimit: '8mb',
    },
  },
};

const DEFAULT_OCR_BACKEND = 'https://pharmaceutical-corporation-development-solved.trycloudflare.com/api/ocr';

function buildTargetUrl(pathSegments = [], query = {}) {
  const base = (process.env.PADDLE_OCR_BACKEND_URL || DEFAULT_OCR_BACKEND).replace(/\/$/, '');
  const suffix = Array.isArray(pathSegments) ? pathSegments.join('/') : String(pathSegments || '');
  const url = new URL(`${base}/${suffix}`.replace(/\/$/, '/') );

  for (const [key, value] of Object.entries(query || {})) {
    if (Array.isArray(value)) {
      value.forEach((v) => url.searchParams.append(key, v));
    } else if (value != null) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

export default async function handler(req, res) {
  const query = { ...(req.query || {}) };
  const path = query.path;
  delete query.path;
  const targetUrl = buildTargetUrl(path, query);

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body || {}),
    });

    const raw = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json';
    res.status(upstream.status);
    res.setHeader('content-type', contentType);
    res.send(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(502).json({ error: `OCR proxy failed: ${message}` });
  }
}
