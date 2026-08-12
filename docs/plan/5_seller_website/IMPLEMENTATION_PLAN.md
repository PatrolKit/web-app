# PatrolKit — Seller Website (Phase 5)

> **Status:** Draft v1. Prerequisite: Phase 2 (Ski Swap) is complete.

---

## 1. Overview & Goals

Phase 5 adds a **public, seller-facing website** that lets sellers check the status of their
consignment items without a PatrolKit account. There are two entry points:

1. **Seller page** — `skiswap.patrolkit.com/s/:sellerId`  
   Shows all items the seller has across every active swap for their org.

2. **Org lookup page** — `skiswap.patrolkit.com/:orgSlug`  
   Sellers enter their **email address** and **last 4 digits of their phone number** to find
   their account and be redirected to their seller page.

Staff print a QR code for a seller's personal URL from the **Sellers tab** of the Ski Swap page
using the existing Phomemo thermal printer.

### In scope
- Two new public web pages (no authentication required).
- `GET /api/v1/public/sellers/:sellerId` — seller detail + active-swap items by seller ID.
- `GET /api/v1/public/:orgSlug/ski-swap/seller-find` — email + last-4 phone → seller ID.
- A "Print QR" action button per row in the Sellers tab; prints a Phomemo thermal label.
- `VITE_SELLER_SITE_URL` env var controlling the base URL baked into QR codes.
- `Organization.logoUrl` (nullable) — displayed on seller pages.
- Production deployment via `skiswap.patrolkit.com` (same server and SPA build as `patrolkit.io`).

### Out of scope
- Seller authentication or self-service item editing.
- Email/SMS delivery of seller URLs.
- Live Square inventory counts (DB-only data keeps the endpoint fast and credential-free).
- Admin UI to set `logoUrl` (set directly in the DB for now).

---

## 2. URL & Routing Design

### 2.1 Public URL space

| URL | Purpose |
|---|---|
| `skiswap.patrolkit.com/:orgSlug` | Org lookup form (email + last-4 phone) |
| `skiswap.patrolkit.com/s/:sellerId` | Seller item-status page |

Both routes are handled by the existing SPA — no separate build artifact. In development they
are reachable at `http://localhost:3000` using the same paths.

### 2.2 API endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/public/sellers/:sellerId` | None | Seller detail + active-swap items |
| `GET` | `/api/v1/public/:orgSlug/ski-swap/seller-find` | None | Lookup seller ID by email + last-4 phone |

Both endpoints carry `@Throttle({ default: { ttl: 60_000, limit: 20 } })`, matching the
existing `PublicLookupController`.

### 2.3 Seller ID

`SwapSeller.id` is a cuid and serves as the URL identifier. No new field is needed.

---

## 3. Data Model Changes

Add `logoUrl` to `Organization`:

```prisma
model Organization {
  // … existing fields …
  logoUrl String? // publicly accessible URL; null falls back to text org name
}
```

One migration required; existing rows default to `null`. Expose `logoUrl` in `OrgResponseSchema`
and the `GET /api/v1/orgs/:id` response.

No other schema changes are needed for Phase 5.

---

## 4. API Changes

### 4.1 Seller detail endpoint (`/api/v1/public/sellers/:sellerId`)

**Request**
```
GET /api/v1/public/sellers/clxyz123
```

**Response (200)**
```jsonc
{
  "success": true,
  "data": {
    "sellerName": "Jane Smith",
    "orgName": "Mountain Ski Patrol",
    "orgLogoUrl": "https://example.com/logo.png",
    "swaps": [
      {
        "swapId": "clswap1",
        "swapTitle": "2025 Ski Swap",
        "items": [
          {
            "itemId": "clitem1",
            "name": "K2 Skis 170cm",
            "priceCents": 8000,
            "sku": "SS25-001",
            "originalQuantity": 1,
            "inStock": 0,
            "soldCount": 1,
            "donateProceeds": false
          }
        ]
      }
    ]
  }
}
```

Items are grouped by active swap; swaps where this seller has no items are omitted.
`inStock` and `soldCount` are computed from DB state only — no Square call is made.

**Errors**
- `404` — seller ID not found, or org does not have `ski_swap` module enabled.

### 4.2 Seller find endpoint (`/api/v1/public/:orgSlug/ski-swap/seller-find`)

**Request**
```
GET /api/v1/public/mountain-patrol/ski-swap/seller-find?email=jane@example.com&last4=4567
```

**Response (200)**
```jsonc
{ "success": true, "data": { "sellerId": "clxyz123" } }
```

**Matching logic**
1. Look up org by slug; 404 if not found or `ski_swap` not enabled.
2. Find `SwapSeller` where `orgId = org.id`, email matches (case-insensitive), and the last 4
   digits of `normalizePhone(phone)` match `last4`.
3. Return `404 { "success": false, "error": "No seller found." }` on any mismatch — the same
   response regardless of which field was wrong.
