# Plan 30 — Pre-beta code review of Ski Swap

> **Status:** Findings, 2026-10-01, reviewed ahead of the customer beta
> weekend. Each item names the file and line as the code stood when reviewed,
> so a fix can be scoped from this document alone.
>
> **Fixed the same day** (commits `079ba4e` and `3cdad02`): A2, A3, A4, A5,
> A6, A7, A9, A10, A11, A12, A13, A14, A15, A16. Each of those entries ends
> with a **Fixed** note saying what was done. Line numbers in the entry body
> describe the code before the fix.
>
> **Still open:** A1 (check the swap prefix length), A8, everything in B, C
> and D.
>
> A rule that came out of A7: payout lines are what a seller is paid, and are
> not to be read as evidence of anything else — not sales, not stock. Square
> is the source for both.

## How this was done

Five parallel reviewers each took one slice of the module and read it in full:
items/swaps/SKU/Square sync; check-in/sellers/public pages/receipts/auth;
printing/stations/scanners/bridges; payouts/PayPal/Square orders; and the web
frontend. Every finding ranked "blocker" or "likely this weekend" below was
then re-verified by hand against the source, and the two Square claims were
checked against the SDK typings in `node_modules/square`.

Alongside the reading:

- `jest` in `apps/api`: 68 suites, 738 tests, all pass.
- `tsc` in both apps: clean.
- `vitest` in `apps/web`: 4 files, 55 tests, all pass.
- `pnpm lint`: one web error (unused `isPrintingId` in `PrintersPage.tsx:65`,
  fixed in `079ba4e`), one pre-existing API error (`let` for `const` in
  `label-templates.ts:841`), four warnings.
- Production probes: `patrolkit.io` and `skiswap.patrolkit.io` both serve;
  `/public/features` reports `sms: false`.
- DNS: SPF for `patrolkit.io` is `include:spf.improvmx.com ~all` only; there is
  no `_dmarc` record.

## What checked out

Worth saying first, because it is most of the module:

- Rate limiting is keyed per account or device once signed in, and the front
  door limits were sized for a venue NAT (Plan 26). `trust proxy` is set to
  `loopback`, so Caddy's forwarding header is believed and nothing else is.
- Print queue claim is a single atomic `UPDATE … LIMIT n` with a per-claim
  token; the expired-claim sweep and `notAfter` expiry are correct;
  `hasPrintedTag` is set on printer ack only, as the runbook says.
- Org isolation holds on every seller-self route (`requireOwnership`), on
  ack/nack/raster (through `station.bridgeDeviceId`), on scans (token org),
  and on helper labels.
- Receipts: denormalised snapshot, deduped by line set, a delivery row written
  even on throw, channel resolved only through verified contacts, and the
  SMS-off paths match their specs.
- `createAtStation`: SKU minted and `liveSku` unique at insert, tags queued
  only after the row exists, `consignedAt` read once at creation.
- Phone normalisation is E.164 everywhere it matters; emails are lowercased at
  the DTO.
- Taxonomy `resolveAnswers` validates reachability, ranges, and free entry.
- UI ↔ contract field names and enums match for check-in, seller self-update,
  item create, payout run calls, and label rendering. UI permission gating
  matches the controllers. Every check-in and payout button is guarded against
  double-submit.
- Routing: every page is reachable; public routes sit outside `AppShell` on
  both hosts; the magic link → `VerifyPage` → `/checkin?swap&station` handoff
  is consistent.

---

## A. Fix before the doors open

Ranked by how many people hit it and how badly.

### A1. 13-character SKUs print an unscannable barcode on 50×30 tags
`apps/api/src/ski-swap/printing/label-templates.ts:266-272`,
`apps/api/src/ski-swap/sku.util.ts:44-50,66-67`

The compact tag draws Code 128 at 2 dots per module and silently skips any
module outside the content box. The compact content box is
400 − marginRight 28 − branding 29 − gap 4 = **339 dots**. A 13-character SKU
is 11 + 13×11 + 11 + 13 = 178 modules = **356 dots**, so the Start-B and Stop
patterns are dropped. 12 characters (334 dots) fits. `MAX_SKU_LENGTH = 13` and
the comment "the most that fits" are wrong for the compact tier, and the golden
fixture `item-tag-max-sku` pins the clipped output rather than catching it.

**Scenario:** `deriveSkuPrefix` yields 6 characters for many titles
("Big Mountain Ski Swap 2026" → `BMSS26`), and `resolveUniquePrefix`
(`swap.service.ts:257-266`) appends a letter to a 5-character prefix on
collision. Either way every station-minted SKU is `PREFIX-C-NNNN` = 13
characters and every tag printed this weekend fails to scan at the register.
62×100 stock is unaffected (it scales `moduleW` down).

**Do now:** check the customer's swap `skuPrefix`. Five characters or fewer is
safe on 50×30. Fix: either lower `MAX_SKU_LENGTH` and cap the prefix at 5, or
drop to 1 dot per module when the payload exceeds the box.

