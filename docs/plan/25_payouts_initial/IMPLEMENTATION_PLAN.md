# Plan 25 — Paying sellers

Everything up to now has been collection: who the seller is, how they want to be
paid, what they brought, what left the building. This plan spends the money.

That changes what "done" means. A tag printed twice is an annoyance; a payout
sent twice is somebody else's money gone, and no amount of careful UI makes it
come back. So the shape of this plan is: **decide the amount from facts we can
defend, put a human in front of the send, make sending twice impossible rather
than unlikely, and write down what happened in a form that survives the swap.**

Scope is the server and the staff web. iOS is not involved. §13 is what a second
phase would add.

---

## 1. Decisions

| | |
|---|---|
| **What counts as sold** | A Square **order**, not a drop in inventory. §2 |
| **What a sale is worth** | The item's **listed price**, not the amount collected. The org absorbs discounts. §2 |
| **The org's share** | Set and shown as a percentage; stored and computed as an integer. §3 |
| **Discounts** | Reported, not just absorbed. Every sale below list, itemised and totalled. §5 |
| **Who moves the money** | PatrolKit, through PayPal Payouts, after a human approves. §6 |
| **The client** | Our own thin REST client. There is no maintained Node SDK for Payouts. §6 |
| **Learning what happened** | Webhooks, with a reconcile sweep behind them. §6 |
| **Sending twice** | A stable `sender_batch_id`, and a state machine that cannot re-enter `SENDING`. §7 |
| **Nudges** | Sellers whose payout is sitting unclaimed. §9 |
| **Checks** | Their own page, a CSV carrying name, address, phone and amount, and optional send tracking. §10 |
| **Venmo** | `recipient_type: USER_HANDLE`, so the handle already collected is payable as it stands. §11 |

---

## 2. What a seller is owed

### Square is the source of truth for *whether*; the price list is the source of truth for *what*

Nothing in PatrolKit has ever seen a transaction. `stats.service` computes
revenue as `(originalQuantity − inStock) × priceCents`, and `inStock` is a live
Inventory read — so a volunteer correcting a count by hand is indistinguishable
from a sale, and a refund that never restored inventory stays sold forever.
Paying real money on that inference is not defensible.

So a payout run reads **orders**:

```
POST /v2/orders/search
  location_ids: [swap.locationId]
  query.filter.state_filter.states: ['COMPLETED']
  query.filter.date_time_filter.closed_at: { start_at, end_at }
```

and matches `line_item.catalog_object_id` to `SwapItem.squareVariationId`, which
is already stored. Each matched line is a sale that can be pointed at: an order
id, a time, a quantity, and what was actually collected.

**The amount owed uses `SwapItem.priceCents` regardless of what was collected.**
Discount a $100 pair of skis to $80 at the register and the seller is owed on
$100, leaving the patrol $20 worse off. That is the right way round: the
discount was the org's to give, and a seller who agreed a price should not
discover it was renegotiated without them. What was collected is recorded
anyway, because the org needs to see what its own generosity cost — §5.

### Refunds and returns

A refunded line is not a sale. Square exposes returns on the order and refunds
on the payment; both are read, and a refunded quantity reduces the sold quantity.

A refund landing **after** a payout has been sent is a debt, not a correction —
the money is gone. It is recorded and surfaced on the seller's row and left for
a human, because clawing money back is not something software should attempt on
its own.

### Items that are not owed

- `SwapItem.donateProceeds` — that item's proceeds were given to the patrol.
  Counted as sold, owed to nobody.
- `User.payoutMethod = 'DONATE'` — the whole payout was given. Computed and
  shown as donated, so the patrol can see what it received, and never sent.

---

## 3. The org's share

`SkiSwapSettings` gains `commissionBasisPoints Int @default(0)`.

**Nobody using this ever sees the phrase "basis points."** A patrol sets its cut
as a percentage, because that is what a patrol calls it, and every screen and
export says `20%`. The integer exists because a percent invites `20.5` and a
float has no place in money; it is an implementation detail of the arithmetic
and stays one. Three operations, all of them at the boundary:

