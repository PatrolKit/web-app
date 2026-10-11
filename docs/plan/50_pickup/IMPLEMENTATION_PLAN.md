# Plan 50: "Returned" becomes "picked up"

**Status:** deployed 2026-10-11, with nothing yet picked up in production. iPad pickups stay off until the iPads run the iOS rename ([IOS_HANDOFF.md](IOS_HANDOFF.md)).

## Why

At the end of a swap, sellers collect their unsold items. Plan 43 called that a **return**, the same word a sale uses for a customer bringing something back (Square refunds, Sales check, Plan 49's exchanges). Two meanings for one word in the same screens invite mistakes, so the end-of-swap one is now **pickup** everywhere: code, database, API and every screen.

## Decisions

| | Decision |
|---|---|
| D1 | **Words:** the status, filter and dashboard say **Picked up**; the scanning screen, and the action that opens it, are **Pick up items**; its undo is **Undo pickup**. |
| D2 | **Database:** the columns are renamed by a hand-written migration (`RENAME COLUMN`, `RENAME INDEX`): names change, data stays, and MySQL 8 does it instantly. Prisma's own rename would drop and re-add the columns, losing every pickup. |
| D3 | **API:** a hard cutover. The old routes and fields go away when this deploys; there are no aliases. The iPads must be on the iOS rename first (see Rollout). |
| D4 | **Stored values are rewritten:** Catalog check issues and hidden issues of kind `returned`, Catalog check notes keyed on it, and the audit actions `ski_swap.item.returned` / `ski_swap.item.return_undone`. Only the new names exist afterwards. |
| D5 | **Other "returns" keep the word**, because they mean something else: a sale's refund or return (Square, Sales check), an exchange's item coming back (Plan 49), PayPal's `RETURNED` payout status, and a shop returning unused tickets (Plan 38). |

## What changed

**Database** (`20261026120000_pickup_rename`):

| Before | After |
|---|---|
| `SwapItem.returnedAt` | `pickedUpAt` |
| `SwapItem.returnedBy` | `pickedUpBy` |
| `SwapItem.returnedByName` | `pickedUpByName` |
| `SwapItem.returnedUnits` | `pickedUpUnits` |
| index `SwapItem_swapId_returnedAt_idx` | `SwapItem_swapId_pickedUpAt_idx` |
| `SwapDiagnosticIssue.kind` / `SwapDiagnosticHidden.kind` `returned` | `picked_up` |
| `SwapIssueNote.issueKey` `…\|returned\|…` (catalog) | `…\|picked_up\|…` |
| `AuditLog.action` `ski_swap.item.returned` / `.return_undone` | `ski_swap.item.picked_up` / `.pickup_undone` |

**API** (under `orgs/:orgId/ski-swap/swaps/:swapId/items`):

| Before | After |
|---|---|
| `POST :itemId/return` (iPad and web), body `{ sellerId?, returnedAt? }` | `POST :itemId/pickup`, body `{ sellerId?, pickedUpAt? }` |
| `DELETE :itemId/return` (undo, web) | `DELETE :itemId/pickup` |
| `POST return-by-sku` (web) | `POST pickup-by-sku` |
| `GET unreturned?sellerId=` (web) | `GET awaiting-pickup?sellerId=` |
| outcome `returned` / `already_returned` | `picked_up` / `already_picked_up` |
| error code `NOT_RETURNED` | `NOT_PICKED_UP` |
| item fields `returnedAt`, `returnedBy`, `returnedUnits` | `pickedUpAt`, `pickedUpBy`, `pickedUpUnits` |
| item list `?status=returned` | `?status=picked_up` |
| public status `returned` | `picked_up` |
| dashboard breakdown `returned` | `pickedUp` |
| Catalog check kind `returned` | `picked_up` |

Refusal messages end "Not picked up." instead of "Not returned.". The other codes (`ITEM_NOT_FOUND`, `NOT_RECEIVED`, `WRONG_SELLER`, `ITEM_SOLD`, `PARTLY_SOLD`) are unchanged.

**Server code:** `ItemReturnService` is `ItemPickupService` (`item-pickup.service.ts`), with `pickUp`, `pickUpBySku`, `awaitingPickup` and `undo`.

**Web:** the Items page's "Return items to sellers" is **Pick up items**, a seller row's "Return items" is **Pick up items**, the status badge and filter say **Picked up**, "Undo return" is **Undo pickup**, the dashboard pie says **Picked up**, Catalog check says **Picked up, still in Square**, and sellers' own pages and the public status page say **Picked up**.

## Rollout

The order matters. With a hard cutover, an old iPad that replays a queued pickup gets a 404. Its sync treats that as a refusal and **undoes the pickup on the iPad**, losing it.

1. The iOS rename is built and ready to install (see the handoff).
2. Pick a quiet time, after the swap closes for the day. On every iPad, make sure the sync queue is empty (no pending pickups).
3. Deploy the server. The migration renames the columns and rewrites the stored values; the release restarts the app. Item reads fail for the few seconds between the migration and the restart.
4. Update every iPad straight away. Until an iPad is updated, its pickups fail and its item list stops showing what was picked up.
5. Check:
   - an item picked up before the change still shows **Picked up** on the web and the iPad;
   - a new pickup works from the web and from an iPad, including one queued offline;
   - Catalog check runs, and any old "picked up, still in Square" issue appears under its new name.

There is no quick rollback: the previous build can't run against the renamed columns. Going back means a migration that renames them back.
