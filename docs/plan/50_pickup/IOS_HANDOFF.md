# iOS handoff: "returned" becomes "picked up" (server Plan 50)

The server and web now call the end-of-swap handback a **pickup** instead of a **return**, so it isn't confused with a sale's return. The rename is a **hard cutover**: the old routes and fields are gone, with no aliases. The iPad app has to make the matching change and ship before, or together with, the server deploy.

Server details: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## API changes the app must follow

| | Before | After |
|---|---|---|
| Pick up one item | `POST …/items/{itemId}/return` | `POST …/items/{itemId}/pickup` |
| Request body | `{ "returnedAt": "…", "sellerId": "…" }` | `{ "pickedUpAt": "…", "sellerId": "…" }` |
| Answer `outcome` | `"returned"` / `"already_returned"` | `"picked_up"` / `"already_picked_up"` |
| Item fields | `returnedAt`, `returnedBy`, `returnedUnits` | `pickedUpAt`, `pickedUpBy`, `pickedUpUnits` |
| Error code (web undo only) | `NOT_RETURNED` | `NOT_PICKED_UP` |
| Refusal sentences | end "Not returned." | end "Not picked up." |

The idempotency key works as before. Unchanged: `squareChecked`, and the codes `ITEM_NOT_FOUND`, `NOT_RECEIVED`, `WRONG_SELLER`, `ITEM_SOLD`.

## Where the app uses the old names

Found by a read of `patrolkit_ios` at `8645665`:

- **`Services/SkiSwapAPIClient.swift`**
  - the `…/items/\(itemId)/return` path (around line 1015);
  - `ReturnItemPayload.returnedAt`;
  - `APIItemReturn` and its `outcome` strings;
  - `APIItem.returnedAt`, `returnedBy` and `returnedUnits`.
- **`Services/SkiSwapSyncModule.swift`**
  - the `("item", "return")` replay (around line 305), its `already_returned` comment, and `api.returnItem`;
  - the rejection branch (around line 459), which calls `store.undoItemReturn`;
  - the queue label `"Item return"` (around line 508);
  - the mapping of `returnedAt`/`returnedBy`/`returnedUnits` into the record (around line 566).
- **`Services/PatrolKitStore+SkiSwap.swift`**
  - the queue `operation: "return"` (around line 1393);
  - `applyItemReturn` and `undoItemReturn`.
- **`Services/PatrolKitStore.swift`**
  - migration `v30-item-returns` added the `items` columns `returnedAt`, `returnedBy`, `returnedUnits` and `returnRefusalCode`.
- **`Features/SkiSwap/Modes/Returns/`**
  - `ReturnItemsModel`, `ReturnItemsView` and `ReturnSellerPicker`;
  - the results `.returned` and `.alreadyReturned`;
  - the text "Returned to seller", "Already returned" and "All returned".
- **`Features/SkiSwap/Modes/SkiSwapMode.swift`**
  - `case endOfSwapReturns = "end_of_swap_returns"`, titled "End-of-Swap Returns";
  - its blurb "Scan unsold gear back out to its sellers."
- **`Features/SkiSwap/SkiSwapCoordinator.swift`:** `case .endOfSwapReturns`.
- **Tests:** `PatrolKitTests/ItemReturnTests.swift` and `PatrolKitTests/Support/FakeSkiSwapAPI.swift` (`returnItemHandler`).

## What to change

1. **API client and models.** Use the new path, body field, outcomes and item fields. Rename the types to match, e.g. `PickupItemPayload`, `APIItemPickup`, `pickUpItem(…)`.
2. **Local database.** Add a GRDB migration that renames the `items` columns to `pickedUpAt`, `pickedUpBy`, `pickedUpUnits` and `pickupRefusalCode` (`ALTER TABLE … RENAME COLUMN`), so pickups already on the iPad are kept. Don't edit `v30`; add a new migration after it.
3. **Sync queue.** Rename the operation `"return"` to `"pickup"`, and have the upgrade's migration rewrite any queued `"return"` rows to `"pickup"`, with their payload's `returnedAt` renamed to `pickedUpAt`. A queued pickup must survive the upgrade.
4. **After upgrading, re-read items in full.** Reset the items delta cursor once, so every item's `pickedUpAt`/`pickedUpBy`/`pickedUpUnits` comes down under the new names. Between the server deploy and this iPad's update, its deltas would have cleared them.
5. **Screens and wording:**

   | Before | After |
   |---|---|
   | Mode "End-of-Swap Returns" | **End-of-Swap Pickup** |
   | Mode blurb "Scan unsold gear back out to its sellers." | "Scan unsold gear as its sellers pick it up." |
   | "Returned to seller" (· 2 of 3) | **Picked up** (· 2 of 3) |
   | "Already returned" | **Already picked up** |
   | "All returned" | **All picked up** |
   | "Item return" (queue label) | **Item pickup** |

   Match the web's banners: "Picked up by {seller}", "Already picked up by {seller}", "Sold: not picked up", "Never accepted: not picked up", "Not sent: not picked up", "Not picked up".

6. **Mode raw value.** If the selected mode is stored, e.g. in `UserDefaults`, rename `end_of_swap_returns` to `end_of_swap_pickup` and map the old stored value to the new case, so an iPad left in that mode stays in it.
7. **Code names.** Move `Modes/Returns/` to `Modes/Pickup/` and rename `ReturnItemsModel`/`View`/`SellerPicker`, `.returned`/`.alreadyReturned`, `applyItemReturn`/`undoItemReturn` and the test file to match.

## Keep "return" where it means a sale's return

Square refunds, receipts and anything about a customer bringing back what they bought keep the word. Only the end-of-swap handback changes.

## Shipping

The server deploy and the iPad update go together:

1. The iPad build is ready.
2. At a quiet time, every iPad's sync queue is empty.
3. Deploy the server.
4. Update every iPad straight away.

An iPad still on the old build after the deploy gets a 404 for each pickup. Its sync treats that as a refusal and undoes the pickup on the iPad, so don't run pickups on an old iPad after the deploy.

## Tests to carry over

The cases in `ItemReturnTests.swift`, under the new names, plus two new ones:

- **Queued pickup survives the upgrade:** a pickup queued under the old `"return"` operation, with `returnedAt` in its payload, replays as `POST …/pickup` with `pickedUpAt`.
- **Local pickups survive the migration:** an item picked up before the migration still has its `pickedUpAt`, `pickedUpBy` and `pickedUpUnits` afterwards.