### A2. "Not you?" leaves the previous seller's check-in state behind
`apps/web/src/pages/checkin/CheckinPage.tsx:30-45,60-72`,
`apps/web/src/pages/checkin/shared.tsx:76-92`

`logout()` clears `user` only. `joined`, `address`, `payoutDone`,
`namedThisSession`, and `finished` stay in `CheckinPage` state, and the join
effect early-returns because `joined` is truthy, so the new user never gets a
membership or seller profile.

**Scenario:** Person A finishes, taps "Not you?", Person B (same household
phone) signs in → B lands on A's "You're checked in" screen or on ItemsStep
with address and payout skipped; "Add item" fails 403 (`SellerProfileGuard`,
B has no profile); "I'm done" is refused with "We still need your address". No
way back except a hard reload. Fix: reset all check-in state on logout, or key
the state on `user.id`.

**Fixed** in `079ba4e`. `CheckinPage` now renders the signed-in flow as a child component keyed on `user.id`, so a change of person is a fresh component with none of the previous seller's state.

### A3. Concurrent consign creates duplicate Square catalog items
`apps/api/src/ski-swap/item.service.ts:941-949` (`consign`), `:894`
(`pushConsignedBatch`)

`consign` is read → unconditional update → push. Nothing is conditional on
`consignedAt IS NULL`, and `syncItemToPos` decides create-vs-update from the
`squareItemId` read at the start.

**Scenario:** a scanner double-reads a barcode; two near-simultaneous POSTs
both see `consignedAt === null`, both update, both push with no `posItemId` →
Square creates two `#item` objects, each with inventory 1 and the same SKU.
The DB keeps whichever write finished last; the other is an orphan in Square
and the register can sell the item twice. Same race between two volunteers
pressing "Accept all", and between check-in finish's push and a staff re-push.
`consignment.spec.ts` only tests sequential double-scan.

Fix: `updateMany({ where: { id, consignedAt: null } })` and push only when
`count === 1`; re-read `squareItemId` inside the push under a row lock.

**Fixed** in `079ba4e`. `consign` stamps with `updateMany({ where: { id, consignedAt: null } })` and pushes only when `count === 1`; `consignAllForSeller` does the same one row at a time and pushes only the rows it won. `syncItemToPos` serialises pushes per item behind an in-process lock and re-reads the Square ids inside it, so a finish and a staff re-push cannot both create.

### A4. Any Square inventory read failure shows every item as "Sold"
`apps/api/src/ski-swap/item.service.ts:1049,1064`,
`apps/api/src/ski-swap/stats.service.ts:40-47`

Inventory fetch failure is swallowed to an empty map; `toResponse` then
computes `inStock = 0`, `soldCount = originalQuantity`, with
`squareSynced: true`. The web status cell (`SwapItemsPanel.tsx:238-249`) shows
"Sold" for every synced item and the dashboard sums `sold × priceCents` for
the whole swap. "Unknown" is indistinguishable from "0".

Two related permanent cases:

- **Item deleted in the Square dashboard**
  (`pos/square.pos.adapter.ts:91-92`): when `posItemId` is set,
  `catalog.object.get` runs outside the recovery `catch`; a 404 throws →
  `syncItemToPos` returns `failed` forever; the "re-push" button cannot recover
  because it always tries the get first; and because `squareItemId` is still
  set the item renders "Sold". Also hit when an org switches sandbox →
  production (every stored Square id dangles). Fix: on NOT_FOUND, clear the ids
  and fall through to create.
- **Initial inventory failure is permanent**
  (`pos/square.pos.adapter.ts:122-124`): `setInitialInventory` runs only when
  `!item.posItemId` and its error is swallowed. One failure (wrong
  `locationId`, Square eventual-consistency NOT_FOUND on a just-created
  variation, transient 5xx) leaves a catalog item with no count; every later
  sync is an update and never retries inventory.
- **Inventory counts read only the first page**
  (`pos/square.pos.adapter.ts:164`): `batchGetCounts` returns a `Page` and the
  code iterates `page.data` rather than `for await`. `stats.service.ts` passes
  every synced item in one call, so a large swap gets "no count" → "Sold" past
  the first page.

Fix: distinguish "no reading" from "zero" in the response (`inStock: null`),
and render it as unknown.

**Fixed** in `079ba4e`. `fetchInventoryMap` returns `null` on a failed read; `toResponse` and `StatsService` carry a new `inventoryKnown` field, with unknown stock reported as unsold rather than sold. The web shows a "Stock unknown" state in the items panel and dashes on the dashboard. The Square adapter now recreates an item Square returns NOT_FOUND for, reads every page of inventory counts, and sets an initial count for an existing item only when Square answers and holds no count row at all (never on a failed read, which would restock a sold item).

### A5. Staff items page silently shows only the first 50 items
`apps/web/src/pages/ski-swap/SwapItemsPanel.tsx:278-285`,
`apps/api/src/ski-swap/item.service.ts:165`

The panel never passes `skip`/`take`; the service defaults `take: 50`.
`data.total` is used only by ConsignAll. The state and print filters
(`:427-432`) are applied client-side to that page.

