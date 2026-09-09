# Plan 16 — Accepting an item before it goes on sale

A seller can check themselves in and put an item on the floor without anyone
having looked at it. Some organisations want a staff member to see it first.

## 1. The gap

Self check-in ends at `CheckinService.finish`, which prints a receipt and pushes
the whole batch to Square. From that moment the items are sellable at the
register. The seller then waits by their pile for staff to come and collect it.

Between those two things is a judgement nobody currently gets to make. A staff
member picks up a pair of skis, sees the delamination the seller did not
mention, and declines to take it — but the item is already in Square, already
priced, already scannable. Nothing in the system records that it was refused,
and the only way to stop it selling is to notice and go and delete it.

`SwapItem` has no notion of being accepted. `hasPrintedTag` is the nearest
thing, and it records what came out of a printer, not what a person decided.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | The toggle is read **once, at check-in**, and its answer stored on the row | Never consulted again. An item is waiting or it is not; flipping the setting later cannot change what is already on the floor. Everything below falls out of this. |
| D2 | Only **self check-in** items wait | Anything a staff member typed — the staff iPad, the web Items page, a business seller's own list — was already in somebody's hands. A second handling buys nothing. |
| D3 | An item is in Square **if and only if** it is consigned | One rule for "on sale", checkable in one query. Deferring the push is what actually stops a refused item selling; a flag beside a live Square item would not. |
| D4 | A refused item is simply **left unconsigned** | No reject action, no reason codes. Staff put it back in the seller's hands and walk on; the system's job is to not sell it. |
| D5 | Scanning is **one item at a time**, against a running list | It matches going through a pile, and it is the only shape that works when some of a seller's items are accepted and some are not. |
| D6 | `consignedAt`, a nullable timestamp — not a status enum | A timestamp cannot contradict itself the way a status plus a date can, and *when* an item was accepted is the question asked when a seller disputes what happened. |
| D7 | Existing rows backfill to **consigned** | They are on the floor. A migration that made live inventory disappear would be a worse bug than the one this fixes. |
| D8 | Consigning needs the staff iPad or `ski_swap:manage` | The same authority that already edits items. |

### 2.1 Why D1 is the whole design

Store the toggle's answer at creation and three problems solve themselves.

**Turning it on mid-swap.** Items checked in this morning were created with the
toggle off, so they carry a `consignedAt` and stay on sale. Items checked in
after the switch carry null and wait. Nothing is recomputed and nothing on the
floor changes, because the row already knows.

**Turning it off mid-swap.** The reverse, and equally uneventful: items already
waiting go on waiting, because their row says so. If staff want them live they
scan them, which is the same action as before.

**Reading.** No screen has to fetch the setting to know what an item is. `null`
means waiting, a date means accepted, and that is true regardless of what the
org has since decided.

The cost is that the toggle describes *what happens next*, not *what is true
now* — an administrator who switches it on and expects the floor to empty will
be surprised. §4.1 says so on the switch itself.

## 3. The model

One nullable column and one boolean setting.

```prisma
model SwapItem {
  // …

  /// When a staff member accepted this item onto the floor.
  ///
  /// Null means it is waiting to be seen: the seller has tagged it and is
  /// standing beside it. An item is pushed to Square when this is set and
  /// never before, so null is also the answer to "can this be sold".
  ///
  /// Set at creation for everything except a self check-in at an org that has
  /// `requireConsignmentScan` on — the setting is read once, here, and never
  /// again (D1).
  consignedAt DateTime?
  /// Whoever accepted it: a user id, or a device id when the staff iPad did.
  /// The audit log carries which of the two, so this does not need to.
  consignedBy String?

  @@index([swapId, consignedAt])
}

model SkiSwapSettings {
  // …

  /// Whether a self check-in item waits for a staff member to scan it before
  /// it goes on sale. Off by default: an org that has not asked for the extra
  /// step should not get it.
  requireConsignmentScan Boolean @default(false)
}
```

The migration backfills `consignedAt = createdAt` for every existing row (D7),
which is both true and the only safe reading — those items are on the floor now.

## 4. The screens

### 4.1 The toggle — Administration

Beside "Labels per item", which is the other org-wide ski-swap setting:

```
Accepting items
  [•] Staff must scan self check-in items before they sell

  A seller who checks themselves in tags their items and waits. Nothing
  they entered reaches the register until a staff member scans it.

  Applies to items checked in from now on — anything already on the
  floor stays there.
```

That last line is the honest half of D1 and belongs on the control, not in a
release note.

### 4.2 Accepting items — the staff iPad

The iPad already authenticates as `ski_swap.staff_check_in` and can reach the
item routes. It needs two things it does not have: a way to find an item by the
number on its tag, and a way to accept it.

```
Accepting — Dana Reyes
  Waiting  3      Accepted  2

  [ scan a tag ]

  ✓ SS26-Q-0041  Volkl Kendo 88 skis      $249
  ✓ SS26-Q-0042  Smith Vantage helmet      $65
    SS26-Q-0043  Salomon QST boots        $180
    SS26-Q-0044  Poles                     $20
    SS26-Q-0045  Ski bag                   $35
```

