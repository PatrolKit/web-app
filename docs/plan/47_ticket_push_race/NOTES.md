# Plan 47: Duplicate Square items from the ticket push race

**Status:** implemented on 2026-10-09 (`square-create-claim.ts`, the three create paths, and link-before-create in the Square adapter). Not deployed yet: it needs the additive migration `20261021120000_square_create_claim`.

## What happened

On 2026-10-09 at 16:41 UTC, tickets 74819–74822 each ended up as **two** active Square items in the "Ski Swap 2026" category, both variable-priced and both named "Item #748xx".
- PatrolKit stored one id per ticket; the other copy was an orphan it didn't know.
- Scanning one of those tickets offered the clerk two matches.
- A sale on an orphan is invisible to PatrolKit: the item stays for sale, the seller goes unpaid, and the payout lists an unmatched sale.

The four orphans were archived that afternoon, but Square still scans archived items. At 21:12 UTC ticket 74820 sold on its archived orphan: $10.00, Yvonne Leroy's ticket. Plan 48's Sales check is how that sale gets credited; the orphans themselves are to be deleted (Plan 48, Catalog check).

## Evidence (production log, 16:41 UTC)

- **The iPad** POSTed `/items` five times, about a second apart (PatrolKit iOS, `CFNetwork/3860.70`). It created 74819–74822 one at a time: `createdAt` 16:41:38.364, 39.495, 40.658 and 41.904. Each request took about a second, which is the Square sync inside it.
- **The web** POSTed `/items/batch-tickets` at 16:41:38.872. It answered in 33 ms, and its Square push ran in the background.
- **Each orphan** was last updated at 16:41:39–50, while the iPad's creates were in flight.

## Cause

Three paths create Square items. None of them claims an item before creating it, so any two can create the same one.

1. **`ItemService.create` and `patch`** (`item.service.ts`, `syncItemToPos` → `pushToPos` → `pos.syncItem`):
   - inserts or updates the row;
   - creates the Square item, which takes about a second;
   - only then writes `squareItemId`.
   - Station check-ins defer this (`deferPos`) and push later the same way.
2. **`IssuedTicketService.push`** (`issued-ticket.service.ts`):
   - runs after `addTickets` (batch tickets, or issuing a block), and from `pushImported`;
   - `pendingTickets` selects **every** consigned, ticket-numbered item of the swap with `squareItemId: null`, not just the rows it was called for;
   - `pushPending` then creates them all with `pos.syncNewItems`.
3. **`ItemService.pushImported`** (file imports, `pos.upsertItems`), and diagnostics' "Copy to Square" (`upsertItems`):
   - `pushImported` calls `issued.push` first, on purpose. Its comment: an import that fills in tickets issued moments before must not create them a second time.

On 10-09, path 2's sweep picked up the iPad's four tickets during the second that path 1 was creating them. Both created a Square item; whichever wrote `squareItemId` last won, and the other was orphaned.

`push` serialises only itself, per swap (`this.pushing`). Nothing coordinates path 1 with path 2 or 3.

**Checking Square first isn't enough on its own.** For the second a create is in flight, Square doesn't have the item yet, so a second path that looks finds nothing and creates its own. The fix has to stop two paths starting the same create.

## Fix

### 1. Claim before creating (the fix)

- **The claim columns:** `SwapItem.squareCreateClaim` (a token) and `squareCreateClaimedAt`, an additive migration.
- **Taking the claim:** before creating an item in Square, a path claims it in one statement:
  - `UPDATE SwapItem SET squareCreateClaim = <token>, squareCreateClaimedAt = now() WHERE id IN (…) AND deletedAt IS NULL AND squareItemId IS NULL AND (squareCreateClaim IS NULL OR squareCreateClaimedAt < now() − 2 min)`.
  - It then reads back the rows holding its token and creates only those: Prisma `updateMany`, then `findMany`.
  - Rows it didn't get are someone else's, mid-create, so it skips them.
