# Plan 32: Legacy tickets without a price

## Goal

A legacy ticket can be entered with no price. At check-in a seller hands over
gear with paper tickets, and the prices come later, before sales start. Staff
fill them in on the Items page.

If a ticket reaches the register still unpriced, the clerk types the price.
The seller is paid on what the clerk typed.

## Decisions

| # | Decision |
|---|---|
| D1 | **Only legacy tickets may be unpriced.** A legacy ticket is an item whose SKU is all digits (`ticketNumberOf`). There is no column for it, and the rule keys off the same test. An item with a generated SKU still needs a price, everywhere. |
| D2 | **Everywhere tickets go in.** The iPad staff check-in, staff Add Item on the web, file uploads (staff and shop), and a shop entering tickets by hand on My Items. Self check-in for individuals makes generated SKUs, so it is unchanged. |
| D3 | **Square sells an unpriced ticket at a typed price.** The variation is upserted with `pricingType: VARIABLE_PRICING` and no `priceMoney`. Square defines that as a price "entered at the time of sale", so Point of Sale asks the clerk for it when the item is rung up or scanned. When staff set a price, the next sync upserts it as `FIXED_PRICING` with `priceMoney`, as today. |
| D4 | **The payout uses what the clerk typed.** For each sale line of an item with no price, the owed unit price is the line's `basePriceMoney`, the price for one unit as rung up. It stays per sale line, so two units typed at different prices pay correctly. A price staff entered always wins; a typed price is used only when there's none. |
| D5 | **A typed price becomes the item's price.** When a run is built, an unpriced item whose sales all carry one typed unit price gets it as its `priceCents`, so receipts, reports and the seller's pages show it from then on. If its sales carry different typed prices, it stays unpriced and each payout line keeps its own price. |
| D6 | **Nothing shows $0 for "no price".** Every display, label and total says the price isn't set, and leaves the item out of the total instead of counting it as $0. |
| D7 | **Migrate in place.** `SwapItem.priceCents` and `ReceiptLine.priceCents` become nullable. Nothing else changes, existing rows keep their prices, and the code running now keeps working while the migration applies. |

## Server

### Schema

- **Migration `…_unpriced_tickets`:** `ALTER TABLE SwapItem MODIFY priceCents INT NULL`, and the same for `ReceiptLine`.
- `PayoutLineItem.priceCents` stays required. Under D4 every payout line has a price: the listed one or the typed one.

### Contracts (`contracts/ski-swap.contracts.ts`, `receipt.contracts.ts`)

**Requests**
- **`CreateItemSchema.priceCents`** becomes `.positive().nullable().optional()`. A refinement refuses a missing or null price unless `sku` is a ticket number. Staff and the iPad both post here.
- **`SellerItemCreateSchema.priceCents`** gets the same.
- **`PatchItemSchema` / `SellerItemUpdateSchema`** are unchanged. A price can be set or changed, but never cleared back to none.

**Responses** (`priceCents` becomes `.nullable()` in each)
- `ItemResponseSchema`, which is also the delta-sync payload.
- `PublicSellerItemSchema`, `PublicSellerDetailItemSchema`.
- `PublicReceiptLine`.

### Items (`item.service.ts`, `legacy-ticket.service.ts`, `seller-self.service.ts`)

- **Types:** `create`, `createAtStation`, `importItems` and the import row types take `priceCents: number | null`, guarded by D1 at the service as well as in the schema.
- **`parseItemCsv`:**
  - The price column is optional when every row is a ticket. A file with no price column at all is still refused if any row would get a generated SKU.
  - An empty cell is `null`, not `NaN`.
- **`checkImportRows`:**
  - A ticket row may have no price.
  - A generated-SKU row still needs one.
  - A non-empty price that isn't a positive amount is still refused.
- **`toResponse`** passes `null` through.

### Square (`pos/square.pos.adapter.ts`, `pos/pos.adapter.ts`)

- **`PosItemSync.priceCents`** becomes `number | null`.
- **`doItemUpsert`:** null sends `pricingType: 'VARIABLE_PRICING'` with no `priceMoney`, and a number sends what it sends today. This replaces the `BigInt(null)` throw that would leave the item consigned but missing from Square.
- **`listSales`** also reads `line.basePriceMoney.amount` into a new `PosSaleLine.unitPriceCents`.
- **Verify once on a real variation:**
  1. Create a test variation as `VARIABLE_PRICING` and scan it on the register. Confirm it prompts for a price.
  2. Ring it up at a typed price.
  3. Confirm `listSales` reads that price back as `unitPriceCents`.
  4. Refund it.

  Use a sandbox location if one exists. Otherwise use the smoke org's location, never BMBWAV's.

### Payouts (`payouts/build-run.ts`, `payout-run.service.ts`)

- **`buildRun`:** a built line item's `priceCents` is `item.priceCents ?? sale.unitPriceCents`, so `grossCents` uses it (D4).
- **Missing typed price:** a sale of an unpriced item with no `unitPriceCents` should not happen. If it does, building the run is refused, naming the tickets, until staff price them. A line paying the rest of that seller's sales would underpay them quietly, and a $0 owed line is never built.
- **`discountsOf`** compares collected against the price owed, now including typed prices, so a typed price that was then discounted still reports.
- **Writing back (D5)** happens when a run is built, in the same transaction. Each priced item is re-synced to Square afterwards (as `FIXED_PRICING`), best-effort, as `patch` does.

