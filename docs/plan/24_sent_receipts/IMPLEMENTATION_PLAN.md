# Plan 24 — Emailed and texted receipts

A seller leaves the counter with a printed receipt. If they lose it there is
nothing to re-send: the receipt is a raster that went to a printer, and the only
lasting record is the seller's items table. This plan gives a check-in a
**record** — frozen at the moment it happened — and two ways to put it in the
seller's hands: an email to a verified address, or a link by text when a phone
number is all there is.

Sending is never automatic. Two buttons send one: on the seller's own check-in,
and on the staff sellers list. The iOS app calls the same endpoint the web does.

SMS delivery is still blocked on toll-free verification (see
`project_sms_originator`). The infrastructure is built here regardless, and the
text path works end to end against a stubbed `SmsService` — which is what it
already does when `AWS_SNS_ORIGINATION_NUMBER` is unset.

---

## 1. Decisions

| | |
|---|---|
| **Prerequisite** | `MailService` and `SmsService` must report their outcome before any of this is built. §2 |
| **What a receipt is** | A frozen snapshot of one check-in: lines, prices and total as they were. A second visit makes a second receipt. §3 |
| **When it is created** | At `finish()`, and on demand for sellers who never self-checked-in. Creating is not sending. §4 |
| **Channel** | Verified email if there is one; otherwise verified phone by SMS. Never an unverified contact. §5 |
| **When it is sent** | Only when somebody presses a button. No automatic send. §6 |
| **The link** | `/r/<token>` on the seller site. Its own random token, no expiry, revocable. §7 |
| **Who can send** | Staff with `ski_swap:manage`, and the seller for their own receipt, throttled. §8 |
| **Delivery record** | Every attempt is a row — channel, destination, outcome. The UI reads it back. §9 |
| **Queueing** | None. A button press sends inline and reports what happened. §9 |

---

## 2. Prerequisite — the send services have to report what happened

**Nothing else here can start until this lands.** It is two files and one caller,
it has nothing to do with receipts, and it is testable on its own.

`MailService.send()` returns `void`. It throws on failure, which is usable, but it
cannot distinguish *sent* from *suppressed*, and it discards the SES message id.
`OUTBOUND_NOTIFICATIONS` is off everywhere but production, so without that
distinction a staging box reports "Emailed to dana@example.com" having sent
nothing — a green that means nothing.

`SmsService.send()` returns `void` **and swallows its errors**: it logs and
returns normally when SNS refuses.

### The swallowing is in the wrong place rather than wrong

There is exactly one SMS caller today, the OTP in
`ContactChallengeService.dispatch`, and it wants a delivery failure logged and not
surfaced — an auth error that depends on whether delivery worked leaks whether
the account exists. The email half of that same method does the same thing, and
does it *at the call site*, with a comment saying why:

```ts
send.catch((err) => this.logger.error({ err }, 'Challenge email delivery failed'));
```

So nobody is harmed today; the only caller wants the behaviour it is getting. The
problem is that the policy lives inside the service, where every future caller
inherits a decision made for OTP. Receipts are the first caller that must not: a
send that reports success for a text that never left is worse than one that fails
loudly, because the volunteer stops helping.

### The change

Both services return a result instead of `void`:

```ts
export type SendOutcome =
  | { status: 'sent'; providerRef?: string }
  | { status: 'suppressed' }
  | { status: 'failed'; error: string };
```

- `SmsService` stops swallowing and reports instead.
- `ContactChallengeService.dispatch` keeps the OTP's fire-and-forget
  **explicitly**, beside the mail call that already does it and for the same
  recorded reason. Behaviour is unchanged; only the place the decision is made
  moves.
- `MailService` reports `suppressed` when the notification gate is off, and
  carries the SES `MessageId` through as `providerRef`.

Done when every existing caller behaves exactly as it does now — the OTP path is
the only one whose behaviour is load-bearing, and
`contact-challenge.service.spec.ts` must keep passing untouched — `suppressed` is
distinguishable from `sent` with notifications off, and no receipt code exists
yet.

---

## 3. The snapshot

The printed receipt is a record of a transaction: *this is what you handed over,
this is what it was priced at.* Items get edited afterwards — staff fix a price,
an item is consigned, something sells — and a receipt that silently follows those
edits is not a receipt. It is a view.