- **Releasing it:** writing `squareItemId` clears the claim. A failed create clears it too, so the next push retries.
- **Where it applies:** every path that creates, through one helper (`claimForSquareCreate`): `syncItemToPos` when the item has no `squareItemId`, `pushPending`, `pushImported`, and diagnostics' "Copy to Square".
- **A crash mid-create** leaves the claim to expire after two minutes. A sweep after that runs into fix 2.

### 2. Link before creating (the safety net)

Before creating Square items for SKUs, look in the swap's category for **active** items with those SKUs, and link one rather than create.
- It goes in the adapter, so every path gets it: `syncNewItems`, `upsertItems` (rows with no `posItemId`) and `syncItem` (no `posItemId`, or a stored id Square no longer has).
- It uses `itemsBySku(categoryId, skus)`, 100 SKUs per search, which already exists.
- **One active match:** use its item and variation ids, then upsert our data over it at its current version, as an update would.
- **More than one:** link the same one every time (the lower item id; Square doesn't give a creation time), and log it, so Catalog check can report the rest.
- **None:** create, as today.
- **Archived matches never count:** an archived item can't be sold through a link. They're Catalog check's to delete (Plan 48), since archived items still scan.

This covers the cases fix 1 can't: a crash mid-create, or an orphan from before the fix.

### 3. Narrow the sweep

- **Batch tickets:** `addTickets` passes the ids it just created to `push`, which pushes those.
- **Imports:** `pushImported` passes the ticket rows it is about to fill in, so its "push them first" ordering holds.
- **The resume:** the unparameterised sweep stays, for tickets a failed push left behind. With fix 1 it skips anything another path holds.

This removes wasted Square calls; fixes 1 and 2 are what stop duplicates.

### 4. Catch it if it happens anyway

- **Catalog check** (Plan 41's diagnostics, moving to Reports in Plan 48) reports a SKU on two Square items in the category ("twice"). These four would have shown there.
- **Sales check** (Plan 48) shows any sale that lands on a copy, with "Credit to …".

## Tests

- **The claim:** two concurrent pushes of the same unsynced item create exactly one Square item. The loser skips it and reads back the winner's ids. This is the 10-09 case, as a test, with the adapter delayed a second.
- **The claim expires:** a claim older than two minutes is taken over.
- **A failed create clears the claim,** and the next push retries.
- **`pushImported`:** ticket rows it fills in are pushed once, whether or not a batch push for them is in flight.
- **Link before creating:**
  - `syncNewItems` and `upsertItems`, given SKUs already active in the category, upsert at those versions and create nothing;
  - `syncItem` links on no `posItemId`, and on a stored id Square no longer has;
  - an archived match is ignored.
- **Regression:** a batch of new tickets with nothing in Square still creates every one, 500 per call, with starting stock.

## Rollout

1. **Migrate**, additively: `SwapItem.squareCreateClaimedAt`.
2. **Deploy.**
3. **Run Catalog check** on the swap, and expect no "twice".

## Done on 2026-10-09 (Square only, no code)

- **Last year's swap:** archived the 7,832 items under "Swap" / "2025". 1,008 of their numbers collided with this year's tickets (e.g. 73789). Archiving didn't stop them scanning: 31 sales landed on them that day. Delete them before the next sales day (Plan 48).
- **Test items:** archived nine leftover test items ("Test Item", "Test Web Item"; SKUs `SS26-0001` and `SS26-0002`).
- **This race:** archived the four orphans; one still took a sale (above).
- **Last year's leftovers:** archived four outside any category ("53451", "53431", "84100", "Swap Item 84097").
- **Unrelated but the same day:** every PatrolKit item's Square variation is now named for its SKU, so receipts show the ticket (commit `8303d66`, deployed).

## Elsewhere

- **Plan 48 (Reports):** Sales check for mis-rung sales; Catalog check, with a catalog-wide duplicate check (`elsewhere`) and deleting or re-numbering the other copy.
- **Closing a swap:** delete or re-number that swap's Square items, so next year's paper tickets (bare numbers, no prefix) never meet this year's. Not yet planned.
- **Price corrections:** a "Price correction" discount in Square, which payouts would treat as the sold price. Not yet planned.
