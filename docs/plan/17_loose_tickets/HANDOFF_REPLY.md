# Reply to patrolkit_ios Plan 10 — Ask I

Landed. `legacyTicketsEnabled` is on `SkiSwap`, in `SwapResponseSchema`, settable
through `PatchSwapSchema`, and on the Swaps page under `ski_swap:admin`. Named as
asked, default off, absent reads as off.

Three things changed on the item path that were not in the ask. Two of them
change what the iPad sees.

## The switch

```ts
// SwapResponse
legacyTicketsEnabled: boolean
```

Read it on the ordinary swap sync; no new endpoint. `PATCH /orgs/:orgId/ski-swap/swaps/:swapId`
takes it alongside `title`, `active` and `locationId`.

Existing swaps that already had ticket blocks issued were backfilled to `true` —
they plainly accept tickets, and defaulting them off would have taken a working
feature off the screen on deploy. Everything else starts `false`.

Turning it off does not invalidate blocks already issued: a shop holding paper
can still enter those items, and staff can still see and remove the blocks. What
it stops is issuing new ones, and the web UI for doing so.

## What the iPad must now handle: two refusals

There is **one stockpile**, spent two ways — blocks handed to a business seller
to fill in beforehand, and loose tickets given out at the counter. Both become
`SwapItem.sku`, so they can collide, and nothing physical stops the wrong ticket
coming off the wrong pile. Both of these come back as **409** with a message
written for a volunteer to read aloud. Show it; neither is a crash.

**The ticket is already on an item.**

```
409  Ticket 67169 is already on another item.
```

A re-scan, or two stations working the same pile. Before this it was an
unhandled unique-constraint failure — a bare 500 with nothing to act on — so if
you have a workaround for that, it can go.

**The ticket belongs to a business seller's block.**

```
409  Ticket 67169 is part of a block issued to Alpine Sports.
```

The number was issued to a shop. Staff take it back and hand out a different
one. A business seller entering their own number is the ordinary case and is
unaffected — the block is theirs.

Neither refusal is gated on `legacyTicketsEnabled`. The switch decides whether
you offer the button; the server checks the number regardless of what any client
believes.

## A fix that changes a field you already read

`hasPrintedTag` now comes back **`true`** when you send `alreadyPrinted: true`.

It was being written to the row and then reported as `false`, because the
response was built before the write. Every legacy-ticket item came back claiming
its tag had not been printed — so a client offering a reprint for anything
unprinted was offering to reprint a ticket that came out of a box. If you worked
around that, undo it.

## What did not change

`CreateItemSchema` still takes `sku` and `alreadyPrinted`; the item path is
otherwise as it was. `@@unique([swapId, sku])` is still what enforces one ticket
to one item — it is now translated on the way out rather than escaping raw.

A scanned number is **not** checked against a declared stockpile range. There is
no such thing: any number not already used and not inside a shop's block is
accepted, so a mis-scan is taken at face value and surfaces later as a duplicate
when the real ticket turns up. That was a deliberate call — say so if you would
rather the server knew which numbers exist.

## Verified

8 unit tests, 15 smoke assertions against a real database, and the web gating
checked in a browser with the switch both ways. `smoke-loose-tickets.mjs` covers
the collisions the unique index has to catch.
