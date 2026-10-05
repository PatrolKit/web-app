# Plan 39: The Items page at 10,000 items

## Goal

The Items page stays quick, and Square stays unbothered, at **10,000 items in a
swap with 5 staff on the page at once**.

**Stock stays in Square, and the server asks only about what's on screen.**
Nothing stores or remembers it. Every feature that needed stock for a whole
swap at once goes: the For sale and Sold filters, the counts beside the
filters, sorting by Status, and the dashboard's sales figures. Sales totals and
lists of what sold live in Square's own reports, and payout runs still work out
sales from Square's orders.

## Today, at 10,000 items

| | |
|---|---|
| Requests to open the Items page | 50, one after another (200 items each) |
| Square stock reads to open it | at least 50, one per batch, more where Square splits its answers into pages |
| Sent to the browser | 5.7 MB, measured: photos, answers and seller on every row |
| After any save, delete, print, accept, or closing Fast Edit | all of the above again |
| 5 staff during check-in | hundreds of Square reads a minute, and multi-megabyte responses built on a 1 GB server |
| Dashboard, with the one-minute refresh already committed | every item's stock from Square, every minute, per open dashboard |
| An iPad's item sync | one Square read per batch, for stock the iPad never uses |

When Square pushes back on that rate, rows show "Stock unknown", and the
For sale and Sold filters go wrong.

**Also fixed here:** the Receipt popup on the Sellers page asks for a seller's
items without a limit, so it gets the server's default of 50. Its item count
and total value are wrong for any seller with more than 50 items.

## Targets

- **Items page:** first rows on screen in under 1 s; a sort, filter or next
  page in under 300 ms of server time, plus one Square read for the page.
- **Square:** one stock read per page viewed, for its 50 items. Nothing reads
  stock for a whole swap. At 5 staff, that's a few dozen reads a minute.
- **Server memory:** no response over about 300 KB.

## Decisions

| # | Decision |
|---|---|
| D1 | **Pages of 50.** The server filters, sorts and searches, and the browser shows one page: "1–50 of 9,812", Previous and Next. Changing a filter, sort or search starts again at page 1. |
| D2 | **Filters are only what our own data answers:** Not yet received, Not in Square (accepted but never put in Square), Needs a price, tag printed or not, and seller. **For sale and Sold go**, along with the counts beside each filter. What a filter finds shows when it runs, as "1–50 of 312". |
| D3 | **Sorting covers SKU, name, price, seller and tag.** Status sorting goes: telling For sale from Sold needs stock for every item. |
| D4 | **Row badges read Square live, for the page.** The Status column still shows For sale, Sold or Stock unknown, from one Square read for the page's items. If Square doesn't answer, those rows say Stock unknown, as now. |
| D5 | **A save updates its row in place.** Edit, print, price and accept replace that row with the server's answer, and a delete removes it. Nothing reloads the whole list. |
| D6 | **The dashboard drops its sales figures:** Items Sold, Est. Revenue, the note about tickets sold before they were priced, and the "Square could not be read" note. Total Items, Sellers and Consigned Value stay. They come from our own data, so the dashboard makes no Square call. |
| D7 | **The Receipt popup shows listed value:** the seller's priced items at their listed prices, as checked in, and how many are still to be priced. Both come from the server, with no Square read. |
| D8 | **The iPads get no stock.** They store `inStock` and `soldCount` but never read them, and their own notes say a check-in iPad shouldn't show "sold". Item responses to a device leave out `inStock`, `soldCount` and `inventoryKnown`, and skip the Square read. The iPad removes them on its side ([IPAD_HANDOFF.md](IPAD_HANDOFF.md)). |
| D9 | **Decisions read Square live, as now.** Removing returned tickets (Plan 38 D10), the shop's describe-once rule (Plan 38 D6) and payouts each read what they need at that moment: one range, one item, or the orders. |

## Server

### The list

- **`GET …/swaps/:swapId/items`** gains:
  - `status=not_received|not_in_square|needs_price`;
  - `printed=true|false`;
  - `sort=sku|name|price|seller|tag` and `dir=asc|desc`.
- **Filters run in SQL**, beside the existing `query` and `sellerId`. The search
  finds matching sellers first, in one small query, and filters items by their
  ids rather than joining every row to its seller.
