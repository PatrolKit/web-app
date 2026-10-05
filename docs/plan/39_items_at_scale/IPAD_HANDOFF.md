# To the iPad: item responses no longer carry stock

**From:** the server (Plan 39). **When:** either side can go first; see
"Order".

## Why

The iPad decodes `inStock` and `soldCount` on every item and stores them, but
nothing reads them back: no screen, count, receipt, filter or check. Your own
notes say so (`docs/plan/6_user_rework/IMPLEMENTATION_PLAN.md` D12a,
`SERVER_HANDOFF.md:322`): a check-in iPad takes goods in, and what has sold is a
dashboard question.

The server reads those values from Square on every request, one Square call per
batch of items. That's a Square call per page of every sync, for numbers that
are thrown away. At 10,000 items it's the iPads' share of the load Plan 39
removes. So the server stops reading and stops sending them.

## What changes on the server

**Item responses to a device leave out `inStock`, `soldCount` and
`inventoryKnown`.** That's every item route the iPad calls:

- the list (`walk` and `updatedSince`);
- create (`POST …/items`);
- patch (`PATCH …/items/:id`);
- photo upload (`POST …/items/:id/photos`).

Nothing else in the response changes. In particular, `squareSynced`,
`consignedAt` and `updatedAt` stay as they are.

## What the iPad should remove

Every stock reference in the app, as of `93887e3`:

1. **The API model:** `SkiSwapAPIClient.swift:197-198`, `inStock` and
   `soldCount` on `APIItem`, and the doc comment at `:187-189` that explains
   them.
2. **The sync:** `SkiSwapSyncModule.swift:534`, where `itemRecord(from:)`
   copies them.
3. **The record:** `PatrolKitStore+SkiSwap.swift:352-353`, the `ItemRecord`
   properties.
4. **Where items are made locally with nil stock:**
   - `ItemEntryViewModel.swift:368`;
   - `PatrolKitStore+SkiSwap.swift:777` (`checkInLegacyTickets`).
5. **The database:** the `inStock` and `soldCount` columns on `items`
   (`PatrolKitStore.swift:212-213`). Drop them in a new migration (the next is
   `v27`), the way `tc_resorts.active` was dropped (`PatrolKitStore.swift:331`).
   Don't edit the migration that added them. iOS 17's SQLite supports
   `DROP COLUMN`.
6. **Tests:**
   - the JSON fixtures: `SellerContractTests.swift:202`, and
     `ReceiptRecordTests.swift:358`, `:372`, `:385` and `:399`;
   - the fake items that pass `inStock: nil, soldCount: nil`:
     `FakeSkiSwapAPI.swift:80`, `OptionalCategoryTests.swift:154`,
     `SyncRecoveryTests.swift:56`, `SyncEngineTests.swift:63`,
     `ReceiptRecordTests.swift:328` and `:471`,
     `RefusedWriteRecoveryTests.swift:60`, `LegacyTicketTests.swift:452`,
     `WholeDollarPriceTests.swift:22`, `ItemSizeTests.swift:52`,
     `UnpricedTicketTests.swift:35` and `PrintRouteTests.swift:433`.
7. **Docs:** D12a and `SERVER_HANDOFF.md:260` and `:322`. The fields are gone
   rather than cached, so the warnings about stale snapshots can go too.

## Order

**Either side can go first.**

- **Server first:** today's app declares both fields optional, so a response
  without them decodes as nil, as it does now for items made on the iPad.
- **iPad first:** the server's extra keys are ignored, because `APIItem` won't
  declare them.

No version check or flag is needed.

## How we'll know

- **A full sync and a delta sync** of a swap succeed, and the items look as they
  did.
- **The server's log** shows no Square inventory call for an iPad's sync.
- **The app's tests** pass with the fixtures updated, and no stock reference is
  left in the repo.
