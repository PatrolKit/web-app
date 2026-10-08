# Plan 46: Sales by hour, an Items bar, and sold by category

## Goal

Three changes to the swap dashboard:

- **Items** becomes a short stacked bar, like the Sellers tile, and joins the top row as its third tile: Sellers · Consigned value · Items.
- **Check-ins by hour** moves to the left, and a new **Sales by hour** heat map takes its old place on the right. It reads like Check-ins by hour (days across, hours down, each cell as solid as it's busy), with a toggle between **Items** (units sold) and **Dollars** (what the register took).
- **Items by category** stays a bar chart. Each bar gains a **sold** layer: the share of that category that has sold, filled in from the bottom, with "sold / total" above it.

| | Left | Middle | Right |
|---|---|---|---|
| **Tiles** | Sellers | Consigned value | **Items** (bar) |
| **Row** | Check-ins by hour | | **Sales by hour** |
| **Full width** | Items by category, with sold | | |

## What's already here

- **`SkiSwapDashboard.tsx`:**
  - a two-tile row (`grid-cols-2`): `SellersTile` (total, a `h-2.5` stacked bar, a legend) and Consigned value;
  - then a two-column row (`lg:grid-cols-2`): `ItemsPieCard` and `CheckinsHeatmapCard`;
  - then `CategoriesChartCard` at full width, then the issue cards.
- **The Items pie:**
  - **Server:** `ItemBreakdownService.getItemBreakdown` returns sold, returned, for sale, no price, no description, not on sale and total.
  - **Sales:** read from Square with `PosAdapter.listSales` (one paged `orders.search` of completed orders, 200 a page). It's cached two minutes per swap, but only as units sold per variation (`soldByVariation`).
  - **Web:** `itemsPie.ts` has the slice order, labels and colors (`pieSlices`, `percent`).
- **Sale lines:** each `PosSaleLine` has `orderId`, `variationId` (our `squareVariationId`), `quantity`, `collectedCents` (after discounts), `refundedQuantity` and `soldAt` (`closedAt`).
- **Check-ins by hour:**
  - **Server:** `StatsService.getCheckinsHeatmap` buckets by `dayIn`/`hourIn` (`checkins-per-day.ts`) in the swap's `timeZone`.
  - **Web:** `checkinsHeatmap.ts` has `heatView`, `opacity`, `dayLabel` and `hourLabel`.
- **Items by category:**
  - **Server:** `StatsService.getCategoryCounts` returns `{ categories: [{ categoryId, label, count }], uncategorised }` for live items, busiest first, without the catch-all "Other".
  - **Web:** `CategoriesChartCard` draws teal columns, up to 80px tall, with the count on top and the category's icon and name under each.
- **Quantity:** imports always create quantity 1 (`item.service.ts`, the import's `quantity: 1`). Only someone typing a quantity in the item form makes one above 1.

## Decisions

| # | Decision |
|---|---|
| D1 | **One Square read for everything that needs sales.** The two-minute sales cache keeps Square's **lines**, not per-variation totals. Three things derive from it:<br>• the Items bar's sold count, as now;<br>• Sales by hour;<br>• sold per category.<br>Whichever asks first after two minutes triggers the read; the rest reuse it. The new features add **no** Square calls. Every card that shows sales says "Sales from Square as of 2:14 PM". |
| D2 | **Only this swap's sales.** A line counts when its `variationId` is one of this swap's items' stored `squareVariationId`, deleted and returned items included, since a sale is a sale. Anything else rung up at that Square location (concessions, another swap) is left out. The same local lookup gives each sale its item's **category** (D6). |
| D3 | **Items: a stacked bar in the third tile,** in the Sellers tile's style.<br>• **Layout:** the label and total ("Items 1,248"), one `h-2.5` bar in the pie's colors and order (Sold, Returned, For sale, No price, No description, Not on sale), and a wrapping legend of colored squares with counts. A segment's tooltip gives its count and percent.<br>• **Sales as of:** "Sales from Square as of 2:14 PM" in small text, under the legend. If Square can't be read, the legend says so in amber and the bar shows what's known without Sold.<br>• **The top row** becomes three tiles at `md` and up (two, then one, on narrower screens). |
| D4 | **Sales by hour mirrors Check-ins by hour,** without the individuals and businesses chips, since sales have no seller kind.<br>• **Toggle:** **Items** / **Dollars**, in the header.<br>• **Items** is units sold (`quantity − refundedQuantity`). **Dollars** is what the register took (`collectedCents` less the refunded share, `collectedCents × refundedQuantity / quantity`), the same money payouts use. Cells show whole dollars ("$1,240"); tooltips show cents.<br>• **When:** the sale's `soldAt`, in the swap's time zone, with the same `dayIn`/`hourIn` as check-ins. The days and hours are those with sales.<br>• **Color:** its own, the green the Items bar uses for Sold, so the two heat maps read as different things side by side.<br>• **Empty states:** "No sales yet"; Square's error in amber if it can't be read. |
| D5 | **The two heat maps share one grid.** The grid, the totals along the top and right, and the Fewer/More key move into a shared component that takes a color, a value function and a formatter. Check-ins by hour looks exactly as it does now. |
| D6 | **Sold on each category bar.**<br>• **Each column** stays the category's total; inside it, from the bottom, a solid fill for the sold part, with the rest of the column a lighter tint of the same color.<br>• **Above it:** "38 / 112" (sold / total), and the column's tooltip adds the percent.<br>• **Counted in units:** a quantity-3 item is 3, and each unit sold fills one. Today every item is quantity 1, so units and items are the same, and the bars keep their current heights. Units stay right if a larger quantity ever appears.<br>• **Sold** is units sold, less refunds, of the category's items: every sale line, through D2's lookup, to its item's category. The category is the item's **current** one, so an item categorized after it sold counts under its category now.<br>• **Header:** "38 sold of 1,248 in these categories · 230 without a category". |
| D7 | **When Square can't be read,** the category bars still draw from our own rows, with no sold layer, and the header says sales couldn't be read. The category card never waits on Square: its counts come first, and sold follows in a second request. |

## Server

- **`item-breakdown.service.ts`:**
  - `sales()` caches `{ at, lines: PosSaleLine[] }`. `getItemBreakdown` derives `soldByVariation(lines)` as now.
  - **`salesHeatmap(orgId, swapId)`:** returns `{ days, hours, cells: [{ date, hour, units, cents }], totals: { units, cents }, timeZone, asOf, error }`.
  - **`soldByCategory(orgId, swapId)`:** returns `{ categories: [{ categoryId: string \| null, units }], asOf, error }`, with null for items with no category.
  - Both read the cache (D1) and map variations to the swap's items in one query (D2).
- **`sales-heatmap.ts`** (new, pure): `salesHeatmap(lines, variationIds, timeZone)` and `soldByCategory(lines, categoryByVariation)`, applying D2, D4 and D6.
- **`stats.controller.ts`:** `GET …/stats/sales-heatmap` and `GET …/stats/sold-by-category`, `ski_swap:report`, beside `checkins` and `breakdown`.
- **`getCategoryCounts`:** counts units (`_sum.originalQuantity`) rather than rows (D6). It's the same number while every quantity is 1.
- **Contracts:** `SalesHeatmap`, `SalesCell` and `SoldByCategory` in `ski-swap.contracts.ts`.

## Web

- **`SkiSwapDashboard.tsx`:**
  - **Top row:** three tiles at `md` (D3): `SellersTile`, Consigned value, and `ItemsTile` in place of `ItemsPieCard`.
  - **Then:** `CheckinsHeatmapCard` and `SalesHeatmapCard` in `lg:grid-cols-2`, then `CategoriesChartCard`.
- **`ItemsTile.tsx`** (new, replacing `ItemsPieCard.tsx`): the bar and legend from `itemsPie.ts`'s slices. That file keeps the order, labels, colors and `percent`, and drops the donut geometry.
- **`heatmapParts.tsx`** (new, D5): the shared grid, `opacity`, `dayLabel` and `hourLabel`, moved from `checkinsHeatmap.ts`, which keeps `heatView`.
- **`SalesHeatmapCard.tsx`** and **`salesHeatmap.ts`** (new):
  - `salesView(map, 'items' | 'dollars')` gives `value`, `dayTotal`, `hourTotal`, `total` and `max`; `money(cents)` formats the dollars.
  - The card polls every two minutes, like the Items tile.
- **`CategoriesChartCard.tsx`:**
  - adds the `sold-by-category` query (every two minutes);
  - the column becomes a total-height track with a sold fill from the bottom;
  - the label "sold / total", and the header line (D6, D7).
  - Pure parts go in **`categoriesChart.ts`**: `columns(counts, sold)`, which joins sold to totals and clamps sold to total.
- **`lib/api.ts`:** `getSalesHeatmap` and `getSoldByCategory`, with their types in `api.types.ts`.

## Tests

- **`sales-heatmap.spec.ts`:**
  - only this swap's variations count, deleted and returned items' included;
  - refunds come off units and dollars;
  - discounts are already in `collectedCents`;
  - buckets fall in the swap's time zone, including a sale just after local midnight;
  - days and hours are only those with sales;
  - sold by category goes to each item's current category, with null for none.
- **`item-breakdown.spec.ts`:** the breakdown is unchanged with lines cached, and every read inside two minutes shares one Square call.
- **`salesHeatmap.test.ts`:** items vs dollars, totals, and the money format.
- **`categoriesChart.test.ts`:** sold joined to totals; a category with no sales shows 0; sold never exceeds total; the header's sums.
- **`itemsPie.test.ts`:** still passes with the donut geometry gone.
- **`checkinsHeatmap.test.ts`:** still passes after the shared parts move.

## Rollout

1. Build and test locally against the stub Square (`PAYOUTS_STUB`, with `SMOKE_SALES_FILE` holding sale lines across two days, one just past local midnight, a refund, and a sale of something not in the swap).
2. Deploy, after asking. No migration.
3. Look at the dashboard in the test org, and in BMBW's read-only.

## Out of scope

- Sales by seller.
- Comparing check-ins against sales in one chart.
- Updates faster than the two-minute Square read.