### Receipts (`receipt.service.ts`, `receipt-templates.ts`)

- **Lines:** `ReceiptLine.priceCents` is copied as `null`.
- **Totals:** `totalCents` sums only priced lines.
- **Email and SMS templates:**
  - An unpriced line reads "Price to come".
  - The total reads "Total of priced items" when any line is unpriced, with a line saying how many have no price yet.
- **Re-minting:** `stillDescribes` already includes the price, so a receipt mints again once prices are filled in.

### Other server sites

- **`checkin.service.ts` summary:** `totalCents` is over priced items, plus an `unpricedCount`.
- **`stats.service.ts`:** revenue counts priced items only, plus an `unpricedSold` count that the stats page shows as "N sold at register prices, not yet counted".
- **Labels (`printing/label-templates.ts`):**
  - **Item tags:** unchanged. A ticket never gets one. Rendering one for an unpriced ticket is refused, and so is queuing a reprint of one.
  - **Helper labels:** an unpriced ticket prints "$____" for staff to write the price in.
  - **Receipt lines** print "TBD", short enough to sit beside the name on a 50 mm label. The foot reads "N items, M TBD", and the total is of the priced items.
  - The station Test helper keeps its fixed price.
- **Public seller pages** show "Price to come" from the nullable response.

## Web

- **Types:** `api.types.ts` makes `priceCents: number | null` on items, receipt lines and public items, and `api.ts` lets `createItem` and `sellerCreateItem` send `null`.
- **`SwapItemsPanel`:**
  - **Required fields:** `missingItemFields` no longer requires a price on a ticket: when a ticket number is entered, or when editing an item that is a `legacyTicket`. A blank price sends `null`, never `NaN`.
  - **Table:** an unpriced item shows "No price" in amber.
  - **"Needs a price" filter:** a new state filter beside the others, with a count in the toolbar, so staff can work through them before sales start.
  - **Editing:** an unpriced ticket opens with an empty price field, not "0.00".
- **Import modals** (`TicketItemImportModal`, `ProxyItemImportModal`): the copy says a ticket row may leave the price blank to fill in later.
- **Receipts, payouts and public pages:**
  - **Price display:** `PrintReceiptModal`, `PayoutRunPage`, `ReceiptPage`, `SellerItemsPage` and `SellerStatusPage` show "Price to come".
  - **Totals:** totals leave unpriced items out and say so.
  - **Formatting:** `lib/money.ts usd()` and `checkin/shared.tsx formatCents` take `null` and return "Price to come", so no caller can print $0.00 for it.
- **Swap dashboard:** a swap with unpriced tickets shows "N tickets have no price yet", linked to the Items page with the "Needs a price" filter on.
  - The plan first put this on the Swaps page. The dashboard already loads that swap's stats, so the count costs one database count and no Square reads.
  - The dashboard also notes how many tickets sold before they were priced, since revenue leaves those out.
- **Staff Add Item has no ticket field.** Tickets reach the web from the iPad, file uploads and a shop's My Items. So the web's part for staff is finding unpriced tickets and pricing them, and its part for shops is entering tickets without a price.

## iPad

The iPad's changes are in a separate handoff, [IPAD_HANDOFF.md](IPAD_HANDOFF.md). It's copied into `patrolkit_ios/docs/plan/` once the server change is deployed, since the iPad can't release before that.

## Rollout

1. **Server and web deploy together.** It needs the migration (approved: in place) and is safe on its own.
   - **Existing items:** nothing has a null price until someone saves an unpriced ticket.
   - **Old iPads:** they decode `null` today and store it as `0`. They'd show $0, and an unedited save of that item would send `0`, which the server refuses.
   - **Until the iPads update:** staff shouldn't leave a price blank on the web for a seller the iPads are also working on. This is a short window, and the iPad PR follows.
2. **Verify on production:**
   - **New smoke `smoke-unpriced-tickets.mjs`** (smoke org only):
     1. Create an unpriced ticket by staff, upload and shop. A generated-SKU item with no price is refused.
     2. The item's Square variation is `VARIABLE_PRICING`.
     3. Setting a price turns it `FIXED_PRICING`.
     4. The receipt shows "Price to come" and a total of the priced items.
   - **Payouts with a typed price** are covered by unit tests on `buildRun`, plus the one-time register check above.
   - **Existing smokes** that assert "a row with no price is refused" change to assert that for generated-SKU rows only (`smoke-legacy-tickets.mjs:293`).
3. **iPad release** after the handoff is done.

## Tests

- **Contract refinements:** a ticket may omit the price, and a generated SKU may not, for each create path.
- **Imports:** blank ticket prices, blank generated-SKU prices, no price column at all.
- **Square adapter:** the upsert body for null and for a number.
- **`buildRun`:**
  - The typed price is owed per line.
  - The listed price wins over a typed one.
  - Several different typed prices stay per line.
  - A missing typed price makes a `PENDING` line, never $0.
  - The write-back happens for a single typed price only.
- **Receipts:** null lines and the priced-only total.
- **Web:** `missingItemFields` for tickets, `usd(null)`, the filter.
