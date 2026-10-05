# Plan 38: Issuing tickets puts them on sale

## Goal

When staff issue a block of legacy tickets to a business seller, every ticket
in it becomes an item at once: in the system, in Square, and scannable at the
register. Today a ticket exists only once its stub is entered, so a stub that
goes missing leaves an item on the floor that Square has never heard of.

An issued ticket is an ordinary ticket with no description and no price yet
(Plan 32): "Item #67169", sold at whatever price the register types. Entering
its stub later describes and prices it.

Ranges stop being tracked. The Sellers page keeps its form for issuing a
block, which now simply creates the tickets. A shop's tickets are the ticket
items it holds, and nothing else records them.

## Decisions

| # | Decision |
|---|---|
| D1 | **Issuing a block creates its tickets.** Each number becomes an item: SKU the number, named `Item #<number>`, no price, the shop as seller, one of it, its tag already printed, and accepted (on sale) at once, by whoever issued it. Issuing is staff accepting the whole block in advance. |
| D2 | **No range bookkeeping.** `LegacyTicketRange` is dropped. Who holds a ticket is its item's seller. What used to come from ranges now comes from items: which numbers are taken, who holds one, and which sellers have tickets. |
| D3 | **A block that overlaps existing items is refused whole,** listing them: "67012 and 67013 are already items (Stowe Sports)." Nothing is created until the block is clear. |
| D4 | **No size limit.** Creating the items is quick and done before the request answers. Putting them in Square runs in the background, in batches, with progress on the Sellers page (D9). |
| D5 | **Issued tickets are like any other ticket with no description or price.** They show everywhere tickets show: Items, the shop's My Items, the iPad, the public status pages, receipts and counts ("Needs a price"). |
| D6 | **A shop may describe and price its own ticket once.** While a ticket of theirs is untouched (no price, no description, no notes) and unsold, the shop may save its description, price and notes, one at a time or by file. After that one save it's locked to the shop, and only staff can change it. Refusals are `409` with `TICKET_DESCRIBED` or `TICKET_SOLD`. |
| D7 | **Shops no longer create tickets.** Every number a shop holds already exists. A shop's ticket entry becomes choosing one of its untouched tickets (lowest first) and filling it in, and a shop file's ticket rows update its tickets. A number the shop doesn't hold is refused: "67169 isn't one of your tickets." Items without a ticket (Plan 31) are unchanged. |
| D8 | **A ticket that's already an item is refused, saying whose:** `409` `TICKET_TAKEN`, "Ticket 67169 belongs to Stowe Sports." This covers the iPad's counter check-in and every other create, the shop's own number included: its ticket exists, to be described. The iPad's own check says the same (handoff). |
| D9 | **Square in the background:** after issuing, the new tickets are pushed in batches (`BatchUpsertCatalogObjects`, then inventory in batches of 100). The shop's ticket panel shows "Putting tickets in Square: 120 of 500" until done. If the push stops (a restart, a Square error), the panel says how many aren't in Square and offers **Put them in Square**, which resumes. |
| D10 | **Removing returned tickets:** |
| | • **One at a time:** the Items row's Delete, as today. |
| | • **By range:** "Remove 67400–67499" for a shop deletes that shop's tickets in the span that are untouched (D6) and unsold, and takes them out of Square in batches. It keeps the rest and lists why: described, priced, or sold. A ticket whose sale Square can't confirm either way is kept. |
| D11 | **Staff can always edit,** whatever the shop did, as today. Fast Edit (Plan 37) works on issued tickets unchanged: they're unpriced tickets. |
| D12 | **When issuing is offered:** when the swap takes legacy tickets anywhere (`allowLegacyCheckin` or `allowLegacyWeb`, Plan 34), as ranges are today. A shop describes its tickets online only where the swap's web takes legacy tickets (`allowLegacyWeb`). |
| D13 | **Photos:** a shop may add and remove photos on its own ticket until it sells, described or not. The item form adds them just after the save that describes the ticket. |
| D14 | **Only shops are on issued tickets.** An individual's loose ticket, checked in at the counter, is theirs, but it doesn't put their self check-in or their own page "on tickets". |

## Server

### Schema (migration `…_issued_tickets`)

- **Drop `LegacyTicketRange`** and its relations on `SkiSwap` and
  `SellerProfile`. Production holds none outside the smoke org. Ask "migrate in
  place" at deploy: dropping a table is destructive, even an empty one.
- **No new item fields.** "Untouched" (D6) is derived: no price, the stand-in
  name, no category, no notes.

### Issuing (`legacy-ticket.service.ts`, `seller.controller.ts`)

- **`POST …/sellers/:sellerId/tickets/issue` `{ swapId, startNumber, endNumber }`**,
  needing `ski_swap:admin`.
  - **Refuses:** an end before the start; a seller who isn't a business seller
    in the org; a swap that takes no legacy tickets (D12); any overlap (D3).
  - **Writes** the items with `createMany`, in one transaction, consigned by
    the caller (D1).
  - **Answers** `{ created, numbers: [start, end] }`, then starts the Square push
    (D9).
- **`POST …/sellers/:sellerId/tickets/remove` `{ swapId, startNumber, endNumber }`**,
  `ski_swap:admin`, per D10. Answers `{ removed, kept: [{ sku, why }] }`.
- **`GET …/sellers/:sellerId/tickets?swapId=`:** the shop's ticket summary.
  - **Runs of consecutive numbers:** "67000–67499".
  - **Counts:** issued, described or priced, and not yet in Square. Sold is
    left out: it would cost a Square read on every view.
  - **Replaces** the ranges list.