4. Return `400` if either query param is absent.

---

## 5. Web App Changes

### 5.1 New routes in `App.tsx`

```tsx
<Route path="s/:sellerId" element={<SellerItemsPage />} />
<Route path=":orgSlug" element={<OrgSellerLookupPage />} />
```

Added before the catch-all `*` redirect. The `:orgSlug` pattern is broad; it must be placed
after all specific top-level routes (`auth/`, `dashboard/`) to avoid shadowing them.

### 5.2 `SellerItemsPage` (`/s/:sellerId`)

- Calls `GET /api/v1/public/sellers/:sellerId`.
- Header: org logo (when `orgLogoUrl` is set) + org name. Falls back to text org name when null.
- Body: seller name, then for each active swap — swap title and an item table with columns
  `Name`, `SKU`, `Price`, `Status` (In Stock / Sold).
- Loading skeleton while the request is in flight; user-friendly error on 404 or network failure;
  empty state when the seller has no items in active swaps.
- No authentication. No links to the admin app.
- Mobile-first layout using existing Tailwind tokens.

### 5.3 `OrgSellerLookupPage` (`/:orgSlug`)

- Form: **Email** (type=email, required) and **Last 4 digits of phone** (type=text, maxLength=4,
  pattern=`\d{4}`, required).
- On 200: `navigate('/s/' + data.sellerId, { replace: true })`.
- On 404: "We couldn't find a seller matching that email and phone."
- On 429: "Too many attempts. Please try again in a moment."
- Submit button disabled while the request is in flight.
- Layout matches `SellerItemsPage`.

### 5.4 QR code print button in `SellersPage`

A **Print QR** icon button is added to each seller row's action column (visible to
`ski_swap:admin` users, matching the existing edit/delete visibility pattern).

1. Clicking opens `SellerQrModal`.
2. The modal renders the seller URL as a QR code on a `<canvas>` using the `qrcode` npm package.
3. **Print Label** sends the label to the connected Phomemo printer via `PrinterContext`. The
   button is disabled with a tooltip ("Connect a printer first") when no printer is connected.

**Seller URL**
```ts
const SELLER_SITE_URL = import.meta.env.VITE_SELLER_SITE_URL ?? 'http://localhost:3000';
const sellerUrl = `${SELLER_SITE_URL}/s/${seller.id}`;
```

**Label layout (40×30 mm, 320×224 dots)**
```
Rows   8–180 : QR code, centred (~172×172 dots)
Rows 188–220 : Seller name, regular 13pt, centred
```

The QR code is rendered to an offscreen canvas, drawn into the label canvas, then converted to
`boolean[][]` raster using the existing `renderLabelToRaster` utility.

---

## 6. Environment Variables

| Variable | Dev default | Prod value |
|---|---|---|
| `VITE_SELLER_SITE_URL` | `http://localhost:3000` | `https://skiswap.patrolkit.com` |

Baked into the SPA at build time. Document in `apps/web/.env.example`. Set in the CI/CD
pipeline for production builds; the `.env` file is gitignored.

---

## 7. Production Subdomain Setup

**DNS** — Add a CNAME (or A record) for `skiswap.patrolkit.com` pointing to the same EC2
instance or load balancer as `patrolkit.io`.

**TLS** — Issue a certificate covering `skiswap.patrolkit.com` via ACM (or expand an existing
wildcard).

**Routing** — `ServeStaticModule` already serves the SPA for all non-`/api` paths, so no server
code changes are needed. If nginx or ALB terminates TLS, add `skiswap.patrolkit.com` as an
additional `server_name` proxying to the same upstream.

---

## 8. Security Considerations

- Both public endpoints must be rate-limited with `@Throttle({ default: { ttl: 60_000, limit: 20 } })`.
- The seller-find endpoint returns the same 404 body regardless of which field failed to match.
- Public endpoints expose only: seller name, org name, org logo URL, swap titles, item names,
  SKUs, prices, and quantities. No contact info, addresses, or payout data.

---

## 9. Testing

**Integration tests**
- `PublicSellerService.getById` — found, not found, disabled module.
- `PublicSellerService.findByEmailAndLast4` — match, no match, wrong last-4, disabled module, missing params.
- New controller routes return correct response shapes.

**Manual acceptance checklist**
- [ ] `GET /api/v1/public/sellers/:id` filters to active swaps only and matches the response schema.
- [ ] `GET /api/v1/public/:orgSlug/ski-swap/seller-find` returns `sellerId` on match; 404 on any mismatch.
- [ ] Seller items page renders correctly; shows empty state when no items; shows error on 404.
- [ ] Org lookup page redirects on match and shows inline error on mismatch.
- [ ] Print QR modal renders the correct URL in the QR code.
- [ ] Phomemo label print sends a valid raster job.
- [ ] Org logo renders when set; falls back to text org name when null.
- [ ] `VITE_SELLER_SITE_URL` is correctly embedded in printed QR codes.