**Scenario:** 300-item swap, staff picks "Not printed" → sees only the
unprinted items among the first 50; items 51+ are invisible unless searched by
SKU or name.

Same cap on a business seller's "My items" (`seller-self.service.ts:78-85`):
a shop that imports 200 ticket items sees 50.

**Fixed** in `079ba4e`. `SwapItemsPanel` fetches every page (200 at a time until `total`), and the seller's own `GET /seller/me/items` accepts `skip`/`take` so the shop's page pages the same way.

### A6. Searching by name returns every item / every seller
`apps/api/src/ski-swap/item.service.ts:120`,
`apps/api/src/ski-swap/seller.service.ts:215`

The phone clause is `phone: { contains: query.replace(/\D/g, '') }`. A query
with no digits ("rossignol", "Smith") becomes `contains: ''` → `LIKE '%%'`,
which matches every non-null phone, and it is OR'd with the other clauses.
Staff typing a brand or surname get effectively the whole swap or roster.
Fix: add the phone clause only when the digit string is non-empty.

**Fixed** in `079ba4e`. Both searches add the phone clause only when the query contains a digit.

### A7. Public "track your items" page says "Not yet sold" all weekend
`apps/api/src/ski-swap/public-seller.service.ts:88-99`,
`apps/web/src/pages/public/SellerItemsPage.tsx:76`

`soldCount` is derived only from payout lines, which do not exist until a
payout run is built. The page text says "it updates on its own, so there is no
need to call and ask." Sellers whose item sold Saturday see "Not yet sold"
until the treasurer builds a run days later. They will call.

**Fixed** in `3cdad02`. `PublicSellerService` reads Square inventory once per active swap at that swap's location, the same reading the staff items page takes, and reports `inventoryKnown` per item. Payout lines no longer feed the sold state at all. The page shows "Could not check — try again shortly" when Square did not answer. The rule that came out of it is in the status block at the top.

### A8. Print queue: bridge with no printer burns attempts; Clear leaves claimed jobs
`apps/api/src/ski-swap/print-queue.service.ts:593-607,670` and `:850-856`

- `take()` has no guard on `bridge.bridgedPrinter`. Jobs are claimed, rendered
  against `DEFAULT_TARGET`, and sent with `printer: null`. Each claim does
  `attempts + 1`, so after five claims (seconds if the firmware nacks; ~7.5 min
  via the 90 s reaper if it does nothing) the jobs are `abandoned` and gone
  when the printer is finally bound. **Scenario:** station and bridge bound,
  printer bound a few minutes later on the Printers page, or a printer
  unbound/re-bound mid-swap while sellers keep saving → their tags are
  abandoned and every seller has to reprint. The web shows "Bridge has no
  printer" but nothing stops the queue draining into the void.
- `clearQueue` deletes `queued|failed|abandoned` only. The runbook's jam
  procedure is fix printer → Clear → sellers reprint. Jobs claimed by the
  jammed bridge with `attempts < 5` survive Clear, expire at 90 s, are
  re-claimed, and print again alongside the seller's reprint. Clear also cannot
  remove jobs stuck "claimed" under a dead bridge.

### A9. Check-in `register` lets a stranger sign in as an existing seller
`apps/api/src/ski-swap/checkin.service.ts:82-96`,
`apps/api/src/common/identity/person.service.ts:46-62`

`register` picks the challenge channel from the *typed* contacts
(`channelFor(normalized)`), but resolves the *account* with
`resolveOrCreate(input)`, which matches by email first, then phone. The two can
name different people, and the challenge goes to the attacker's contact for the
victim's `userId`. `CheckinRegisterSchema` accepts both fields; only the web
client restricts itself to one.

- SMS off (current state): `{ phone: "<victim phone>", email: "attacker@evil" }`
  → matches victim by phone, channel falls to email → magic link to attacker →
  session as victim; `confirm` (`contact-challenge.service.ts:238-249`)
  overwrites the victim's `verifiedEmail` with the attacker's, which is where
  receipts and a PayPal `EMAIL` payout target resolve.
- SMS on: `{ email: "victim@x.com", phone: "<attacker phone>" }` → OTP texted
  to attacker.
- Non-malicious variant: a spouse types the partner's phone (on file from last
  year) plus their own email → signed in as the partner, partner's verified
  email silently replaced.

Fix: refuse when the typed email and phone resolve to different people, or
only ever issue to the contact that matched (or the one being created).

**Fixed** in `079ba4e`. `register` resolves the account by the contact the code is sent to and by nothing else: `resolveOrCreate` is given only that one contact. Whatever else was typed plays no part in sign-in.

### A10. Staff "Add seller" silently resets a returning seller's payout to CHECK
`apps/api/src/ski-swap/seller.service.ts:326-333` (create), `:664-666`
(`writeUserFields`), `apps/web/src/pages/ski-swap/SellersPage.tsx:31,176-178`