```ts
// In. Rounded, because 20.1 * 100 is 2010.0000000000002 and a float is exactly
// what the integer exists to keep out.
const bps = Math.round(Number(percentInput) * 100);

// Compute. Multiply first, divide once, round half up. Never
// `gross * (bps / 10_000)`, which reaches for a float before a rounding rule.
const commissionCents = Math.round((grossCents * bps) / 10_000);
const netCents = grossCents - commissionCents;

// Out. 2050 → "20.5%", 2000 → "20%". No trailing zeros on a round number.
const percent = `${bps / 100}%`;
```

Which fixes the precision at **two decimal places**: 20.5% and 20.25% are
expressible, 20.555% is not. The settings field says so and refuses the rest,
rather than quietly rounding a number and then showing somebody a different one
than they typed.

Rounding is per seller on their total, not per item, so a hundred items do not
accumulate a hundred half-cent decisions. Half goes up, to the patrol — written
down here because a rounding rule nobody chose is a rounding rule somebody
discovers later.

Gross, the percentage, what it came to, and net appear together on review, on
the evidence and on the seller's own page:

```
Sold          $315.00
Patrol (20%)  −$63.00
Payout        $252.00
```

The check CSV carries the net alone, because that is the number a check is
written for (§10).

---

## 4. The model

```prisma
/// One swap's payout run. A swap has at most one open run; closing it is what
/// makes the amounts final.
model PayoutRun {
  id        String    @id
  orgId     String
  swapId    String
  /// DRAFT | REVIEW | CLOSED
  status    String    @db.VarChar(12)
  /// The window the orders were read from, so a re-read is reproducible and a
  /// sale after the run is visibly after it.
  salesFrom DateTime
  salesTo   DateTime
  /// Copied from settings when the run opens. Changing the setting later must
  /// not restate what a seller has already been told they would get.
  commissionBasisPoints Int

  createdAt DateTime  @default(now())
  closedAt  DateTime?
  closedBy  String?

  org   Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  swap  SkiSwap      @relation(fields: [swapId], references: [id], onDelete: Cascade)
  lines PayoutLine[]

  @@unique([swapId, status])   // at most one DRAFT/REVIEW per swap
  @@index([orgId, createdAt])
}

/// What one seller is owed in one run, and what happened to it.
model PayoutLine {
  id       String @id
  runId    String
  sellerId String

  /// Frozen when the run was built, like a receipt's lines.
  sellerName  String
  method      String  @db.VarChar(8)   // PAYPAL | VENMO | CHECK | DONATE
  destination String?                  // resolved at build time — see below
  /// The PayPal `recipient_type`: EMAIL | PHONE | PAYPAL_ID | USER_HANDLE (§11).
  destinationType String? @db.VarChar(12)

  grossCents      Int
  commissionCents Int
  netCents        Int

  /// PENDING | APPROVED | SENDING | SENT | UNCLAIMED | FAILED | RETURNED | PAID_BY_CHECK | DONATED
  status     String    @db.VarChar(16)
  /// Why it is where it is: PayPal's failure reason, or that a held item is
  /// under review.
  statusNote String?   @db.Text

  /// PayPal's own ids, for reconciling against their dashboard.
  payoutBatchId String?
  payoutItemId  String?

  /// Set when a person approved this line. Nothing sends without it.
  approvedBy String?
  approvedAt DateTime?
  sentAt     DateTime?

  /// Check tracking (§10). Null for every other method.
  checkNumber String?
  checkSentAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  run    PayoutRun     @relation(fields: [runId], references: [id], onDelete: Cascade)
  seller SellerProfile @relation(fields: [sellerId], references: [id])
  items  PayoutLineItem[]

  @@unique([runId, sellerId])
  @@index([runId, status])
}

/// The evidence. One row per item sold, as it was.
model PayoutLineItem {
  id     String @id
  lineId String
  itemId String?

  name       String
  sku        String
  /// What the seller was owed on. `SwapItem.priceCents` at run time.
  priceCents Int
  quantity   Int
  /// What Square actually took, which may be less. Recorded so the org can see
  /// what a discount cost it; never what the seller is paid on.
  collectedCents Int
  /// The order this came from, and when. What makes the payout defensible.
  squareOrderId String
  soldAt        DateTime
  refundedQty   Int @default(0)

  line PayoutLine @relation(fields: [lineId], references: [id], onDelete: Cascade)

  @@index([lineId])
}
```

