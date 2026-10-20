# To the iPad: a comped item shows "Comped" to staff (server Plan 53)

> **Status:** live on patrolkit.io.

## Why

Staff can now **comp** an item on the web (Ski Swap → Adjustments → Comps): mark it sold when Square has no trace of it selling, so its seller is paid the list price. Customers see a comped item as sold. **Patrol staff see "Comped"**, with the reason to hand, and that includes the staff iPad.

The iPad doesn't comp anything. It only shows the state.

## What changes on the server

Every staff item response (the item lists, by-SKU lookup, the scan lookup, and the item returned after an edit) gains one field:

```json
"comp": {
  "id": "c1x…",
  "priceCents": 6000,
  "units": 1,
  "reason": "OUTSIDE",
  "note": "Paid cash at the counter",
  "compedAt": "2026-10-19T15:02:11.000Z",
  "compedBy": "user id"
}
```

- `null` when the item isn't comped. Absent on an older server, so treat missing as `null`.
- `reason` is one of:
  - `OUTSIDE`: "Paid outside Square";
  - `NOT_FOUND`: "Sold, no sale found";
  - `LOST`: "Lost or damaged";
  - `OTHER`: "Other".
- A comped item is also sold in every other way: Square's stock is 0, and pickup refuses it, as for any sold item.

## What the iPad should do

- Wherever staff see an item's status, show **Comped** instead of **Sold** while `comp` is set, with the reason. The note is optional to show.
- Nothing customer-facing changes: the seller status page and seller website already say "Sold" and carry no `comp`.

## Since this was first sent (2026-10-19)

Three more server and web changes went live. None changes the item contract above, and none needs work on the iPad:

- **Comping and undoing are on Adjustments → Comps only.** The web's Items list no longer has "Comp…" or "Undo comp"; it shows the Comped status, as the iPad should. The iPad still only shows the state.
- **The Items search ranks its matches.** The exact ticket number comes first, then other tickets containing the search, then names, then items that matched only by seller. It affects the item list only when a `query` is sent with no `sort`. The iPad sends neither: it reads items with `walk=true`, which is unchanged.
- **The web's Reports tab is now Verify**, at `/dashboard/ski-swap/verify`. The iPad has no links to it.

So the work for the iPad is still just the Comped state described above.
