# To the iPad: issued tickets are items from the start

**From:** the server (Plan 38). **When:** once the server deploys.

## Why

When staff issue a block of legacy tickets to a shop, the server now creates
every ticket in it at once: an item named `Item #<number>`, with no price, the
shop as seller, accepted and on sale in Square. Before, a ticket existed only
once its stub was entered, and a missed stub meant an item on the floor that
Square didn't know.

## What reaches the iPad

**No new endpoints or fields.** Issued tickets are ordinary items, and they
arrive by the usual sync. A shop issued 500 tickets brings 500 items, mostly
`Item #…` with no price.

**Ranges are gone.** The server no longer keeps ticket ranges, and a ticket's
holder is its item's seller. The iPad never read ranges, so nothing to remove.

## What the iPad needs

1. **Scanning a ticket that's already an item:** refuse it, saying whose,
   rather than "already checked in". The holder is the local item's seller,
   and the server words it the same way: "Ticket 67169 belongs to Stowe
   Sports." That includes a shop's own tickets, which are items already.

   The local check is in `LegacyTicketRules.swift:67-82`, against
   `existingSkus` from `SellerDetailView.swift:38-42`.
2. **The server's refusal, for a queued create that loses a race:**
   - **What it is:** `409` with `code: "TICKET_TAKEN"` and the same sentence.
   - **What to do:** drop the queued create and show the sentence. Retrying
     can't succeed.
   - **Where:** `SkiSwapSyncModule.swift:412-453` already dead-letters a legacy
     collision; key it on the code.
3. **Seller pages:** a shop's page lists its issued tickets like any items.
   Nothing to change unless the list is slow at several hundred. If it is, a
   search or an "untouched" filter is the iPad's call.

## How we'll know

- **A shop's issued ticket:** scanning it at check-in is refused, naming the
  shop.
- **A queued create the server refuses with `TICKET_TAKEN`:** dropped with the
  server's sentence, and not retried.