That view already exists at `/s/:sellerId`, is printed on every seller's QR
label, and is the right place to answer "has my stuff sold?". The receipt answers
a different question and needs its own storage.

Two additive tables. Nothing existing changes.

```prisma
/// One check-in, frozen. Created when a check-in finishes, or when somebody
/// asks for a receipt for a seller who never self-checked-in.
model Receipt {
  id        String   @id
  orgId     String
  swapId    String
  sellerId  String
  /// Where it happened. Null for a receipt minted from the sellers list.
  stationId String?

  /// The public link. Random, not derived from any id — see §7.
  token     String   @unique @db.VarChar(32)
  /// Set to revoke the link without deleting the record.
  revokedAt DateTime?

  /// Denormalised so the public page renders without joining a live tree, and
  /// so an org rename does not rewrite history.
  orgName     String
  orgLogoUrl  String?
  swapTitle   String
  sellerName  String
  /// What the tag said to do with the money, at the time.
  payoutLabel String?

  totalCents Int
  itemCount  Int

  createdAt DateTime @default(now())

  lines      ReceiptLine[]
  deliveries ReceiptDelivery[]

  org    Org           @relation(fields: [orgId], references: [id])
  swap   SkiSwap       @relation(fields: [swapId], references: [id])
  seller SellerProfile @relation(fields: [sellerId], references: [id])

  @@index([orgId, swapId, sellerId, createdAt])
}

/// A line as it was. `itemId` is a pointer for staff tooling; the text is the
/// record and is never re-resolved (Plan 19's frozen-name rule, applied to the
/// receipt rather than the item).
model ReceiptLine {
  id         String  @id
  receiptId  String
  itemId     String?
  name       String
  sku        String
  priceCents Int
  position   Int

  receipt Receipt @relation(fields: [receiptId], references: [id], onDelete: Cascade)

  @@index([receiptId, position])
}
```

`itemId` is nullable and deliberately carries no cascading constraint: deleting
an item must not rewrite a receipt.

---

## 4. Creating one

`ReceiptService.snapshot(orgId, swapId, sellerId, stationId?)` reads the seller's
items for that swap, writes a `Receipt` and its lines, and returns it. It sends
nothing. Two callers.

**`CheckinService.finish()`**, after the print jobs are queued and before the
Square push — the same placement, and the same reason, as the receipt queue: a
Square outage must not cost the seller their paperwork. The seller is standing
there, so this is the moment the snapshot is true.

**The send endpoint**, for a seller who never self-checked-in. Staff enter items
for proxy and business sellers, and those sellers have no `finish()` in their
history — but the sellers list still needs a working **Send receipt** button. So
the send path does not require a receipt to exist:

```ts
/**
 * The receipt to send, minting one if what we have no longer describes the
 * seller's items.
 *
 * Re-sending yesterday's receipt after three more items went on is not a
 * re-send, it is a wrong receipt. Comparing the lines is cheap and means a
 * plain re-send — the common case, a seller who lost the paper — reuses the
 * record and its link rather than minting a near-duplicate.
 */
async currentFor(orgId, swapId, sellerId): Promise<Receipt>
```

Matching is on the set of `(itemId, name, sku, priceCents)` rather than on a
timestamp: an edit that changed nothing observable should not mint a receipt.

---

## 5. Choosing a channel

```
verifiedEmail  → email, receipt rendered inline
verifiedPhone  → SMS with a link
neither        → refuse, and say which contact is missing
```

**Verified only.** `User.email` and `User.phone` are claims — indexed, explicitly
not unique, and possibly someone else's. `verifiedEmail` and `verifiedPhone` are
the proven ones, and are already what the payout destination resolves through. A
receipt carries a name, a list of what somebody owns, and for a mailed-check
seller an address; sending that to an unverified claim sends it to whoever typed
it.

Email wins when both exist: it carries the whole receipt rather than a link, it
costs nothing to send, and the seller can forward it on.

With no verified contact the endpoint returns a 400 the UI can render, not a
silent success. The sellers list disables the button and says why rather than
offering an action that cannot work.

---

## 6. The two buttons

### Self check-in

`FinishStep.tsx`, under the existing "Your receipt is printing at this station"
card. One button, labelled for the channel it will actually use:

- `Email my receipt to dana@example.com`
- `Text me a link to my receipt`
- nothing at all when neither contact is verified — the seller cannot fix that
  from this screen, and an explanation with no remedy is noise.

After a send it becomes a confirmation with a quiet "Send again".

### Staff sellers list

`SellersPage.tsx` already has a per-seller **Print receipt** action opening
`PrintReceiptModal`, which lists the items and totals them — which is exactly
what somebody about to send one wants to see. Keep **Print**, add **Send** beside
it, and show the last delivery under both: *"Emailed to dana@example.com · today
9:42 AM"*.

---

## 7. The public page

`/r/:token` on the seller site renders the receipt; it reads
`GET /public/receipts/:token`, which needs no auth.

The token is 32 characters of `randomBytes(24).toString('base64url')`, stored on
the receipt. Not derived from the receipt id, and not signed: a signed token
cannot be revoked without keeping a list of what has been revoked, which is the
table already here.

**No expiry.** A seller who reopens a text in March to check what they dropped off
should find it. `revokedAt` covers a link that went somewhere it should not have,
and is settable from the staff modal.

**One receipt, not a history.** A leaked link exposes one check-in. That is the
whole reason for not reusing `/s/:sellerId`, which is the seller's live page and
is already printed on a QR label — widening it to mean "and every receipt" makes
a piece of paper on a table more valuable than it is today. The page links on to
`/s/:sellerId` for live status.

Add `r/:token` to **both** branches of `App.tsx`: the `isSellerSite` branch, and
the staff-host branch that already carries `s/:sellerId` and `checkin` for local
development where there is no seller subdomain.

---

## 8. Endpoints

```
POST /orgs/:orgId/ski-swap/sellers/:sellerId/receipts
     body: { swapId, stationId? }
     auth: ski_swap:manage
     → the frozen receipt. Creates, does not send.

POST /orgs/:orgId/ski-swap/sellers/:sellerId/receipts/send
     body: { swapId }
     auth: ski_swap:manage
     → { receiptId, channel, destination, sentAt, url }

POST /orgs/:orgId/ski-swap/seller/me/receipts/send
     body: { swapId }
     auth: the signed-in seller, own receipt only
     throttle: 3 / hour / seller
     → same shape

GET  /orgs/:orgId/ski-swap/sellers/:sellerId/receipts
     auth: ski_swap:manage
     → receipts with their deliveries, newest first (for the modal)

POST /orgs/:orgId/ski-swap/receipts/:receiptId/revoke
     auth: ski_swap:manage

GET  /public/receipts/:token
     no auth → the frozen receipt, or 404 when revoked
```

The staff send route is the one iOS calls. §11.

**Guard note.** `PermissionsGuard` checks a *device* against its role instead of
permission keys, so a class-level `@RequireDeviceRole` opens every route in a
controller. These go in a controller guarded by permissions, or the receipt send
becomes reachable by any provisioned scanner.

---

## 9. Delivery records

```prisma
model ReceiptDelivery {
  id          String   @id
  receiptId   String
  /// EMAIL | SMS
  channel     String   @db.VarChar(8)
  /// The address or number it actually went to, as it was then.
  destination String
  /// SENT | SUPPRESSED | FAILED
  status      String   @db.VarChar(12)
  /// SES/SNS message id, when there is one.
  providerRef String?
  error       String?  @db.Text
  /// Who pressed the button. Null when the seller sent it to themselves.
  actorUserId String?
  createdAt   DateTime @default(now())

  receipt Receipt @relation(fields: [receiptId], references: [id], onDelete: Cascade)

  @@index([receiptId, createdAt])
}
```

The three statuses are §2's `SendOutcome` written down, which is the whole reason
§2 comes first: a row can only record what the service was able to tell it.

**No queue.** A button press awaits the send and reports the outcome. SES and SNS
are both fast, the operator is standing there watching, and a queue would move
the failure somewhere nobody is looking. If receipts ever go out in bulk — every
seller at the end of a swap — that is when a queue earns its place, and
`ReceiptDelivery` is already the table it would drain into.

---

## 10. What the messages say

### Email

House style from `mail.service.ts`: dark card, brand-red heading, one clear
action. In order:

- Org name and swap title
- The date the check-in happened, not the date the email was sent
- The itemised list — name, SKU, price — and the total
- A button to the `/r/<token>` page, which is the copy worth keeping and the way
  through to live status
- The payout destination as it was, so the seller can see where the money goes

The body is the receipt. The link is for keeping, not for reading.

### SMS

One message, no more than 160 characters so it does not split:

```
<Org>: your <swap> receipt — <n> items, $<total>. <url>
```

e.g. `Stowe Patrol: your Fall Swap receipt — 3 items, $135.00. https://skiswap.patrolkit.io/r/Xk3…`

Everything else lives behind the link, which is why the route is `/r/` and not
`/receipts/`.

---

## 11. iOS

**The iPad must create the receipt record, not just print one.** Today it renders
a receipt and sends it to a printer, and that is the whole of it — nothing
reaches the server. Once a receipt is a record, an iOS check-in that only prints
leaves a seller with paper and no way to be sent a copy, and leaves the sellers
list with a **Send** button that mints a fresh snapshot hours later instead of
the one they were handed.

So wherever iOS prints a receipt it first calls
`POST .../sellers/:sellerId/receipts` and prints from what comes back. The
server is where a receipt exists; the printer is one way of rendering it.

What iOS needs:

1. `POST /orgs/:orgId/ski-swap/sellers/:sellerId/receipts` with
   `{ swapId, stationId? }`, returning the frozen receipt — call this at the
   moment a check-in is completed, before printing, and print from the response
   so paper and record cannot disagree.
2. `POST .../receipts/send` with `{ swapId }`, returning
   `{ receiptId, channel, destination, sentAt, url }`.
3. The 400 for "no verified contact" carries a message fit to show a volunteer.
   Render it rather than a generic failure.
4. `GET .../sellers/:sellerId/receipts` for the last-sent line, if the iOS seller
   screen wants one. Optional for a first pass.
5. Nothing about tokens or templates. The URL comes back in the response; iOS
   never constructs one.

Creating is idempotent in the sense that matters: a second call with the same
items returns the same receipt rather than a second one (§4), so a retry after a
dropped response is safe.

Write this up as `SERVER_HANDOFF.md` in this folder once the endpoints are real,
following the shape of `13_provisioned_scanners`.

---

## 12. Testing

Unit tests for the pure parts, a smoke script for anything spanning services —
what the printing work settled on.

**Unit** (`receipt.service.spec.ts`)
- A snapshot freezes: edit an item afterwards, the receipt is unchanged.
- `currentFor` reuses a receipt when nothing observable changed, and mints a new
  one when a price moved or an item was added.
- Channel selection: email preferred, SMS fallback, refusal with neither — and
  an unverified `email` with no `verifiedEmail` is a refusal, not a send.

**Smoke** (`smoke-sent-receipts.mjs`), against a real API and database
- Self check-in → snapshot exists, lines match the items, nothing sent yet.
- Staff send for a seller with a verified email → one `ReceiptDelivery`, channel
  `EMAIL`, status `SUPPRESSED` on a box with notifications off.
- Seller with a phone only → channel `SMS`.
- Seller with neither → 400, and no delivery row.
- `GET /public/receipts/:token` returns the frozen lines; after revoke, 404.
- The seller-self route refuses another seller's `swapId`.
- **Assert the fixture before asserting the behaviour.** A receipt with no lines
  renders and sends perfectly well, so every check above would pass while saying
  nothing — which is how the tall-receipt smoke went green against zero items.

**Not** a golden raster. Nothing here draws.

---

## 13. Out of scope, and one thing worth doing next

- Bulk send at the end of a swap. §9 says where it would go.
- Receipts for anything but a ski-swap check-in.
- Unsubscribe and preference handling. These are transactional messages to a
  verified contact who just handed over their skis; if that changes it changes
  for every message the system sends, and belongs in its own plan.
- Making SMS actually deliver — blocked on the toll-free registration, and
  independent of everything here.

**Worth doing next.** Once `Receipt` exists, the printed receipt could render from
the snapshot instead of from live items. `finish()` queues print jobs that
re-resolve the item list at claim time, so an edit between finishing and printing
changes the paper — right for a tag, wrong for a receipt. Unifying them would make
the paper, the email and the web page provably the same document. Small once this
lands, and confusing to attempt before it.