- **Sorting reads every matching row's id and sort fields, sorts them, and cuts
  the page** (`item-list-order.ts`). SQL can't sort SKUs as numbers or names the
  way people read them without per-column tricks:
  - SKU sorts as a number ("9" before "100").
  - Seller sorts by the name shown: the business name, or first and last, read once per seller.
  - A missing price or seller sorts last either way, and ties sort by SKU, as the table does now.
- **The page** is read with the usual includes for its 50 ids, plus one Square stock read for those in Square (D4).
- **Other callers keep the defaults:** no `sort` means newest first.
- **A device caller** (`req.device` set) gets no stock fields and causes no Square call (D8). That covers the list (`walk` and `updatedSince`), create, patch and photo upload. The contract gains a device variant of `ItemResponse` without the three fields, so the web's type keeps them required.

### The dashboard's figures

- **`GET …/swaps/:swapId/stats`** drops `itemsSold`, `grossRevenueCents`,
  `unpricedSold` and `inventoryKnown`, and with them its Square read. Only the
  web dashboard reads it.

### The Receipt popup

- **The server supplies the seller's figures (D7):** their item count in the
  swap, their listed value, and how many are still to be priced. This fixes the
  50-item limit.

## Web

- **`SwapItemsPanel`:**
  - asks for one page with the filters, sort and search;
  - keeps them in the URL, so the dashboard's links and a reload land on the same view;
  - drops the paging loop, the browser-side filtering, sorting and counting, and the stock-unknown count above the table;
  - keeps the sort headings already committed for SKU, name, price, seller and tag, which now send `sort` and `dir`. The Status heading no longer sorts.
- **Status filter menu:** All statuses, Not yet received, Not in Square, Needs a price, with no counts.
- **Pager:** "1–50 of 9,812", Previous and Next, above and below the table.
- **The shop's My Items page** works the same way, through its own list endpoint (`seller/me/items`), which already takes `skip` and `take`.
- **The dashboard:**
  - the Items Sold and Est. Revenue tiles and the two notes go (D6);
  - its links to filtered Items views (needs a price, not yet received) keep working through the URL.
- **The Receipt popup** shows the server's count and listed value (D7).

## Rollout

- **Nothing deploys while a customer's swap is running** without the user's say-so.
- **No migration.**
- **The one-minute dashboard refresh** already committed ships with D6, when the
  figures stop costing a Square read. If it has to go out sooner, take it out of
  that commit.
- **iPad:** [IPAD_HANDOFF.md](IPAD_HANDOFF.md) goes to the iOS repo. Either side
  can go first.

## Tests

**Measured** against a scratch database with 10,000 items, 300 sellers and
3,334 photos, on a development server with no Square:

| | Server time (median) | Response |
|---|---|---|
| A page, newest first | 33 ms | 30 KB |
| Sorted by SKU, price or name | 43–45 ms | 30 KB |
| Sorted by seller | 69 ms | 31 KB |
| Needs a price, or Not in Square and not printed | 28–31 ms | 30–33 KB |
| A search, sorted | 39 ms | 33 KB |
| Dashboard figures | 61 ms | 0.2 KB |
| Receipt figures | 4 ms | 0.1 KB |
| Five clients, 100 requests | p95 102 ms, max 131 ms | |
| Today's full load, for comparison | 50 requests, 2.1 s | 5.7 MB |


- **Scale,** against a scratch database with 10,000 items, sellers and photos:
  - each sort and filter, with and without search, for query time and response size;
  - five clients loading pages and saving at once, against a fake Square that counts its calls: one call per page shown, none for anything else.
- **Server:**
  - every filter and sort, including numeric SKU, missing values last and ties by SKU;
  - `total` matching the filters;
  - one Square read per page, for the page's items only;
  - no stock fields and no Square call for a device, on the list, create, patch and photo upload;
  - responses to a person unchanged;
  - the stats making no Square call;
  - the Receipt figures for a seller with more than 50 items.
- **Web:**
  - the URL keeping the view;
  - a save updating one row;
  - the pager;
  - the dashboard without the sales tiles;
  - the Receipt popup's count and listed value.