**`destination` is resolved and frozen when the run is built.** Plan 13 was
deliberate that a PayPal-to-email destination stores no handle, so a stale copy
cannot be paid to — the address is read from `verifiedEmail` when the money
moves. Building the run *is* that moment. After it the line carries the address
it will actually pay, and a seller who changes their email mid-run cannot
silently redirect a payment somebody has already approved.

---

## 5. Building a run

`POST /orgs/:orgId/ski-swap/swaps/:swapId/payout-runs` — staff, `ski_swap:admin`.

1. Refuse if a DRAFT or REVIEW run already exists for the swap. One at a time.
2. Read orders for the window and match line items to this swap's items.
3. Group by seller, apply §2's exclusions, compute §3's arithmetic.
4. Write the run, its lines and every `PayoutLineItem`.

A run opens in **DRAFT** and can be rebuilt — orders re-read, lines replaced —
until somebody moves it to **REVIEW**. After that the amounts are what people
are looking at, and rebuilding is refused.

### What review shows

Per seller: name, method and destination, gross, commission, net, and an item
count. Expanding a row gives the evidence — every item, its SKU, what it listed
for, what Square collected, the order id and the time.

Where collected differs from listed, the row says so plainly:

```
Rossignol Experience 88 Ti      $125.00   collected $100.00   −$25.00 to the patrol
```

Totals at the foot: owed, commission kept, discounts absorbed, and — the number
the treasurer actually needs — **what leaves the bank**.

### Discounts are a report of their own

§2's policy is only safe if the difference it absorbs is *visible*. A rule that
quietly costs the patrol money and is never totalled anywhere is how a swap
discovers in April that it gave away more than it kept.

So the run carries a discounts section: every line where Square collected less
than the item listed for, with the item, the seller, both amounts and the gap,
largest first.

```
Discounts given                                    12 items      −$284.00

Rossignol Experience 88 Ti   Dana Reyes   $125.00 → $100.00      −$25.00
Salomon QST 92 180cm         Alex Stone    $90.00 →  $72.00      −$18.00
…
```

Derived from the same `PayoutLineItem` rows the evidence uses — `priceCents`,
`quantity` and `collectedCents` are already on each one and the gap is
`priceCents × quantity − collectedCents` — so it cannot disagree with the
evidence it is drawn from. Three things it has to get right:

- **Only downward.** A line collected *above* list is a register mistake or a
  tip, not a discount. Netting the two together would hide both, so anything
  above list is listed separately as an anomaly.
- **Refunds are not discounts.** A refunded line collected nothing, and counting
  it here would report the whole price as given away. Refunded quantities come
  out before the comparison.
- **Zero collected is flagged, not totalled.** An item that sold for nothing is
  either a deliberate give-away or a match against the wrong catalog object, and
  those want different responses.

Exportable as CSV beside the check list: the person asking "what did we discount"
is doing the books, and answering in a browser tab they cannot paste into a
spreadsheet answers half of it.

---

## 6. Credentials, the client, and approval

### PayPal credentials

`PayPalConfig`, mirroring `SquareConfig`: one row per org, client id and secret
encrypted with the existing `SquareCryptoService` — renamed
`CredentialCryptoService`, since it is not Square-specific and is about to have
a second caller — an `environment` of `sandbox | live`, and an audit row on
every write. Same Administration tab, a second card beside Square's.

**The secret is never returned.** Square's config already reads back
`accessToken: '***'`; this does the same. A "Test connection" button fetches an
OAuth token and reports whether it worked, which is the only honest way to tell
somebody their credentials are right.

### The client: ours, not an SDK

There is no maintained Node SDK for Payouts. `@paypal/payouts-sdk` was last
published around five years ago; PayPal's Payouts SDK page offers Java and
Python only; the current `@paypal/paypal-server-sdk` covers Checkout and Orders.
PayPal's own advice for anything else is to call the REST API directly.

So a small `PayPalClient`, behind an interface, with a stub for tests — the
arrangement `IPosAdapter` already uses for Square. Four calls is the whole
surface, and taking on somebody's abandoned dependency to make them would buy
nothing in the one part of the system that moves money:

```
POST /v1/oauth2/token                       client credentials → bearer
POST /v1/payments/payouts                   create a batch
GET  /v1/payments/payouts/{batch_id}        batch + item statuses
POST /v1/payments/payouts-item/{id}/cancel  cancel an unclaimed item (§9)
```

### Learning what happened: webhooks, with a sweep behind them

PayPal publishes payout events, and they are the right primary signal:

```
PAYMENT.PAYOUTS-ITEM.SUCCEEDED | .FAILED | .BLOCKED | .HELD
PAYMENT.PAYOUTS-ITEM.UNCLAIMED | .RETURNED | .REFUNDED | .CANCELED
PAYMENT.PAYOUTSBATCH.SUCCESS | .PROCESSING | .DENIED
```

Polling alone would be poor: `UNCLAIMED` resolves to `RETURNED` **thirty days**
later, and a poller that must keep running for a month to notice is one that
gets restarted and forgets. Three things come with the webhooks:

- **Verify every delivery.** `POST /v1/notifications/verify-webhook-signature`,
  against the webhook id registered with PayPal. An unverified payout webhook is
  an unauthenticated status change on a money record, and anyone can POST to a
  public URL.
- **Batch events carry no item detail** — PayPal says so explicitly. Treat a
  batch event as "go and look", and read item state from the batch endpoint.
- **A reconcile sweep anyway.** A missed webhook is silent, so a scheduled pass
  re-reads any batch still holding a non-terminal item. Webhooks make it prompt;
  the sweep makes it true.

### Approval

Approval is per line, not per batch. A treasurer happy with thirty-nine of forty
sellers should not have to choose between approving everything and paying
nobody.

- `POST .../payout-lines/:id/approve` sets `approvedBy`, `approvedAt`, and the
  status `APPROVED`.
- A line can be un-approved while it is still `APPROVED`. Once it is `SENDING`
  it is out of anybody's hands.
- Approving is not sending. **Send** is a separate action on the run.

---

## 7. Sending, and never sending twice

This is the part that has to be right.

```
PENDING ──approve──> APPROVED ──send──> SENDING ──> SENT
                        ^                  │          │
                        └──unapprove───────┘          ├──> UNCLAIMED ──> RETURNED
                                                      └──> FAILED
```

**`SENDING` is a one-way door.** The send endpoint moves every `APPROVED` line
to `SENDING` in a single transaction, and only the lines that transaction moved
go into the batch. A second press finds nothing to move and sends nothing. A
crash mid-batch leaves lines in `SENDING` for a human to resolve against
PayPal's dashboard — deliberately, because the alternative is software guessing
whether money left.

**`sender_batch_id` is the run id plus an attempt counter**, stored before the
call. It is a genuine second lock, in PayPal's own words:

> "PayPal does not process duplicate payouts. If you specify a `sender_batch_id`
> that was used in the last 30 days, the API rejects the request… If you receive
> an HTTP 5nn status code, you can safely retry the request with the same
> `sender_batch_id`."

So a lost response is recoverable by design: retry with the same id and PayPal
either completes it once or refuses it as a duplicate. **The guarantee lasts 30
days** — longer than any run should stay open, but not forever. A batch
resurrected months later is a new batch to PayPal, and the state machine, not
the id, is what stops that.

**`sender_item_id` is the `PayoutLine.id`.** It is echoed back on every webhook
and every item in the batch response, so a status maps to a line without a
lookup table. PayPal allows 63 characters; a cuid is half that.

Batch size is not a constraint — the API takes up to 15,000 items, and a swap is
three figures at most.

Item status arrives by webhook (§6) and is confirmed by
`GET /v1/payments/payouts/{batch_id}`. PayPal's nine item statuses map as:

| PayPal | Ours |
|---|---|
| `SUCCESS` | `SENT` |
| `UNCLAIMED` | `UNCLAIMED` — §9 |
| `RETURNED`, `REVERSED`, `REFUNDED` | `RETURNED`, back into review |
| `FAILED`, `BLOCKED` | `FAILED`, with PayPal's reason in `statusNote` |
| `PENDING` | stays `SENDING` — in flight |
| `ONHOLD` | stays `SENDING`, with `statusNote` recording the review |

