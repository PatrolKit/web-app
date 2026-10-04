# Plan 33: Swap settings dialog, public status pages, and who may sign in

## Goal

- **Settings dialog.** A swap's settings move out of the inline form into a
  tabbed dialog: General, Tickets, Status Page.
- **Slug.** Each swap gets a short, unique, editable slug for its public
  address.
- **Status Page toggles.** The Status Page tab holds three per-swap switches:
  - **Unauthenticated SKU Lookup:** a new page at
    `skiswap.patrolkit.io/<org>/<swap slug>/status`, where anyone can enter one
    SKU and see that item's status.
  - **Unauthenticated Seller Status:** the existing email and last-4 lookup,
    and the seller page it leads to.
  - **Authenticated Seller Status:** whether an individual seller may sign in to
    patrolkit.io and see their items. A seller whose swaps all have it off
    can't sign in; patrolkit.io is then for patrollers, members and shops.

**Out of scope:** receipts. Receipt links, and signing in from a receipt, are
the next plan's. Until then, a receipt's "Track your items" link or QR code may
lead to a page showing nothing. That's accepted.

## Decisions

| # | Decision |
|---|---|
| D1 | **Toggles are per swap and start off,** on new swaps and on existing ones when this ships. Turning one on is a deliberate act on each swap. |
| D2 | **The slug is the SKU prefix's derivation, lowercased, and set once.** "Ski Swap 2026" becomes `ss26`. |
| | • It's unique among all the org's swaps, active or not; a clash gets `-2`, `-3` and so on. |
| | • It matches `^[a-z0-9-]{1,40}$`. |
| | • Renaming the swap doesn't change it. Editing it is allowed, with a warning that the status link changes. |
| | • Existing swaps get one from their current prefix. |
| D3 | **SKU Lookup shows the item's name and status, nothing else.** No price and no seller, since SKUs are sequential and anyone can step through them. It's scoped to one swap, because the same ticket number can exist in two. |
| D4 | **Unauthenticated Seller Status covers the lookup and the page it leads to.** The email and last-4 lookup finds a seller only when they have items in an active swap with it on. `/s/<sellerId>` shows only those swaps and their payouts. |
| D5 | **Who may sign in to patrolkit.io:** |
| | • a super admin; |
| | • a real member of an active org: a patroller, someone with permissions, or someone invited plainly (the Members page's `IS_MEMBER`); |
| | • a shop (a live seller profile with a business name), always, because shops manage their own inventory; |
| | • an individual seller with items in an active swap whose Authenticated Seller Status is on. |
| | Everyone else is refused. An individual's My Items lists only the swaps that allow it; a shop's lists every active swap, as now. |
| D6 | **Check-in sessions are check-in only.** Signing in at a station, from its QR code, works whatever the toggles. That session reaches the check-in flow and nothing else, and lasts one day, not 30. |
| D7 | **Someone refused is treated like an address with no account.** The page says "a link is on its way", as it always does, and no email is sent. Nothing tells someone typing an address that it belongs to a seller. A refused seller gets no explanation, the same as someone who typed the wrong address today. |

## Server

### Schema (migration `…_swap_status_page`)

**`SkiSwap`** gains:
- `slug String`, with `@@unique([orgId, slug])`;
- `skuLookupEnabled`, `sellerLookupEnabled` and `sellerLoginEnabled`, each
  `Boolean @default(false)`.

**`RefreshToken`** gains `scope String @default("full")`, either `full` or
`checkin`.

**Backfilling the slug,** in the same migration:
1. Add the column as nullable.
2. Set it to `LOWER(skuPrefix)`.
3. Suffix clashes using `ROW_NUMBER() OVER (PARTITION BY orgId, slug ORDER BY createdAt)`:
   the later ones get `-2`, `-3`.
4. Make the column `NOT NULL` and add the unique index.

### Slug (`sku.util.ts`, `swap.service.ts`)

- **`deriveSwapSlug(title)`** is `deriveSkuPrefix(title).toLowerCase()`, so
  there's one derivation.
- **`resolveUniqueSlug(orgId, base, excludeId?)`** tries `base`, then `base-2`,
  `base-3`… against every swap in the org. This avoids a flaw in the prefix
  resolver: it slices candidates to 6 characters, so suffixed ones can collapse
  back onto the base.
- **Create** takes an optional `slug`, or derives one.
- **Patch** takes `slug` and checks it's unique; a P2002 becomes a 409 naming
  the swap that has it. A title change leaves it alone.
- **Contracts:**
  - `CreateSwapSchema` and `PatchSwapSchema` gain `slug` and the three toggles.
    `PatchSwapSchema` is `.strict()`, so each must be listed.
  - `SwapResponseSchema` gains all four. The iPad decodes swaps leniently and
    ignores them.

### SKU Lookup (new `public-status.controller.ts` / `.service.ts`)

**Routes,** under `public/:orgSlug/swaps/:swapSlug`. A missing org, missing
swap, toggle off or unknown SKU all answer the same 404, so a closed swap can't
be told apart from a missing one.

| Route | Returns |
|---|---|
| `GET` | `{ orgName, orgLogoUrl, swapTitle }` |
| `GET sku/:sku` | `{ sku, name, status, soldCount?, quantity? }` |

**`status`** is one of:
- **`not_received`:** the item isn't consigned yet.
- **`for_sale` or `sold`:** from Square's inventory for that one variation. An
  item with more than one unit also reports `soldCount` of `quantity`.
- **`unknown`:** Square couldn't be read, or the item isn't in Square yet.

**Finding the item:** an exact SKU match within the swap, which `findBySku`
already does. The response is built for the public. It's never the staff
`ItemResponse`, which carries the seller's name and phone.

**One status helper:** `publicItemStatus(item, inventoryMap)`, in a shared
module. Today the staff list calls an item missing from Square "sold" and the
public seller page calls it "unsold"; this page follows neither.

**Rate limit:** a new limit, `public.skuLookup`, of 30 per minute per IP, on
`sku/:sku` only, to slow anyone stepping through numbers. `public.reads` is
unchanged for the rest.

### Unauthenticated Seller Status (`public-lookup.service.ts`, `public-seller.service.ts`)

- **`findByEmailAndLast4`** matches only a seller with items in an active swap
  whose `sellerLookupEnabled` is on. Anyone else gets the existing "No seller
  found."
- **`getById` (`/s/:sellerId`):**
  - Its swap filter (`:40-42`) also requires `sellerLookupEnabled`.
  - Payouts are limited to those swaps.
  - With no such swap, it returns `available: false`, `sellerName: null` and
    no swaps, rather than a 404. The page can then show a message instead of
    an error, without revealing whether the seller exists.
- **Branding:** `GET public/:orgSlug/ski-swap/branding` gains
  `sellerLookupOpen`: whether any active swap has the lookup on.

### Who may sign in (`auth/`, `common/guards/`)

**`SignInPolicy.mayUseApp(userId)`** applies D5, with one query per kind. It
lives beside `IS_MEMBER` so the two can't drift.

**Where it's enforced:**
- **`AuthService.requestLogin`:** a person the policy refuses gets the same
  decoy an unknown address gets today: a challenge id, with no email or text
  sent (D7). A sign-in with a check-in context is never refused.
- **`AuthService.confirmChallenge`:** checks the policy again for purposes
  `login` and `invite` without a check-in context. This catches a link sent
  while sign-in was open and opened after it closed.
  - A refusal answers `403` with `code: 'SIGN_IN_CLOSED'`, and no session is
    created.
  - The message reads: "Sign-in isn't open for sellers at this swap. To check
    in, scan the swap's check-in QR code."
- **`AuthService.refresh`:**
  - A `full` session is checked against the policy again. Turning the toggle
    off ends existing seller sessions within one access-token lifetime, 15
    minutes.
  - A `checkin` session refreshes as itself until it expires.

**Check-in sessions (D6):**
- **Minting:** `confirmChallenge` with a check-in context mints `scope:
  'checkin'`. The access JWT carries `scope`, the refresh row stores it, and
  the refresh lifetime is one day.
- **Enforcing:** `JwtAuthGuard` puts `scope` on `req.user`. A new
  `CheckinSessionGuard`, run globally after it, refuses a `checkin` session
  except on routes marked `@CheckinSessionAllowed()`. Those are the routes the
  check-in flow calls, checked against every call in
  `apps/web/src/pages/checkin/*`:
  - `checkin/*`;
  - `GET /me`;
  - `seller/me` (profile), `GET` and `PATCH`;
  - `seller/me/items`, `POST` (which already needs a `stationId` for an
    individual);
  - `seller/me/items/:id/reprint`;
  - `seller/me/items/:id/photos` with a `stationId`;
  - `seller/me/receipts/send`;
  - `auth/refresh` and `auth/logout`.
- **`GET /me`** gains `sessionScope`.

**Unchanged:** `OrgContextGuard`, `SellerProfileGuard`, and device tokens. The
iPad doesn't sign in as a person and isn't affected.

### My Items swaps

In `seller-self.service`'s swap list (`:54-62`):
- an individual sees the active swaps with `sellerLoginEnabled`;
- a shop sees every active swap, as now.

## Web

### Swap settings dialog (`SwapsPage.tsx`, new `SwapSettingsModal.tsx`)

**Structure:** one dialog, which replaces the inline form, for both **+ New
Swap** and a row's **Edit**. It reuses existing patterns:
- `ResortFormModal`: a fixed overlay, a save mutation, and `onClose`/`onSaved`;
- `ItemTaxonomyTab`: tab buttons;
- `ItemDescriber`: `role="dialog"`, `aria-modal` and Escape to close.

**General tab:**
- Title and Square location.
- Slug, with the address it makes shown beneath:
  `skiswap.patrolkit.io/<org>/<slug>/status`.
  - On create, the slug fills in from the title as it's typed, until someone
    edits it.
  - On edit, changing it asks for confirmation, as `OrgGeneralPage` does for
    the org slug: "The status page's address changes, and the old one stops
    working."

**Tickets tab** (edit only, as today):
- The nested legacy-ticket settings, unchanged: Accept legacy tickets, then
  Staff Check-In (with helper labels) and Web UI under it.
- Labels per item.

**Status Page tab:** three toggles, each with a one-line description.
- **Unauthenticated SKU Lookup:** "Anyone can enter a SKU and see whether that
  item has sold. Nothing else about it or its seller is shown." When it's on,
  the page's link is shown with a **Copy link** button.
- **Unauthenticated Seller Status:** "Sellers can find their items by email and
  the last 4 digits of their phone, and see everything they're selling here."
- **Authenticated Seller Status:** "Sellers can sign in to PatrolKit and see
  their items. Off, only patrollers, members and shops can sign in."

**Saving:**
- One **Save** sends one `PATCH` with whatever changed.
- A 409 on the slug switches to the General tab and shows there.
- Activate and Deactivate stay as row buttons in the table.

### SKU Lookup page (new `pages/public/SkuStatusPage.tsx`)

- **Route:** `:orgSlug/:swapSlug/status`, on the seller site and, for local
  development, on the staff host. It sits above the `:orgSlug` catch-all.
- **Page:** the org's branding, the swap's title, and one SKU field.
- **Result:** the item's name and its status in words:
  - "Not checked in yet";
  - "For sale";
  - "Sold", or "2 of 3 sold";
  - "We can't check right now. Try again in a minute."
- **Not found and closed look the same:** "No item with that SKU in this swap."
- **Privacy:** the SKU stays in the page's state, never in the address bar or
  history.

### Seller pages

- **`OrgSellerLookupPage`:** when `sellerLookupOpen` is false, says the lookup
  isn't available, rather than offering a form that always fails.
- **`SellerItemsPage`:** with `available: false`, it says "Item status isn't
  available here." It gives no reason, and doesn't reveal whether the seller
  exists.

### Sign-in

- **`VerifyPage`**, where the emailed link lands, and **`LoginPage`'s code
  form:** a `SIGN_IN_CLOSED` refusal shows its message rather than a generic
  error.
- **Check-in sessions:** with `sessionScope: 'checkin'`, `AppShell` shows
  "You're signed in to check in at the swap. Sign in again to use PatrolKit.",
  with a sign-out button, instead of the dashboard.
- **`DefaultDashboardRedirect`** is unchanged. A seller whose swaps all have
  Authenticated Seller Status off never gets a session to arrive with.

## Rollout

1. **Migration:** new columns with defaults, plus the backfilled slug. It's
   additive apart from the slug's unique index, which the backfill satisfies
   first. Ask "migrate in place" at deploy, per the go-live rule.
2. **What changes the moment this deploys,** with every toggle off (D1):
   - Individual sellers can't sign in to patrolkit.io, and their sessions end
     within 15 minutes.
   - The `/<org>` lookup and every `/s/<sellerId>` link show nothing. That
     includes links on receipts and printed QR codes already handed out.
   - Shops, patrollers and members are unaffected. Check-in at a station works
     as before, but its session is check-in only.

   Right after the deploy, turn on whatever BMBWAV's swap should keep. It's one
   save in the dialog.
3. **Verify on production** with a new `smoke-swap-status.mjs`, in the smoke
   org only:
   - **Slug:** derived on create, unique, unchanged by a rename, editable.
   - **SKU Lookup:**
     - off is a 404;
     - on finds a SKU and returns only `name` and `status`;
     - another swap's SKU is a 404;
     - the rate limit applies.
   - **Seller lookup:** off, it finds nobody and `/s/` shows nothing. On, both
     work, limited to that swap.
   - **Sign-in:**
     - an individual seller gets the decoy and no email when the swap's toggle
       is off, and a real link when it's on;
     - a shop and a plainly invited member are always allowed.
   - **Check-in session:** signing in at a station works with everything off.
     That session is refused by a dashboard route such as `GET seller/me/items`
     and allowed on the check-in routes.
4. **Existing smokes that sign in as a seller,** such as
   `smoke-legacy-tickets`'s shop (allowed) and `smoke-checkin` (a check-in
   session): check them, and adjust any where an individual now needs a swap
   with sign-in on.

## Tests

- **Slug:** the derivation, the `-2` suffix, unchanged on rename, the format,
  and the 409 on a clash.
- **`publicItemStatus`:** every status, including not in Square and a failed
  read.
- **SKU Lookup service:** the same 404 for toggle off, missing SKU and another
  swap's SKU, and a response holding only the allowed fields.
- **`SignInPolicy`:** each kind in D5, and refusal when all the toggles are off.
- **Sign-in:**
  - `requestLogin` sends nothing to a refused person, and answers exactly as it
    does for an unknown address.
  - `confirmChallenge` refuses a link opened after sign-in closed.
  - `refresh` ends a refused person's session.
  - A check-in context mints a `checkin` session, and refreshing keeps the
    scope.
- **`CheckinSessionGuard`:** allowed and refused routes.
- **Seller lookup and `/s/`:** limited to swaps with the toggle on.
- **Web:**
  - the settings dialog's tabs and single save;
  - the slug filling in from the title until edited;
  - the SKU page's states;
  - the verify page's `SIGN_IN_CLOSED` message.
