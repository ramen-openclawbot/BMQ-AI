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

`otp-relay.vnagent.ai` must resolve to the static-IP server or to a Cloudflare tunnel that terminates on this server. Caddy obtains the TLS certificate automatically after DNS resolves.

Current intended VietGuys whitelist/public outbound IP: `14.161.32.215`.