`ONHOLD` earns its own row rather than being lumped with `PENDING`: PayPal
describes it as under review, which can sit for days, and a treasurer asking
"why has this not landed" deserves better than a spinner. `DENIED` is not in the
table because it is a *batch* status, not an item one.

### A floor

Sending $0.40 costs more than it is worth and clutters a batch. A run refuses to
send a line below a configured minimum — default $1.00 — and marks it for the
next swap or a check. Stated here because the alternative is discovering it as a
PayPal fee.

---

## 8. What the seller sees

Their existing status page gains a payout section: what sold, the arithmetic,
and where the money went. Nothing new to sign in to — the `/s/:sellerId` link is
already on their receipt and their tag.

`SENT` names the destination and the date. `UNCLAIMED` says what they have to do
about it, which is the only state where the seller can act.

---

## 9. Nudging unclaimed payouts

A payout to a destination with no matching account sits **unclaimed** and
returns to the sender after 30 days. Nobody finds out unless we say so, and the
cost of silence is the seller's money.

- On day 7 and day 21 of `UNCLAIMED`, message the seller on their verified
  contact — email if there is one, otherwise SMS. Plan 24's `SendOutcome` and
  `ReceiptDelivery` already do this job; the same pattern, a `PayoutNotice`
  table, so a suppressed nudge is not recorded as sent.
- **A wrong destination need not wait 30 days.**
  `POST /v1/payments/payouts-item/{id}/cancel` returns an unclaimed item's money
  immediately. A seller who says "that is my old email" is fixed the same day:
  cancel, correct the destination, include them in the next batch — rather than
  waiting a month for their own money.
- At day 30 PayPal returns it automatically. The line goes to `RETURNED` and
  back into review, where a human chooses between a corrected destination and a
  check.
- Nudges and returns are visible on the run, so "who has not collected" is a
  screen rather than a memory.

Staff are not nudged. An unapproved run costs nobody anything, and a
notification nobody needs is how notifications stop being read.

---

## 10. Checks

Its own page beside the review, because it is a different job done by a
different person on a different day, and folding it in would put a CSV download
next to a button that moves money.

Lines whose method is `CHECK` never enter a PayPal batch. They are approved the
same way, then exported:

```
Seller name, Street, City, State, ZIP, Phone, Amount, Reference
Dana Reyes, 12 Summit Rd, Stowe, VT, 05672, +15550101001, 252.00, PK-8F3C-0042
```

**The phone is there because an address is not enough to fix an address.** An
undelivered check, a name that does not match, a seller who moved between the
swap and the mailing — each is a phone call, and a treasurer holding a returned
envelope should not have to come back to this screen for the number.
`User.phone` is already on the record.

**Reference is ours, not the check number.** A treasurer's book decides what
number comes next, not us. The reference matches a payment back to a line; the
check number is recorded *after* the check is written, in the tracking below.

Amounts are written as plain decimal strings rather than formatted currency: a
CSV a spreadsheet reads as text or rounds to two decimal places is how
$1,250.00 becomes $1.25. The phone is written as stored, `+1` and all, for the
same reason — a spreadsheet will strip a leading plus given the chance.

### Optional tracking

Off by default, because a swap writing six checks does not need a workflow.
Switched on, each line takes a check number and a sent date from whoever wrote
it, moving the line to `PAID_BY_CHECK`. The page then shows what is still owed
on paper, which is the question the treasurer has in December.

---

## 11. Venmo

Venmo rides PayPal Payouts, and the handle collected at check-in is payable as
it stands: `recipient_type: USER_HANDLE`, with the handle in `receiver` and
`recipient_wallet` set to Venmo. No migration, no enum change, nobody to
re-ask — Plan 13's "your Venmo ID" question was the right one.

| `payoutTarget` | PayPal `recipient_type` | `recipient_wallet` |
|---|---|---|
| `EMAIL` | `EMAIL` | (default, PayPal) |
| `PHONE` | `PHONE` | (default, PayPal) |
| `PAYPAL_ID` | `PAYPAL_ID` | (default, PayPal) |
| `VENMO_ID` | `USER_HANDLE` | Venmo |

