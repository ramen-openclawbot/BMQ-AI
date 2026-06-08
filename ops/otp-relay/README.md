# BMQ OTP Relay

Small HMAC-protected relay for BMQ dealer OTP delivery through VietGuys from a static outbound IP.

Production path:

```txt
Supabase Edge Function dealer-auth-start
  -> https://otp-relay.vnagent.ai/send
    -> https://api-v2.vietguys.biz:4438/zalo/v4/send
```

## Runtime files

The live instance is deployed at `/opt/bmq-otp-relay` on the static-IP server.

Required `.env` values, never commit actual secrets:

```env
RELAY_SECRET=<same value as Supabase DEALER_OTP_RELAY_SECRET>
ALLOWED_ENDPOINT_HOSTS=api-v2.vietguys.biz
PROVIDER_TIMEOUT_MS=15000
```

## Deploy/update

```bash
sudo mkdir -p /opt/bmq-otp-relay
sudo rsync -a ops/otp-relay/ /opt/bmq-otp-relay/
cd /opt/bmq-otp-relay
# create/update .env with RELAY_SECRET first
chmod 600 .env
docker compose build relay
docker compose up -d
```

## Supabase secrets

```bash
DEALER_OTP_RELAY_URL=https://otp-relay.vnagent.ai/send
DEALER_OTP_RELAY_SECRET=<same as RELAY_SECRET>
```

## DNS/TLS

Preferred production path is Cloudflare Tunnel, because the router currently owns public `80/443`.

Cloudflare Zero Trust setup:

1. Create a tunnel for this server.
2. Add public hostname:
   - Hostname: `otp-relay.vnagent.ai`
   - Service: `http://relay:3000`
3. Copy the Docker tunnel token.
4. Add it to `/opt/bmq-otp-relay/.env` as `CLOUDFLARED_TOKEN=...` without printing it.
5. Start the connector:

```bash
/opt/bmq-otp-relay/start-tunnel.sh
```

Then verify:

```bash
curl https://otp-relay.vnagent.ai/health
```

Caddy is retained as an optional profile for direct DNS + port-forward deployments only:

```bash
docker compose --profile caddy up -d caddy
```

Current intended VietGuys whitelist/public outbound IP: `14.161.32.215`.