- **Gone:**
  - `GET/POST/DELETE …/ticket-ranges`;
  - `addRange`, `removeRange`, `holderOf`, `assertUsable`, `assertNotExhausted`,
    `suggestNext`, and the ranges half of `formState`.
- **`ticket-sellers`** (who staff may upload for): sellers holding ticket items
  in the swap, instead of sellers holding ranges.

### Square, in batches (`square.pos.adapter.ts`, `item.service.ts`)

- **`syncItemsBatch(items)`:**
  - creates or updates catalog objects in `BatchUpsertCatalogObjects` calls of
    up to 1,000;
  - stores each item's Square ids from the id mappings;
  - sets inventory in `BatchCreateChanges` calls of 100.
  - A batch that fails is retried once, then left for the resume (D9).
- **`deleteItemsBatch(squareItemIds)`:** `BatchDeleteCatalogObjects`, 200 per
  call, for D10.
- **The background push:**
  - one per org at a time, in process, after the issue answers;
  - it picks up the swap's consigned ticket items that have no Square id, so a
    resume is the same call;
  - progress is read from the rows, not held in memory, so it survives a
    restart.

### Creates and shop edits

- **Every create of a ticket number** (`ItemService.create`): an existing live
  item with that SKU is a `409`, `code: "TICKET_TAKEN"`, naming its seller (D8).
  The check comes before the insert; the unique index stays the guard.
- **Shop self-service** (`seller-self.service.ts`):
  - **Ticket entry:** becomes "describe ticket N". `PATCH` of one of the shop's
    own untouched, unsold tickets, setting any of description, category and
    answers, price and notes. It's refused once touched or sold:
    "Ask the swap's staff to change 67169."
  - **`assertNotAccepted`** gives way to the D6 rule for ticket items. Other
    items keep today's rule.
  - **The shop's file:** a ticket row updates that ticket under D6. A number the
    shop doesn't hold is a row error (D7). The whole file is checked before
    anything is written, as today.
  - **The form state:** the shop's untouched tickets, lowest first, replace the
    next-number suggestion. "All your tickets are described" replaces
    "exhausted".
- **Staff file import** (`importForSeller`): a ticket row updates the shop's
  existing ticket (staff aren't held to D6). A number that isn't issued to that
  shop is a row error. Generated-SKU rows still create.
- **Selling checks:** "unsold" for D6 and D10 is Square's inventory for that
  ticket, read in one batch per request (`fetchInventoryMap`).

## Web

- **`SellerTicketSource.tsx`:** for the chosen swap, the shop's ticket summary:
  - the runs, with counts;
  - the Square progress, or **Put them in Square** (D9);
  - **Issue tickets** (start, end): it shows "This creates 500 tickets and puts
    them on sale" before confirming;
  - **Remove tickets** (start, end): it lists what was kept, and why.
- **Shop's My Items (`BusinessSellerPage.tsx`):**
  - **Add for a ticket:** a ticket picker over its untouched tickets, lowest
    first, then the item form, then one save.
  - **Touched tickets:** read-only, with "Ask the swap's staff to change this."
  - **The upload's wording:** "Describe your tickets", not "Add".
- **`ProxyItemImportModal`:** the eligible-sellers list per the new
  `ticket-sellers`, and the wording for ticket rows ("updates ticket 67169").
- **Messages:** "Ticket 67169 belongs to Stowe Sports." wherever a create is refused
  (D8).

## iPad

There's a short note in [IPAD_HANDOFF.md](IPAD_HANDOFF.md). Issued tickets
arrive by the usual item sync, so the iPad needs no new endpoints:
- **Scanning one** is refused, saying whose (D8).
- **Shops show their tickets** in the seller page, like any items.

## Rollout

1. **Migration:** drops `LegacyTicketRange`. Production has no ranges outside
   the smoke org. Ask "migrate in place".
2. **Smokes using ranges move to issuing:** `smoke-legacy-tickets`,
   `smoke-loose-tickets`, `smoke-mixed-tickets`, `smoke-proxy-import`,
   `smoke-unpriced-tickets` and `smoke-checkin`, where they issue ranges.
3. **New `smoke-issued-tickets.mjs`,** in the smoke org, which has no Square:
   - an issue creating items with the right fields;
   - an overlap refused, listing numbers;
   - a shop describing a ticket once, then refused;
   - a shop file updating tickets;
   - a create of an issued number refused with its holder;
   - a remove by range keeping touched ones.
   The Square batches can only be checked against a real Square account: the
   first issue on BMBWAV's swap, with staff watching the progress line.
4. **The iPad note** goes to the iOS repo after the deploy.

## Tests

- **Issue:**
  - fields per D1;
  - D3's refusal listing every overlap;
  - D12's gate;
  - a large block written in one `createMany`.
- **Push:** batching (1,000 and 100), id mapping back to rows, one retry, and
  resume picking up only what isn't in Square.
- **Remove by range:** untouched and unsold removed; described, priced, sold and
  unknown kept with reasons; the Square deletes batched.
- **Shop edits:**
  - one save on an untouched ticket;
  - refused after, when sold, or when not theirs;
  - non-ticket items unchanged.
- **Files:** shop and staff ticket rows updating, unheld numbers refused, and
  nothing written when any row fails.
- **Create:** an issued number refused with `TICKET_TAKEN` and the holder.
- **Web:** the shop's ticket picker order, and the issue and remove forms'
  messages.