### Settle three details in sandbox first

PayPal's documentation and its published OpenAPI spec disagree about Venmo — the
spec omits `USER_HANDLE` entirely and says Venmo requires a mobile number, while
two documentation pages describe the handle. **The documentation is right and
the spec is stale**, which is worth knowing before anybody reaches for the spec
as the authority. It also leaves three details cheap to test and expensive to
guess:

- **The casing of `recipient_wallet`.** Every documentation sample shows
  `"Venmo"`; the spec's enum is `["PAYPAL", "VENMO"]` with
  `pattern: ^[0-9A-Z_]+$`, which would reject `"Venmo"`. One batch settles it.
- **Whether `note` is required.** The spec says Venmo payouts require one, the
  guide calls it optional. Send one regardless — the swap's name, which is what
  the seller sees beside the money — and the question stops mattering.
- **Whether a handle needs its `@`.** Unstated either way. Try both and
  normalise on the way in, so two sellers who typed it differently are not paid
  differently.

Venmo payouts are US-only and USD-only. A seller outside the US cannot be paid
this way whatever their handle says, and that is worth catching at check-in
rather than at a batch.

---

## 12. Other risks

- **Orders matching.** An item sold through a Square catalog object we did not
  create — a manual register entry, a mis-scan — will not match and will not be
  paid. The run reports unmatched line items rather than silently dropping them.
- **The window.** A swap has no end date, only `active`. The run takes an
  explicit `salesFrom`/`salesTo`, defaulted from the first and last item
  timestamps, and shows it — "which sales are in this run" must be a question
  with a visible answer.
- **Test mode.** A run can point at PayPal's sandbox while reading a real
  Square. Useful, and worth being loud about on screen: a sandbox run that looks
  like a live one is its own hazard.

---

## 13. Not in this plan

- **Refund clawback.** Recorded and surfaced, never automated.
- **Partial payouts** of one seller across several runs.
- **1099 / tax reporting.** A real obligation above a threshold, and its own
  plan.
- **Square webhooks.** Plan 6 was drafted and never built. Orders are read in a
  batch at run time, which is enough for a payout and avoids standing up an
  event pipeline to answer a question asked once per swap.
- **iOS.** Nothing here belongs on a check-in iPad.

---

## 14. Testing

Money, so the bar is higher than usual: every arithmetic path unit-tested, and
every state transition exercised against a real database.

**Unit**
- Commission: rounding at the half cent, zero percent, and that per-seller
  rounding does not drift across many items.
- The percent boundary, both ways: `"20.5"` stores 2050 and renders `20.5%`,
  `"20"` renders `20%` and not `20.00%`, and a percent with three decimals is
  refused rather than quietly rounded.
- Owed: listed price used, collected ignored, `donateProceeds` excluded,
  `DONATE` sellers computed but never sent, refunds subtracted.
- Status mapping: each of PayPal's nine item statuses lands somewhere, and an
  unrecognised one fails loudly rather than defaulting to `SENT`.
- Destination building: each `payoutTarget` produces the `recipient_type` §11's
  table says it should, and a `VENMO_ID` line — and only a `VENMO_ID` line —
  carries `recipient_wallet` and a note.

**Smoke** (`smoke-payouts.mjs`), against a real API and database
- A run built from fixture orders produces the expected lines and evidence.
- **Pressing send twice sends one batch.** Asserted by counting what reaches a
  stubbed PayPal, not by reading a status back.
- A line leaves `SENDING` only through a verified webhook or the reconcile
  sweep.
- An unapproved line is never in a batch.
- The check CSV parses; amounts and phone numbers survive the round trip as
  strings, `+1` and all.
- A forged `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` aimed at a `SENDING` line changes
  nothing — an unverified webhook is an unauthenticated write to a money record.
- A webhook that never arrives is caught by the sweep, so the two paths agree
  rather than one silently covering for the other.
- Assert the fixture before the behaviour: a run with no lines approves, sends
  and reconciles perfectly while proving nothing.

**Not** a live PayPal call in CI. The client is behind an interface with a stub,
the way the POS adapter already is.
