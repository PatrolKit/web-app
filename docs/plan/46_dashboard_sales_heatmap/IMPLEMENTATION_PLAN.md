# Plan 46: Sales by hour, and categories as a pie

## Goal

The swap dashboard gains a **Sales by hour** heat map, and its category breakdown becomes a pie:

| | Left | Right |
|---|---|---|
| **Row 1** | Check-ins by hour (moved left) | **Sales by hour** (new, in Check-ins' old spot) |
| **Row 2** | Items (moved down one row) | **Items by category**, now a pie (was the bar chart below) |

Sales by hour reads like Check-ins by hour: days across, hours down, each cell as solid as it's busy. A toggle switches it between **Items** (units sold) and **Dollars** (what the register took).

## What's already here

- **`SkiSwapDashboard.tsx`:** tiles, then a two-column row (`lg:grid-cols-2`) with `ItemsPieCard` and `CheckinsHeatmapCard`, then `CategoriesChartCard` (bars) at full width, then the issue cards.
- **Check-ins by hour:**
  - **Server:** `StatsService.getCheckinsHeatmap` buckets items by `dayIn` and `hourIn` (`checkins-per-day.ts`) in the swap's `timeZone`, and returns `{ days, hours, cells, sellers, timeZone }`.
  - **Web:** the card's numbers are in `checkinsHeatmap.ts`: `heatView`, `opacity` (square root, so one huge hour doesn't wash out the rest), `dayLabel` and `hourLabel`.
- **Sales from Square:**
  - **`listSales`:** `PosAdapter.listSales(locationId, from, to)` runs one paged `orders.search` for completed orders, 200 a page. Each `PosSaleLine` has `orderId`, `variationId`, `quantity`, `collectedCents` (after discounts), `refundedQuantity` and `soldAt` (`closedAt`).
  - **The Items pie's cache:** `ItemBreakdownService.sales()` reads Square for the swap's whole life and keeps it two minutes per swap (`salesCache`). It stores only units sold per variation (`soldByVariation`), not the lines.
- **Items by category:**
  - **Server:** `StatsService.getCategoryCounts` returns `{ categories: [{ categoryId, label, count }], uncategorised }` for live items, busiest first. It leaves out the catch-all "Other" category.
  - **Web:** `CategoriesChartCard` draws bars, with each category's icon from the taxonomy.
- **The Items pie:**
  - **Card:** `ItemsPieCard`.
  - **Helpers:** `itemsPie.ts` has `PIE` (size, radii), `pieSlices` and `percent`. The card draws an SVG donut with the total in the middle and a legend beside it.

## Decisions

| # | Decision |
|---|---|
| D1 | **One Square read, two cards.** The sales cache keeps Square's **lines** rather than per-variation totals. The Items pie derives units sold from them, and Sales by hour derives its cells. Both stay within the existing two-minute read per swap, so the new card adds **no** Square calls. Whichever card asks first after the two minutes are up triggers the read; the other reuses it. Both show the same "Sales from Square as of 2:14 PM". |
| D2 | **Only this swap's sales.** A line counts when its `variationId` is one of this swap's items' stored `squareVariationId` (live, returned or deleted, since a sale is a sale). Anything else rung up at that Square location (concessions, another swap) is left out. The check is a local lookup, not a Square call. |
| D3 | **Items** is units sold: `quantity − refundedQuantity`. **Dollars** is what the register took, after discounts: `collectedCents`, less the refunded share (`collectedCents × refundedQuantity / quantity`). It's the same money payouts are based on. Shown as whole dollars in cells ("$1,240") and to the cent in tooltips. |
| D4 | **When:** the sale's `soldAt` (when it was paid), bucketed by the swap's time zone with the same `dayIn` and `hourIn` as check-ins. The days and hours shown are those with sales; check-in days and sale days usually differ. |
| D5 | **The card mirrors Check-ins by hour,** without the individuals and businesses chips, since sales have no seller kind. A toggle (**Items** / **Dollars**) in the header, totals per day along the top and per hour down the right, the Fewer/More key, and "Sales from Square as of …". Its own color (the green the Items pie uses for Sold), so the two heat maps read as different things side by side. Before any sale: "No sales yet." If Square can't be read: the error, as the Items pie shows it. |
| D6 | **Categories as a pie,** in the Items pie's style: a donut with the total in the middle, a legend beside it with each category's icon, count and share.<br>• **Top 7, then "More categories":** the seven biggest categories get slices, and the rest share one, "More categories (12)".<br>• **Drill-down:** clicking "More categories" (the slice or its legend row) redraws the pie with just those categories, top 7 again with their own "More" if needed. A trail above ("All categories › More") steps back.<br>• **No category:** items with no category are a grey slice, "No category", always at the top level. The total in the middle is then every item in the swap.<br>• **"Other":** the catch-all "Other" category is a slice like any other here. The pie covers every item, and leaving it out would make the total wrong. That's why the grouped slice is called "More categories", not "Other". |
| D7 | **Layout.** Two rows of two at `lg` and wider; one column, in the order above, on narrower screens. The cards in a row stretch to the same height. |