`create` calls `writeUserFields` without `overwrite`, so names and address
fill gaps only, but `payoutMethod`/`payoutTarget`/`payoutHandle` are written
unconditionally (they bypass `keep`). The web form always sends
`payoutMethod: 'CHECK'` with null target and handle.

**Scenario:** last season's seller has PAYPAL on `User`; staff add them again
by phone this weekend → `resolveOrCreate` matches → payout overwritten to
CHECK with no warning. If a client sends only `payoutMethod`,
`assertPayoutIsCoherent` instead throws 400 and the create fails.

**Fixed** in `079ba4e`. `writeUserFields` applies the fill-gaps rule to the three payout fields as a unit: without `overwrite`, an existing `payoutMethod` is left alone. Staff edit (`patch`) still overwrites, as it passes `overwrite: true`.

### A11. Seller edit form cannot save business or email-only sellers
`apps/web/src/pages/ski-swap/SellersPage.tsx:369-399`, `:183-194`

When `editSeller` is set the individual block renders for everyone with
`required` on First name, Last name and Phone. A business seller (invited with
name + email) or an individual who self-checked-in by email has no phone →
browser validation blocks Save with no visible reason. The patch also never
sends `businessName`, so a shop cannot be renamed.

**Fixed** in `079ba4e`. Editing a shop shows a required Business name field and sends `businessName` on save; first and last name are required only for individuals; phone is never `required` (the server still requires a name or one contact, and now says so on screen).

### A12. Stale `selectedSwap` in localStorage blanks every swap-scoped tab
`apps/web/src/pages/ski-swap/SkiSwapLayout.tsx:82-97,119,213-223`

A stored id not among the active swaps → `selectedSwap` null; the
default-to-first effect runs only when `!selectedSwapId`. The `<select>`
visually shows the first option because its value does not match, and with
one active swap the user cannot "change" it to trigger `onChange`.

**Scenario:** admin deactivates the test swap they were viewing, opens
Dashboard → "No active swaps found. Create one on the 'Swaps' page." while the
picker shows the real swap. Stuck until localStorage is cleared.

**Fixed** in `079ba4e`. Both default-to-first effects also fire when the remembered id is not in the loaded list.

### A13. Patching an unconsigned item puts it in Square
`apps/api/src/ski-swap/item.service.ts:553`,
`apps/api/src/ski-swap/seller-self.service.ts:208-218`

`patch` always calls `syncItemToPos`; neither it nor `syncItemToPos` checks
`consignedAt`. Reachable by a seller editing a price from their phone, a shop
editing not-yet-arrived inventory, or staff editing a "Not yet received" item.
With `requireConsignmentScan` on, the item is live in Square before any staff
member has seen it, while the web still says "not in Square and cannot sell".
Only matters if that setting is on.

**Fixed** in `079ba4e`. `syncItemToPos` returns `skipped` for any item with `consignedAt` null, so no caller — patch, re-push, finish — can put an unaccepted item in Square.

### A14. Errors are swallowed in the item and seller modals
`apps/web/src/pages/ski-swap/SwapItemsPanel.tsx:287-343,801-818`,
`apps/web/src/pages/ski-swap/SellersPage.tsx:155-194,593-607`