Scanning a tag accepts that item and moves it up. What stays below the line is
what the seller still has in their hands — including anything staff have decided
not to take, which simply never gets scanned (D4).

The seller is identified by the first tag scanned; the list is that seller's
unconsigned items for the running swap.

### 4.3 What the seller sees

`FinishStep` currently tells a seller their items are checked in. With the
toggle on, that is not yet true, and the receipt should not imply it:

> **Checked in — waiting to be accepted**
> Stay with your items. A volunteer will come and look through them.

The public seller status page lists unconsigned items as *waiting*, so a seller
who checks later can see which of their things were taken.

### 4.4 The dashboard

A count of items waiting, next to the existing tiles, shown only when the toggle
is on and the number is above zero. It is the operational question during a
swap — how many people are still standing next to a pile — and a tile that reads
zero every day stops being read.

## 5. Validation

| Rule | Behaviour |
|---|---|
| Consigning an item that is already consigned | Accepted, unchanged. A scanner double-reads a barcode constantly; the second one must not be an error. |
| Consigning an item in another org or swap | 404 — the same shape as every other cross-org lookup. |
| Scanning a SKU that does not exist in this swap | "No item in this swap has tag SS26-Q-0041." |
| Scanning a tag belonging to another seller mid-list | Accepted, and the list switches to that seller — staff work through piles, not through our idea of a session. |
| Consigning when the toggle is off | Accepted and a no-op: the item is already consigned, because it was consigned at creation. |
| A device without `ski_swap.staff_check_in`, or a user without `ski_swap:manage` | Refused (D8). |

Exact-match lookup is a new query. `ItemService.list` searches `sku` with
`contains`, which is right for a person typing into a search box and wrong for a
scanner: `67169` would also match `671690`.

## 6. Square, and what "active" comes to mean

Today `finish` pushes every item in the batch. With the toggle on it pushes
none, and each item goes up as it is accepted (D3).

This makes an invariant worth stating plainly, because it is the thing that
actually protects the seller from a refused item selling: **an item is in Square
exactly when `consignedAt` is set.** Not a flag beside a live catalogue entry,
not a price of zero — absent from the catalogue entirely.

Two consequences:

**Photos land later.** `attachPendingPhotos` runs on the Square sync, so a photo
taken at check-in attaches when the item is accepted rather than at finish. That
is the same path the deferred station push already uses; nothing new breaks.

**`finish` reports differently.** Its `squareFailures` count is about a push that
no longer happens there. With the toggle on it should say what it did — a
receipt printed, items awaiting acceptance — rather than reporting zero failures
of nothing.

## 7. Phases

1. **The column and the rule.** `consignedAt`, `consignedBy`,
   `requireConsignmentScan`, the backfill, and the decision at creation. Items
   start being marked; nothing reads it yet.
2. **Square follows consignment.** `finish` pushes only consigned items; the
   consign path pushes as it accepts. This is the phase that changes behaviour,
   and it is worth landing on its own so a regression here is unambiguous.
3. **The toggle.** Administration, with the copy from §4.1.
4. **Accepting.** Exact-SKU lookup, the consign endpoint, the unconsigned filter
   on the item list — everything the iPad needs. The iPad screen itself is the
   iOS repo's work; this phase is the handoff.
5. **Telling people.** The finish screen, the seller status page, the dashboard
   count.

1 and 2 together are the feature; 3 makes it reachable; 4 and 5 make it usable.

## 8. What this costs, honestly

**A seller can be told to wait and then nobody comes.** The system has no
opinion about how long an item sits unconsigned, and nothing chases it. A swap
that turns this on and then gets busy will have sellers standing next to piles
with no idea whether they have been forgotten. The dashboard count is the only
thing that surfaces it, and only to someone looking at the dashboard.

**Refused and unseen look identical** (D4). "Not consigned" covers both the pair
of skis a volunteer declined and the pile nobody has reached yet — for the
seller, for staff, and in any report. That is the accepted trade of not building
a reject action, and it is fine while a person is standing there to explain. It
would not be fine as the basis of a settlement report.

**An item accepted by mistake is not easily un-accepted.** Nothing here removes
a `consignedAt` — the way back is deleting the item, which for a legacy ticket
also frees its number. Worth knowing before someone scans a whole pile by
accident.

**Turning the toggle on does not secure a swap already in progress** (D1). Every
item checked in before the switch is still on sale, unlooked-at. The copy in
§4.1 says so, but somebody will still expect otherwise.

## 9. Out of scope

- **A reject action, with reasons and counts.** D4 settles this for now. If
  "how much did we turn away" becomes a question, that is when the second state
  earns itself.
- **Un-accepting.** See §8. Deleting the item is the way back.
- **Chasing items that sit unconsigned.** No timer, no alert, no queue age. The
  dashboard count is the whole of it.
- **Business sellers and staff-entered items.** D2 — they never wait.
- **The iPad screen.** §4.2 describes what it needs to do; building it is the
  iOS repo's work, and this plan's job is the endpoints it calls.
