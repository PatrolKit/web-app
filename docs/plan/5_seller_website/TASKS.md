# PatrolKit — Seller Website Task Breakdown (Phase 5)

> Tasks are ordered by dependency. Implement one at a time; do not start a task until all
> tasks in its **Depends on** list are marked ✅.

---

## Task SW-0 — DB: Add `logoUrl` to Organization

**Summary:** Add a nullable `logoUrl` field to the `Organization` model and expose it through
the existing org contracts and the new public seller endpoint.

**Files to create / modify**
- `apps/api/prisma/schema.prisma` — add `logoUrl String?` to `Organization`
- `apps/api/prisma/migrations/` — generate migration (`prisma migrate dev --name add_org_logo_url`)
- `apps/api/src/contracts/orgs.contracts.ts` — add `logoUrl: z.string().url().nullable()` to `OrgResponseSchema`
- `apps/api/src/orgs/orgs.service.ts` — include `logoUrl` in org query selects

**Depends on:** nothing

**Acceptance criteria**
- Migration applies cleanly; existing rows default to `null`.
- `GET /api/v1/orgs/:id` response includes `logoUrl` (null for existing orgs).
- No admin UI to set the field is required in this phase — it can be set directly in the DB.

---

## Task SW-1 — API: Public seller detail endpoint

**Summary:** Add a new public endpoint that returns a seller's info and items grouped by active
swap, looked up by seller ID.

**Files to create / modify**
- `apps/api/src/ski-swap/public-seller.service.ts` (new)
- `apps/api/src/ski-swap/public-seller.controller.ts` (new)
- `apps/api/src/contracts/ski-swap.contracts.ts` — add `PublicSellerDetailResponse` schema
- `apps/api/src/ski-swap/ski-swap.module.ts` — register new service + controller

**Depends on:** nothing (Phase 2 complete)

**Acceptance criteria**
- `GET /api/v1/public/sellers/:sellerId` returns `{ sellerName, orgName, orgLogoUrl, swaps: [{ swapId, swapTitle, items: [...] }] }`.
- `orgLogoUrl` is `null` when the org has no logo set.
- Only items in **active** swaps are returned; swaps with no items for this seller are omitted.
- Returns 404 if seller ID does not exist.
- Returns 404 if the seller's org does not have `ski_swap` module enabled.
- `inStock` is computed as `originalQuantity` minus Square-synced sold count **from the DB only** (no live Square call).
- No payout fields, contact info, or address fields are included in the response.
- Endpoint is decorated with `@Throttle({ default: { ttl: 60_000, limit: 20 } })`.
- Integration test covers: found seller, not found, disabled module.

---

## Task SW-2 — API: Seller find-by-email+last4 endpoint

**Summary:** Extend the existing `PublicLookupController` with a new endpoint that accepts
email + last 4 digits of phone and returns the matching seller's ID.

**Files to modify**
- `apps/api/src/ski-swap/public-lookup.controller.ts` — add `GET seller-find` route
- `apps/api/src/ski-swap/public-lookup.service.ts` — add `findByEmailAndLast4` method
- `apps/api/src/contracts/ski-swap.contracts.ts` — add `SellerFindResponse` schema

**Depends on:** nothing

**Acceptance criteria**
- `GET /api/v1/public/:orgSlug/ski-swap/seller-find?email=...&last4=...` returns `{ sellerId }` on match.
- Email matching is case-insensitive.
- `last4` matches the last 4 digits of `normalizePhone(seller.phone)`.
- Returns 404 with `{ success: false, error: "No seller found." }` on any mismatch — same response whether email, last4, or both are wrong.
- Returns 400 if either query param is missing.
- Returns 404 if org slug not found or `ski_swap` not enabled.
- Integration test covers: match, no match, missing params, disabled module.

---

## Task SW-3 — Web: Seller items page (`/s/:sellerId`)

**Summary:** Create a public, mobile-first React page that displays a seller's items across all
active swaps.

**Files to create / modify**
- `apps/web/src/pages/public/SellerItemsPage.tsx` (new)
- `apps/web/src/App.tsx` — add route `<Route path="s/:sellerId" element={<SellerItemsPage />} />`
- `apps/web/src/lib/api.ts` — add `api.public.getSellerDetail(sellerId)` method
- `apps/web/src/lib/api.types.ts` — add `PublicSellerDetailResponse` type

**Depends on:** SW-1

**Acceptance criteria**
- Page loads at `/s/:sellerId` without authentication.
- Header displays org logo (when `orgLogoUrl` is non-null) and org name; falls back to text org name when null.
- Displays seller name and items grouped by swap title.
- Each item row shows: name, SKU, price (formatted as `$X.XX`), status ("In Stock" / "Sold" badge).
- Shows a loading skeleton while the API call is in flight.
- Shows a user-friendly error if the seller is not found (404) or the network fails.
- Shows an empty state message if the seller has no items in active swaps.
- No links to the admin dashboard or any authenticated route.
- Passes basic keyboard-accessibility check (focusable elements, `alt` text where applicable).

