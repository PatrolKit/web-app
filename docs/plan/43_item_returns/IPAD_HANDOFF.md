# To the iPad: returning unsold items to their sellers

**From:** the server (Plan 43). **When:** once the server deploys.

## Why

At the end of a swap, staff hand unsold items back to their sellers. The
server now records each one as **returned**: when, by whom, and how many
units. A returned item is taken out of Square, so it can't ring up after it
has left the building. It stays live on the seller's record. **A return is a
state, not a delete:** the item keeps arriving in the walk, with `deletedAt`
null.

The web has a scan screen for this. The iPad needs one too, and it must work
offline, since pickup happens wherever the sellers are.

## What reaches the iPad

### New fields on every item in the walk

`GET items?walk=true&updatedSince=…` carries three new fields, null unless
the item is returned. A return moves `updatedAt`, so it arrives in the next
delta like any edit.

| Field | Type | Meaning |
|---|---|---|
| `returnedAt` | ISO string or null | When it went back to its seller. |
| `returnedBy` | string or null | Who handed it back: a person's name, or a device's name. A display name, not an id. |
| `returnedUnits` | int or null | How many units went back: the quantity less any sold. Below `originalQuantity` means some sold. |

An item that comes back with `returnedAt` null after being returned has had
its return **undone** on the web. Clear the local fields.

### One new endpoint

```
POST /api/v1/orgs/:orgId/ski-swap/swaps/:swapId/items/:itemId/return
Authorization: Bearer <device token>        (role ski_swap.staff_check_in)
Idempotency-Key: <itemId>-return-<scannedAt>
Content-Type: application/json

{ "returnedAt": "2026-10-19T18:02:11.000Z", "sellerId": "…" }
```

- **`returnedAt`** (optional, send it): the moment of the scan. The server
  keeps it when it falls between the item's acceptance and now (plus a minute
  for clock drift), and uses its own time otherwise. A return queued offline
  for hours keeps its real time.
- **`sellerId`** (optional): only if the iPad's screen is locked to one
  seller. The server then refuses another seller's item (`WRONG_SELLER`). Omit
  it for an open session.
- **`Idempotency-Key`:** a replay with the same key returns the first answer
  unchanged.

**Success, `200`:**

```json
{ "item": { …ItemResponse, with returnedAt / returnedBy / returnedUnits… },
  "outcome": "returned" | "already_returned",
  "squareChecked": true | false }
```

- `already_returned` is **success**: another iPad or the web got there first.
  The item carries who and when.
- `squareChecked: false` means Square couldn't be read, so the return was
  recorded without checking for a sale. Worth a quiet note ("Couldn't check
  Square"), not a failure.

**Refusals** use the usual envelope, `{ success: false, error, code, details }`.
`error` is a sentence written for the person at the counter. Show it as is.

| HTTP | `code` | Meaning | What the iPad does |
|---|---|---|---|
| 409 | `ITEM_SOLD` | Square says every unit sold. It shouldn't be in the return pile. | Final. Undo the local return, and flag it loudly: the item may already be in the seller's hands. |
| 409 | `NOT_RECEIVED` | Never accepted, so never on sale. | Final. Undo the local return and show the sentence. |
| 409 | `WRONG_SELLER` | Not the locked seller's item. `details.owner` names whose it is. | Final. Undo the local return and show the sentence. |
| 404 | `ITEM_NOT_FOUND` | No live item with that id in that swap (deleted since). | Final. Undo the local return and show the sentence. |

All four are already final in `SkiSwapSyncModule.perform`'s error handling
(`conflict`, and `clientError` other than 408 and 429). They only need
recording on the item (see 3 below).

### Not for the iPad

These are web-only, and an iPad token gets `403` on each:

- `POST items/return-by-sku` (the web scanner's route);
- `GET items/unreturned?sellerId=` (the locked session's still-out list);
- `DELETE items/:itemId/return` (undo).

The iPad finds items by SKU in its own mirror, and sends the item id.

## What the iPad needs

1. **Storage.** Add a migration `v30-item-returns` with `returnedAt`,
   `returnedBy` and `returnedUnits` (all nullable) on `items`:
   - `ItemRecord`, at `PatrolKitStore+SkiSwap.swift:339`;
   - the migrator, after `v29-show-us-boot-sizes` in `PatrolKitStore.swift:658`;
   - `APIItem` in `SkiSwapAPIClient.swift:184`;
   - the mapping in `SkiSwapSyncModule.itemRecord(from:)` at `:528`.

   An inbound item with `returnedAt` null clears them, because the return was
   undone.
2. **A "Return items" scan screen.**
   - It finds the scanned SKU in the local mirror and shows the seller's name
     largest, then SKU, name and price, so a wrong pile is obvious.
   - It shows a big green, amber or red result per scan, as the other scan
     screens do, and lists the session's scans, newest first.
   - It has an optional seller lock, which is what sends `sellerId`.
   - **On a scan:**
     - set the item's `returnedAt` to now;
     - set `returnedBy` to this iPad's name;
     - mark it pending;
     - queue an `item` / `return` mutation with payload
       `{ swapId, returnedAt, sellerId? }` and `Idempotency-Key`
       `"<itemId>-return-<scannedAt>"`.

     Show it returned at once.
   - **Refuse locally, without queueing:**
     - an SKU not in the mirror ("Not found");
     - an item already returned ("Already returned at 2:14 PM by Pat");
     - another seller's item when locked.
   - **Sold and never-accepted come only from the server.** The iPad holds no
     stock (Plan 39), and doesn't know whether an item was accepted.
3. **Replay,** in `SkiSwapSyncModule.swift`:
   - **`perform` (`:234`):** add a case `("item", "return")` that POSTs and
     applies the returned `item` with `applyServerItem`. Both outcomes are
     success.
   - **`recordRefusal` (`:423`):** add a case `("item", "return")` that clears
     the local return and marks the item with the server's sentence.
     `ITEM_SOLD` needs to stand out: it means a buyer paid for something
     that may have gone home with the seller.
   - **`describe` (`:478`):** add `"Item return"`.
   - **`SkiSwapAPIClient`:** add `returnItem(orgId:swapId:itemId:payload:idempotencyKey:token:)`.
4. **Display.** Wherever items are listed (a seller's page, search), a
   returned item reads **"Returned to seller"**. When `returnedUnits` is below
   the quantity, add "· 2 of 3". It's done, so it isn't on sale and isn't
   missing.
5. **No undo on the iPad.** A mistaken return is undone on the web, and the
   iPad picks up the cleared fields in the next delta.

## How we'll know

- **Online:** scanning an unsold item shows it returned at once. On the web
  it reads "Returned to seller", by this iPad's name, and it's gone from
  Square.
- **Offline (airplane mode):** scan three items, then reconnect. All three
  sync, each with its **scan** time as `returnedAt` rather than the sync time.
- **Two devices:** scan the same item on the iPad and on the web. Both show
  it returned; the second sees `already_returned`, not an error.
- **Sold:** scan an item Square shows sold. The queued return is refused
  with `ITEM_SOLD`, the local return is undone, and the item is flagged with
  the server's sentence.
- **Locked:** lock to one seller and scan another seller's item. It's refused
  on the iPad, and nothing is queued.
- **Undo on the web:** the item's return clears on the iPad after the next
  delta.
