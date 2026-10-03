# To the iPad: a legacy ticket may have no price

**From:** the server (Plan 32). **When:** release after the server change is
deployed. Until then the server refuses an item with no price.

## Why

At check-in a seller hands over gear with paper tickets, and the prices come
later, before sales start. So a legacy ticket may now be saved with no price.
Staff fill it in later, on the iPad or the web.

If one reaches the register still unpriced, Square asks the clerk to type a
price, and the seller is paid on that.

## What changes on the wire

**Rule:** only a legacy ticket may be unpriced, meaning an item whose SKU is all
digits (`ItemRecord.isLegacyTicket`). An item with a generated SKU still needs
a price, and the server refuses it without one.

**Requests**
- **`POST …/items` (`CreateItemPayload`):** `priceCents` may be `null` or absent
  when `sku` is a ticket number.
- **`PATCH …/items/:id` (`PatchItemPayload`):** sets or changes a price as
  today. There's no way to clear a price back to none.

**Responses**
- **Items, including the `?updatedSince=` delta:** `priceCents` may be `null`.
- **Receipt lines:** `priceCents` may be `null`, and `totalCents` sums priced
  lines only.

**After a sale:** once a payout run is built, an unpriced ticket that sold at
one price typed at the register gets that price. It arrives in the next delta
like any other edit.

## What the iPad needs

Paths are `patrolkit_ios/PatrolKit/…`.

### 1. Store and sync a missing price

- **`ItemRecord.priceCents`** becomes `Int?` (`Services/PatrolKitStore+SkiSwap.swift:307`).
- **GRDB:** add a migration making `priceCents` nullable. The column is
  declared `INTEGER NOT NULL` at `Services/PatrolKitStore.swift:196`.
- **Sync:** store `null` as `null`. `Services/SkiSwapSyncModule.swift:499` has
  `priceCents: item.priceCents ?? 0`, which turns "no price" into $0 today.
- **Receipt lines:** `APIReceiptLine.priceCents` becomes `Int?`
  (`Services/SkiSwapAPIClient.swift:106`). As `Int`, a null line fails to
  decode, and the receipt fetch falls back to local items.
- **Create payloads:** `CreateItemPayload.priceCents` becomes `Int?` (:372).
  Re-mint and re-parent rebuild these (`PatrolKitStore+SkiSwap.swift:864`,
  :1125) and should carry `nil` through.

### 2. Save a ticket without a price

In `ItemEntryViewModel`:
- **`saveBlockers`** (:208-211) and the guard in **`saveItem`** (:245-247) ask
  for a price only when the item isn't a legacy ticket. A price that is entered
  still has to be $1 or more, in whole dollars, as now.
- **`resolvedPriceCents`** (:193-199) returns `nil` for an empty field.
- **An unpriced item opens with an empty price field.** Today it would open
  with "0". An unedited save then sends `priceCents: 0`, which the server
  refuses.

### 3. Helper labels

- **Unpriced tickets:** print `$______` in place of the price, so staff can
  write it in. This covers the item sticker and the office sticker
  (`Printing/HelperLabelTemplate.swift:47-53`, :102-104, `price()` at :123).
  The content structs (`Printing/HelperLabelContent.swift:13,23,41`) take
  `Int?`.
- **Reprint:** when a price is filled in later, offer the existing helper-label
  reprint (`SellerDetailView.swift:803-825`), the same as for a price change.

### 4. Displays and receipts

- **Wording:** show "Price to come" wherever an item's price is shown:
  - `SellerDetailView.swift:1168`
  - `SessionSummaryView.swift:112`
  - receipt and item-tag lines in `Printing/ReceiptTemplates.swift`,
    `LabelRenderer.swift`, `LabelGenerator.swift`
- **Totals** (e.g. `SessionSummaryViewModel.totalCents`, `LabelRenderer.swift:76`)
  sum priced items only, and say how many have no price yet. The server's
  receipts read "Total of priced items" and "N items have no price yet".
- **Item tags** don't change: a legacy ticket never gets one.

## Until this ships

An iPad on today's build:
- **Display:** it shows an unpriced ticket as $0, and prints `$0` on its helper
  labels.
- **Saving:** an unedited save of that item sends `0`, which the server
  refuses. Typing a price first saves fine.

Staff are asked not to leave prices blank on the web for sellers the iPads are
also working on until this is released.

## How we'll know

- **Saving without a price:** a ticket checked in with no price saves, syncs,
  and shows "Price to come" on every iPad.
- **Labels:** its helper labels print `$______`.
- **Pricing it later:** setting the price on the web reaches the iPad in the
  next delta, and the reprint is offered.
- **Generated SKUs:** an item with a generated SKU still can't be saved without
  a price.
