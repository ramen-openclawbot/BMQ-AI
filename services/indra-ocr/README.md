# bmq-indra-ocr

Local-only HTTP wrapper around [Indra OCR](https://pypi.org/project/indra-ocr/) for
the BMQ scan functions. The Supabase Edge Function can send a document image or
PDF to this service, get the recognized text back, and ask DeepSeek to extract
structured data from that text instead of from the image.

The service binds `127.0.0.1` only. It is not a public upload endpoint.

## Runtime

- Python 3.12
- `indra-ocr==1.1.2`
- `pytest` (tests only)
- Standard library HTTP server, no web framework

## Install on the owner's Mac

```bash
mkdir -p ~/.local/share/bmq-indra-ocr
python3.12 -m venv ~/.local/share/bmq-indra-ocr/venv
~/.local/share/bmq-indra-ocr/venv/bin/pip install -r requirements.txt
```

Put the environment file at `~/.local/share/bmq-indra-ocr/.env` and lock it down:

```bash
install -m 600 /dev/null ~/.local/share/bmq-indra-ocr/.env
# edit the file, then:
chmod 600 ~/.local/share/bmq-indra-ocr/.env
```

Use `.env.example` as the template. `INDRA_OCR_TOKEN` is required and must be at
least 24 characters; generate it with `openssl rand -hex 32`. Never commit the
real file or token.

Run manually:

```bash
set -a; . ~/.local/share/bmq-indra-ocr/.env; set +a
cd /path/to/repo/services/indra-ocr
~/.local/share/bmq-indra-ocr/venv/bin/python -m bmq_indra_ocr
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `INDRA_OCR_TOKEN` | required | Bearer token, minimum 24 characters |
| `INDRA_OCR_PORT` | `8792` | Listen port on 127.0.0.1 |
| `INDRA_OCR_THREADS` | `4` | Threads passed to `indra_ocr.load` |
| `INDRA_OCR_MAX_BYTES` | `12582912` (12 MiB) | Maximum request body |
| `INDRA_OCR_MAX_QUEUE` | `4` | Requests allowed to wait for the converter |
| `INDRA_OCR_MODEL_DIR` | unset | Optional model directory |

## API

- `GET /healthz` — `200 {"ok": true, "engine": "indra-ocr", "version": "..."}`.
  No auth and no document data.
- `POST /v1/ocr` — requires `Authorization: Bearer <token>`.
  `Content-Type` must be `image/jpeg`, `image/png`, `image/webp` or
  `application/pdf`. `Content-Length` is required and capped by
  `INDRA_OCR_MAX_BYTES`.
  - `401 {"error": "unauthorized"}`
  - `415 {"error": "unsupported_type"}`
  - `411 {"error": "length_required"}`
  - `413 {"error": "too_large"}`
  - `422 {"error": "unreadable"}`
  - `503 {"error": "busy"}` when the waiter queue is full
  - `200 {"engine": "indra-ocr", "version": "...", "ms": 123, "pages": [...]}`
    where each page carries `rotation`, `skew`, `source`, `text`, `markdown`,
    `line_count`, `mean_conf`, `lines[{box, text, conf}]`, `width`, `height`
    and `timings`.

One request gets one conversion. Concurrency is serialized by a lock; extra
requests wait in a bounded queue and get `503 busy` when it is full. Logs contain
only method, path, status, body size and duration — never headers, the token or
document text.

## LaunchAgent example

Save as `~/Library/LaunchAgents/ai.vnagent.bmq-indra-ocr.plist` (replace the
`REPLACE_...` placeholders with the real absolute paths; do not commit the
filled-in plist):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.vnagent.bmq-indra-ocr</string>
  <key>ProgramArguments</key>
  <array>
    <string>REPLACE_WITH_HOME/.local/share/bmq-indra-ocr/venv/bin/python</string>
    <string>-m</string>
    <string>bmq_indra_ocr</string>
  </array>
  <key>WorkingDirectory</key>
  <string>REPLACE_WITH_REPO/services/indra-ocr</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>INDRA_OCR_TOKEN</key><string>REPLACE_WITH_THE_TOKEN_FROM_THE_ENV_FILE</string>
    <key>INDRA_OCR_PORT</key><string>8792</string>
    <key>INDRA_OCR_THREADS</key><string>4</string>
    <key>PYTHONPATH</key><string>REPLACE_WITH_REPO/services/indra-ocr</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>REPLACE_WITH_HOME/.local/share/bmq-indra-ocr/logs/indra-ocr.out.log</string>
  <key>StandardErrorPath</key>
  <string>REPLACE_WITH_HOME/.local/share/bmq-indra-ocr/logs/indra-ocr.err.log</string>
</dict>
</plist>
```

Create `~/.local/share/bmq-indra-ocr/logs` first. Load with
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.vnagent.bmq-indra-ocr.plist`.

## Cloudflare named tunnel

Expose only this local service; never expose the token in a URL.

1. `cloudflared tunnel create bmq-ocr`
2. Add a named-tunnel config (for example `~/.cloudflared/config.yml`):

```yaml
tunnel: bmq-ocr
credentials-file: REPLACE_WITH_HOME/.cloudflared/REPLACE_WITH_TUNNEL_ID.json
ingress:
  - hostname: bmq-ocr.vnagent.ai
    service: http://127.0.0.1:8792
  - service: http_status:404
```

3. `cloudflared tunnel route dns bmq-ocr bmq-ocr.vnagent.ai`
4. `cloudflared tunnel run bmq-ocr`

The Edge Function then sets `INDRA_OCR_URL=https://bmq-ocr.vnagent.ai` and the
same `INDRA_OCR_TOKEN` secret. Cloudflare only proxies traffic; the service still
requires the bearer token on every OCR request.

## Tests

```bash
~/.local/share/bmq-indra-ocr/venv/bin/pip install -r requirements-dev.txt
~/.local/share/bmq-indra-ocr/venv/bin/python -m pytest -q
```

The tests use a fake converter and a real server on port 0; they never load the
model or call the network.

## Model licence

The Indra OCR model weights are distributed under a **modified OpenRAIL-M**
licence. Review that licence before any commercial redistribution or before
serving the model to third parties. The Python package itself is a separate
dependency with its own licence; this repository only wraps it.

## Benchmark

The Edge-side benchmark lives at `apps/web/scripts/bench_scan_text_first.ts`. It
compares the image mode and the Indra text mode on labelled samples:

```bash
cd apps/web
node --experimental-strip-types scripts/bench_scan_text_first.ts \
  --samples /path/to/samples --truth /path/to/truth.json --mode both \
  --out bench-report.json
```
