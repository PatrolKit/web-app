# Plan 16 — what the server does, for the iPad

The server half is built and deployed. This is what it gives you and what it
expects back. The accepting screen itself (§4.2 of the plan) is yours.

## The one rule

An item is in Square **exactly when `consignedAt` is set**. Not flagged, not
priced at zero — absent from the catalogue. That is what actually stops a
refused item ringing up at the register, and it means `consignedAt` is the whole
answer to "can this be sold".

Consigning an item is what puts it in Square. There is no second step.

## What waits

Only a self check-in at a station, at an org that has turned the scan on. The
setting is read **once, at check-in**, and its answer stored on the row. Nothing
reads it again.

So: do not fetch the org setting to decide what an item is. `consignedAt === null`
means waiting; a date means accepted. That holds regardless of what the org has
since decided, which is the point — an admin who flips the toggle mid-swap does
not move anything already on the floor.

Items that never wait, whatever the setting says: anything a staff member
entered (including from your own iPad), and anything entered away from a
station — a business seller listing stock from their desk.

## Endpoints

All three are on the existing item controller and reachable with your
`ski_swap.staff_check_in` device token — no new auth.

**Find an item by the number on its tag.**

```
GET /orgs/:orgId/ski-swap/swaps/:swapId/items/by-sku/:sku
```

Exact match, trimmed. `404` with `"No item in this swap has tag <sku>."` when
nothing matches — that message is written for a person and is safe to show.

Do not use `?query=` for a scan. It searches with `contains`, so scanning
`67169` would also match `671690` and you would accept the wrong pair of skis.

**Accept an item.**

```
POST /orgs/:orgId/ski-swap/swaps/:swapId/items/:itemId/consign
→ 200, the item
```

Idempotent. A second scan of the same tag returns `200` with the item unchanged
— the accepted time does not move and nothing is pushed to Square twice. A
scanner double-reads constantly; treat a repeat as success, not as an error to
show.

`consignedBy` is stamped with your device id automatically, from the token. You
send no body.

`404` for an item in another org or swap, same as every other lookup here.

**A seller's list, split.**

```
GET …/items?sellerId=<id>&consigned=false   → still waiting
GET …/items?sellerId=<id>&consigned=true    → accepted
```

Omit `consigned` for everything, as before. Both return `{ items, total }` with
the usual `skip`/`take`.

## The item shape

`ItemResponse` gains one field:

```ts
consignedAt: string | null   // ISO 8601, or null while it waits
```

Everything else is unchanged.

## The list on your screen

The seller is identified by the first tag scanned — read `seller.id` off the
item that comes back, then list that seller's items for the running swap.

A tag belonging to a different seller mid-list is not an error: staff work
through piles, not through our idea of a session. Accept it and switch the list
to that seller.

## Refusing an item

There is nothing to call. A staff member who declines a pair of skis simply
never scans it: it stays unconsigned, stays out of Square, and the seller takes
it home. No reject action, no reason codes — see the plan's §8 for what that
costs.

Consequently "refused" and "nobody has got to it yet" look identical from here.
That is fine while a person is standing at the table to explain, and you should
not present unconsigned items as rejected.

## What check-in already reports

`POST /orgs/:orgId/ski-swap/checkin/finish` now returns an extra field:

```ts
awaitingConsignment: number   // how many of this seller's items still wait
```

Zero at an org that has not turned the scan on, so a client can decide what to
say without knowing about the setting. The web check-in uses it to change the
finish screen from "You're checked in" to "Checked in — waiting to be accepted".

## Not built, deliberately

- **Un-accepting.** Nothing clears a `consignedAt`. The way back is deleting the
  item.
- **Any chasing of items that sit unconsigned.** No timer, no alert, no queue
  age. A count on the web dashboard is the whole of it.