## Server

- **`item-breakdown.service.ts`:**
  - `sales()` caches `{ at, lines: PosSaleLine[] }` instead of the sold map. `getItemBreakdown` derives `soldByVariation(lines)` as now.
  - New `salesHeatmap(orgId, swapId)` reads the same cache (D1). It filters lines to the swap's variations (D2), then buckets by `dayIn`/`hourIn` in the swap's time zone (D4).
  - It returns `{ days, hours, cells: [{ date, hour, units, cents }], totals: { units, cents }, timeZone, asOf, error }`.
  - A Square failure answers `{ error }` with empty cells, as the breakdown does.
- **`sales-heatmap.ts`** (new, pure): `salesHeatmap(lines, variationIds, timeZone)`. It applies D2–D4 and is tested on its own.
- **`stats.controller.ts`:** `GET …/stats/sales-heatmap`, `ski_swap:report`, beside `checkins` and `breakdown`.
- **`getCategoryCounts`:** `categories` now includes the catch-all "Other" (D6), still busiest first. The bars are going, and nothing else reads this.
- **Contracts:** `SalesHeatmap` and `SalesCell` in `ski-swap.contracts.ts`.

## Web

- **`SkiSwapDashboard.tsx`:** the two rows (D7): `CheckinsHeatmapCard`, then `SalesHeatmapCard`, then `ItemsPieCard`, then `CategoriesPieCard`, all in one `grid gap-4 lg:grid-cols-2`. `CategoriesChartCard` is removed.
- **`heatmapParts.ts`** (new, from `checkinsHeatmap.ts`):
  - The shared helpers move here: `opacity`, `dayLabel`, `hourLabel`, and the grid as a small component (cells, totals row and column, the Fewer/More key) taking a color, a value function and a formatter.
  - `CheckinsHeatmapCard` uses it unchanged in look. `checkinsHeatmap.ts` keeps `heatView`.
- **`SalesHeatmapCard.tsx`** (new) and **`salesHeatmap.ts`** (new, pure):
  - `salesView(map, 'items' | 'dollars')` gives `value`, `dayTotal`, `hourTotal`, `total` and `max`.
  - `money(cents)` gives "$1,240" in cells and "$1,240.50" in tooltips.
  - The card polls every two minutes, like the Items pie.
- **`CategoriesPieCard.tsx`** (new) and **`categoriesPie.ts`** (new, pure):
  - `categorySlices(categories, uncategorized, path)` returns the slices for the level being shown: top 7, a "More categories" slice when more remain, and "No category" at the top level only.
  - Colors come from a fixed palette of distinct hues in a stable order, with grey for "No category" and a neutral for "More".
  - The card draws the donut with `PIE` from `itemsPie.ts`, a legend with `NodeIcon`s, and the trail for the drill-down.
- **`lib/api.ts`:** `getSalesHeatmap`, with its types in `api.types.ts`.

## Tests

- **`sales-heatmap.spec.ts`:**
  - only this swap's variations count, deleted and returned items' included;
  - refunds come off both units and dollars;
  - discounts are already in `collectedCents`;
  - buckets fall in the swap's time zone, including a sale just after midnight local time;
  - days and hours are only those with sales.
- **`item-breakdown.spec.ts`:** the breakdown is unchanged with lines cached; both reads share one Square call inside two minutes.
- **`categoriesPie.test.ts`:**
  - top 7, plus "More categories" with the right count when there are more;
  - no "More" slice at 7 or fewer;
  - the drill-down level shows the rest, top 7 again;
  - "No category" only at the top level, and only when there are any;
  - shares add to 100%.
- **`salesHeatmap.test.ts`:** items vs dollars, totals, and the money format.
- **`checkinsHeatmap.test.ts`:** still passes after the shared helpers move.

## Rollout

1. Build and test locally against the stub Square (`PAYOUTS_STUB`, with `SMOKE_SALES_FILE` holding sale lines across two days, one just past midnight, a refund and a sale of something not in the swap).
2. Deploy, after asking. No migration.
3. Look at the dashboard in the test org, and in BMBW's read-only.

## Out of scope

- Sales by category, or by seller.
- Comparing check-ins against sales in one chart.
- Live updates faster than the two-minute Square read.
