# PatrolKit — Square Webhooks (Phase 6)

> **Status:** Draft v1. Prerequisite: Phase 2 (Ski Swap) and Phase 5 (Seller Website) are complete.

---

## 1. Overview & Goals

Phase 6 wires Square's webhook system into PatrolKit so the server is **notified in real time**
when an item is sold or returned at the POS. Today, `inStock` and `soldCount` are computed by
calling Square's Inventory API on every list request. After this phase, those values are cached
locally on `SwapItem` and kept current by webhook events, eliminating the live Square round-trip
for list views.

### In scope

- Programmatic webhook subscription registration per org (auto-triggered when Square config is
  saved or updated).
- A single public endpoint `POST /api/v1/webhooks/square` that receives and verifies all
  Square webhook events.
- Handling of `inventory.count.updated` to update a cached inventory field on `SwapItem`.
- Item list/detail API responses use the cached value when available, falling back to a live
  Square call when not.
- A "Sold" badge in the web Items panel for items where `inStock === 0`.

### Out of scope

- Webhooks for catalog changes (`catalog.version.updated`) — item edits are always initiated from
  PatrolKit, so no sync-back is needed.
- OAuth flow — orgs continue to supply their own Square access tokens.
- Webhook delivery retries / dead-letter queue — Square retries automatically for up to 24 hours.
- Push notifications or real-time UI updates (WebSockets) — a page refresh reflects the
  webhook-updated value.

---

## 2. Square Webhook Architecture

### 2.1 Registration model

Square webhook subscriptions are created via `POST /v2/webhooks/subscriptions` using the org's
access token. Each subscription targets a single notification URL and a list of event types.
The response includes a **signature key** used to verify all future deliveries for that
subscription.

Because each org provides their own access token, each org gets their **own** webhook
subscription. All subscriptions point to the same PatrolKit URL; the payload's `merchant_id`
field identifies which org sent the event.

```
Square (Org A)  ──► POST /api/v1/webhooks/square  (merchant_id = A)
Square (Org B)  ──► POST /api/v1/webhooks/square  (merchant_id = B)
```

### 2.2 Signature verification

Square signs each delivery with:

```
HMAC-SHA256(signatureKey, notificationUrl + rawBody)
```

The result is base64-encoded and sent in `x-square-hmacsha256-signature`. Verification must use
the **raw** request body (before any JSON parsing) and the **exact** URL Square was told to call
(scheme + host + path, no trailing slash). NestJS's `RawBodyMiddleware` (enabled via
`bodyParser: false` + `rawBody: true` in `main.ts`) provides `req.rawBody`.

### 2.3 Org lookup by merchant ID

`SquareConfig` will gain a `squareMerchantId` column so an incoming webhook can be routed to the
right org without an access-token decrypt round-trip. The merchant ID is fetched from
`GET /v2/merchants/me` when the Square config is first saved.

### 2.4 Events subscribed

| Square event type          | Trigger                                      |
|----------------------------|----------------------------------------------|
| `inventory.count.updated`  | Any inventory change: sale, return, adjustment |

---

## 3. Data Model Changes

### 3.1 `SquareConfig` — webhook state

```prisma
model SquareConfig {
  // … existing fields …
  squareMerchantId        String?   // cached from GET /v2/merchants/me; used for webhook routing
  webhookSubscriptionId   String?   // Square subscription ID; null before first registration
  webhookSignatureKeyEnc  String?   @db.Text // AES-256-GCM encrypted (same scheme as accessTokenEnc)
}
```

### 3.2 `SwapItem` — cached inventory

```prisma
model SwapItem {
  // … existing fields …
  cachedInventory  Int?      // null until first webhook; updated on inventory.count.updated
  inventoryCachedAt DateTime? // timestamp of the last webhook update
}
```

One Prisma migration covers both model changes.

---

## 4. API Changes

### 4.1 New public endpoint

```
POST /api/v1/webhooks/square
```

- **Auth:** none (public). Verification is done via HMAC signature.
- **Raw body required:** middleware must preserve `req.rawBody`.
- **Response:** always `200 OK` with `{}` — Square considers any non-2xx a delivery failure and
  will retry.
- **Guard:** a dedicated `SquareWebhookGuard` reads the signature header, looks up the org's
  `webhookSignatureKeyEnc`, decrypts it, and calls `SquareCryptoService.verifyWebhookSignature()`.
  Returns `403` on verification failure (not retried by Square).
- Housed in a new `WebhooksModule` (`apps/api/src/webhooks/`).

### 4.2 Modified endpoints — no breaking changes

`GET /api/v1/orgs/:orgId/ski-swap/:swapId/items` and
`GET /api/v1/orgs/:orgId/ski-swap/:swapId/items/:itemId` already return `inStock` and
`soldCount`. Their values will now come from `cachedInventory` when available; the response shape
is unchanged.

### 4.3 Square config upsert — side effects

`PATCH /api/v1/orgs/:orgId/ski-swap/config` (existing) triggers webhook registration after saving
the token. If registration fails, the config save still succeeds (non-fatal) and a warning is
logged; the admin can re-save to retry.

---

## 5. Webhook Registration Flow

Triggered by `SquareConfigService.upsert()`:

```
1. Fetch merchant ID   →  GET /v2/merchants/me
2. Delete old sub      →  DELETE /v2/webhooks/subscriptions/{existingId}  (if exists)
3. Create new sub      →  POST /v2/webhooks/subscriptions
                            notificationUrl: WEBHOOK_BASE_URL + /api/v1/webhooks/square
                            eventTypes: ["inventory.count.updated"]
4. Encrypt sig key     →  SquareCryptoService.encrypt(signatureKey)
5. Persist to DB       →  SquareConfig.update({ squareMerchantId, webhookSubscriptionId,
                                                 webhookSignatureKeyEnc })
```

`WEBHOOK_BASE_URL` is an env var (`SQUARE_WEBHOOK_BASE_URL`), e.g. `https://patrolkit.io` in
production or an ngrok URL during development.

On `SquareConfigService.remove()`:

```
1. Delete sub   →  DELETE /v2/webhooks/subscriptions/{existingId}  (best-effort, non-fatal)
2. Delete config row
```

---

## 6. Webhook Event Handling

### 6.1 `inventory.count.updated` payload (abridged)

```json
{
  "merchant_id": "MLEF5XXXXXXXXX",
  "type": "inventory.count.updated",
  "data": {
    "object": {
      "inventory_counts": [
        {
          "catalog_object_id": "<squareVariationId>",
          "location_id": "<locationId>",
          "quantity": "3",
          "state": "IN_STOCK"
        }
      ]
    }
  }
}
```

### 6.2 Processing logic

```
for each count in inventory_counts:
  if state !== "IN_STOCK" → skip (SOLD, WASTE, etc. are transitions, not final state)
  find SwapItem where squareVariationId = catalog_object_id AND orgId = resolvedOrgId
  if found:
    update SwapItem.cachedInventory = parseInt(quantity)
    update SwapItem.inventoryCachedAt = now()
```

A single `inventory.count.updated` event may contain multiple counts. All are processed in one
DB transaction.

### 6.3 Item response — inventory source priority

`ItemService.fetchInventoryMap()` is updated:

1. If **all** requested items have a non-null `cachedInventory` → return cached values directly
   (no Square call).
2. If **any** item lacks a cached value → fall back to the live Square API call (existing
   behavior) and also back-fill `cachedInventory` for the items that were fetched.

---

## 7. Web UI Changes

### 7.1 Items panel — "Sold" badge

In `SwapItemsPanel.tsx`, item rows that have `inStock === 0 && soldCount > 0` display a
"SOLD" pill badge (red background, white text) next to the item name. No API contract changes —
`inStock` and `soldCount` are already returned by the API.

### 7.2 Square Config page — webhook status

Add a read-only "Webhook Status" section to `SquareConfigPage.tsx` showing:

- **Registered** — subscription ID is present in the config response.
- **Not registered** — prompt the admin to re-save their Square credentials to trigger
  registration.

The `SquareConfigResponse` contract gains two optional fields: `webhookSubscriptionId: string |
null` and `webhookRegisteredAt: string | null` (derived from `updatedAt` when a subscription
exists; no new DB column needed).

---

## 8. Security Considerations

- **Signature key storage:** encrypted with AES-256-GCM via the existing `SquareCryptoService`
  before writing to `SquareConfig.webhookSignatureKeyEnc`. Never logged or returned by any API.
- **Timing-safe comparison:** use `crypto.timingSafeEqual` when comparing the computed HMAC
  against the header value.
- **Body size limit:** Square payloads are small; the existing 10 MB body limit is sufficient.
  The webhook route uses `RawBodyMiddleware` so the raw buffer is available without disabling
  global body parsing.
- **No account enumeration:** returning `200` for all events (including unknown `merchant_id`)
  prevents probing which merchants are registered.
- **Rate limiting:** webhook endpoint is exempt from the user-facing throttle guard but benefits
  from the server's global connection limits.

---

## 9. Environment Variables

| Variable               | Description                                          | Example                         |
|------------------------|------------------------------------------------------|---------------------------------|
| `SQUARE_WEBHOOK_BASE_URL` | Base URL Square will call for webhooks            | `https://patrolkit.io`          |

> Development: use [ngrok](https://ngrok.com) or [localtunnel](https://theboroer.github.io/localtunnel-www/)
> to expose localhost. Set `SQUARE_WEBHOOK_BASE_URL=https://<tunnel>.ngrok.io` locally.

---

## 10. Deployment Notes

- Run `pnpm prisma migrate deploy` at container startup (existing entrypoint already does this).
- The new `SQUARE_WEBHOOK_BASE_URL` env var must be set before the container starts. Without it,
  webhook registration is skipped (log a warning) and the system degrades gracefully to live
  Square inventory calls.
- Existing orgs do **not** get webhooks automatically. Admins must re-save their Square config
  once after this deploy. Add a banner on `SquareConfigPage` informing admins of this.

---

## 11. Out-of-Band Considerations

- **Square sandbox vs production:** the webhook URL must be publicly reachable. Sandbox
  subscriptions and production subscriptions are independent; the `SquareConfig.environment`
  field determines which Square environment the client connects to.
- **Multiple locations:** `inventory.count.updated` is scoped to a specific `location_id`. We
  match against the swap's `locationId` to ignore inventory changes at other locations (e.g., a
  merchant with multiple stores).