`createMutation.error`, `patchMutation.error`, `deleteMutation.error`,
`inviteMutation.error` are never rendered. A price of `0` or `.` → 400 → modal
stays open, nothing happens. A duplicate phone (409) or "That email has not
been verified" (`seller.service.ts:783`) → same. Delete refused → row stays, no
message. Also unshown: `PayoutsPage.tsx:47` nudge errors,
`SellerProfilePage.tsx` save errors, Bluetooth print failures in
`SwapItemsPanel.tsx:409-424` (caught and `console.error`'d).

**Fixed** in `079ba4e`. The items modal renders create/patch errors and the panel shows delete and Bluetooth print errors above the toolbar; the sellers modal renders create/patch/invite errors and the page shows delete errors above the table. Mutations are reset when a form closes. Not done: `PayoutsPage` nudge errors and `SellerProfilePage` save errors.

### A15. Sign-in link resend both kills the first link and locks the address out
`apps/api/src/auth/contact-challenge.service.ts:104-122,180-206`,
`apps/web/src/pages/auth/VerifyPage.tsx:107`

Each `issue` supersedes the outstanding challenge (so the link in the first,
slow email dies once the seller taps again), and every issued code, superseded
ones and staff `verify` codes included, counts toward `codes.perDestination`
(5 / 15 min) and `codes.perDestinationDaily` (10 / day).

**Scenario:** slow venue email; seller taps "send link" 3–4 times, then opens
the first email → "Invalid or expired code"; taps again → 429 and locked out
up to 15 minutes while standing at the station. Staff cannot help by
initiating `verify` either (same counter).

Also: the expired-link screen's "Send me a new link" is an `<a href="/auth/login">`,
which has no route on the seller site (`App.tsx` seller branch), so it lands
on a blank page. On the seller site it should say "scan the station QR again".

**Fixed** in `079ba4e`. `ContactChallengeService.issue` supersedes outstanding challenges only for the phone channel; emailed links stay valid until used or expired. The "Check your email" screen has a resend button with a 30 second hold and says every link keeps working. The expired-link screen on the seller site points back to `/checkin` instead of `/auth/login`. The per-destination limits are unchanged.

### A16. Item-add idempotency key is minted per tap, not per attempt
`apps/web/src/pages/checkin/ItemsStep.tsx:142`

A fresh key is generated inside `addItem`; the comment says it is "kept across
retries of that attempt" but a retry after a timeout is a new key. A request
that lands server-side with a dropped response → error shown → seller taps
again → second item and second tag.

**Fixed** in `079ba4e`. The key lives in a ref from the first tap until the item saves, then clears.

---

## B. Fix before the first payout run

The customer will want a payout run after the beta. These stop or corrupt it.

### B1. BLOCKER — Square order search is rejected on every call
`apps/api/src/ski-swap/pos/square.pos.adapter.ts:187-199`

The search filters on `closedAt` but never sets `query.sort.sortField`. The
SDK typing (`SearchOrdersSort.d.ts`) states: "When using a DateTimeFilter,
`sort_field` must match the timestamp field that the DateTimeFilter uses to
filter … If this field does not match … SearchOrders returns an error.
Default: `CREATED_AT`." The stub adapter bypasses this, so no test covers it.
Every payout run `create()` throws. Fix: `sort: { sortField: 'CLOSED_AT' }`.

### B2. BLOCKER — Resume path re-posts a used `sender_batch_id` and then double-pays
`apps/api/src/ski-swap/payouts/payout-run.service.ts:371-376,405-406,440-448`,
`apps/api/src/ski-swap/payouts/stub.providers.ts:43-48`

The code comment says PayPal "dedupes it for thirty days and returns the batch
it already has." PayPal's documentation, quoted in Plan 25 §7 line 404, says
"the API rejects the request". The stub models the wrong behaviour, so the
smoke passes.

**With real PayPal:** lines in SENDING (timeout, or a batch still PENDING at
PayPal) → staff press Send → `inFlight > 0` → same `runId-attempt` re-posted →
PayPal 400 → `!err.retryable` branch moves **every SENDING line in the run**
to APPROVED with "PayPal refused the batch" → staff press Send again →
`inFlight === 0` → `sendAttempt + 1` → new batch id → PayPal accepts → every
seller in the first batch is paid twice.

**Hits without any outage:** send batch 1; approve two more lines while batch
1 items are still PENDING at PayPal (seconds to minutes); press Send → batch 1
lines revert to APPROVED → Send → double pay. Also: a timed-out first attempt
leaves `payoutBatchId` null, so `reconcileOrg` (`:580-588`, filter
`payoutBatchId: { not: null }`) can never see those lines.

Fix: on a duplicate-batch 4xx, look the batch up by `sender_batch_id` and
apply its result rather than reverting; never move SENDING → APPROVED without
a PayPal-confirmed outcome.

### B3. A second run after CLOSE re-reads the same window and re-pays everyone
`payout-run.service.ts:55-62` (refuses only while DRAFT/REVIEW), `:70-71`
(default window = `swap.createdAt` .. now), `:148` (created straight into
REVIEW; DRAFT/rebuild from Plan 25 §5 not implemented; no delete endpoint)

Nothing excludes order lines already on a `PayoutLineItem` of an earlier run.
Saturday-night preview run → Sunday sales → close and create another → every
Saturday seller appears again. "Approve all N remaining"
(`PayoutRunPage.tsx:379`) + Send pays them twice. A sale after `salesTo` is
only paid via this double-including second run.

### B4. Refunds are never subtracted
`square.pos.adapter.ts:208,222,294-304`

Square puts `returns[]` on the *return* order (`Order.returns`: "items from
sale orders being returned in this one"; `OrderReturn.sourceOrderId` names the
original). `refundedQuantities(order)` reads `order.returns` of the sale order
(always empty). `refundedQuantity` is always 0; a buyer who returns boots an
hour later still produces a paid sale. The smoke feeds `refundedQuantity`
directly, so this is untested end-to-end.

### B5. FAILED and RETURNED lines have no exit
`payout-run.service.ts:331-335` (approve only PENDING → APPROVED),
`contracts/payouts.contracts.ts:125-130` (RETURNED terminal),
`payout-nudge.service.ts:146` (cancel needs UNCLAIMED), `:619` (recordCheck
needs method CHECK)

Plan 25 §7 says RETURNED goes "back into review". A PayPal FAILED item, a
30-day RETURNED, or a line approved with no destination (`:410-414` marks
FAILED; `approve()` never checks `destination`, and "Approve all remaining"
approves the "No usable destination" lines too) is stuck forever: cannot
re-approve, cannot switch to check, cannot cancel.

### B6. Cancel-then-resend reuses the line id as `sender_item_id`
`payout-nudge.service.ts:154-163`, `payout-run.service.ts:489-500`

After `cancelItem` (back to PENDING, `payoutItemId` cleared, `payoutBatchId`
kept), PayPal emits CANCELED/RETURNED for the old item → matched on
`senderItemId` only → line → RETURNED (terminal, see B5) before staff can fix
the email, or after resend it overwrites the new in-flight item's status.

### B7. $0 lines are built and sendable
`payouts/build-run.ts:135-173`

A seller whose every sold item is `donateProceeds` (or 100 % commission) gets
a PENDING PAYPAL line with gross/net 0. "Approve all remaining" includes it;
PayPal rejects a 0.00 item, which 4xx-fails the whole batch and (per B2)
reverts every line in the run.

### B8. Oversell / double-ring is paid in full
`payouts/build-run.ts:102-130`

No comparison of total sold quantity per item against `originalQuantity`. A
cashier scanning the same tag in two orders (Square sells past zero by
default) pays the seller twice on listed price with nothing flagged.

### B9. No scheduler for reconcile or nudges
`payouts/payout-run.controller.ts:118-131`; no `@Cron`/`ScheduleModule` in
`apps/api`

Plan 25 §6/§9 require a scheduled sweep. If the PayPal `webhookId` is not
registered (optional at save, `payouts.contracts.ts:24`), every webhook is
dropped (`paypal.client.ts:133-136`), lines sit in SENDING until someone
presses Reconcile, and `close()` (`:659-664`) refuses. Day-7/21 nudges never go
out unless someone remembers.

### B10. Smaller payout items
- Nudge clock resets on every reconcile: `payout-nudge.service.ts:73` uses
  `line.updatedAt`, and `applyBatchResult` (`:489`) `updateMany`s
  UNCLAIMED → UNCLAIMED on each sweep, bumping `@updatedAt`.
- Resume path silently skips newly approved lines and the `expectedLineCount`
  check (`payout-run.service.ts:375-403`).
- Webhook race: UNCLAIMED from a fast webhook is overwritten by the
  createBatch response's PENDING → SENDING (`:458`, `:492`).
- Partial-refund discount report is wrong (`build-run.ts:124,260-261`):
  `collectedCents` is the whole line but `quantity` is post-refund.
- Sales at a different Square location are silently invisible, not even
  "unmatched" (`square.pos.adapter.ts:188`).
- CHECK lines with no address export blank cells with no flag
  (`payout-run.service.ts:537-553`).
- `applyBatchResult` is not org-scoped (`:489-492`).
- `list()` `totalNetCents` sums DONATED/FAILED/RETURNED lines (`:229`).
- "All payout runs" link: `PayoutRunPage.tsx:82` `Link to=".."` resolves to
  `/dashboard/ski-swap`, not `/payouts`.

---

## C. Operational checklist for the weekend

Not code defects, but things that will decide whether the weekend works.

- **Texting is off in production** (`/public/features` → `sms: false`). Every
  seller signs in by email magic link. A seller with no email cannot check in.
  The link opens in whatever browser the mail app chooses (Gmail's in-app
  webview on iOS), and the session lives there.
- **Email deliverability.** Confirm SES is out of sandbox and DKIM is verified
  for `patrolkit.io`. SPF currently includes only ImprovMX and there is no
  DMARC record. SES's own MAIL FROM passes SPF on `amazonses.com`, so
  alignment rests entirely on DKIM. Add `_dmarc` with `p=none` and
  `include:amazonses.com` in SPF regardless.
- **`canText` says yes when nothing can be sent** (`sms/sms.service.ts:42-47`
  vs `:111-128`). If the switch is flipped on this weekend, `canText` ignores
  `OUTBOUND_NOTIFICATIONS` and `AWS_SNS_ORIGINATION_NUMBER`; `register` returns
  `channel: 'phone'`, the UI says "We texted a 6-digit code", and nothing
  arrives. Keep the switch off.
- **Swap prefix length** — see A1. Five characters or fewer.
- **Device tokens reach too much.** Class-level `@RequireDeviceRole` on
  `swap.controller.ts:27` lets a check-in iPad `PATCH`/`DELETE` swaps (and
  `POST` crashes with a TypeError on `user.userId`, `:45`); on
  `seller.controller.ts:38` it opens CSV import, `remove`, and
  `verify/initiate` to the device token. Add `@NoDeviceAccess()` to those
  handlers.
- **Revoked bridges keep a working token for up to `DEVICE_TOKEN_TTL`**
  (`device-auth.guard.ts:26-37`, `devices.service.ts:269-280`). Auth is
  signature-only; a revoked bridge can still post scans and consign until
  expiry.
- **Staff CSV item import** (`item.service.ts:752-765,781-803`) does one to
  three Square round-trips per row inside the HTTP request and is not atomic.
  A 200-row shop file is minutes in one request and will likely time out at
  the proxy while the loop keeps running; a failure at row N leaves rows
  1..N−1 committed with a 409 and no row results. Suggest `deferPos: true`
  and a background push like `consignAllForSeller`. (The check-in finish push
  at `checkin.service.ts:379-391` is also sequential per item; a 30-item
  seller could push the request past a proxy timeout. Not timed.)
- Lint: `label-templates.ts:841` declares `y` with `let`; `prefer-const` fails
  the API lint. One word, untouched because the file was not otherwise in
  scope. (The web lint error at `PrintersPage.tsx:65` was fixed in `079ba4e`.)

---

## D. Minor

Confirmed, lower impact. Grouped by area.

### Items / Square
- Category "recovery" fires on any `INVALID_REQUEST_ERROR` and always creates
  a new category (`square.pos.adapter.ts:12,101-103`); items end up split
  across same-named categories.
- `remove` deletes from Square/S3 before the DB write
  (`item.service.ts:625-650`); a failed transaction leaves a live item with a
  dangling `squareItemId`.
- Keyset cursor silently drops the search filter (`item.service.ts:114-141`):
  both the `query` block and the `after` block spread an `OR` key, and the
  second overwrites the first.
- `resetOrgData` fails once any payout exists (`square-config.service.ts:22-29`,
  `PayoutLine.seller` has no `onDelete`) and orphans Square/S3 objects.
- Duplicate ticket via leading zeros in CSV (`legacy-ticket.service.ts:465-481`):
  `0100` and `100` both insert.
- `resolveUniquePrefix` degenerates for 6-character prefixes
  (`swap.service.ts:258-268`): all 26 candidates equal `base`.
- Client-supplied `sku` is unvalidated (`CreateItemSchema.sku: max(20)`;
  `item.service.ts:401-405`): anything up to 20 characters is accepted as a
  live SKU, longer than `MAX_SKU_LENGTH`, and `createAtStation` does not
  check `legacyTicketsEnabled` for a bare ticket number.

### Check-in / sellers / public
- Email-only sellers cannot use the public status lookup
  (`public-lookup.service.ts:43-53,112-114`): it matches on the phone claim
  and `seller-find` requires the last 4 of a phone. Only the `/s/:sellerId`
  receipt link works for them.
- The legacy phone-lookup status page (`SellerStatusPage.tsx:90`,
  `public-lookup.service.ts:83-92`) reports unconsigned items as "Sold!"
  (`soldCount = originalQuantity − inStock`, inStock 0 when not in Square),
  bypasses the `api` client (no 429 handling), and gates on phone number
  alone. Live on both hosts though nothing links to it.
- `confirm` replaces `verifiedEmail`/`verifiedPhone` with whatever the
  challenge target was (`contact-challenge.service.ts:238-249`). Harmless
  alone; it is what makes A9 a payout redirect.
- Missing query params fall through to "any": `checkin.service.ts:50-54`
  (`?station=` absent → first station), `:403-407` (`summary` without
  `swapId`), `receipt.controller.ts:91-99` (`list` without `swapId`).
- `join` ignores `:orgId` (`checkin.controller.ts:62-66`,
  `checkin.service.ts:163-177`): a caller can join org B's active swap via org
  A's URL.
- A seller may rewrite their own `phone`/`email` claims to anything
  (`seller-self.service.ts:41-50` → `seller.service.ts:402`, `overwrite: true`);
  claims are not unique, so `public-lookup`'s `findFirst` then returns an
  arbitrary profile. `patch` also silently nulls a phone `normalizePhone`
  rejects (`:658`).
- `finish` with zero items still prints a header label and emails "No items
  were checked in." (`checkin.service.ts:253-331`); no guard on the swap still
  being active.
- Finish-email idempotency key `count:total` can collide
  (`checkin.service.ts:321`): withdraw a $50 item, add a different $50 item,
  finish again → no updated email for 24 h.
- Seller self-send receipt limit counts failed/suppressed deliveries
  (`receipt.service.ts:325-348`).
- `register` is an enumeration oracle where `/auth/login` is not
  (`checkin.service.ts:90-96` issues without `whenLimited: 'decoy'`).
- Custom taxonomy icons are not org-scoped on read
  (`taxonomy.controller.ts:243-255` → `taxonomy-icon.service.ts:101-112`).
- CSV seller import requires an Email column the server does not
  (`SellerImportModal.tsx:5-8,194`; server accepts email OR phone).
- Session loss is not surfaced (`api.ts:50-60` throws 401 after a failed
  refresh but never resets `AuthContext`). Refresh TTL is 30 days, so unlikely
  this weekend.

### Printing
- ack/nack do not check the claim token or status
  (`print-queue.service.ts:716-753,887-894`): a late ack for a re-claimed job
  marks it printed and deletes the new claim's raster (duplicate); a late nack
  on a `printed` job with `attempts < 5` re-queues it; `nack` with no `error`
  nulls `lastError`.
- `hasPrintedTag` can never flip for `labelsPerItem` 2–3 if a sibling job is
  cleared or render-fails (`print-queue.service.ts:726-735,853`).
- Receipt page index chosen at finish, re-paginated at claim
  (`checkin.service.ts:258-268`; `print-queue.service.ts:913-925`;
  `print-recipe.service.ts:90-107`): adding/deleting an item or swapping
  printer tiers before the receipt prints → "Label page N no longer exists".
- Printer model/paperSize not cross-validated at the API
  (`printer.service.ts:48-65,129-150,189-198`); the web restricts the combos.
- Helper-label endpoint does not require the swap to be active
  (`print-queue.service.ts:361-367`).
- Receipt timestamp uses the server's local zone
  (`print-recipe.service.ts:134-138`, no `timeZone`).
- Receipt modal "Total value" sums `priceCents × inStock`
  (`PrintReceiptModal.tsx:51`) → "$0.00" for an unconsigned seller; list
  capped at 50.
- Station QR encodes only the newest active swap
  (`CheckinStationsPage.tsx:55`).

### Web leftovers
- `SellerQrModal.tsx` is unreferenced.
- `SellersPage.tsx:199` `setQueryData(['ski-swap/sellers', orgId])` never
  matches the real key, so the optimistic removal is a no-op.
- `SwapsPage.tsx:64-75` saving an edit with no changes sends `{}` → "At least
  one field must be provided".
- `SignInStep.tsx:220` enables "Text me a code" at 5 characters while the
  contract requires 7 (server message shown, cosmetic).
- `api.ts` `stationQrPdf` and `checksCsv` read `body?.error?.message`; the
  filter sends `error` as a string, so the generic fallback always shows.

---

## E. Test-coverage gaps

Behaviour the specs do not exercise, found by reading them:

- Concurrent `consign`, batch + scanner overlap (only sequential double-scan).
- `patch` on an unconsigned item reaching Square.
- `syncItem` when Square returns 404 for a stored `posItemId`; inventory-set
  failure follow-up.
- `importTicketItems` partial failure / Square timing.
- `listSales` request shape (no adapter test at all).
- `list` search by text vs the phone-digit clause.
- `labelsPerItem > 1` → `hasPrintedTag` flips only after the last ack.
- Two bridges racing a claim; render-failure → `failed`; a bridge with no
  printer.
- `smoke-print-queue.mjs:335` "a bridge cannot serve two stations" still
  expects 409; it passes only because both smoke stations are self-service.
- Reaper / attempt cap covered by the smoke but not by a unit spec.
- Payout refunds end-to-end (the smoke feeds `refundedQuantity` directly).

---

## F. Unverified suspicions

Raised by a reviewer, not confirmed. Worth a look, not a fix on faith.

- Square `BatchRetrieveInventoryCounts` page size (if ~100, A4's paging gap
  hits the stats page at any mid-size swap).
- `doItemUpsert` sends the ITEM `version` but not the nested ITEM_VARIATION
  `version` (`square.pos.adapter.ts:57-80`); Square may reject updates with
  VERSION_MISMATCH, which via the category-recovery path would also spawn a
  stray category per edit. Price edits presumably work in practice.
- `catalog.object.upsert` full-replace semantics: `itemData` never includes
  `imageIds`, so a price edit may detach the item's photos in Square.
- `SQUARE_VERSION` (`square-client.service.ts:6`) is exported but never passed
  to `new SquareClient(...)`.
- Square eventual consistency between catalog create and
  `setInitialInventory` (A4).
- `recipient_wallet: 'Venmo'` casing (`paypal-mapping.ts:91`) and whether
  PayPal accepts an E.164 `+1…` receiver for `recipient_type: PHONE`; Plan 25
  §11 said settle in sandbox, nothing shows it was.
- `payoutStubsEnabled()` only refuses when `NODE_ENV === 'production'`; a prod
  box with `PAYOUTS_STUB=1` and an unset `NODE_ENV` would stub PayPal.
- `line.totalMoney` includes tax; a taxed sale reads as "collected above list".
- `auth.service.ts:65-67`: `requestLogin` resolves by the non-unique claim
  with `findFirst`; if two users carry the same claim and the verified holder
  is not first, the real owner's confirm fails.
- Firmware behaviour when a claim says `printer: null` (if it nacks at once,
  A8 burns the five attempts in seconds).
- A 62×100 raster over slow BLE taking > 90 s would be re-claimed by the same
  bridge mid-print (`CLAIM_SECONDS = 90`).
- The web shows "Ready" on `printerLink === 'ready'` without checking
  `printerLinkAt` age.
- `PayoutStep.tsx:63-68`: a stored `payoutTarget: 'EMAIL'` with `verifiedEmail`
  now null leaves the segment unoffered but selected; Continue is enabled.
- `ItemsStep.tsx:86-101`: a restored draft whose `categoryId` no longer exists
  leaves `canAdd` true while the grid shows nothing picked.

---

## What is left, in order

1. A1 — check the customer's swap prefix length now. Five characters or
   fewer needs no code change; six needs a fix before any tag is printed.
2. A8 — the print queue: refuse to claim for a bridge with no printer, and
   make Clear take claimed jobs too.
3. B1 and B2 before anyone presses "Create run"; B3 and B4 before the second
   run.
4. Everything in C that is a setting rather than code, today.
5. The rest of D as time allows.
