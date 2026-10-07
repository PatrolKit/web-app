# Plan 43: Returning unsold items to their sellers

## Goal

At the end of a swap, staff hand unsold items back to their sellers and record each one as **returned**. A returned item comes off sale in Square, so it can't ring up after it has left the building. It stays on the seller's record, saying when it went back and who handed it over.

Two ways to record a return:

- **Scanning on the web.** Staff scan a stack of tags, or type their SKUs. Each scan returns that item at once and answers on a big banner (green, amber or red, with an icon and the reason), as the other scan screens do. Every scan also stays in the session's list, with its seller and name, so a wrong pile shows as it's scanned. A session is open to any seller by default; staff can lock it to one seller, so another seller's item is refused instead of returned.
- **On the iPad.** Offline-first, like everything else it does: a return is queued locally and sent when the iPad reaches the server. The server builds the API; the iPad's side is a handoff (`IPAD_HANDOFF.md`, written once the API is final).

With returns recorded, every accepted item ends the swap **sold** (Square says so), **returned**, or **neither**. Neither means missing, and staff go and look for it.

## What's already here

- **Items.** `SwapItem` has `consignedAt` / `consignedBy` (accepted, and by whom; a user id or a device id), `deletedAt` (soft delete), `squareItemId` / `squareVariationId`, and `originalQuantity`. Nothing for returned.
- **Sold.** Sold comes from Square only. `ItemService.soldAmong` reads inventory counts in one call; stock below 1 is sold, and a failed read answers "none sold". `IssuedTicketService.remove` makes the same check more strictly: a failed read keeps the ticket. Payouts read Square's completed orders and match them to items on `squareVariationId`, deleted items included.
- **Taking items out of Square.** "Return unused tickets" (`IssuedTicketService.remove`) soft-deletes tickets nobody described and deletes them from Square with `pos.deleteItems`. A Square failure is only logged.
- **Web scanning.** `BatchAddTicketsModal` and `ScanTicketModal` take Bluetooth scans through `ScannerContext.subscribe`, with a typed fallback (`TypedCode`), the shared banners and error tone in `ScanSessionParts.tsx`, and pure list logic beside each modal (`batchAddLogic.ts`, `scanTicketLogic.ts`). `GET items/by-sku/:sku` finds an item by its tag.
- **The iPad.** It queues work in `sync_queue` (`OutboundQueue.swift`), drained in order with one `Idempotency-Key` per mutation, and replays it in `SkiSwapSyncModule.perform` per (entity, operation). It pulls item changes with `GET items?walk=true&updatedSince=…`, so any write that moves `updatedAt` reaches it. A tombstoned (`deletedAt`) item is deleted from the iPad, so a return mustn't be a soft delete. `ItemController` admits the staff check-in iPad (`OrDeviceAuthGuard`, `@RequireDeviceRole('ski_swap.staff_check_in')`); a route opts out with `@NoDeviceAccess()`.
- **Diagnostics** (Plan 41) raises "Only in PatrolKit" for a live, accepted item Square doesn't have. Unchanged, it would raise every returned item.
- **Display.** `itemState()` on the Items page checks not received → not in Square → stock unknown → for sale → sold. The dashboard pie checks sold → no price → no description → not on sale → for sale. The public seller page shows Sold / Waiting / Not yet sold.
- **Audit.** `AuditLog` (`action`, `actorType`, `actorId`, `targetType`, `targetId`, `metadata`). No item action is audited today.

## Decisions

