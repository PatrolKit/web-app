# PatrolKit — Square Webhooks: Task Breakdown

> Tasks must be completed in order. Each task is one commit.

---

## T6-1 — Schema migration: webhook fields + cachedInventory

**Depends on:** nothing (schema-only)

**Changes:**
- `SquareConfig`: add `squareMerchantId String?`, `webhookSubscriptionId String?`,
  `webhookSignatureKeyEnc String? @db.Text`
- `SwapItem`: add `cachedInventory Int?`, `inventoryCachedAt DateTime?`
- Generate and apply Prisma migration

**Acceptance criteria:**
- `pnpm prisma migrate dev` succeeds
- Existing rows unaffected (all new columns nullable)

---

## T6-2 — SquareCryptoService: add webhook signature verification

**Depends on:** T6-1

**Changes:**
- Add `verifyWebhookSignature(signatureKey: string, notificationUrl: string, rawBody: Buffer,
  header: string): boolean` to `SquareCryptoService`
- Uses `crypto.createHmac('sha256', signatureKey).update(notificationUrl + rawBody).digest('base64')`
  and `crypto.timingSafeEqual` for comparison
- Unit test: valid signature passes, tampered body/wrong key fails

**Acceptance criteria:**
- `pnpm test` passes in `apps/api`

---

## T6-3 — Webhook registration in SquareConfigService

**Depends on:** T6-2

**Changes:**
- Add `SQUARE_WEBHOOK_BASE_URL` to config schema (optional; skip registration when absent)
- Add private `registerWebhook(orgId, client)` method:
  - `GET /v2/merchants/me` → save `squareMerchantId`
  - Delete existing subscription if `webhookSubscriptionId` is set
  - `POST /v2/webhooks/subscriptions` with `eventTypes: ["inventory.count.updated"]`
  - Encrypt signature key, persist all three fields
- Call `registerWebhook` at end of `upsert()` (non-fatal: catch + warn)
- On `remove()`: best-effort `DELETE /v2/webhooks/subscriptions/{id}` before deleting config row
- Update `SquareConfigResponse` contract: add `webhookSubscriptionId: string | null`

**Acceptance criteria:**
- Saving a valid Square token creates a webhook subscription (verified in Square dashboard or
  sandbox logs)
- Deleting the config removes the subscription
- Registration failure does not fail the upsert request

---

## T6-4 — Raw body middleware + WebhooksModule scaffold

**Depends on:** T6-2

**Changes:**
- Enable raw body in `main.ts`: `app.use(json({ verify: (req, _, buf) => { req.rawBody = buf; } }))`
  (or use NestJS `rawBody: true` option)
- Create `apps/api/src/webhooks/` module with:
  - `webhooks.module.ts`
  - `square-webhook.controller.ts` — single `POST /webhooks/square` route, `@Public()` decorator
  - `square-webhook.service.ts` — stub returning `{}`
- Register `WebhooksModule` in `AppModule`
- Route is accessible without JWT auth

**Acceptance criteria:**
- `curl -X POST http://localhost:3000/api/v1/webhooks/square` returns `200 {}`

---

## T6-5 — SquareWebhookGuard + controller wiring

**Depends on:** T6-3, T6-4

**Changes:**
- `SquareWebhookGuard` (`webhooks/square-webhook.guard.ts`):
  - Extract `merchant_id` from parsed body (or raw JSON parse)
  - Look up `SquareConfig` by `squareMerchantId`; return `200` (not `403`) if not found to
    avoid enumeration
  - Decrypt `webhookSignatureKeyEnc`, call `SquareCryptoService.verifyWebhookSignature()`
  - Return `403` on signature mismatch
- Apply guard to the controller route
- Attach resolved `orgId` to the request for the service to read

**Acceptance criteria:**
- Valid Square test event (sent from Square dashboard "Test" button) reaches the service
- Tampered payload or wrong signature returns `403`

---

## T6-6 — inventory.count.updated handler

**Depends on:** T6-5

**Changes:**
- `SquareWebhookService.handleInventoryCountUpdated(orgId, counts)`:
  - Filter for `state === "IN_STOCK"` and matching `location_id` (swap's `locationId`)
  - `prisma.$transaction`: for each matching `squareVariationId`, update `cachedInventory` and
    `inventoryCachedAt`
- Dispatch from controller based on `event.type`
- Log unhandled event types at debug level (no error)

**Acceptance criteria:**
- Firing a test `inventory.count.updated` event with a known variation ID updates
  `SwapItem.cachedInventory` in the DB
- Unknown variation IDs are silently skipped

---

## T6-7 — ItemService: prefer cachedInventory

**Depends on:** T6-6

**Changes:**
- `fetchInventoryMap()`: if all items in the batch have non-null `cachedInventory`, build the map
  from the DB values without calling Square
- If any item lacks a cached value, fetch from Square as before and back-fill `cachedInventory`
  for those items
- `toResponse()`: `inStock` and `soldCount` calculation unchanged (still uses the map)

**Acceptance criteria:**
- After a webhook updates `cachedInventory`, the item list returns the correct `inStock`/`soldCount`
  without a Square API call (verify via Square dashboard "Inventory" showing different count)
- Items with no cached value still fall back to live Square calls

---

## T6-8 — Web UI: "Sold" badge + webhook status

**Depends on:** T6-7

**Changes:**
- `SwapItemsPanel.tsx`: add "SOLD" pill (red, white text) to item rows where
  `item.inStock === 0 && item.soldCount > 0`
- `SquareConfigPage.tsx`:
  - Display `webhookSubscriptionId` status ("Registered" / "Not registered")
  - Show one-time re-save banner when `webhookSubscriptionId` is null (to prompt registration
    post-deploy)

**Acceptance criteria:**
- A fully sold item shows the "SOLD" badge in the Items list
- The Square Config page shows the subscription ID when registered

---

## Definition of Done (all tasks)

- [ ] `pnpm -r build` passes
- [ ] `pnpm -r lint` passes
- [ ] `pnpm -r test` passes (unit tests for crypto + webhook guard)
- [ ] No raw secrets, tokens, or signature keys in logs or API responses
- [ ] Webhook registered and verified end-to-end in Square sandbox
