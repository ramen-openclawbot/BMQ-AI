# BMQ MCP (read-only dealer storefront)

`sme_platform/bmq_mcp.py` exposes a small, read-only [Model Context Protocol](https://modelcontextprotocol.io)
surface over the same local warehouse that already serves the owner-only `/v1` routes. It lets a
dealer-facing assistant look up this dealer's prices and prepare an order draft. It **never** inserts,
submits, approves or dispatches an order, and it performs no network I/O.

The earlier Supabase Edge MCP experiment is unrelated and stays unused; this module is the warehouse-side
implementation.

## Enable it

The endpoint is **off by default**. In `sme-data-platform/config/app.yaml`:

```yaml
mcp:
  enabled: false      # set true to mount POST /mcp
  ui_theme: bakery    # bakery | street | minimal (default bakery)
```

Restart the warehouse API for a change to take effect. When `enabled` is false, `POST /mcp` is simply
not mounted (404) and every existing `/v1` route is untouched.

`ui_theme` is the storefront presentation hint returned by every tool as
`provider.ui_theme`; `provider.name` is always `Bánh Mì Que`. An invalid or missing value falls back
to `bakery`.

## Endpoint and authentication

* `POST /mcp`, JSON-RPC 2.0 over MCP Streamable HTTP, protocol version `2025-06-18`.
* Authenticated **only** by `Authorization: Bearer <dealer MCP key>`.
  Missing, malformed, unknown, revoked, or inactive-customer keys return HTTP `401` with JSON-RPC
  error `-32001`.
* Dealer keys never authenticate or elevate any owner-only `/v1` route.
* The request body is limited to 64 KiB. Responses carry `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff`.

Supported methods: `initialize`, `notifications/initialized` (HTTP 202, empty body), `ping`,
`tools/list`, `tools/call`.

## Dealer keys (CLI)

Keys live in a local SQLite file under the data root (`<data_root>/mcp/keys.sqlite3`). That store is
**never synced** to Supabase and is not part of the replicated bronze data. Only the SHA-256 digest of a
key is stored; the plaintext key (prefix `bmq_live_`) is printed once at creation and cannot be
recovered. Authentication compares digests with a constant-time comparison.

```bash
cd sme-data-platform
PYTHONPATH=src .venv/bin/python -m sme_platform.cli mcp-key create --customer-code KH1 --label "Quầy 1"
PYTHONPATH=src .venv/bin/python -m sme_platform.cli mcp-key list
PYTHONPATH=src .venv/bin/python -m sme_platform.cli mcp-key revoke <id>
```

`mcp-key create` prints the key exactly once. `mcp-key list` never shows key material. `mcp-key revoke`
is idempotent. A key whose customer is no longer `is_active` in `mini_crm_customers` is rejected at
authentication time even if the key itself was never revoked.

## Tools

Every tool result includes:

```json
{ "provider": { "name": "Bánh Mì Que", "ui_theme": "bakery" }, "data_as_of": "<latest sync time>" }
```

| Tool | Arguments | Result |
| --- | --- | --- |
| `search_products` | `query?`, `limit?` (1–50) | This dealer's priced finished goods |
| `get_product` | `sku` | One product, its image and label spec |
| `quote_cart` | `items: [{sku, quantity}]` | Integer-VND line totals and cart total |
| `prepare_order_draft` | `items`, `key` | Draft id, lines, total and a `<vnagent-order>` UI payload |

Rules enforced by the tools:

* Quantities must be positive integer multiples of 10; totals and unit prices are whole VND.
* Unknown SKUs, hidden (`hide_from_dealer_portal`) or non-finished SKUs, and SKUs without a positive
  integer effective price are rejected.
* `prepare_order_draft` is idempotent per `(customer, key)`: repeating the same customer and key returns
  the same deterministic draft id. It returns `submitted: false` / `order_created: false` and writes
  nothing to the warehouse.

## Catalog and pricing

The catalog is read read-only from the latest reconciled bronze snapshot
(`bronze.supabase_current`) for `product_skus`, `mini_crm_customer_price_list`, `product_label_specs`
and `mini_crm_customers`. Prices reuse `bmq_customer.effective_prices`:

* customer-specific active override first, otherwise the current `selling_price`;
* finished goods only, `hide_from_dealer_portal` excluded;
* non-positive prices are excluded.

`image_url` is replicated from `product_skus` (public CDN scalar only) so tools can return product
images.

## Data freshness

`data_as_of` is the latest Supabase sync observation time (`meta_supabase_sync_runs.observed_at`). As
with the owner price lookup, the catalog fails closed: if the newest snapshot belongs to another tenant,
is older than 30 minutes, or is missing any required reconciled source, the request returns an error
rather than stale or partial prices.

## Availability dependency

The warehouse runs on the Mac that owns the BMQ SSD. MCP is available only while that Mac is powered on
and the SSD is mounted and healthy; there is no cloud fallback. If the Mac is asleep or the SSD is
unmounted, the endpoint is unavailable and no data is served.

## Public exposure is a separate step

This change only adds the local `POST /mcp` route and its key store. Publishing it at
`mcp.banhmique.vn` requires a separately reviewed TLS relay/tunnel and DNS change, and is **not** part
of this step.