| # | Decision |
|---|---|
| D1 | **A return is a state of a live item, not a delete.** New `SwapItem` columns: `returnedAt`, `returnedBy` (a user id or a device id, as `consignedBy` is) and `returnedUnits` (how many went back: `originalQuantity` less any sold). The item stays live, so it stays on the seller's record, on the iPad, and in reconciliation. |
| D2 | **What can be returned:** an accepted item (`consignedAt` set), not deleted, not already returned, with at least one unit unsold.<br>• **Sold:** every unit sold, per Square. Refused, `ITEM_SOLD` ("Sold Sat 2:14 PM. It shouldn't be in the return pile"): the guard against handing back something a buyer paid for.<br>• **Partly sold** (quantity above 1): the unsold units are returned, and `returnedUnits` says how many.<br>• **Square can't be read:** returned anyway, since the item in staff's hands is good evidence it didn't sell. The answer says "Couldn't check Square".<br>• **Not accepted yet:** refused, `NOT_RECEIVED`. It was never on sale.<br>• **Already returned:** not an error. "Already returned at 2:14 PM by Pat", so a double scan is harmless. |
| D3 | **Off sale means deleted from Square** (`pos.deleteItem`), as returned tickets are. The stored Square ids are kept. No sales history is lost: sales are read from Square's completed orders, which a catalog delete doesn't change, and payouts match them on the stored id, so a partly sold item's sales still count. Deleted rather than set to 0 in stock, because Square still sells an item at 0, and 0 in stock already means sold to `soldAmong`, the Items page and the seller page. If Square refuses the delete, the return stands, the failure is logged, and Diagnostics raises it (D9). |
| D4 | **Undo,** on the web: clears the three columns and puts the item back in Square as a new Square item, storing its new ids. Refused for an item with any units sold, since the new ids would orphan those sales; add the rest as a new item instead. |
| D5 | **Locking to a seller is optional.** A session starts unlocked, open to any seller's items, which suits a mixed pile. Staff can lock it to one seller at any point and unlock it again; the session's list carries on either way. Locked, another seller's item is refused, not returned (`WRONG_SELLER`, naming whose it is), and the session also shows that seller's items still out (accepted, unsold, not returned), shrinking as scans land, so staff can see when a seller is done. |
| D6 | **Who.** On the web, `ski_swap:manage`. On the iPad, the staff check-in device role. Undo is web only (`@NoDeviceAccess`). |
| D7 | **When a return happened.** The web uses the server's time. The iPad sends `returnedAt` as the moment of the scan, which may be hours before it syncs; the server accepts it when it falls between the item's acceptance and now (plus a minute for clock drift), and otherwise uses its own time. |
| D8 | **Audited:** `ski_swap.item.returned` and `ski_swap.item.return_undone`, with the item, SKU, seller, actor (user or device), units, and whether Square was checked. A dispute ("I never got my boots back") is answered from it. |
| D9 | **Diagnostics.** A returned item isn't expected in Square, so it's never "Only in PatrolKit". A Square item whose SKU is a returned item is a new issue, **Returned, still in Square** (the D3 failure), with choices **Remove from Square** · **Mark resolved**. |
| D10 | **Shown wherever an item's state is.**<br>• **Items page:** state **Returned** (checked first, the date in its tooltip) and a **Returned** filter.<br>• **Dashboard pie:** a **Returned** slice, checked right after Sold.<br>• **Public seller page and the seller's own items:** the status reads **Returned to seller**, the date in its tooltip.<br>• **Not on receipts:** a receipt is what was dropped off, and doesn't change. |
| D11 | **Out of scope:** items never picked up (abandoned or donated), seller sign-off, telling sellers pickup is open, an end-of-swap reconciliation report, and sellers recording returns from their own accounts. Each is its own follow-up. |

## Server

### Migration

- `SwapItem.returnedAt DateTime?`, `returnedBy String? @db.VarChar(191)`, `returnedUnits Int?`. Additive, nullable, no backfill.
- Index `(swapId, returnedAt)`, for the filter and the dashboard.

### Returning (`ski-swap/item-return.service.ts`, new)

- `returnItem(orgId, swapId, itemId, { actor, returnedAt?, sellerId? })`, the one path both routes use:
  1. Load the live item.
  2. Refuse `NOT_FOUND`, `NOT_RECEIVED`, or `WRONG_SELLER` (a `sellerId` that differs; the message names whose it is). An item already returned answers `already_returned`, with who and when.
  3. Read units sold in one `getInventoryCounts` call. All sold is `ITEM_SOLD`; a failed read is "unchecked".
  4. Write conditionally (`updateMany where returnedAt: null`), so two devices returning the same item can't both win. Audit.
  5. Delete from Square after the write, logging a failure (D3). The answer doesn't wait on Square.
- `undoReturn(orgId, swapId, itemId, actorId)`: refused with any units sold. Clears the three columns, clears the Square ids, re-pushes through `syncItemToPos`, and audits.
- The answer: the item (`ItemResponse`, with the new fields), `outcome: 'returned' | 'already_returned'`, `squareChecked`, and the seller's display name.

### Routes (`item.controller.ts`)

- `POST …/swaps/:swapId/items/:itemId/return`: body `{ returnedAt?: ISO, sellerId?: string }` and an `Idempotency-Key` header. Staff and the check-in iPad.
- `POST …/swaps/:swapId/items/return-by-sku`: body `{ sku, sellerId? }`, for the web scanner; the same service, finding the item by `liveSku`. Staff only.
- `DELETE …/swaps/:swapId/items/:itemId/return`: undo. Staff only.
- `GET …/swaps/:swapId/sellers/:sellerId/unreturned`: the locked session's list (D5), the seller's accepted, not-returned items with units still in stock, from one inventory read. Staff only.

### Elsewhere

- **`ItemResponse`** gains `returnedAt`, `returnedBy` (display name) and `returnedUnits`; the iPad's walk carries them.
- **List filter:** `ITEM_LIST_STATUSES` gains `returned`; `not_in_square` excludes returned items.
- **`ItemBreakdownService`:** a `returned` count, checked after sold.
- **Diagnostics:** `ourItems` leaves returned items out. `diagnose` takes the returned SKUs and raises `returned_in_square` for a Square item matching one, with the choice `remove_from_square` (`pos.deleteItems`). The fix paths that set `consignedAt` skip returned rows.
- **Public seller page and seller self-service:** the returned state (D10).

