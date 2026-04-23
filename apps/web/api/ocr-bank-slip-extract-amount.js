export const config = {
  api: {
    bodyParser: {
      sizeLimit: '8mb',
    },
  },
};

const TARGET_URL = 'https://pharmaceutical-corporation-development-solved.trycloudflare.com/api/ocr/bank-slip/extract-amount/';

export default async function handler(req, res) {
  try {
    const upstream = await fetch(TARGET_URL, {
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