---

## Task SW-4 — Web: Org lookup page (`/:orgSlug`)

**Summary:** Create a public lookup page where a seller enters their email and last-4 phone digits
to be redirected to their personal seller items page.

**Files to create / modify**
- `apps/web/src/pages/public/OrgSellerLookupPage.tsx` (new)
- `apps/web/src/App.tsx` — add route `<Route path=":orgSlug" element={<OrgSellerLookupPage />} />`
  placed **after** all explicit top-level routes to avoid shadowing `auth/` or `dashboard/`.
- `apps/web/src/lib/api.ts` — add `api.public.findSeller(orgSlug, email, last4)` method
- `apps/web/src/lib/api.types.ts` — add `SellerFindResponse` type

**Depends on:** SW-2

**Acceptance criteria**
- Page loads at `/:orgSlug` without authentication.
- Form has email field (type=email, required) and last-4-phone field (type=text, maxLength=4,
  pattern=`\d{4}`, required).
- On success: React Router `navigate('/s/' + sellerId, { replace: true })`.
- On 404: shows "We couldn't find a seller matching that email and phone." inline.
- On 429: shows "Too many attempts. Please try again in a moment." inline.
- Submit button is disabled while the request is in flight.
- Layout matches `SellerItemsPage` branding (PatrolKit logo, dark theme, same Tailwind tokens).

---

## Task SW-5 — Web: QR code print button in Sellers tab

**Summary:** Add a "Print QR" action per seller row in `SellersPage`. Render the seller URL as a
QR code on a Phomemo thermal label.

**New dependency**
```bash
pnpm --filter web add qrcode
pnpm --filter web add -D @types/qrcode
```

**Files to create / modify**
- `apps/web/src/pages/ski-swap/SellerQrModal.tsx` (new)
- `apps/web/src/pages/ski-swap/SellersPage.tsx` — add Print QR button per row + import modal
- `apps/web/src/lib/printing/PhomemoPrinterService.ts` — add `generateQrLabel(sellerName, qrDataUrl, paperSize, margins)` function

**Seller URL construction**

Import `SELLER_SITE_URL` from the shared util created in SW-6:
```ts
import { SELLER_SITE_URL } from '../../lib/sellerSiteUrl';
const sellerUrl = `${SELLER_SITE_URL}/s/${seller.id}`;
```

**QR label layout (320 wide, paper-height tall, at 8 dots/mm)**
- Rows 8–180: QR code, centred horizontally (~172 × 172 dots).
- Rows 188–220: Seller name, regular 13 pt, centred.

**Depends on:** SW-3, SW-6

**Acceptance criteria**
- A print icon button appears in each seller row (visible to `ski_swap:admin` users only,
  matching the existing edit/delete button visibility pattern).
- Clicking it opens `SellerQrModal` with the seller's name and a rendered QR code.
- The QR code encodes the correct seller URL (`VITE_SELLER_SITE_URL/s/:sellerId`).
- A "Print Label" button is shown. If a printer is connected in `PrinterContext`, clicking it
  generates the raster and calls `printer.print(rows)`. If no printer is connected the button is
  disabled with a tooltip: "Connect a printer first".
- `window.print()` is never called.
- Modal closes cleanly; no memory leaks from the canvas or QR library.

---

## Task SW-6 — Config & environment wiring

**Summary:** Document and wire up the `VITE_SELLER_SITE_URL` env var and confirm the production
subdomain routing strategy requires no code changes.

**Files to create / modify**
- `apps/web/.env.example` — add `VITE_SELLER_SITE_URL=http://localhost:3000`
- `apps/web/src/lib/sellerSiteUrl.ts` (new, single-line util):
  ```ts
  export const SELLER_SITE_URL =
    import.meta.env.VITE_SELLER_SITE_URL ?? 'http://localhost:3000';
  ```
  Import from here in `SellerQrModal` and anywhere else the URL is needed.

**Depends on:** nothing (can be done in parallel with any other task)

**Acceptance criteria**
- `apps/web/.env.example` documents the new variable with a comment explaining its purpose.
- Setting `VITE_SELLER_SITE_URL=https://skiswap.patrolkit.com` in the build environment
  causes QR codes to encode the production URL.
- A brief note in `apps/api/README.md` (or the existing docs) explains that
  `skiswap.patrolkit.com` should point to the same server as `patrolkit.io` and that no API
  or SPA code changes are needed for subdomain routing.

---

## Definition of Done (all tasks)

- [ ] `pnpm -r build` passes with no errors.
- [ ] `pnpm -r lint` passes with no warnings introduced by this phase.
- [ ] `pnpm -r test` passes (unit + integration).
- [ ] All acceptance criteria above are checked.
- [ ] No raw tokens, credentials, or payout data exposed in any public endpoint response.
- [ ] No leftover `TODO` comments in committed code.