## Web

- **`ReturnItemsModal.tsx`,** opened from the Items page's Actions ("Return items"), or from **Return items** on a seller's page, which opens it locked to that seller. Built from the scan screens' shared parts (`ScanSessionParts.tsx`): the scanner banner, the typed-SKU fallback, `Banner` and `errorTone()`.
  - **The seller, at the top:** a searchable picker, "Any seller" (unlocked, the default) or one seller (locked, D5), changeable at any time.
  - **The latest scan, on a banner that can't be missed:**

    | Outcome | Banner | Icon | Says |
    |---|---|---|---|
    | Returned | green | check | "Returned to Little Mountain" · SKU · name · price |
    | Already returned | green | check | "Already returned at 2:14 PM by Pat" |
    | Couldn't check Square | amber | warning | "Returned. Couldn't check Square: if it sold, find the buyer's receipt" |
    | Sold | red, error tone | stop | "Sold Sat 2:14 PM. It shouldn't be in the return pile" |
    | Not this seller's | red, error tone | stop | "This is Geigers' item, not Little Mountain's. Not returned" |
    | Not received | red, error tone | stop | "Never accepted: it was never on sale. Not returned" |
    | Not found | red, error tone | stop | "No item has this SKU in this swap" |
    | Not sent | red | warning | "Couldn't reach PatrolKit. Not returned", with **Retry** |

    On a green banner the seller's name is the largest text, so a wrong pile shows at a glance. `Banner` gains an amber `warn` tone.
  - **The session's list, below:** every scan, newest first: SKU, seller, name, price, and its outcome as a small badge in the banner's color and icon. Counts at the top ("18 returned · 2 refused"). A returned row has **Undo** while the modal is open; a refused row says why; a "Not sent" row has **Retry**.
  - **Locked, a second list:** the seller's items still out, ticked off as they're scanned, reading "All returned" at zero.
  - **One request per scan,** never batched, so what the screen says is what the server did.
  - **Pure logic** (rows, outcomes, counts, the locked seller's remaining list, retry) in `returnItemsLogic.ts`, beside the modal.
- **Items page:** the Returned state and filter, and **Undo return** in a returned item's row menu.
- **Dashboard:** the Returned slice.
- **Public seller page:** "Returned to seller", the date in its tooltip.

## iPad (handoff)

`docs/plan/43_item_returns/IPAD_HANDOFF.md`, in the shape of Plan 38's:

- **What reaches the iPad:** `returnedAt`, `returnedBy` and `returnedUnits` on items in the walk; `POST items/:itemId/return`, with its body, key and refusals.
- **What it needs:**
  - **Storage:** an `ItemRecord` migration for the three fields.
  - **Offline:** a "Return items" scan screen that finds items by SKU in the local mirror and shows seller and name. It queues an `item` / `return` mutation with `Idempotency-Key` `"<itemId>-return-<scannedAt>"` and `returnedAt` as the scan time, and shows the item returned at once.
  - **Replay:** a `perform` case for the return. `ITEM_SOLD`, `NOT_RECEIVED` and `WRONG_SELLER` are final refusals, shown on the item for staff; `already_returned` is success.
  - **Display:** returned items marked wherever items are listed.
- **How we'll know:** acceptance checks, including a return made in airplane mode and synced later.

## Rollout

1. Build and test locally against a copy of the database: the web flow end to end with the stub Square, and the API from a script as the iPad calls it.
2. Write `IPAD_HANDOFF.md` against the API as built.
3. Migrate and deploy, after asking: the swap is live, and the change is additive.
4. Smoke in the test org: a return, a refusal, a double scan, an undo, and Diagnostics with a returned item.

## Tests

- **`item-return.service.spec.ts`:**
  - each refusal and its code;
  - already returned is not an error;
  - partly sold returns the rest;
  - Square unreadable still returns, with `squareChecked` false;
  - of two simultaneous returns, one wins;
  - a device's `returnedAt` is kept inside the window and replaced outside it;
  - a failed Square delete keeps the return;
  - undo is refused with sales, and re-pushes without;
  - both are audited.
- **Diagnostics:** a returned item isn't "Only in PatrolKit"; a returned SKU still in Square is `returned_in_square`.
- **Breakdown and list filter:** Returned counted and filtered; `not_in_square` excludes it.
- **Web:** `returnItemsLogic` (rows, outcomes, the locked seller's remaining list, retry); `itemState` puts Returned before anything else.

## Open questions

1. **Not picked up:** is there a pickup deadline after which items are donated or become the patrol's? That would be a second outcome beside Returned (D11).
2. **Proof:** is staff's record enough, or should a seller sign or confirm?
3. **Timing:** when is pickup? That decides whether this ships during this swap or after it.
